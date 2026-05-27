const { pickRandomPersonas } = require('./personas');
const { pickRandomFormats } = require('./formats');
const { buildAssignments, drawTasksByPlayer } = require('./pairings');
const { zero, scoreMatchups, scoreAwards } = require('./scoring');
const { generateRandomTitle } = require('./randomTitle');

const PHASES = {
  LOBBY: 'lobby',
  WRITING: 'writing',
  DRAWING: 'drawing',
  VOTING: 'voting',
  SCOREBOARD: 'scoreboard',
  BROWSE: 'browse',
  RESULTS: 'results'
};

const DEFAULTS = {
  WRITE_SECONDS: 90,
  DRAW_SECONDS: 180,
  VOTE_SECONDS: 25,
  BROWSE_SECONDS: 60,
  PERSONA_MODE: 'drawer', // 'writer' | 'drawer'
  ROUNDS: 3
};

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genRoomCode(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!existing.has(code)) return code;
  }
  return `R${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  create(hostName) {
    const code = genRoomCode(this.rooms);
    const hostId = uid('p');
    const room = {
      code,
      hostId,
      phase: PHASES.LOBBY,
      players: [
        { id: hostId, name: hostName || 'Host', connected: true, isHost: true, spectator: false }
      ],
      hostDisplays: new Set(),
      config: { ...DEFAULTS },
      timerEndsAt: null,
      timerHandle: null,
      round: null,
      currentRound: 0,
      allMatchupResults: [],
      browse: null,
      scores: {},
      awardResults: null
    };
    this.rooms.set(code, room);
    return { room, hostId };
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase()) || null;
  }

  join(code, name) {
    const room = this.get(code);
    if (!room) return { error: 'Room not found' };
    if (room.phase !== PHASES.LOBBY) {
      return { error: 'Game already in progress' };
    }
    if (room.players.length >= 30) {
      return { error: 'Room is full (max 30)' };
    }
    const trimmed = (name || '').trim().slice(0, 20) || 'Player';
    if (room.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      return { error: 'That name is taken in this room' };
    }
    const id = uid('p');
    room.players.push({
      id,
      name: trimmed,
      connected: true,
      isHost: false,
      spectator: false
    });
    return { room, playerId: id };
  }

  rename(room, playerId, name) {
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    const trimmed = (name || '').trim().slice(0, 20);
    if (trimmed) p.name = trimmed;
  }

  setSpectator(room, playerId, spectator) {
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    p.spectator = !!spectator;
  }

  remove(room, playerId) {
    room.players = room.players.filter((p) => p.id !== playerId);
  }

  // ----- game lifecycle -----

  startGame(room) {
    if (room.phase !== PHASES.LOBBY) return { error: 'Already started' };
    const active = room.players.filter((p) => !p.spectator);
    if (active.length < 1) return { error: 'Need at least 1 player' };

    room.currentRound = 0;
    room.scores = {};
    room.allMatchupResults = [];
    this._startRound(room);
    return { ok: true };
  }

  _startRound(room) {
    const active = room.players.filter((p) => !p.spectator);
    room.phase = PHASES.WRITING;
    room.round = {
      writers: active.map((p) => p.id),
      titles: {}, // writerId -> { id, writerId, persona, format, title }
      drawings: {}, // writerId -> [{ id, writerId, artistId, png }]
      assignments: null,
      suggestions: this._buildSuggestions(active),
      voting: null,
      voteIndex: 0,
      matchupResults: []
    };
    this._startTimer(room, room.config.WRITE_SECONDS, () => this._finishWriting(room));
  }

  _buildSuggestions(players) {
    const out = {};
    for (const p of players) {
      out[p.id] = {
        personas: pickRandomPersonas(5),
        formats: pickRandomFormats(6)
      };
    }
    return out;
  }

  submitTitle(room, playerId, payload) {
    if (room.phase !== PHASES.WRITING) return { error: 'Not in writing phase' };
    const persona = (payload.persona || '').trim().slice(0, 60);
    const title = (payload.title || '').trim().slice(0, 120);
    const format = (payload.format || '').trim().slice(0, 140);
    if (!title) return { error: 'Title required' };
    room.round.titles[playerId] = {
      id: uid('t'),
      writerId: playerId,
      persona: persona || '—',
      format: format || null,
      title
    };
    if (this._allWritersSubmitted(room)) {
      this._finishWriting(room);
    }
    return { ok: true };
  }

  _allWritersSubmitted(room) {
    return room.round.writers.every((id) => room.round.titles[id]);
  }

  _finishWriting(room) {
    if (room.phase !== PHASES.WRITING) return;
    this._clearTimer(room);

    // Generate a random title for any writer who didn't submit.
    for (const id of room.round.writers) {
      if (!room.round.titles[id]) {
        const random = generateRandomTitle();
        room.round.titles[id] = {
          id: uid('t'),
          writerId: id,
          persona: random.persona,
          format: null,
          title: random.title
        };
      }
    }

    const activeIds = room.round.writers;
    room.round.assignments = buildAssignments(activeIds);
    room.round.drawTasks = drawTasksByPlayer(room.round.assignments);
    room.phase = PHASES.DRAWING;
    this._startTimer(room, room.config.DRAW_SECONDS, () => this._finishDrawing(room));
  }

  submitDrawing(room, playerId, writerId, png, persona) {
    if (room.phase !== PHASES.DRAWING) return { error: 'Not in drawing phase' };
    const tasks = (room.round.drawTasks || {})[playerId] || [];
    if (!tasks.includes(writerId)) return { error: 'Not assigned to this title' };
    if (typeof png !== 'string' || !png.startsWith('data:image/')) {
      return { error: 'Invalid image' };
    }
    if (png.length > 1_800_000) return { error: 'Drawing too large' };
    if (!room.round.drawings[writerId]) room.round.drawings[writerId] = [];
    const drawPersona = room.config.PERSONA_MODE === 'drawer'
      ? (persona || '').trim().slice(0, 60) || null
      : null;
    const existing = room.round.drawings[writerId].find(
      (d) => d.artistId === playerId
    );
    if (existing) {
      existing.png = png;
      if (drawPersona) existing.persona = drawPersona;
    } else {
      room.round.drawings[writerId].push({
        id: uid('d'),
        writerId,
        artistId: playerId,
        png,
        persona: drawPersona
      });
    }
    if (this._allDrawingsSubmitted(room)) {
      this._finishDrawing(room);
    }
    return { ok: true };
  }

  _allDrawingsSubmitted(room) {
    for (const [drawerId, writerIds] of Object.entries(room.round.drawTasks || {})) {
      for (const writerId of writerIds) {
        const arr = room.round.drawings[writerId] || [];
        if (!arr.some((d) => d.artistId === drawerId)) return false;
      }
    }
    return true;
  }

  _finishDrawing(room) {
    if (room.phase !== PHASES.DRAWING) return;
    this._clearTimer(room);

    // Build voting queue: one matchup per written title.
    const queue = room.round.writers.map((writerId) => {
      const title = room.round.titles[writerId];
      const thumbs = (room.round.drawings[writerId] || []).slice();
      // Shuffle thumbnail display order for blind voting
      thumbs.sort(() => Math.random() - 0.5);
      return {
        writerId,
        title,
        thumbnails: thumbs,
        votes: {},
        votedBy: new Set()
      };
    });
    room.round.voting = queue;
    room.round.voteIndex = 0;
    room.phase = PHASES.VOTING;
    this._beginCurrentMatchup(room);
  }

  _currentMatchup(room) {
    return room.round.voting[room.round.voteIndex] || null;
  }

  _beginCurrentMatchup(room) {
    const m = this._currentMatchup(room);
    if (!m) {
      this._finishVoting(room);
      return;
    }
    // Clear any previous results on this matchup
    delete m.results;
    // Solo mode: 1 thumbnail, no vote needed — flash the reveal briefly.
    if (m.thumbnails.length <= 1) {
      // Auto-advance after a short reveal delay.
      this._clearTimer(room);
      room.timerEndsAt = Date.now() + 3000;
      room.timerHandle = setTimeout(() => this._advanceMatchup(room), 3000);
      return;
    }
    this._startTimer(room, room.config.VOTE_SECONDS, () =>
      this._advanceMatchup(room)
    );
  }

  submitVote(room, playerId, thumbnailId) {
    if (room.phase !== PHASES.VOTING) return { error: 'Not in voting phase' };
    const m = this._currentMatchup(room);
    if (!m) return { error: 'No active matchup' };
    if (m.votedBy.has(playerId)) return { error: 'Already voted' };
    const target = m.thumbnails.find((t) => t.id === thumbnailId);
    if (!target) return { error: 'Unknown thumbnail' };
    // Players may not vote for their own thumbnail in this matchup.
    if (target.artistId === playerId) return { error: 'Cannot vote for your own thumbnail' };
    m.votes[thumbnailId] = (m.votes[thumbnailId] || 0) + 1;
    m.votedBy.add(playerId);
    if (this._allEligibleVoted(room, m)) {
      this._advanceMatchup(room);
    }
    return { ok: true };
  }

  _allEligibleVoted(room, matchup) {
    const eligible = room.players.filter((p) => {
      if (p.spectator) return false;
      const isArtistInMatchup = matchup.thumbnails.some(
        (t) => t.artistId === p.id
      );
      return !isArtistInMatchup;
    });
    // If no one is eligible (tiny groups), let the timer run out.
    if (eligible.length === 0) return false;
    return eligible.every((p) => matchup.votedBy.has(p.id));
  }

  _advanceMatchup(room) {
    this._clearTimer(room);
    const m = this._currentMatchup(room);
    if (m) {
      // Compute winning thumbnail(s) for this matchup
      let max = -1;
      for (const id of Object.keys(m.votes)) {
        if (m.votes[id] > max) max = m.votes[id];
      }
      const winners = Object.keys(m.votes).filter(
        (id) => m.votes[id] === max && max > 0
      );

      // If results haven't been shown yet, store them and broadcast for 4s
      if (!m.results) {
        m.results = { winners, votes: { ...m.votes } };
        this._broadcastAll(room);
        room.timerEndsAt = Date.now() + 4000;
        room.timerHandle = setTimeout(() => {
          room.timerHandle = null;
          room.timerEndsAt = null;
          // Now actually advance
          room.round.matchupResults.push({
            writerId: m.writerId,
            title: m.title,
            thumbnails: m.thumbnails,
            votes: m.votes,
            winners
          });
          room.round.voteIndex += 1;
          if (room.round.voteIndex >= room.round.voting.length) {
            this._finishVoting(room);
            this._broadcastAll(room);
          } else {
            this._beginCurrentMatchup(room);
          }
        }, 4000);
        return;
      }

      // Results already shown (shouldn't normally reach here, but handle gracefully)
      room.round.matchupResults.push({
        writerId: m.writerId,
        title: m.title,
        thumbnails: m.thumbnails,
        votes: m.votes,
        winners
      });
    }
    room.round.voteIndex += 1;
    if (room.round.voteIndex >= room.round.voting.length) {
      this._finishVoting(room);
      this._broadcastAll(room);
    } else {
      this._beginCurrentMatchup(room);
    }
  }

  _finishVoting(room) {
    this._clearTimer(room);

    // Score this round's matchups, accumulating into room.scores
    const scores = room.scores;
    // Ensure all players have an entry
    for (const p of room.players) {
      if (!(p.id in scores)) scores[p.id] = 0;
    }
    const tallies = room.round.matchupResults.map((r) => ({
      writerId: r.writerId,
      votes: r.votes,
      thumbnails: r.thumbnails
    }));
    scoreMatchups(tallies, scores);

    // Accumulate this round's matchup results for cross-round stats
    room.allMatchupResults.push(...room.round.matchupResults);

    // Show scoreboard between rounds (or before browse on final round)
    room.phase = PHASES.SCOREBOARD;
    room.scoreboard = {
      scores: { ...room.scores },
      roundJustFinished: room.currentRound + 1,
      totalRounds: room.config.ROUNDS,
      isLastRound: room.currentRound >= room.config.ROUNDS - 1
    };
    this._startTimer(room, 8, () => this._finishScoreboard(room));
  }

  _finishScoreboard(room) {
    if (room.phase !== PHASES.SCOREBOARD) return;
    this._clearTimer(room);

    if (!room.scoreboard.isLastRound) {
      room.currentRound += 1;
      this._startRound(room);
      this._broadcastAll(room);
      return;
    }

    // Last round — build browse page from ALL rounds' matchup results
    const concepts = room.allMatchupResults.map((r) => {
      let winnerId = r.winners[0];
      if (!winnerId && r.thumbnails.length > 0) winnerId = r.thumbnails[0].id;
      const winningThumb = r.thumbnails.find((t) => t.id === winnerId) || r.thumbnails[0] || null;
      return {
        id: uid('c'),
        writerId: r.writerId,
        artistId: winningThumb ? winningThumb.artistId : null,
        title: r.title,
        thumbnail: winningThumb,
        allThumbnails: r.thumbnails,
        matchupVotes: r.votes
      };
    });

    room.browse = {
      concepts,
      votes: { bestThumb: {}, bestTitle: {} },
      votedBy: { bestThumb: new Set(), bestTitle: new Set() }
    };
    room.phase = PHASES.BROWSE;
    this._startTimer(room, room.config.BROWSE_SECONDS, () => this._finishBrowse(room));
  }

  submitBrowseVote(room, playerId, category, conceptId) {
    if (room.phase !== PHASES.BROWSE) return { error: 'Not in browse phase' };
    if (!room.browse.votes[category]) return { error: 'Unknown category' };
    if (room.browse.votedBy[category].has(playerId)) {
      const prev = room.browse.votedByChoice?.[category]?.[playerId];
      if (prev) {
        room.browse.votes[category][prev] = Math.max(0, (room.browse.votes[category][prev] || 0) - 1);
      }
    }
    const concept = room.browse.concepts.find((c) => c.id === conceptId);
    if (!concept) return { error: 'Unknown concept' };
    if (category === 'bestThumb' && concept.artistId === playerId) {
      return { error: 'You can\'t vote for your own thumbnail' };
    }
    if (category === 'bestTitle' && concept.writerId === playerId) {
      return { error: 'You can\'t vote for your own title' };
    }
    room.browse.votes[category][conceptId] =
      (room.browse.votes[category][conceptId] || 0) + 1;
    room.browse.votedBy[category].add(playerId);
    room.browse.votedByChoice = room.browse.votedByChoice || { bestThumb: {}, bestTitle: {} };
    room.browse.votedByChoice[category][playerId] = conceptId;

    const active = room.players.filter((p) => !p.spectator);
    const allDone = ['bestThumb', 'bestTitle'].every((cat) =>
      active.every((p) => room.browse.votedBy[cat].has(p.id))
    );
    if (allDone) this._finishBrowse(room);
    return { ok: true };
  }

  _finishBrowse(room) {
    this._clearTimer(room);
    // Scores were already accumulated across rounds in _finishVoting
    const scores = room.scores;

    // Score awards
    const awardResults = scoreAwards(
      room.browse.votes,
      room.browse.concepts.map((c) => ({
        id: c.id,
        writerId: c.writerId,
        artistId: c.artistId
      })),
      scores
    );

    // Compute per-player stats for the awards reveal
    const stats = this._computeStats(room, scores);
    const funAwards = this._computeFunAwards(room, stats);

    room.scores = scores;
    room.awardResults = {
      awardResults,
      stats,
      funAwards,
      champion: this._pickChampion(scores),
      concepts: room.browse.concepts
    };
    room.phase = PHASES.RESULTS;
  }

  _computeStats(room, scores) {
    const stats = {};
    for (const p of room.players) {
      stats[p.id] = {
        id: p.id,
        name: p.name,
        score: scores[p.id] || 0,
        matchupsWon: 0,
        matchupsEntered: 0,
        totalClicks: 0,
        unanimousTitles: 0
      };
    }
    for (const r of room.allMatchupResults) {
      let max = -1;
      for (const id of Object.keys(r.votes)) {
        if (r.votes[id] > max) max = r.votes[id];
      }
      let totalVotes = 0;
      for (const id of Object.keys(r.votes)) totalVotes += r.votes[id];
      for (const thumb of r.thumbnails) {
        if (!stats[thumb.artistId]) continue;
        stats[thumb.artistId].matchupsEntered += 1;
        const v = r.votes[thumb.id] || 0;
        stats[thumb.artistId].totalClicks += v;
        if (max > 0 && v === max) stats[thumb.artistId].matchupsWon += 1;
      }
      if (r.thumbnails.length >= 2 && totalVotes > 0) {
        const winners = Object.keys(r.votes).filter(
          (id) => r.votes[id] === max && max > 0
        );
        if (winners.length === 1) {
          const onlyOne = Object.keys(r.votes).every(
            (id) => id === winners[0] || (r.votes[id] || 0) === 0
          );
          if (onlyOne && stats[r.writerId]) {
            stats[r.writerId].unanimousTitles += 1;
          }
        }
      }
    }
    return stats;
  }

  _computeFunAwards(room, stats) {
    const players = Object.values(stats);
    if (players.length === 0) return {};
    const top = (getter) => {
      let best = -Infinity;
      let winner = null;
      for (const p of players) {
        const v = getter(p);
        if (v > best) {
          best = v;
          winner = p;
        }
      }
      return best > 0 ? winner : null;
    };
    return {
      mostClickableArtist: top((p) => p.matchupsWon),
      bestThumbnailArtist: top((p) => p.totalClicks),
      bestTitleWriter: top((p) => p.unanimousTitles)
    };
  }

  _pickChampion(scores) {
    let best = -Infinity;
    let winner = null;
    for (const [pid, s] of Object.entries(scores)) {
      if (s > best) {
        best = s;
        winner = pid;
      }
    }
    return winner;
  }

  // Optional: host can manually advance from the results screen back to lobby.
  restart(room) {
    room.phase = PHASES.LOBBY;
    room.round = null;
    room.currentRound = 0;
    room.browse = null;
    room.scores = {};
    room.allMatchupResults = [];
    room.awardResults = null;
    this._clearTimer(room);
  }

  // ----- timer -----

  _startTimer(room, seconds, callback) {
    this._clearTimer(room);
    room.timerEndsAt = Date.now() + seconds * 1000;
    room.timerHandle = setTimeout(() => {
      room.timerHandle = null;
      room.timerEndsAt = null;
      try {
        callback();
      } catch (e) {
        console.error('Timer callback error', e);
      }
      this._broadcastAll(room);
    }, seconds * 1000);
  }

  _broadcastAll(room) {
    this.io.to(room.code).emit('state', this.publicState(room));
    for (const p of room.players) {
      if (p.socketId) {
        this.io.to(p.socketId).emit('private', this.privateView(room, p.id));
      }
    }
  }

  _clearTimer(room) {
    if (room.timerHandle) clearTimeout(room.timerHandle);
    room.timerHandle = null;
    room.timerEndsAt = null;
  }

  // ----- serialization -----

  publicState(room) {
    const base = {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.isHost,
        spectator: p.spectator
      })),
      timerEndsAt: room.timerEndsAt,
      config: room.config,
      currentRound: room.currentRound || 0,
      totalRounds: room.config.ROUNDS || 1
    };
    if (room.phase === PHASES.WRITING) {
      base.writing = {
        submitted: Object.keys(room.round.titles)
      };
    }
    if (room.phase === PHASES.DRAWING) {
      const submittedByDrawer = {};
      for (const [drawerId, writerIds] of Object.entries(room.round.drawTasks || {})) {
        submittedByDrawer[drawerId] = [];
        for (const writerId of writerIds) {
          const arr = room.round.drawings[writerId] || [];
          if (arr.some((d) => d.artistId === drawerId)) {
            submittedByDrawer[drawerId].push(writerId);
          }
        }
      }
      base.drawing = {
        totalTasks: Object.values(room.round.drawTasks || {}).reduce(
          (s, arr) => s + arr.length,
          0
        ),
        submittedByDrawer
      };
    }
    if (room.phase === PHASES.SCOREBOARD) {
      base.scoreboard = room.scoreboard;
    }
    if (room.phase === PHASES.VOTING) {
      const m = this._currentMatchup(room);
      base.voting = {
        index: room.round.voteIndex,
        total: room.round.voting.length,
        matchup: m
          ? {
              writerId: m.writerId,
              title: m.title,
              thumbnails: m.thumbnails.map((t) => ({
                id: t.id,
                png: t.png,
                persona: t.persona || null
              })),
              votedBy: [...m.votedBy],
              results: m.results || null
            }
          : null
      };
    }
    if (room.phase === PHASES.BROWSE) {
      base.browse = {
        concepts: room.browse.concepts.map((c) => ({
          id: c.id,
          writerId: c.writerId,
          artistId: c.artistId,
          title: c.title,
          thumbnail: c.thumbnail ? { id: c.thumbnail.id, png: c.thumbnail.png } : null
        })),
        votedBy: {
          bestThumb: [...room.browse.votedBy.bestThumb],
          bestTitle: [...room.browse.votedBy.bestTitle]
        }
      };
    }
    if (room.phase === PHASES.RESULTS) {
      base.results = {
        scores: room.scores,
        stats: room.awardResults.stats,
        funAwards: room.awardResults.funAwards,
        awardResults: room.awardResults.awardResults,
        concepts: room.awardResults.concepts.map((c) => ({
          id: c.id,
          writerId: c.writerId,
          artistId: c.artistId,
          title: c.title,
          thumbnail: c.thumbnail ? { id: c.thumbnail.id, png: c.thumbnail.png } : null,
          allThumbnails: c.allThumbnails.map((t) => ({
            id: t.id,
            artistId: t.artistId,
            png: t.png
          }))
        })),
        champion: room.awardResults.champion
      };
    }
    return base;
  }

  // Private view for a single player (includes their secrets: assigned titles, etc.)
  privateView(room, playerId) {
    const view = {};
    if (!room.round) return view;
    if (room.phase === PHASES.WRITING && room.round.suggestions[playerId]) {
      view.suggestions = room.round.suggestions[playerId];
      view.myTitle = room.round.titles[playerId] || null;
    }
    if (room.phase === PHASES.DRAWING) {
      const taskWriterIds = (room.round.drawTasks || {})[playerId] || [];
      view.tasks = taskWriterIds.map((wid) => {
        const existing = (room.round.drawings[wid] || []).find(
          (d) => d.artistId === playerId
        );
        return {
          writerId: wid,
          title: room.round.titles[wid],
          submitted: !!existing,
          myPersona: existing?.persona || null
        };
      });
      if (room.config.PERSONA_MODE === 'drawer') {
        view.personaSuggestions = pickRandomPersonas(5);
      }
    }
    return view;
  }
}

module.exports = { RoomManager, PHASES };
