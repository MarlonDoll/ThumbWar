(function () {
  const socket = io();
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('code') || '').toUpperCase();

  if (!code) {
    window.location.href = '/';
    return;
  }

  const app = document.getElementById('host-app');
  const timerPill = document.getElementById('timer-pill');
  const roomPill = document.getElementById('room-code-pill');
  roomPill.textContent = code;

  let state = { public: null };
  // What the TV has already announced, so re-renders on every broadcast
  // don't replay sounds and entrance animations.
  const seen = { matchup: null, reveal: null, scoreboard: null, results: false };

  const soundBtn = document.getElementById('sound-toggle');
  function refreshSoundBtn() {
    const on = ThumbFx.isUnlocked() && !ThumbFx.isMuted();
    soundBtn.textContent = on ? '🔊 Sound on' : (ThumbFx.isMuted() ? '🔇 Sound off' : '🔇 Tap to enable sound');
    soundBtn.classList.toggle('needs-tap', !ThumbFx.isUnlocked());
  }
  soundBtn.onclick = () => {
    // The page-wide gesture listener unlocks audio on pointerdown, before this
    // click runs, so decide from what the button was showing, not the context.
    if (soundBtn.classList.contains('needs-tap')) { ThumbFx.unlock(); ThumbFx.setMuted(false); }
    else ThumbFx.setMuted(!ThumbFx.isMuted());
    setTimeout(refreshSoundBtn, 100);
  };
  refreshSoundBtn();
  setInterval(refreshSoundBtn, 1000);

  socket.on('connect', () => {
    socket.emit('host-display', { code }, (res) => {
      if (res.error) {
        alert(res.error);
        window.location.href = '/';
      }
    });
  });
  socket.on('state', (pub) => {
    state.public = pub;
    if (typeof pub.serverNow === 'number') {
      state.clockOffset = pub.serverNow - Date.now();
    }
    render();
  });

  function render() {
    const p = state.public;
    if (!p) return;
    if (p.phase !== 'results') seen.results = false;
    if (p.phase === 'lobby') return renderLobby();
    if (p.phase === 'writing') return renderWriting();
    if (p.phase === 'drawing') return renderDrawing();
    if (p.phase === 'voting') return renderVoting();
    if (p.phase === 'scoreboard') return renderScoreboard();
    if (p.phase === 'browse') return renderBrowse();
    if (p.phase === 'results') return renderResults();
  }

  function useTpl(id) {
    const tpl = document.getElementById(id);
    app.innerHTML = '';
    app.appendChild(tpl.content.cloneNode(true));
  }

  function renderLobby() {
    useTpl('host-tpl-lobby');
    document.getElementById('big-code').textContent = state.public.code;
    const grid = document.getElementById('host-players');
    grid.innerHTML = '';
    for (const pl of state.public.players) {
      const el = document.createElement('div');
      el.className = 'player-tile';
      el.innerHTML = `<span class="player-name">${escapeHtml(pl.name)}</span>
        ${pl.isHost ? '<span class="badge">host</span>' : ''}
        ${pl.spectator ? '<span class="badge muted">spectator</span>' : ''}`;
      grid.appendChild(el);
    }
  }

  function renderWriting() {
    useTpl('host-tpl-writing');
    const tracker = document.getElementById('host-submit-tracker');
    const submitted = new Set(state.public.writing?.submitted || []);
    const active = state.public.players.filter((p) => !p.spectator);
    for (const p of active) {
      const el = document.createElement('div');
      el.className = 'submit-row';
      el.innerHTML = `
        <span class="dot ${submitted.has(p.id) ? 'done' : ''}"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="status">${submitted.has(p.id) ? '✓ title in' : 'writing…'}</span>
      `;
      tracker.appendChild(el);
    }
  }

  function renderDrawing() {
    useTpl('host-tpl-drawing');
    const tracker = document.getElementById('host-draw-tracker');
    const d = state.public.drawing || {};
    const submittedByDrawer = d.submittedByDrawer || {};
    const active = state.public.players.filter((p) => !p.spectator);
    for (const p of active) {
      const mine = submittedByDrawer[p.id] || [];
      const assignedCount = countAssigned(p.id);
      if (!assignedCount) continue;
      const el = document.createElement('div');
      el.className = 'submit-row';
      el.innerHTML = `
        <span class="dot ${mine.length === assignedCount && assignedCount > 0 ? 'done' : ''}"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="status">${mine.length}/${assignedCount} thumbnails</span>
      `;
      tracker.appendChild(el);
    }
  }

  function countAssigned(playerId) {
    return state.public.drawing?.assignedByDrawer?.[playerId] || 0;
  }


  function nameOf(id) {
    const p = state.public.players.find((x) => x.id === id);
    return p ? p.name : (state.public.names?.[id] || 'Unknown');
  }

  function renderVoting() {
    useTpl('host-tpl-voting');
    const v = state.public.voting;
    if (!v || !v.matchup) {
      document.getElementById('host-vote-title').textContent = 'Loading…';
      return;
    }
    const m = v.matchup;
    const res = m.results;
    const matchupKey = `${state.public.currentRound}:${v.index}`;
    const isNew = seen.matchup !== matchupKey;
    if (isNew) {
      seen.matchup = matchupKey;
      if (m.thumbnails.length > 1) ThumbFx.play('vs');
    }
    if (res && seen.reveal !== matchupKey) {
      seen.reveal = matchupKey;
      const total = Object.values(res.votes || {}).reduce((a, b) => a + b, 0);
      ThumbFx.play(res.winners.length === 1 && total > 0 ? 'win' : 'tie');
    }
    document.getElementById('host-vote-title').textContent = m.title.title;
    const voted = (m.votedBy || []).length;
    const sub = document.getElementById('host-vote-sub');
    if (res) {
      sub.innerHTML = `Matchup ${v.index + 1} / ${v.total} · <strong>${escapeHtml(m.title.persona || '')}</strong> · title by ${escapeHtml(nameOf(m.writerId))}`;
    } else if (m.thumbnails.length <= 1) {
      sub.textContent = `Matchup ${v.index + 1} / ${v.total} · Solo thumbnail — no vote this time`;
    } else {
      sub.textContent = `Matchup ${v.index + 1} / ${v.total} · Which video would you click? · ${voted}/${m.eligibleCount || 0} voted`;
    }
    const row = document.getElementById('host-thumb-row');
    row.innerHTML = '';
    row.classList.toggle('vs-3', m.thumbnails.length >= 3);
    row.classList.toggle('revealed', !!res);
    row.classList.toggle('enter', isNew);
    m.thumbnails.forEach((t, i) => {
      if (i > 0) {
        const vs = document.createElement('div');
        vs.className = 'host-vs-badge';
        vs.textContent = 'VS';
        row.appendChild(vs);
      }
      const label = String.fromCharCode(65 + i);
      const card = document.createElement('div');
      card.className = 'host-thumb';
      let footer = '';
      if (res) {
        const count = res.votes[t.id] || 0;
        const won = res.winners.includes(t.id);
        card.classList.add(won ? 'winner' : 'loser');
        footer = `
          <div class="host-thumb-result">
            <span class="host-thumb-votes">${won ? '🏆 ' : ''}${count} vote${count === 1 ? '' : 's'}</span>
            <span class="host-thumb-artist">drawn by ${escapeHtml(nameOf(t.artistId))}</span>
          </div>`;
      }
      card.innerHTML = `
        <div class="host-thumb-img">
          <img src="${t.png}" alt="Thumbnail ${label}" />
          <span class="host-thumb-label">${label}</span>
        </div>
        ${footer}
      `;
      row.appendChild(card);
    });
  }

  function renderScoreboard() {
    useTpl('host-tpl-scoreboard');
    const sb = state.public.scoreboard;
    if (!sb) return;
    const key = `${sb.roundJustFinished}`;
    const animate = seen.scoreboard !== key;
    seen.scoreboard = key;
    document.getElementById('host-sb-kicker').textContent = sb.isLastRound
      ? 'Final round complete'
      : `Round ${sb.roundJustFinished} of ${sb.totalRounds} complete`;
    document.getElementById('host-sb-title').textContent = 'Scoreboard';
    const deltas = sb.deltas || {};
    const top = Object.entries(deltas).sort((a, b) => b[1] - a[1])[0];
    document.getElementById('host-sb-winner').innerHTML = top && top[1] > 0
      ? `🏆 Round winner: <strong>${escapeHtml(nameOf(top[0]))}</strong> <span class="delta">+${top[1]}</span>`
      : '';
    const board = document.getElementById('host-sb-list');
    board.innerHTML = '';
    Object.entries(sb.scores)
      .map(([id, s]) => ({ id, s, name: nameOf(id) }))
      .sort((a, b) => b.s - a.s)
      .forEach((row, i) => {
        const li = document.createElement('li');
        const d = deltas[row.id] || 0;
        const deltaHtml = d > 0 ? `<span class="delta">+${d}</span>` : '';
        li.style.setProperty('--i', i);
        if (animate) li.classList.add('sb-enter');
        li.innerHTML = `<span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(row.name)}</span>
          <span class="score"><span class="score-num">${row.s}</span> 👍${deltaHtml}</span>`;
        board.appendChild(li);
        if (animate && d > 0) {
          ThumbFx.countUp(li.querySelector('.score-num'), row.s - d, row.s, { duration: 1400, tick: i === 0 });
        }
      });
  }

  function renderBrowse() {
    useTpl('host-tpl-browse');
    const b = state.public.browse;
    const total = b.eligibleCount || 0;
    const thumbVotes = (b.votedBy?.bestThumb || []).length;
    const titleVotes = (b.votedBy?.bestTitle || []).length;
    document.getElementById('host-browse-progress').innerHTML = `
      <span class="host-browse-pill">🎨 Best Thumbnail · ${thumbVotes}/${total}</span>
      <span class="host-browse-pill">✍️ Best Title · ${titleVotes}/${total}</span>
    `;
    const grid = document.getElementById('host-browse-grid');
    // Show EVERY thumbnail from every concept, not just winners.
    for (const c of state.public.browse.concepts) {
      const thumbs = (c.allThumbnails && c.allThumbnails.length)
        ? c.allThumbnails
        : (c.thumbnail ? [c.thumbnail] : []);
      for (const t of thumbs) {
        const card = document.createElement('div');
        card.className = 'browse-card';
        card.innerHTML = `
          ${t.png ? `<img src="${t.png}" alt="" />` : '<div class="empty-thumb">no thumbnail</div>'}
          <div class="browse-title">${escapeHtml(c.title.title)}</div>
        `;
        grid.appendChild(card);
      }
    }
  }

  function renderResults() {
    useTpl('host-tpl-results');
    const r = state.public.results;
    if (!seen.results) {
      seen.results = true;
      ThumbFx.play('fanfare');
      ThumbFx.confetti();
    }
    const nameOf = (id) => {
      const p = state.public.players.find((x) => x.id === id);
      return p ? p.name : (state.public.names?.[id] || 'Unknown');
    };
    document.getElementById('host-champion').innerHTML = `
      <div class="champ-trophy">🏆</div>
      <div class="champ-name">${escapeHtml(nameOf(r.champion))}</div>
      <div class="champ-sub">${r.scores[r.champion] || 0} pts</div>
    `;
    const board = document.getElementById('host-scoreboard');
    Object.entries(r.scores)
      .map(([id, s]) => ({ id, s, name: nameOf(id) }))
      .sort((a, b) => b.s - a.s)
      .forEach((row, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(row.name)}</span>
          <span class="score">${row.s} 👍</span>`;
        board.appendChild(li);
      });

    renderHostGallery(document.getElementById('host-gallery'), r.concepts || []);

    const awards = document.getElementById('host-awards');
    const awardDefs = [
      { key: 'bestThumb', label: '🎨 Best Thumbnail', showThumb: true },
      { key: 'bestTitle', label: '✍️ Best Title Idea', showThumb: false }
    ];
    for (const { key, label, showThumb } of awardDefs) {
      const data = r.awardResults?.[key];
      if (!data || !data.winners || data.winners.length === 0) continue;
      const winnerId = data.winners[0];
      let concept = null;
      let winningThumb = null;
      if (key === 'bestThumb') {
        for (const c of r.concepts || []) {
          const t = (c.allThumbnails || []).find((x) => x.id === winnerId);
          if (t) { concept = c; winningThumb = t; break; }
        }
      } else {
        concept = (r.concepts || []).find((c) => c.id === winnerId);
        winningThumb = concept?.thumbnail;
      }
      if (!concept) continue;
      const artistId = winningThumb?.artistId || concept.artistId;
      const thumbPng = winningThumb?.png || concept.thumbnail?.png;
      const card = document.createElement('div');
      card.className = 'award-card';
      card.innerHTML = `
        <h3>${label}</h3>
        ${showThumb && thumbPng ? `<img src="${thumbPng}" alt="" />` : ''}
        <p class="award-title">${escapeHtml(concept.title.title)}</p>
        <p class="muted tiny">by ${escapeHtml(nameOf(concept.writerId))}${artistId ? ` · art by ${escapeHtml(nameOf(artistId))}` : ''}</p>
      `;
      awards.appendChild(card);
    }
  }

  function renderHostGallery(container, concepts) {
    container.innerHTML = '';
    for (const c of concepts) {
      const votes = c.matchupVotes || {};
      const thumbs = c.allThumbnails || [];
      const max = Math.max(0, ...thumbs.map((t) => votes[t.id] || 0));
      const row = document.createElement('div');
      row.className = 'matchup-row';
      row.innerHTML = `
        <div class="matchup-row-head">
          <div class="matchup-row-title">${escapeHtml(c.title.title)}</div>
          <div class="muted small">${escapeHtml(c.title.persona || '')} · written by ${escapeHtml(nameOf(c.writerId))}</div>
        </div>
        <div class="matchup-row-thumbs"></div>
      `;
      const wrap = row.querySelector('.matchup-row-thumbs');
      for (const t of thumbs) {
        const v = votes[t.id] || 0;
        const won = thumbs.length > 1 && max > 0 && v === max;
        const card = document.createElement('div');
        card.className = 'matchup-thumb' + (won ? ' won' : '');
        card.innerHTML = `
          <img src="${t.png}" alt="" />
          <div class="matchup-thumb-meta">
            <span>${won ? '🏆 ' : ''}${escapeHtml(nameOf(t.artistId))}</span>
            <span class="muted">${v} vote${v === 1 ? '' : 's'}</span>
          </div>
        `;
        wrap.appendChild(card);
      }
      container.appendChild(row);
    }
  }

  // Timer. Writing/drawing show a big clock (people are waiting on it);
  // voting/browse/scoreboard use a small ring so the thumbnails get the room.
  let timerTotal = null;
  let timerFor = null;
  setInterval(() => {
    const ring = document.getElementById('timer-ring');
    if (!state.public || !state.public.timerEndsAt) {
      timerPill.hidden = true;
      const big = document.getElementById('big-timer');
      if (big) big.textContent = '--:--';
      if (ring) ring.hidden = true;
      return;
    }
    if (timerFor !== state.public.timerEndsAt) {
      timerFor = state.public.timerEndsAt;
      timerTotal = Math.max(1, timerFor - (Date.now() + (state.clockOffset || 0)));
    }
    if (ring) {
      const left = Math.max(0, timerFor - (Date.now() + (state.clockOffset || 0)));
      ring.hidden = false;
      ring.style.setProperty('--p', (left / timerTotal).toFixed(3));
      ring.classList.toggle('urgent', left <= 5000);
      document.getElementById('timer-ring-text').textContent = Math.ceil(left / 1000);
    }
    const skew = state.clockOffset || 0;
    const remaining = Math.max(0, Math.round((state.public.timerEndsAt - (Date.now() + skew)) / 1000));
    timerPill.hidden = false;
    const s = formatTime(remaining);
    timerPill.textContent = s;
    timerPill.classList.toggle('urgent', remaining <= 10);
    const big = document.getElementById('big-timer');
    if (big) big.textContent = s;
  }, 250);

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);
  }
})();
