const { pickRandomPersonas } = require('./personas');
const { pickRandomFormats } = require('./formats');
const { buildAssignments, drawTasksByPlayer } = require('./pairings');
const { zero, scoreMatchups, scoreAwards } = require('./scoring');
const { generateRandomTitle } = require('./randomTitle');
const hall = require('./hall');

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
  WRITE_SECONDS: 45,
  DRAW_SECONDS: 180,
  VOTE_SECONDS: 25,
  BROWSE_SECONDS: 30,
  ROUNDS: 3,
  // 2 = 1v1 matchups, 3 = three-way. Three-way only kicks in with enough
  // players that each matchup still has several voters.
  MATCHUP_SIZE: 2,
  // Off unless the host opts in: winners appear on the public homepage.
  SHARE_HALL: false
};

// How long the winner reveal stays on screen between matchups.
const REVEAL_MS = 3500;
// A matchup nobody is able to vote on (everyone left is one of its artists)
// is still shown briefly instead of waiting out the full vote timer.
const NO_VOTERS_SECONDS = 5;
// Three-way matchups need this many drawers; below it a round uses 1v1.
const MIN_PLAYERS_THREE_WAY = 6;

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
      awardResults: null,
      // Drawings are served over HTTP (/img/CODE/ID) instead of being embedded
      // in every state broadcast, which made each update several megabytes.
      images: new Map(),
      // Names of everyone who has been in the room, so scores and galleries
      // still show a name after someone leaves.
      names: { [hostId]: hostName || 'Host' }
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
    room.names[id] = trimmed;
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
    if (trimmed) { p.name = trimmed; room.names[playerId] = trimmed; }
  }

  setSpectator(room, playerId, spectator) {
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    p.spectator = !!spectator;
  }

  remove(room, playerId) {
    room.players = room.players.filter((p) => p.id !== playerId);
  }

  // Players who are active (not spectator) and currently connected.
  _connectedActive(room) {
    return room.players.filter((p) => !p.spectator && p.connected);
  }

  // ----- game lifecycle -----

  startGame(room) {
    if (room.phase !== PHASES.LOBBY) return { error: 'Already started' };
    const active = this._connectedActive(room);
    if (active.length < 1) return { error: 'Need at least 1 connected player' };

    room.currentRound = 0;
    room.scores = {};
    room.allMatchupResults = [];
    this._startRound(room);
    return { ok: true };
  }

  _startRound(room) {
    const active = this._connectedActive(room);
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
      // The writer picks the creator; leaving it blank gets a random one.
      persona: persona || pickRandomPersonas(1)[0],
      format: format || null,
      title
    };
    if (this._allWritersSubmitted(room)) {
      this._finishWriting(room);
    }
    return { ok: true };
  }

  _allWritersSubmitted(room) {
    const connected = new Set(this._connectedActive(room).map((p) => p.id));
    return room.round.writers
      .filter((id) => connected.has(id))
      .every((id) => room.round.titles[id]);
  }

  _finishWriting(room) {
    if (room.phase !== PHASES.WRITING) return;
    this._clearTimer(room);

    // Generate a random title for any writer who didn't submit but is still
    // here. Writers who left without submitting are dropped from the round.
    const connected = new Set(this._connectedActive(room).map((p) => p.id));
    for (const id of room.round.writers) {
      if (!room.round.titles[id] && connected.has(id)) {
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

    // Every title gets a matchup; whoever is still connected does the drawing.
    const titleWriters = room.round.writers.filter((id) => room.round.titles[id]);
    const drawers = room.round.writers.filter((id) => connected.has(id));
    const size = room.config.MATCHUP_SIZE === 3 && drawers.length >= MIN_PLAYERS_THREE_WAY ? 3 : 2;
    room.round.matchupSize = size;
    room.round.assignments = buildAssignments(titleWriters, drawers, { size });
    room.round.drawTasks = drawTasksByPlayer(room.round.assignments);
    room.phase = PHASES.DRAWING;
    this._startTimer(room, room.config.DRAW_SECONDS, () => this._finishDrawing(room));
  }

  submitDrawing(room, playerId, writerId, png) {
    if (room.phase !== PHASES.DRAWING) return { error: 'Not in drawing phase' };
    const tasks = (room.round.drawTasks || {})[playerId] || [];
    if (!tasks.includes(writerId)) return { error: 'Not assigned to this title' };
    if (typeof png !== 'string' || !png.startsWith('data:image/')) {
      return { error: 'Invalid image' };
    }
    if (png.length > 1_800_000) return { error: 'Drawing too large' };
    if (!room.round.drawings[writerId]) room.round.drawings[writerId] = [];
    const existing = room.round.drawings[writerId].find(
      (d) => d.artistId === playerId
    );
    if (existing) {
      existing.png = png;
      room.images.set(existing.id, png);
    } else {
      const drawing = { id: uid('d'), writerId, artistId: playerId, png };
      room.round.drawings[writerId].push(drawing);
      room.images.set(drawing.id, png);
    }
    if (this._allDrawingsSubmitted(room)) {
      this._finishDrawing(room);
    }
    return { ok: true };
  }

  _allDrawingsSubmitted(room) {
    const connected = new Set(this._connectedActive(room).map((p) => p.id));
    for (const [drawerId, writerIds] of Object.entries(room.round.drawTasks || {})) {
      if (!connected.has(drawerId)) continue;
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

    // Build voting queue — only for titles that have at least 1 thumbnail.
    // Titles with no submissions (all assigned drawers dropped) are skipped.
    const queue = [];
    for (const writerId of Object.keys(room.round.assignments || {})) {
      const title = room.round.titles[writerId];
      if (!title) continue;
      const thumbs = (room.round.drawings[writerId] || []).slice();
      if (thumbs.length === 0) continue;
      thumbs.sort(() => Math.random() - 0.5);
      queue.push({
        writerId,
        title,
        thumbnails: thumbs,
        votes: {},
        votedBy: new Set()
      });
    }
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
      this._startTimer(room, 3, () => {
        room.round.matchupResults.push({
          writerId: m.writerId,
          title: m.title,
          thumbnails: m.thumbnails,
          votes: m.votes,
          winners: m.thumbnails[0] ? [m.thumbnails[0].id] : []
        });
        this._nextMatchupOrFinish(room);
      });
      this._broadcastAll(room);
      return;
    }
    // Add the card-reveal animation to the clock so it doesn't eat into
    // voting time (matches ThumbFx.revealDelays on the clients).
    const revealSeconds = (m.thumbnails.length - 1) * 0.45 + 0.5;
    const seconds = (this._eligibleVoters(room, m).length === 0
      ? Math.min(NO_VOTERS_SECONDS, room.config.VOTE_SECONDS)
      : room.config.VOTE_SECONDS) + revealSeconds;
    this._startTimer(room, seconds, () => this._advanceMatchup(room));
    // Broadcast immediately so the client sees the new matchup + timer.
    // Without this, the client stays on the previous matchup's expired
    // timer until someone votes or the next timer fires.
    this._broadcastAll(room);
  }

  submitVote(room, playerId, thumbnailId) {
    if (room.phase !== PHASES.VOTING) return { error: 'Not in voting phase' };
    const m = this._currentMatchup(room);
    if (!m) return { error: 'No active matchup' };
    // Reveal in progress — voting is closed for this matchup.
    if (m.results) return { error: 'Voting closed for this matchup' };
    if (m.votedBy.has(playerId)) return { error: 'Already voted' };
    const target = m.thumbnails.find((t) => t.id === thumbnailId);
    if (!target) return { error: 'Unknown thumbnail' };
    // Artists in this matchup sit it out entirely — voting for a rival's
    // thumbnail would let them knock out the strongest competitor.
    if (target.artistId === playerId) return { error: 'Cannot vote for your own thumbnail' };
    if (m.thumbnails.some((t) => t.artistId === playerId)) {
      return { error: 'You drew one of these — the others are voting' };
    }
    m.votes[thumbnailId] = (m.votes[thumbnailId] || 0) + 1;
    m.votedBy.add(playerId);
    // Broadcast so everyone sees the updated tally / "waiting" state.
    this._broadcastAll(room);
    if (this._allEligibleVoted(room, m)) {
      this._advanceMatchup(room);
    }
    return { ok: true };
  }

  // Connected players who can vote on this matchup (anyone who didn't draw
  // one of its thumbnails — including the title's writer).
  _eligibleVoters(room, matchup) {
    return room.players.filter((p) => {
      if (p.spectator || !p.connected) return false;
      return !matchup.thumbnails.some((t) => t.artistId === p.id);
    });
  }

  _allEligibleVoted(room, matchup) {
    const eligible = this._eligibleVoters(room, matchup);
    // Nobody left who can vote (e.g. voters dropped out) — don't hang.
    if (eligible.length === 0) return true;
    return eligible.every((p) => matchup.votedBy.has(p.id));
  }

  // Called when voting ends for the current matchup (timer expiry or all
  // eligible players voted). Locks in results, shows the reveal, then
  // schedules the move to the next matchup.
  _advanceMatchup(room) {
    const m = this._currentMatchup(room);
    if (!m) {
      this._clearTimer(room);
      this._nextMatchupOrFinish(room);
      return;
    }
    // Already revealing — ignore duplicate calls.
    if (m.results) return;

    this._clearTimer(room);

    let max = -1;
    for (const id of Object.keys(m.votes)) {
      if (m.votes[id] > max) max = m.votes[id];
    }
    const winners = Object.keys(m.votes).filter(
      (id) => m.votes[id] === max && max > 0
    );
    m.results = { winners, votes: { ...m.votes } };

    // Show the reveal for a fixed window, then advance.
    this._startTimer(room, REVEAL_MS / 1000, () => {
      room.round.matchupResults.push({
        writerId: m.writerId,
        title: m.title,
        thumbnails: m.thumbnails,
        votes: m.votes,
        winners
      });
      this._nextMatchupOrFinish(room);
    });
    this._broadcastAll(room);
  }

  _nextMatchupOrFinish(room) {
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
    const prevScores = { ...scores };
    scoreMatchups(tallies, scores);
    const deltas = {};
    for (const id of Object.keys(scores)) {
      deltas[id] = (scores[id] || 0) - (prevScores[id] || 0);
    }

    // Accumulate this round's matchup results for cross-round stats
    room.allMatchupResults.push(...room.round.matchupResults);

    // Show scoreboard between rounds (or before browse on final round)
    room.phase = PHASES.SCOREBOARD;
    room.scoreboard = {
      scores: { ...room.scores },
      deltas,
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
        // Only matchup winners compete for Best Thumbnail; showing every
        // thumbnail made the browse page hundreds of cards long.
        browseThumbnails: r.winners.length
          ? r.thumbnails.filter((t) => r.winners.includes(t.id))
          : r.thumbnails.slice(0, 1),
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

  submitBrowseVote(room, playerId, category, targetId) {
    if (room.phase !== PHASES.BROWSE) return { error: 'Not in browse phase' };
    if (!room.browse.votes[category]) return { error: 'Unknown category' };
    if (room.browse.votedBy[category].has(playerId)) {
      const prev = room.browse.votedByChoice?.[category]?.[playerId];
      if (prev) {
        room.browse.votes[category][prev] = Math.max(0, (room.browse.votes[category][prev] || 0) - 1);
      }
    }
    if (category === 'bestThumb') {
      // Vote is per-thumbnail. Find the thumbnail across all concepts.
      let foundThumb = null;
      let foundConcept = null;
      for (const c of room.browse.concepts) {
        const t = (c.browseThumbnails || c.allThumbnails || []).find((x) => x.id === targetId);
        if (t) { foundThumb = t; foundConcept = c; break; }
      }
      if (!foundThumb) return { error: 'Unknown thumbnail' };
      if (foundThumb.artistId === playerId) {
        return { error: 'You can\'t vote for your own thumbnail' };
      }
    } else if (category === 'bestTitle') {
      const concept = room.browse.concepts.find((c) => c.id === targetId);
      if (!concept) return { error: 'Unknown concept' };
      if (concept.writerId === playerId) {
        return { error: 'You can\'t vote for your own title' };
      }
    }
    room.browse.votes[category][targetId] =
      (room.browse.votes[category][targetId] || 0) + 1;
    room.browse.votedBy[category].add(playerId);
    room.browse.votedByChoice = room.browse.votedByChoice || { bestThumb: {}, bestTitle: {} };
    room.browse.votedByChoice[category][playerId] = targetId;

    const active = this._connectedActive(room);
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
        artistId: c.artistId,
        allThumbnails: c.allThumbnails || []
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
    if (room.config.SHARE_HALL) this._addToHall(room, awardResults);
  }

  // Feature this game's Best Thumbnail (or, failing that, the most-voted
  // matchup thumbnail) in the homepage Hall of Thumbs.
  _addToHall(room, awardResults) {
    const concepts = room.browse.concepts;
    let concept = null;
    let thumb = null;
    const awardId = awardResults?.bestThumb?.winners?.[0];
    if (awardId) {
      for (const c of concepts) {
        const t = (c.allThumbnails || []).find((x) => x.id === awardId);
        if (t) { concept = c; thumb = t; break; }
      }
    }
    if (!thumb) {
      let best = 0;
      for (const c of concepts) {
        for (const t of c.allThumbnails || []) {
          const v = (c.matchupVotes || {})[t.id] || 0;
          if (v > best) { best = v; concept = c; thumb = t; }
        }
      }
    }
    if (!thumb) return;
    const nameOf = (id) => room.players.find((p) => p.id === id)?.name || 'Someone';
    try {
      hall.add({
        png: thumb.png,
        title: concept.title.title,
        creator: concept.title.persona,
        writer: nameOf(concept.writerId),
        artist: nameOf(thumb.artistId)
      });
    } catch (e) {
      console.error('Hall of Thumbs: add failed', e);
    }
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
    room.images = new Map();
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

  getImage(room, id) {
    return room.images.get(id) || null;
  }

  _imgUrl(room, t) {
    return `/img/${room.code}/${t.id}`;
  }

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
      serverNow: Date.now(),
      hasDisplay: room.hostDisplays.size > 0,
      names: room.names,
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
      const assignedByDrawer = {};
      for (const [drawerId, writerIds] of Object.entries(room.round.drawTasks || {})) {
        assignedByDrawer[drawerId] = writerIds.length;
      }
      base.drawing = {
        assignedByDrawer,
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
              // Who drew what stays secret until the results are revealed.
              thumbnails: m.thumbnails.map((t) => ({
                id: t.id,
                png: this._imgUrl(room, t),
                ...(m.results ? { artistId: t.artistId } : {})
              })),
              votedBy: [...m.votedBy],
              eligibleCount: this._eligibleVoters(room, m).length,
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
          thumbnail: c.thumbnail ? { id: c.thumbnail.id, png: this._imgUrl(room, c.thumbnail) } : null,
          allThumbnails: (c.browseThumbnails || c.allThumbnails || []).map((t) => ({
            id: t.id,
            artistId: t.artistId,
            png: this._imgUrl(room, t)
          }))
        })),
        eligibleCount: this._connectedActive(room).length,
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
          thumbnail: c.thumbnail ? { id: c.thumbnail.id, png: this._imgUrl(room, c.thumbnail) } : null,
          matchupVotes: c.matchupVotes || {},
          allThumbnails: c.allThumbnails.map((t) => ({
            id: t.id,
            artistId: t.artistId,
            png: this._imgUrl(room, t)
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
          submitted: !!existing
        };
      });
    }
    if (room.phase === PHASES.VOTING) {
      // Which thumbnails in the current matchup are this player's own, so
      // the client can disable those vote buttons without revealing artists.
      const m = this._currentMatchup(room);
      view.myThumbnailIds = m
        ? m.thumbnails.filter((t) => t.artistId === playerId).map((t) => t.id)
        : [];
    }
    if (room.phase === PHASES.BROWSE && room.browse) {
      const choice = room.browse.votedByChoice || {};
      view.myBrowseVotes = {
        bestThumb: choice.bestThumb?.[playerId] || null,
        bestTitle: choice.bestTitle?.[playerId] || null
      };
    }
    return view;
  }
}

module.exports = { RoomManager, PHASES, MIN_PLAYERS_THREE_WAY };
