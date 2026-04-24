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
    render();
  });

  function render() {
    const p = state.public;
    if (!p) return;
    if (p.phase === 'lobby') return renderLobby();
    if (p.phase === 'writing') return renderWriting();
    if (p.phase === 'drawing') return renderDrawing();
    if (p.phase === 'voting') return renderVoting();
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
    // Not in public state; infer from submittedByDrawer structure, but the raw
    // count isn't visible. Fall back to players.length - 1 as a reasonable hint.
    // (Server enforces the real count.)
    const n = state.public.players.filter((p) => !p.spectator).length;
    if (n <= 1) return 1;
    if (n === 2) return 1;
    if (n === 3) return 2;
    return n >= 6 ? 3 : 2;
  }

  function renderVoting() {
    useTpl('host-tpl-voting');
    const v = state.public.voting;
    if (!v || !v.matchup) {
      document.getElementById('host-vote-title').textContent = 'Loading…';
      return;
    }
    const m = v.matchup;
    document.getElementById('host-vote-title').textContent = m.title.title;
    document.getElementById('host-vote-sub').textContent =
      `Matchup ${v.index + 1} / ${v.total} · persona: ${m.title.persona} · Which video would you click?`;
    const row = document.getElementById('host-thumb-row');
    row.innerHTML = '';
    m.thumbnails.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'host-thumb';
      card.innerHTML = `
        <div class="thumb-letter">${String.fromCharCode(65 + i)}</div>
        <img src="${t.png}" alt="Thumbnail ${i + 1}" />
      `;
      row.appendChild(card);
    });
  }

  function renderBrowse() {
    useTpl('host-tpl-browse');
    const grid = document.getElementById('host-browse-grid');
    for (const c of state.public.browse.concepts) {
      const card = document.createElement('div');
      card.className = 'browse-card';
      card.innerHTML = `
        ${c.thumbnail ? `<img src="${c.thumbnail.png}" alt="" />` : '<div class="empty-thumb">no thumbnail</div>'}
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
      `;
      grid.appendChild(card);
    }
  }

  function renderResults() {
    useTpl('host-tpl-results');
    const r = state.public.results;
    const nameOf = (id) => {
      const p = state.public.players.find((x) => x.id === id);
      return p ? p.name : 'Unknown';
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
          <span class="score">${row.s}</span>`;
        board.appendChild(li);
      });

    const awards = document.getElementById('host-awards');
    const awardLabels = {
      funniest: '😂 Funniest Concept',
      clickbait: '🎣 Most Clickbait',
      interesting: '🤔 Most Interesting'
    };
    for (const [cat, data] of Object.entries(r.awardResults || {})) {
      const card = document.createElement('div');
      card.className = 'award-card';
      if (!data || !data.winners || data.winners.length === 0) {
        card.innerHTML = `<h3>${awardLabels[cat] || cat}</h3><p class="muted">No votes</p>`;
      } else {
        const concept = (r.concepts || []).find((c) => c.id === data.winners[0]);
        if (!concept) continue;
        card.innerHTML = `
          <h3>${awardLabels[cat] || cat}</h3>
          ${concept.thumbnail ? `<img src="${concept.thumbnail.png}" alt="" />` : ''}
          <p class="award-title">${escapeHtml(concept.title.title)}</p>
          <p class="muted tiny">by ${escapeHtml(nameOf(concept.writerId))}${concept.artistId ? ` · art by ${escapeHtml(nameOf(concept.artistId))}` : ''}</p>
        `;
      }
      awards.appendChild(card);
    }
  }

  // Timer
  setInterval(() => {
    if (!state.public || !state.public.timerEndsAt) {
      timerPill.hidden = true;
      const big = document.getElementById('big-timer');
      if (big) big.textContent = '--:--';
      return;
    }
    const remaining = Math.max(0, Math.round((state.public.timerEndsAt - Date.now()) / 1000));
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
