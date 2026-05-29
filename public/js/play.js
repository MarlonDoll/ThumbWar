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
    const fontIn = document.getElementById('text-modal-font');
    const boldBtn = document.getElementById('text-modal-bold');
    const preview = document.getElementById('text-modal-preview');
    const cancel = document.getElementById('text-modal-cancel');
    const confirm = document.getElementById('text-modal-confirm');
    let pendingConfirm = null;
    let isBold = true;

    function refreshPreview() {
      preview.textContent = input.value || 'YOUR THUMBNAIL TEXT';
      preview.style.fontSize = sizeIn.value + 'px';
      preview.style.color = colorIn.value;
      preview.style.fontFamily = fontIn.value + ', sans-serif';
      preview.style.fontWeight = isBold ? '900' : '400';
      preview.style.webkitTextStroke = isBold ? '2px black' : '1px black';
      boldBtn.classList.toggle('btn-primary', isBold);
    }
    input.addEventListener('input', refreshPreview);
    sizeIn.addEventListener('input', refreshPreview);
    colorIn.addEventListener('input', refreshPreview);
    fontIn.addEventListener('change', refreshPreview);
    boldBtn.addEventListener('click', () => {
      isBold = !isBold;
      refreshPreview();
    });

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
        color: colorIn.value,
        font: fontIn.value,
        bold: isBold
      };
      close();
      if (cb && payload.text) cb(payload);
    });

    window.openTextModal = ({ color, size, opacity, onConfirm }) => {
      input.value = '';
      sizeIn.value = size || 64;
      colorIn.value = color || '#ffd400';
      fontIn.value = 'Impact';
      isBold = true;
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

    // Persona mode toggle (host only)
    const pmRow = document.getElementById('persona-mode-row');
    const pmWriter = document.getElementById('pm-writer');
    const pmDrawer = document.getElementById('pm-drawer');
    const currentPM = state.public.config?.PERSONA_MODE || 'writer';
    pmWriter.classList.toggle('active', currentPM === 'writer');
    pmDrawer.classList.toggle('active', currentPM === 'drawer');
    if (isHost()) {
      pmWriter.onclick = () => socket.emit('set-persona-mode', { mode: 'writer' });
      pmDrawer.onclick = () => socket.emit('set-persona-mode', { mode: 'drawer' });
    } else {
      pmRow.hidden = true;
    }

    // Timer settings (host only)
    const timerSettings = document.getElementById('timer-settings');
    if (isHost()) {
      const cfg = state.public.config || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = String(val);
      };
      setVal('cfg-write', cfg.WRITE_SECONDS || 90);
      setVal('cfg-draw', cfg.DRAW_SECONDS || 180);
      setVal('cfg-vote', cfg.VOTE_SECONDS || 25);
      setVal('cfg-browse', cfg.BROWSE_SECONDS || 30);
      setVal('cfg-rounds', cfg.ROUNDS || 3);

      const sendTimers = () => {
        socket.emit('set-timers', {
          write: document.getElementById('cfg-write').value,
          draw: document.getElementById('cfg-draw').value,
          vote: document.getElementById('cfg-vote').value,
          browse: document.getElementById('cfg-browse').value
        });
      };
      ['cfg-write', 'cfg-draw', 'cfg-vote', 'cfg-browse'].forEach((id) => {
        document.getElementById(id).onchange = sendTimers;
      });
      document.getElementById('cfg-rounds').onchange = () => {
        socket.emit('set-rounds', { rounds: document.getElementById('cfg-rounds').value });
      };
    } else {
      timerSettings.hidden = true;
    }

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

    // In drawer mode, hide the persona section — drawers pick persona later
    const drawerMode = state.public.config?.PERSONA_MODE === 'drawer';
    if (drawerMode) {
      const personaCol = personaInput.closest('.col');
      if (personaCol) personaCol.hidden = true;
    }

    populateSuggestions();
    restoreMyTitle();

    document.getElementById('random-title').onclick = async () => {
      try {
        const res = await fetch('/api/random-title');
        const r = await res.json();
        if (!drawerMode) personaInput.value = r.persona;
        titleInput.value = r.title;
        titleInput.focus();
      } catch (e) {
        showToast('Could not load random title');
      }
    };

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
      const titleInput = document.getElementById('title-input');
      for (const f of sugg.formats.slice(0, 4)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'format-btn';
        b.textContent = f;
        b.onclick = () => {
          // Drop the format in as-is — let the player fill the [X] / [Y]
          // blanks themselves. Auto-select the first blank so they can
          // start typing to replace it immediately.
          titleInput.value = f;
          titleInput.focus();
          const idx = f.indexOf('[');
          if (idx >= 0) {
            const end = f.indexOf(']', idx);
            if (end >= 0) titleInput.setSelectionRange(idx, end + 1);
          }
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

    // In drawer-picks-persona mode, show the persona picker
    const drawerMode = state.public.config?.PERSONA_MODE === 'drawer';
    const personaRow = document.getElementById('drawer-persona-row');
    const personaIn = document.getElementById('drawer-persona-input');
    if (drawerMode && personaRow) {
      personaRow.hidden = false;
      if (!personaIn.value) personaIn.value = me()?.name || '';
      const chips = document.getElementById('drawer-persona-chips');
      const sugg = state.private?.personaSuggestions || [];
      if (chips && sugg.length && chips.children.length === 0) {
        for (const p of sugg) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = p;
          b.onclick = () => { personaIn.value = p; };
          chips.appendChild(b);
        }
      }
    }

    state.drawing.refresh = loadActiveTask;
    loadActiveTask();
    updateDrawingStatus();

    // Robustness: if tasks haven't arrived yet, poll until they do
    if (getTasks().length === 0) {
      state.drawing._pollInterval = setInterval(() => {
        if (state.public?.phase !== 'drawing') {
          clearInterval(state.drawing._pollInterval);
          state.drawing._pollInterval = null;
          return;
        }
        if (getTasks().length > 0) {
          clearInterval(state.drawing._pollInterval);
          state.drawing._pollInterval = null;
          loadActiveTask();
        }
      }, 500);
    }

    // Auto-submit all drawings when ~3 seconds remain
    state.drawing._autoSubmitted = false;
    state.drawing._autoSubmitInterval = setInterval(() => {
      if (state.public?.phase !== 'drawing') {
        clearInterval(state.drawing._autoSubmitInterval);
        return;
      }
      if (state.drawing._autoSubmitted) return;
      if (!state.public.timerEndsAt) return;
      const remaining = state.public.timerEndsAt - Date.now();
      if (remaining < 3500) {
        state.drawing._autoSubmitted = true;
        clearInterval(state.drawing._autoSubmitInterval);
        const tasks = getTasks();
        const cv = state.drawing.canvas;
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          if (t.submitted) continue;
          // Save current canvas to the task's slot if it's the active one
          if (i === state.drawing.activeIndex && cv) {
            state.drawing.cachedPngs[t.writerId] = cv.toDataURL();
          }
          const png = state.drawing.cachedPngs[t.writerId];
          if (png) {
            const drawPersona = document.getElementById('drawer-persona-input')?.value || '';
            socket.emit('submit-drawing', { writerId: t.writerId, png, persona: drawPersona });
          }
        }
        showToast('Auto-submitted drawings (time almost up)');
      }
    }, 1000);

    function switchTask(delta) {
      const tasks = getTasks();
      if (tasks.length === 0) return;
      if (tasks[state.drawing.activeIndex]) {
        const wid = tasks[state.drawing.activeIndex].writerId;
        state.drawing.cachedPngs[wid] = canvas.toDataURL();
      }
      state.drawing.activeIndex = (state.drawing.activeIndex + delta + tasks.length) % tasks.length;
      state.drawing._loadedWriterId = null;
      loadActiveTask();
    }

    function loadActiveTask() {
      const tasks = getTasks();
      const t = tasks[state.drawing.activeIndex];
      const btn = document.getElementById('submit-drawing');
      const titleEl = document.getElementById('drawing-title');
      const personaEl = document.getElementById('drawing-persona');
      const labelEl = document.getElementById('task-label');
      const bannerTitle = document.getElementById('banner-title');
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
      if (bannerTitle) bannerTitle.textContent = t.title.title;
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
      // Only reload the canvas when switching to a different task.
      // Reloading on every state update wipes whatever the player is drawing.
      if (state.drawing._loadedWriterId !== t.writerId) {
        state.drawing._loadedWriterId = t.writerId;
        const cached = state.drawing.cachedPngs[t.writerId];
        canvas.loadPng(cached || null);
      }
      // Restore drawer's persona pick if they already submitted one
      const dpi = document.getElementById('drawer-persona-input');
      if (dpi && t.myPersona) dpi.value = t.myPersona;
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
      const drawPersona = document.getElementById('drawer-persona-input')?.value || '';
      socket.emit('submit-drawing', { writerId: t.writerId, png, persona: drawPersona }, (res) => {
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
      app.innerHTML = '<section class="panel thumbwar-countdown"><h1>1, 2, 3, 4…</h1><h1 class="hero-accent">I declare a ThumbWar!</h1></section>';
      return;
    }
    const m = voting.matchup;
    document.getElementById('vote-title-row').textContent =
      `Matchup ${voting.index + 1} of ${voting.total}`;
    document.getElementById('vote-progress').textContent = '';

    const arena = document.getElementById('thumb-choices');
    arena.innerHTML = '';
    arena.classList.toggle('vs-3', m.thumbnails.length >= 3);

    const alreadyVoted = (m.votedBy || []).includes(state.playerId);
    const hasResults = !!(m.results);

    m.thumbnails.forEach((t, i) => {
      if (i > 0) {
        const vs = document.createElement('div');
        vs.className = 'vs-badge';
        vs.textContent = 'VS';
        arena.appendChild(vs);
      }
      const card = document.createElement('div');
      card.className = 'vs-card';
      const label = String.fromCharCode(65 + i);
      const creator = t.persona || m.title.persona || '';
      const creatorInitial = (creator || '?').replace(/^(a|an|the|your|my)\s+/i,'').charAt(0).toUpperCase();
      const ytMeta = `
        <div class="vs-yt-meta">
          <div class="vs-yt-avatar">${creatorInitial}</div>
          <div class="vs-yt-text">
            <div class="vs-yt-title">${escapeHtml(m.title.title)}</div>
            <div class="vs-yt-channel">${escapeHtml(creator)}</div>
          </div>
        </div>
      `;

      if (hasResults) {
        const isWinner = m.results.winners.includes(t.id);
        const voteCount = m.results.votes[t.id] || 0;
        card.classList.toggle('winner', isWinner);
        card.innerHTML = `
          <div class="vs-letter">${label}</div>
          <img src="${t.png}" alt="Thumbnail ${label}" />
          ${ytMeta}
          <div class="vote-result ${isWinner ? 'vote-result-winner' : ''}">
            ${isWinner ? '🏆 ' : ''}${voteCount} vote${voteCount !== 1 ? 's' : ''}
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="vs-letter">${label}</div>
          <img src="${t.png}" alt="Thumbnail ${label}" />
          ${ytMeta}
          <button class="btn btn-primary vote-btn" ${alreadyVoted ? 'disabled' : ''}>I'd click this</button>
        `;
        card.querySelector('.vote-btn').onclick = () => {
          if (alreadyVoted) return;
          socket.emit('submit-vote', { thumbnailId: t.id }, (res) => {
            if (res && res.error) showToast(res.error);
            else {
              showToast('Vote cast!');
              card.classList.add('voted');
            }
          });
        };
      }
      arena.appendChild(card);
    });

    if (hasResults) {
      document.getElementById('vote-status').textContent = 'Results! Next matchup coming up…';
    } else if (m.thumbnails.length <= 1) {
      document.getElementById('vote-status').textContent = 'Solo reveal — advancing…';
    } else if (alreadyVoted) {
      document.getElementById('vote-status').textContent = 'Waiting for others to vote…';
    } else {
      document.getElementById('vote-status').textContent = 'Tap the thumbnail you would click.';
    }
  }

  function renderScoreboard() {
    renderTemplate('tpl-scoreboard');
    const sb = state.public.scoreboard;
    if (!sb) return;
    const nameOf = (id) => {
      const p = state.public.players.find((x) => x.id === id);
      return p ? p.name : 'Unknown';
    };
    const titleEl = document.getElementById('scoreboard-title');
    const subEl = document.getElementById('scoreboard-sub');
    const nextEl = document.getElementById('scoreboard-next');

    titleEl.textContent = sb.isLastRound
      ? 'Final Round Complete!'
      : `Round ${sb.roundJustFinished} of ${sb.totalRounds} Complete`;
    subEl.textContent = sb.isLastRound
      ? 'Here are the scores before the final vote.'
      : `Next round starting soon…`;
    nextEl.textContent = sb.isLastRound
      ? 'The browse page is next — pick the best concept.'
      : `Round ${sb.roundJustFinished + 1} starts in a few seconds.`;

    const board = document.getElementById('mid-scoreboard');
    board.innerHTML = '';
    const deltas = sb.deltas || {};
    Object.entries(sb.scores)
      .map(([id, s]) => ({ id, s, name: nameOf(id) }))
      .sort((a, b) => b.s - a.s)
      .forEach((row, i) => {
        const li = document.createElement('li');
        const d = deltas[row.id] || 0;
        const deltaHtml = d > 0 ? `<span class="delta">+${d}</span>` : '';
        li.innerHTML = `<span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(row.name)}</span>
          <span class="score">${row.s} 👍${deltaHtml}</span>`;
        board.appendChild(li);
      });
  }

  function renderBrowse() {
    renderTemplate('tpl-browse');
    const concepts = (state.public.browse && state.public.browse.concepts) || [];
    const votedBy = state.public.browse.votedBy || {};

    // Best Thumbnail grid — every individual thumbnail is votable
    const thumbGrid = document.getElementById('browse-thumb-grid');
    thumbGrid.innerHTML = '';
    const thumbVoted = (votedBy.bestThumb || []).includes(state.playerId);
    const allThumbs = [];
    concepts.forEach((c) => {
      const thumbs = c.allThumbnails || (c.thumbnail ? [c.thumbnail] : []);
      thumbs.forEach((t) => allThumbs.push({ t, c }));
    });
    allThumbs.forEach(({ t, c }) => {
      const isMyArt = t.artistId === state.playerId;
      const card = document.createElement('div');
      card.className = 'browse-card' + (isMyArt ? ' browse-card-mine' : '');
      card.innerHTML = `
        ${t.png ? `<img src="${t.png}" alt="" />` : '<div class="empty-thumb">no thumbnail</div>'}
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
        ${isMyArt ? '<div class="browse-yours">Your art</div>' : ''}
      `;
      if (!isMyArt) {
        card.onclick = () => {
          socket.emit('submit-browse-vote', { category: 'bestThumb', conceptId: t.id }, (res) => {
            if (res && res.error) return showToast(res.error);
            showToast('Voted for Best Thumbnail!');
          });
        };
      }
      thumbGrid.appendChild(card);
    });
    document.getElementById('browse-thumb-status').textContent = thumbVoted
      ? '✓ Voted. Tap a different one to change.'
      : '';

    // Best Title grid
    const titleGrid = document.getElementById('browse-title-grid');
    titleGrid.innerHTML = '';
    const titleVoted = (votedBy.bestTitle || []).includes(state.playerId);
    concepts.forEach((c) => {
      const isMyTitle = c.writerId === state.playerId;
      const card = document.createElement('div');
      card.className = 'browse-card browse-card-title' + (isMyTitle ? ' browse-card-mine' : '');
      card.innerHTML = `
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
        ${isMyTitle ? '<div class="browse-yours">Your title</div>' : ''}
      `;
      if (!isMyTitle) {
        card.onclick = () => {
          socket.emit('submit-browse-vote', { category: 'bestTitle', conceptId: c.id }, (res) => {
            if (res && res.error) return showToast(res.error);
            showToast('Voted for Best Title!');
          });
        };
      }
      titleGrid.appendChild(card);
    });
    document.getElementById('browse-title-status').textContent = titleVoted
      ? '✓ Voted. Tap a different one to change.'
      : '';
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
          <span class="score">${row.s} 👍</span>`;
        board.appendChild(li);
      });

    const awards = document.getElementById('awards');
    awards.innerHTML = '';
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
        // winnerId is a thumbnailId — find the concept that has it
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

  // Soft tick sound when drawing/writing time is running low.
  let audioCtx = null;
  function playTick(urgent) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = urgent ? 900 : 700;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(urgent ? 0.07 : 0.04, audioCtx.currentTime + 0.01);
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.08);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } catch {}
  }
  let lastTickSecond = -1;
  function maybeTick(remaining, phase) {
    if (phase !== 'drawing' && phase !== 'writing') {
      lastTickSecond = -1;
      return;
    }
    if (remaining > 10 || remaining <= 0) {
      lastTickSecond = remaining;
      return;
    }
    if (remaining !== lastTickSecond) {
      lastTickSecond = remaining;
      playTick(remaining <= 3);
    }
  }

  function updateTimer() {
    if (!state.public || !state.public.timerEndsAt) {
      timerPill.hidden = true;
      return;
    }
    const remaining = Math.max(0, Math.round((state.public.timerEndsAt - Date.now()) / 1000));
    timerPill.hidden = false;
    const totalRounds = state.public.totalRounds || 1;
    const roundPrefix = totalRounds > 1
      ? `R${(state.public.currentRound || 0) + 1}/${totalRounds} `
      : '';
    timerPill.textContent = roundPrefix + formatTime(remaining);
    timerPill.classList.toggle('urgent', remaining <= 10);
    maybeTick(remaining, state.public.phase);
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
        if (state.drawing._pollInterval) clearInterval(state.drawing._pollInterval);
        if (state.drawing._autoSubmitInterval) clearInterval(state.drawing._autoSubmitInterval);
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
    else if (phase === 'scoreboard') renderScoreboard();
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
