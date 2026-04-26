(function () {
  const socket = io();
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('code') || '').toUpperCase();

  if (!code) {
    window.location.href = '/';
    return;
  }

  const state = {
    code,
    playerId: null,
    public: null,
    private: null,
    timerInt: null,
    // Drawing phase local UI
    drawing: {
      activeIndex: 0,
      canvas: null,
      // cache of PNGs per assigned writerId (so switching is lossless)
      cachedPngs: {}
    },
    // Browse phase UI
    browse: { activeCat: 'funniest' },
    // Local cache of suggested items (don't re-render on every state change)
    suggestionCache: { personas: null, formats: null }
  };

  // ----- resume or wait for landing-provided ids -----

  try {
    const saved = JSON.parse(localStorage.getItem('thumbwar:session') || 'null');
    if (saved && saved.code === code && saved.playerId) {
      state.playerId = saved.playerId;
      const doResume = () => {
        socket.emit('resume', { code, playerId: state.playerId }, (res) => {
          if (res && res.error) {
            alert(res.error);
            localStorage.removeItem('thumbwar:session');
            window.location.href = '/';
          }
        });
      };
      if (socket.connected) doResume();
      socket.on('connect', doResume);
    }
  } catch {}

  if (!state.playerId) {
    // First-time visitor or expired session — bounce back to landing with
    // the code preserved so the join form pre-fills.
    window.location.replace(`/?code=${encodeURIComponent(code)}`);
    return;
  }

  // ----- DOM helpers -----

  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const timerPill = document.getElementById('timer-pill');
  const roomPill = document.getElementById('room-code-pill');
  roomPill.textContent = code;

  // Text modal — wired to canvas.js via window.openTextModal
  (function setupTextModal() {
    const modal = document.getElementById('text-modal');
    if (!modal) return;
    const input = document.getElementById('text-modal-input');
    const sizeIn = document.getElementById('text-modal-size');
    const colorIn = document.getElementById('text-modal-color');
    const preview = document.getElementById('text-modal-preview');
    const cancel = document.getElementById('text-modal-cancel');
    const confirm = document.getElementById('text-modal-confirm');
    let pendingConfirm = null;

    function refreshPreview() {
      preview.textContent = input.value || 'YOUR THUMBNAIL TEXT';
      preview.style.fontSize = sizeIn.value + 'px';
      preview.style.color = colorIn.value;
    }
    input.addEventListener('input', refreshPreview);
    sizeIn.addEventListener('input', refreshPreview);
    colorIn.addEventListener('input', refreshPreview);

    function close() {
      modal.hidden = true;
      pendingConfirm = null;
    }
    cancel.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    confirm.addEventListener('click', () => {
      const cb = pendingConfirm;
      const payload = {
        text: input.value.trim(),
        size: parseInt(sizeIn.value, 10),
        color: colorIn.value
      };
      close();
      if (cb && payload.text) cb(payload);
    });

    window.openTextModal = ({ color, size, opacity, onConfirm }) => {
      input.value = '';
      sizeIn.value = size || 64;
      colorIn.value = color || '#ffd400';
      pendingConfirm = onConfirm;
      modal.hidden = false;
      refreshPreview();
      setTimeout(() => input.focus(), 30);
    };
  })();

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.hidden = true), 2200);
  }

  function renderTemplate(id) {
    const tpl = document.getElementById(id);
    app.innerHTML = '';
    app.appendChild(tpl.content.cloneNode(true));
  }

  function me() {
    if (!state.public) return null;
    return state.public.players.find((p) => p.id === state.playerId) || null;
  }

  function isHost() {
    return state.public && state.public.hostId === state.playerId;
  }

  // ----- phase renderers -----

  function renderLobby() {
    renderTemplate('tpl-lobby');
    const codeEl = document.getElementById('lobby-code');
    codeEl.textContent = state.public.code;
    document.getElementById('copy-code').onclick = () => {
      navigator.clipboard?.writeText(state.public.code);
      showToast('Room code copied');
    };
    document.getElementById('open-display').onclick = () => {
      window.open(`/host?code=${state.public.code}`, '_blank', 'noopener');
    };

    const grid = document.getElementById('lobby-players');
    grid.innerHTML = '';
    for (const p of state.public.players) {
      const el = document.createElement('div');
      el.className = 'player-tile';
      if (p.spectator) el.classList.add('spectator');
      if (!p.connected) el.classList.add('offline');
      el.innerHTML = `
        <span class="player-name">${escapeHtml(p.name)}</span>
        ${p.isHost ? '<span class="badge">host</span>' : ''}
        ${p.spectator ? '<span class="badge muted">spectator</span>' : ''}
        ${!p.connected ? '<span class="badge muted">offline</span>' : ''}
      `;
      grid.appendChild(el);
    }

    const specBox = document.getElementById('spectator');
    const m = me();
    specBox.checked = !!(m && m.spectator);
    specBox.onchange = () => socket.emit('set-spectator', { spectator: specBox.checked });

    const startBtn = document.getElementById('start-btn');
    const hostHint = document.getElementById('host-hint');
    const activeCount = state.public.players.filter((p) => !p.spectator).length;
    if (isHost()) {
      startBtn.disabled = activeCount < 1;
      startBtn.onclick = () => {
        socket.emit('start-game', {}, (res) => {
          if (res && res.error) showToast(res.error);
        });
      };
      hostHint.textContent = `${activeCount} player${activeCount === 1 ? '' : 's'} ready — workload auto-assigns on start.`;
    } else {
      startBtn.hidden = true;
      hostHint.textContent = 'Waiting for the host to start…';
    }
  }

  function renderWriting() {
    renderTemplate('tpl-writing');
    const personaInput = document.getElementById('persona-input');
    const titleInput = document.getElementById('title-input');
    const submitBtn = document.getElementById('submit-title');

    populateSuggestions();
    restoreMyTitle();

    submitBtn.onclick = () => {
      const title = titleInput.value.trim();
      if (!title) return showToast('Write a title first');
      socket.emit(
        'submit-title',
        { persona: personaInput.value, title, format: '' },
        (res) => {
          if (res && res.error) showToast(res.error);
          else showToast('Title submitted');
        }
      );
    };

    updateWritingStatus();
  }

  function populateSuggestions() {
    const personaChips = document.getElementById('persona-suggestions');
    const formatWrap = document.getElementById('format-suggestions');
    if (!personaChips || !formatWrap) return;
    const sugg = state.private?.suggestions;
    if (!sugg || !sugg.personas?.length || !sugg.formats?.length) return;

    if (personaChips.children.length === 0) {
      const personaInput = document.getElementById('persona-input');
      for (const p of sugg.personas) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = p;
        b.onclick = () => {
          personaInput.value = p;
          personaInput.focus();
        };
        personaChips.appendChild(b);
      }
    }

    if (formatWrap.children.length === 0) {
      const personaInput = document.getElementById('persona-input');
      const titleInput = document.getElementById('title-input');
      for (const f of sugg.formats) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'format-btn';
        b.textContent = f;
        b.onclick = () => {
          const personaVal = personaInput.value.trim();
          let filled = f;
          if (personaVal) filled = filled.replace('[X]', personaVal);
          titleInput.value = filled;
          titleInput.focus();
        };
        formatWrap.appendChild(b);
      }
    }
  }

  function restoreMyTitle() {
    const priv = state.private || {};
    const personaInput = document.getElementById('persona-input');
    const titleInput = document.getElementById('title-input');
    if (!personaInput || !titleInput) return;
    if (priv.myTitle) {
      if (!personaInput.value) personaInput.value = priv.myTitle.persona || '';
      if (!titleInput.value) titleInput.value = priv.myTitle.title || '';
    }
  }

  function updateWritingStatus() {
    const statusEl = document.getElementById('writing-status');
    if (!statusEl) return;
    const submittedCount = state.public.writing?.submitted?.length || 0;
    const total = state.public.players.filter((p) => !p.spectator).length;
    const priv = state.private || {};
    const mine = priv.myTitle ? '✓ Submitted — you can edit and resubmit. ' : '';
    statusEl.textContent = `${mine}${submittedCount}/${total} players submitted`;
  }

  function getTasks() {
    return state.private?.tasks || [];
  }

  function renderDrawing() {
    renderTemplate('tpl-drawing');
    const canvasEl = document.getElementById('thumb');
    const canvas = new ThumbCanvas(canvasEl);
    state.drawing.canvas = canvas;

    if (state.drawing.activeIndex >= getTasks().length) state.drawing.activeIndex = 0;

    buildPalette(canvas);
    bindToolbar(canvas);

    document.getElementById('prev-task').onclick = () => switchTask(-1);
    document.getElementById('next-task').onclick = () => switchTask(1);
    document.getElementById('submit-drawing').onclick = submitCurrentDrawing;

    state.drawing.refresh = loadActiveTask;
    loadActiveTask();
    updateDrawingStatus();

    function switchTask(delta) {
      const tasks = getTasks();
      if (tasks.length === 0) return;
      if (tasks[state.drawing.activeIndex]) {
        const wid = tasks[state.drawing.activeIndex].writerId;
        state.drawing.cachedPngs[wid] = canvas.toDataURL();
      }
      state.drawing.activeIndex = (state.drawing.activeIndex + delta + tasks.length) % tasks.length;
      loadActiveTask();
    }

    function loadActiveTask() {
      const tasks = getTasks();
      const t = tasks[state.drawing.activeIndex];
      const btn = document.getElementById('submit-drawing');
      const titleEl = document.getElementById('drawing-title');
      const personaEl = document.getElementById('drawing-persona');
      const labelEl = document.getElementById('task-label');
      if (!t) {
        if (titleEl) titleEl.textContent = tasks.length === 0 ? 'Loading your assignments…' : 'All done!';
        if (personaEl) personaEl.textContent = '';
        if (labelEl) labelEl.textContent = tasks.length === 0 ? '—' : `${state.drawing.activeIndex + 1} / ${tasks.length}`;
        if (btn) {
          btn.disabled = true;
          btn.textContent = tasks.length === 0 ? 'Waiting…' : 'No more thumbnails';
        }
        return;
      }
      if (titleEl) titleEl.textContent = t.title.title;
      if (personaEl) personaEl.textContent = t.title.persona;
      if (labelEl) labelEl.textContent = `${state.drawing.activeIndex + 1} / ${tasks.length}`;
      const dotEl = document.getElementById('drawing-dot');
      if (dotEl) {
        const initials = (t.title.persona || '?')
          .replace(/^(a|an|the|your|my)\s+/i, '')
          .split(/\s+/)
          .map((w) => w[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
          .toUpperCase() || '?';
        dotEl.textContent = initials;
      }
      const cached = state.drawing.cachedPngs[t.writerId];
      canvas.loadPng(cached || null);
      if (btn) {
        btn.disabled = false;
        btn.textContent = t.submitted ? '✓ Submitted — Resubmit?' : 'Submit Thumbnail';
      }
    }

    function submitCurrentDrawing() {
      const tasks = getTasks();
      const t = tasks[state.drawing.activeIndex];
      if (!t) return showToast('No active task — wait a moment and try again');
      const btn = document.getElementById('submit-drawing');
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      const png = canvas.toDataURL();
      state.drawing.cachedPngs[t.writerId] = png;
      socket.emit('submit-drawing', { writerId: t.writerId, png }, (res) => {
        btn.disabled = false;
        if (res && res.error) {
          btn.textContent = 'Try Submitting Again';
          showToast('Submit failed: ' + res.error);
          return;
        }
        btn.textContent = '✓ Submitted — Resubmit?';
        showToast('Thumbnail submitted!');
        const next = getTasks();
        const nextIdx = next.findIndex((x, i) => i > state.drawing.activeIndex && !x.submitted);
        if (nextIdx >= 0) {
          state.drawing.activeIndex = nextIdx;
          loadActiveTask();
        } else {
          const firstUnsub = next.findIndex((x) => !x.submitted);
          if (firstUnsub >= 0 && firstUnsub !== state.drawing.activeIndex) {
            state.drawing.activeIndex = firstUnsub;
            loadActiveTask();
          }
        }
      });
    }
  }

  function updateDrawingStatus() {
    const el = document.getElementById('drawing-status');
    const tasks = getTasks();
    if (state.drawing.refresh) state.drawing.refresh();
    if (!el) return;
    const done = tasks.filter((t) => t.submitted).length;
    el.textContent = `${done}/${tasks.length} thumbnails submitted`;
  }

  function buildPalette(canvas) {
    const palette = document.getElementById('palette');
    palette.innerHTML = '';
    for (const color of window.THUMB_PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = color;
      b.onclick = () => {
        canvas.color = color;
        document.getElementById('custom-color').value = color;
        updateSwatchSelection(color);
      };
      b.dataset.color = color;
      palette.appendChild(b);
    }
    updateSwatchSelection(canvas.color);
  }

  function updateSwatchSelection(color) {
    document.querySelectorAll('.swatch').forEach((el) => {
      el.classList.toggle('selected', el.dataset.color === color);
    });
  }

  function bindToolbar(canvas) {
    document.querySelectorAll('.tool').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.tool').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        canvas.tool = btn.dataset.tool;
      };
    });
    document.getElementById('size').oninput = (e) => {
      canvas.size = parseInt(e.target.value, 10);
    };
    document.getElementById('text-size').oninput = (e) => {
      canvas.textSize = parseInt(e.target.value, 10);
    };
    document.getElementById('opacity').oninput = (e) => {
      canvas.opacity = parseInt(e.target.value, 10) / 100;
    };
    document.getElementById('custom-color').oninput = (e) => {
      canvas.color = e.target.value;
      updateSwatchSelection(canvas.color);
    };
    document.getElementById('undo').onclick = () => canvas.undo();
    document.getElementById('redo').onclick = () => canvas.redo();
    document.getElementById('clear').onclick = () => {
      if (confirm('Clear canvas?')) canvas.clear();
    };
  }

  function renderVoting() {
    renderTemplate('tpl-voting');
    const voting = state.public.voting;
    if (!voting || !voting.matchup) {
      app.innerHTML = '<section class="panel"><h1>Preparing the next matchup…</h1></section>';
      return;
    }
    const m = voting.matchup;
    document.getElementById('vote-title-row').textContent = m.title.title;
    document.getElementById('vote-progress').textContent =
      `Matchup ${voting.index + 1} of ${voting.total} · persona: ${m.title.persona}`;

    const grid = document.getElementById('thumb-choices');
    grid.innerHTML = '';

    // Was I an artist in this matchup?
    const iAmArtist = !!(state.public.players.find(
      (p) => p.id === state.playerId && !p.spectator
    )) && false; // we don't know artistId on public payload — server enforces

    const alreadyVoted = (m.votedBy || []).includes(state.playerId);

    m.thumbnails.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'thumb-card';
      const label = String.fromCharCode(65 + i);
      card.innerHTML = `
        <div class="thumb-letter">${label}</div>
        <img src="${t.png}" alt="Thumbnail ${label}" />
        <button class="btn btn-primary vote-btn" ${alreadyVoted ? 'disabled' : ''}>Click this</button>
      `;
      card.querySelector('.vote-btn').onclick = () => {
        if (alreadyVoted) return;
        socket.emit('submit-vote', { thumbnailId: t.id }, (res) => {
          if (res && res.error) showToast(res.error);
          else {
            showToast('Vote cast');
            card.classList.add('voted');
          }
        });
      };
      grid.appendChild(card);
    });

    if (m.thumbnails.length <= 1) {
      document.getElementById('vote-status').textContent = 'Solo reveal — advancing…';
    } else if (alreadyVoted) {
      document.getElementById('vote-status').textContent = 'Waiting for others to vote…';
    } else {
      document.getElementById('vote-status').textContent = 'Tap the thumbnail you would click.';
    }
  }

  function renderBrowse() {
    renderTemplate('tpl-browse');
    const tabs = document.querySelectorAll('#browse-tabs .tab');
    tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.cat === state.browse.activeCat);
      tab.onclick = () => {
        state.browse.activeCat = tab.dataset.cat;
        renderBrowse();
      };
    });

    const grid = document.getElementById('browse-grid');
    grid.innerHTML = '';
    const concepts = (state.public.browse && state.public.browse.concepts) || [];
    const category = state.browse.activeCat;
    const votedBy = state.public.browse.votedBy[category] || [];
    const alreadyVoted = votedBy.includes(state.playerId);

    concepts.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'browse-card';
      card.innerHTML = `
        ${c.thumbnail ? `<img src="${c.thumbnail.png}" alt="" />` : '<div class="empty-thumb">no thumbnail</div>'}
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
      `;
      card.onclick = () => {
        socket.emit(
          'submit-browse-vote',
          { category, conceptId: c.id },
          (res) => {
            if (res && res.error) return showToast(res.error);
            showToast(`Voted for ${category}`);
          }
        );
      };
      grid.appendChild(card);
    });

    document.getElementById('browse-status').textContent = alreadyVoted
      ? `You've voted in ${category}. Tap a different one to change your pick.`
      : `Pick the concept that feels most ${category} to you.`;
  }

  function renderResults() {
    renderTemplate('tpl-results');
    const r = state.public.results;
    const players = state.public.players;
    const nameOf = (id) => {
      const p = players.find((x) => x.id === id);
      return p ? p.name : 'Unknown';
    };

    // Champion
    const champId = r.champion;
    const champName = champId ? nameOf(champId) : '—';
    document.getElementById('champion-card').innerHTML = `
      <div class="champ-trophy">🏆</div>
      <div class="champ-name">${escapeHtml(champName)}</div>
      <div class="champ-sub">ThumbWar Champion · ${r.scores[champId] || 0} pts</div>
    `;

    const board = document.getElementById('scoreboard');
    board.innerHTML = '';
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

    const awards = document.getElementById('awards');
    awards.innerHTML = '';
    const awardLabels = {
      funniest: '😂 Funniest Concept',
      clickbait: '🎣 Most Clickbait',
      interesting: '🤔 Most Interesting'
    };
    for (const [cat, data] of Object.entries(r.awardResults || {})) {
      const card = document.createElement('div');
      card.className = 'award-card';
      if (!data || !data.winners || data.winners.length === 0) {
        card.innerHTML = `<h3>${awardLabels[cat] || cat}</h3><p class="muted">No votes cast</p>`;
      } else {
        const concept = (r.concepts || []).find((c) => c.id === data.winners[0]);
        if (!concept) {
          card.innerHTML = `<h3>${awardLabels[cat] || cat}</h3><p class="muted">(no concept)</p>`;
        } else {
          card.innerHTML = `
            <h3>${awardLabels[cat] || cat}</h3>
            ${concept.thumbnail ? `<img src="${concept.thumbnail.png}" alt="" />` : ''}
            <p class="award-title">${escapeHtml(concept.title.title)}</p>
            <p class="muted tiny">by ${escapeHtml(nameOf(concept.writerId))}${concept.artistId ? ` · art by ${escapeHtml(nameOf(concept.artistId))}` : ''}</p>
          `;
        }
      }
      awards.appendChild(card);
    }

    // Fun stat awards
    const fun = r.funAwards || {};
    const funMap = {
      mostClickableArtist: '🖱️ Most Clickable Artist',
      bestThumbnailArtist: '🎨 Best Thumbnail Artist',
      bestTitleWriter: '✍️ Best Title Writer'
    };
    for (const [k, label] of Object.entries(funMap)) {
      if (!fun[k]) continue;
      const card = document.createElement('div');
      card.className = 'award-card small';
      card.innerHTML = `
        <h3>${label}</h3>
        <p class="award-title">${escapeHtml(fun[k].name)}</p>
      `;
      awards.appendChild(card);
    }

    // Final gallery
    const gallery = document.getElementById('final-gallery');
    gallery.innerHTML = '';
    (r.concepts || []).forEach((c) => {
      const card = document.createElement('div');
      card.className = 'browse-card';
      card.innerHTML = `
        ${c.thumbnail ? `<img src="${c.thumbnail.png}" alt="" />` : '<div class="empty-thumb">no thumbnail</div>'}
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
        <div class="browse-meta">${escapeHtml(nameOf(c.writerId))}${c.artistId ? ` · art by ${escapeHtml(nameOf(c.artistId))}` : ''}</div>
      `;
      gallery.appendChild(card);
    });

    const restart = document.getElementById('play-again');
    if (isHost()) {
      restart.onclick = () => socket.emit('restart', {}, () => {});
    } else {
      restart.disabled = true;
      restart.textContent = 'Waiting for host…';
    }
  }

  // ----- timer -----

  function updateTimer() {
    if (!state.public || !state.public.timerEndsAt) {
      timerPill.hidden = true;
      return;
    }
    const remaining = Math.max(0, Math.round((state.public.timerEndsAt - Date.now()) / 1000));
    timerPill.hidden = false;
    timerPill.textContent = formatTime(remaining);
    timerPill.classList.toggle('urgent', remaining <= 10);
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  if (!state.timerInt) {
    state.timerInt = setInterval(updateTimer, 250);
  }

  // ----- state routing -----

  function render() {
    if (!state.public) return;
    const phase = state.public.phase;
    const lastPhase = state._lastPhase;
    if (phase !== lastPhase) {
      state._lastPhase = phase;
      if (phase === 'writing') state.suggestionCache = { personas: null, formats: null };
      if (phase === 'drawing') {
        state.drawing = { activeIndex: 0, canvas: null, cachedPngs: {} };
      }
      if (phase === 'voting') state._lastMatchupIndex = null;
    }
    if (phase === 'voting') {
      const idx = state.public.voting ? state.public.voting.index : null;
      if (idx !== state._lastMatchupIndex) {
        state._lastMatchupIndex = idx;
        renderVoting();
        return;
      }
      // Only re-render voting if something changed (votedBy etc.)
      renderVoting();
      return;
    }
    if (phase === 'lobby') renderLobby();
    else if (phase === 'writing') {
      if (!state._writingRendered) {
        state._writingRendered = true;
        renderWriting();
      } else {
        updateWritingStatus();
      }
    }
    else if (phase === 'drawing') {
      if (!state.drawing.canvas) renderDrawing();
      else updateDrawingStatus();
    }
    else if (phase === 'browse') renderBrowse();
    else if (phase === 'results') renderResults();
  }

  socket.on('state', (pub) => {
    const prevPhase = state.public?.phase;
    state.public = pub;
    if (prevPhase !== pub.phase) {
      // Reset per-phase render flags so the next phase initialises cleanly
      state._writingRendered = false;
    }
    render();
  });
  socket.on('private', (priv) => {
    state.private = priv;
    // In writing phase, only patch — never re-render the whole template,
    // which would wipe whatever the player is typing.
    if (state.public && state.public.phase === 'writing' && state._writingRendered) {
      populateSuggestions();
      restoreMyTitle();
      updateWritingStatus();
    }
    if (state.public && state.public.phase === 'drawing' && state.drawing.canvas) {
      updateDrawingStatus();
    }
  });
  socket.on('disconnect', () => showToast('Disconnected — reconnecting…'));
  socket.on('connect', () => {
    // after connect, resume (handled earlier on first connect)
  });

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
