const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { RoomManager, PHASES } = require('./src/rooms');
const { generateRandomTitle } = require('./src/randomTitle');
const hall = require('./src/hall');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 4e6
});

app.use(express.json({ limit: '4mb' }));
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
app.get('/api/random-title', (_req, res) => res.json(generateRandomTitle()));
app.get('/api/hall', (_req, res) => res.json(hall.list()));
// Drawings for a room, by id. Ids are random and change per drawing, so the
// browser can cache them; room codes are already the access control.
app.get('/img/:code/:id', (req, res) => {
  const room = rooms.get(req.params.code);
  const data = room && rooms.getImage(room, req.params.id);
  const m = data && /^data:(image\/[a-z]+);base64,(.+)$/.exec(data);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(m[2], 'base64'));
});
app.use('/hall-images', express.static(hall.HALL_DIR, { maxAge: '7d' }));

const rooms = new RoomManager(io);
// How long writing/drawing waits for a dropped phone to come back before
// carrying on without it.
const RECONNECT_GRACE_MS = 15 * 1000;

function broadcastState(room) {
  io.to(room.code).emit('state', rooms.publicState(room));
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('private', rooms.privateView(room, p.id));
    }
  }
}

io.on('connection', (socket) => {
  // Any message from a player proves this socket is live: make sure the room
  // treats them as connected on it (belt and braces for the race above).
  socket.use((_packet, next) => {
    const room = socket.data.roomCode && rooms.get(socket.data.roomCode);
    const p = room && room.players.find((x) => x.id === socket.data.playerId);
    if (p && (p.socketId !== socket.id || !p.connected)) {
      p.socketId = socket.id;
      p.connected = true;
      delete p.disconnectedAt;
    }
    next();
  });
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
    rooms.ensureInRound(room, playerId);
    cb({ ok: true });
    broadcastState(room);
  });

  // A TV / screen-share display. If a player turned their own device into
  // the TV (playerId given), the display takes over that player's identity:
  // they become a spectator, and if they're the host they keep host controls
  // (start / play again) from the TV.
  socket.on('host-display', ({ code, playerId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isHostDisplay = true;
    room.hostDisplays.add(socket.id);
    const p = playerId && room.players.find((x) => x.id === playerId);
    if (p) {
      socket.data.playerId = p.id;
      p.socketId = socket.id;
      p.connected = true;
      delete p.disconnectedAt;
      if (room.phase === 'lobby') p.spectator = true;
    }
    cb({ ok: true, isHost: !!p && room.hostId === p.id });
    // Phones go quiet once a TV display is connected, so tell everyone.
    broadcastState(room);
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

  socket.on('set-timers', (cfg, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    if (room.hostId !== socket.data.playerId) return cb && cb({ error: 'Host only' });
    if (room.phase !== 'lobby') return cb && cb({ error: 'Only in lobby' });
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || lo));
    if (cfg.write) room.config.WRITE_SECONDS = clamp(cfg.write, 30, 300);
    if (cfg.draw) room.config.DRAW_SECONDS = clamp(cfg.draw, 60, 600);
    if (cfg.vote) room.config.VOTE_SECONDS = clamp(cfg.vote, 10, 120);
    if (cfg.browse) room.config.BROWSE_SECONDS = clamp(cfg.browse, 15, 180);
    if (typeof cfg.hall === 'boolean') room.config.SHARE_HALL = cfg.hall;
    if (cfg.matchup) room.config.MATCHUP_SIZE = String(cfg.matchup) === '3' ? 3 : 2;
    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('set-rounds', ({ rounds }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: 'No room' });
    if (room.hostId !== socket.data.playerId) return cb && cb({ error: 'Host only' });
    if (room.phase !== 'lobby') return cb && cb({ error: 'Only in lobby' });
    const clamped = Math.max(1, Math.min(5, parseInt(rounds, 10) || 3));
    room.config.ROUNDS = clamped;
    cb && cb({ ok: true });
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

  socket.on('submit-drawing', ({ writerId, png, persona }, cb) => {
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
      // A player's own device acting as the TV went away: treat them as gone
      // so host handover and cleanup still work.
      const tvPlayer = room.players.find((x) => x.id === socket.data.playerId);
      if (tvPlayer && tvPlayer.socketId === socket.id) {
        tvPlayer.connected = false;
        tvPlayer.socketId = null;
        tvPlayer.disconnectedAt = Date.now();
      }
      broadcastState(room);
      return;
    }
    const p = room.players.find((x) => x.id === socket.data.playerId);
    // Phones drop and reconnect constantly (switching apps, screen lock). The
    // new connection usually resumes before the server notices the old one
    // died, so only mark the player offline if this was their current socket.
    // Otherwise a late disconnect knocked live players offline: no private
    // data (suggestions, drawing tasks) and no drawing assignments.
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    p.disconnectedAt = Date.now();
    // Don't immediately remove the player — page navigations (landing -> /play)
    // disconnect briefly. The cleanup sweep will remove truly stale players.
    //
    // Re-check phase completion: if a disconnected player was the one everyone
    // was waiting on, the game should advance rather than hang. For writing
    // and drawing, wait a little first: phones drop for a few seconds when
    // you switch apps, and advancing instantly threw away their work.
    const phaseAtDrop = room.phase;
    const roundAtDrop = room.currentRound;
    if ((phaseAtDrop === 'writing' || phaseAtDrop === 'drawing') && room.round) {
      setTimeout(() => {
        if (room.phase !== phaseAtDrop || room.currentRound !== roundAtDrop || p.connected) return;
        if (phaseAtDrop === 'writing' && rooms._allWritersSubmitted(room)) rooms._finishWriting(room);
        if (phaseAtDrop === 'drawing' && rooms._allDrawingsSubmitted(room)) rooms._finishDrawing(room);
        broadcastState(room);
      }, RECONNECT_GRACE_MS);
    }
    if (room.phase === 'voting' && room.round) {
      const m = rooms._currentMatchup(room);
      if (m && rooms._allEligibleVoted(room, m)) rooms._advanceMatchup(room);
    }
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
