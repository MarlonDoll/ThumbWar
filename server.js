const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { RoomManager, PHASES } = require('./src/rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/play', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});
app.get('/host', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const rooms = new RoomManager(io);

function broadcastState(room) {
  io.to(room.code).emit('state', rooms.publicState(room));
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('private', rooms.privateView(room, p.id));
    }
  }
}

io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.roomCode = null;
  socket.data.isHostDisplay = false;

  socket.on('create-room', ({ name }, cb) => {
    const { room, hostId } = rooms.create(name);
    const host = room.players.find((p) => p.id === hostId);
    host.socketId = socket.id;
    socket.join(room.code);
    socket.data.playerId = hostId;
    socket.data.roomCode = room.code;
    cb({ ok: true, code: room.code, playerId: hostId });
    broadcastState(room);
  });

  socket.on('join-room', ({ code, name }, cb) => {
    const res = rooms.join(code, name);
    if (res.error) return cb({ error: res.error });
    const p = res.room.players.find((x) => x.id === res.playerId);
    p.socketId = socket.id;
    socket.join(res.room.code);
    socket.data.playerId = res.playerId;
    socket.data.roomCode = res.room.code;
    cb({ ok: true, code: res.room.code, playerId: res.playerId });
    broadcastState(res.room);
  });

  // Reconnect flow — player already has an id from a prior connection.
  socket.on('resume', ({ code, playerId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return cb({ error: 'Player not found in this room' });
    p.socketId = socket.id;
    p.connected = true;
    delete p.disconnectedAt;
    socket.join(room.code);
    socket.data.playerId = playerId;
    socket.data.roomCode = room.code;
    cb({ ok: true });
    broadcastState(room);
  });

  socket.on('host-display', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isHostDisplay = true;
    room.hostDisplays.add(socket.id);
    cb({ ok: true });
    socket.emit('state', rooms.publicState(room));
  });

  socket.on('set-spectator', ({ spectator }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    rooms.setSpectator(room, socket.data.playerId, spectator);
    broadcastState(room);
  });

  socket.on('rename', ({ name }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    rooms.rename(room, socket.data.playerId, name);
    broadcastState(room);
  });

  socket.on('start-game', (_data, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    if (room.hostId !== socket.data.playerId) {
      return cb && cb({ error: 'Only the host can start' });
    }
    const r = rooms.startGame(room);
    if (r.error) return cb && cb({ error: r.error });
    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('submit-title', (payload, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    const r = rooms.submitTitle(room, socket.data.playerId, payload || {});
    cb && cb(r);
    broadcastState(room);
  });

  socket.on('submit-drawing', ({ writerId, png }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    const r = rooms.submitDrawing(room, socket.data.playerId, writerId, png);
    cb && cb(r);
    broadcastState(room);
  });

  socket.on('submit-vote', ({ thumbnailId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    const r = rooms.submitVote(room, socket.data.playerId, thumbnailId);
    cb && cb(r);
    broadcastState(room);
  });

  socket.on('submit-browse-vote', ({ category, conceptId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    const r = rooms.submitBrowseVote(
      room,
      socket.data.playerId,
      category,
      conceptId
    );
    cb && cb(r);
    broadcastState(room);
  });

  socket.on('restart', (_d, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    if (room.hostId !== socket.data.playerId) {
      return cb && cb({ error: 'Only the host can restart' });
    }
    rooms.restart(room);
    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.isHostDisplay) {
      room.hostDisplays.delete(socket.id);
      return;
    }
    const p = room.players.find((x) => x.id === socket.data.playerId);
    if (p) {
      p.connected = false;
      p.socketId = null;
      p.disconnectedAt = Date.now();
    }
    // Don't immediately remove the player — page navigations (landing -> /play)
    // disconnect briefly. The cleanup sweep will remove truly stale players.
    broadcastState(room);
  });
});

// Periodic cleanup: drop players who've been disconnected too long, promote a
// new host if the host vanished, and delete empty rooms. Keeps in-memory state
// from accumulating without yanking the rug on someone reloading their tab.
const DISCONNECT_GRACE_MS = 2 * 60 * 1000; // 2 minutes
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;  // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of [...rooms.rooms.entries()]) {
    let hostGone = false;
    const before = room.players.length;
    room.players = room.players.filter((p) => {
      if (p.connected) return true;
      if (!p.disconnectedAt) return true;
      const gone = now - p.disconnectedAt > DISCONNECT_GRACE_MS;
      if (gone && p.id === room.hostId) hostGone = true;
      return !gone;
    });
    if (hostGone && room.players.length > 0) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }
    if (room.players.length === 0) {
      const allDisconnected = before === 0;
      room.emptyAt = room.emptyAt || now;
      if (allDisconnected || now - room.emptyAt > EMPTY_ROOM_TTL_MS) {
        rooms.rooms.delete(code);
      }
    } else {
      delete room.emptyAt;
      io.to(room.code).emit('state', rooms.publicState(room));
    }
  }
}, 30 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ThumbWar running on http://localhost:${PORT}`);
});
