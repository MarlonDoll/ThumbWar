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
      cachedPngs: {}, cachedStates: {}
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
    let isBold = false;

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

    window.openTextModal = ({ color, size, onConfirm, text, font, bold, editing }) => {
      input.value = text || '';
      sizeIn.value = Math.min(160, size || 64);
      colorIn.value = color || '#ffd400';
      fontIn.value = font || 'Impact';
      isBold = editing ? bold !== false : false;
      confirm.textContent = editing ? 'Update Text' : 'Add Text';
      modal.querySelector('h2').textContent = editing ? 'Edit text' : 'Add text to thumbnail';
      pendingConfirm = onConfirm;
      modal.hidden = false;
      refreshPreview();
      setTimeout(() => input.focus(), 30);
    };
  })();

  // Sound effects play on the TV when one is connected; otherwise on phones.
  function sfx(name) {
    if (!state.public?.hasDisplay) ThumbFx.play(name);
  }

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

    // Timer settings (host only); everyone else gets a read-only summary.
    const timerSettings = document.getElementById('timer-settings');
    const hallSettings = document.getElementById('hall-settings');
    const summary = document.getElementById('settings-summary');
    {
      const cfg = state.public.config || {};
      const fmt = (sec) => (sec % 60 === 0 ? `${sec / 60} min` : sec > 60 ? `${(sec / 60).toFixed(1)} min` : `${sec}s`);
      const rounds = cfg.ROUNDS || 3;
      summary.innerHTML = `
        <h3 class="settings-title">This game</h3>
        <p class="settings-summary-line">${rounds} round${rounds === 1 ? '' : 's'} · ✍️ ${fmt(cfg.WRITE_SECONDS || 45)} writing · 🎨 ${fmt(cfg.DRAW_SECONDS || 180)} drawing · 🗳️ ${fmt(cfg.VOTE_SECONDS || 25)} per vote</p>
        ${cfg.MATCHUP_SIZE === 3 ? '<p class="muted tiny">⚔️ 3-way matchups (with 6+ players): you\'ll draw 3 thumbnails a round.</p>' : ''}
        ${cfg.SHARE_HALL ? '<p class="muted tiny">📸 The best thumbnail will be featured in the Hall of Thumbs.</p>' : ''}
      `;
    }
    if (isHost()) {
      summary.hidden = true;
      const hallBox = document.getElementById('cfg-hall');
      hallBox.checked = !!state.public.config?.SHARE_HALL;
      hallBox.onchange = () => socket.emit('set-timers', { hall: hallBox.checked });
      const cfg = state.public.config || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = String(val);
      };
      setVal('cfg-write', cfg.WRITE_SECONDS || 45);
      setVal('cfg-draw', cfg.DRAW_SECONDS || 180);
      setVal('cfg-vote', cfg.VOTE_SECONDS || 25);
      setVal('cfg-browse', cfg.BROWSE_SECONDS || 30);
      setVal('cfg-rounds', cfg.ROUNDS || 3);
      setVal('cfg-matchup', cfg.MATCHUP_SIZE || 2);
      document.getElementById('cfg-matchup').onchange = (e) => {
        socket.emit('set-timers', { matchup: e.target.value });
      };

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
      hallSettings.hidden = true;
      summary.hidden = false;
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
      const threeWayShort = (state.public.config?.MATCHUP_SIZE === 3) && activeCount < 6;
      hostHint.textContent = `${activeCount} player${activeCount === 1 ? '' : 's'} ready — workload auto-assigns on start.` +
        (threeWayShort ? ' 3-way needs 6+ players, so rounds will be 1v1 until then.' : '');
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

    document.getElementById('random-title').onclick = async () => {
      try {
        const res = await fetch('/api/random-title');
        const r = await res.json();
        personaInput.value = r.persona;
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
      const remaining = state.public.timerEndsAt - (Date.now() + (state.clockOffset || 0));
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
          if (png) socket.emit('submit-drawing', { writerId: t.writerId, png });
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
        state.drawing.cachedStates[wid] = canvas.getState();
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
        const saved = state.drawing.cachedStates[t.writerId];
        if (saved) canvas.loadState(saved);
        else canvas.loadPng(null);
      }
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
      state.drawing.cachedStates[t.writerId] = canvas.getState();
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
        canvas.recolorSelected(color);
        const sp = document.getElementById('size-preview');
        if (sp) sp.style.background = color;
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
        // Switching tools finishes any text/sticker still being placed.
        canvas.commitPlacement();
        canvas.tool = btn.dataset.tool;
      };
    });
    const sizeInput = document.getElementById('size');
    const sizePreview = document.getElementById('size-preview');
    function refreshSizePreview() {
      if (!sizePreview) return;
      const v = parseInt(sizeInput.value, 10);
      // Cap visual at 32px so the toolbar doesn't blow up
      const display = Math.min(32, Math.max(2, v));
      sizePreview.style.width = display + 'px';
      sizePreview.style.height = display + 'px';
      sizePreview.style.background = canvas.color;
    }
    sizeInput.oninput = (e) => {
      canvas.size = parseInt(e.target.value, 10);
      refreshSizePreview();
    };
    refreshSizePreview();
    document.getElementById('text-size').oninput = (e) => {
      canvas.textSize = parseInt(e.target.value, 10);
    };
    document.getElementById('opacity').oninput = (e) => {
      canvas.opacity = parseInt(e.target.value, 10) / 100;
    };
    document.getElementById('custom-color').oninput = (e) => {
      canvas.color = e.target.value;
      canvas.recolorSelected(e.target.value);
      updateSwatchSelection(canvas.color);
      refreshSizePreview();
    };
    document.getElementById('undo').onclick = () => canvas.undo();
    document.getElementById('redo').onclick = () => canvas.redo();
    document.getElementById('clear').onclick = () => {
      if (confirm('Clear canvas?')) canvas.clear();
    };

    // Stickers — stamp an emoji in draggable move mode.
    document.querySelectorAll('.sticker-btn').forEach((btn) => {
      btn.onclick = () => canvas.beginSticker(btn.dataset.sticker);
    });

    // Edit bar shown while a text or sticker is selected. Tap any text or
    // sticker on the canvas (with any tool) to bring it back.
    const banner = document.getElementById('place-banner');
    canvas.onSelectionChange = (obj) => {
      if (!banner) return;
      banner.hidden = !obj;
      if (obj) document.getElementById('obj-edit').hidden = obj.type !== 'text';
    };
    document.getElementById('obj-smaller').onclick = () => canvas.resizeSelectedBy(1 / 1.2);
    document.getElementById('obj-bigger').onclick = () => canvas.resizeSelectedBy(1.2);
    document.getElementById('obj-edit').onclick = () => canvas.editSelected();
    document.getElementById('obj-delete').onclick = () => canvas.deleteSelected();
    document.getElementById('place-confirm').onclick = () => canvas.deselect();

    // Keyboard shortcuts for tools (ignored while typing in an input).
    const shortcuts = { p: 'pen', e: 'eraser', f: 'fill', l: 'line', r: 'rect', c: 'circle', a: 'arrow', t: 'text' };
    if (state.drawing._keyHandler) document.removeEventListener('keydown', state.drawing._keyHandler);
    state.drawing._keyHandler = (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (!document.getElementById('text-modal')?.hidden) return;
      // Only skip while actually typing. Sliders, color pickers and buttons
      // keep focus after a click, and used to swallow every shortcut.
      const t = ev.target;
      const tag = (t.tagName || '').toLowerCase();
      const typing = tag === 'textarea' || tag === 'select' || t.isContentEditable ||
        (tag === 'input' && !['range', 'color', 'checkbox', 'radio', 'button'].includes(t.type));
      if (typing) return;
      const tool = shortcuts[ev.key.toLowerCase()];
      if (!tool) return;
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      if (!btn) return;
      ev.preventDefault();
      btn.click();
    };
    document.addEventListener('keydown', state.drawing._keyHandler);
  }

  function renderVoting() {
    renderTemplate('tpl-voting');
    const voting = state.public.voting;
    if (!voting || !voting.matchup) {
      app.innerHTML = '<section class="panel thumbwar-countdown"><h1>1, 2, 3, 4…</h1><h1 class="hero-accent">I declare a ThumbWar!</h1></section>';
      return;
    }
    const m = voting.matchup;
    const nameOf = (id) => state.public.players.find((p) => p.id === id)?.name || state.public.names?.[id] || 'Unknown';
    document.getElementById('vote-title-row').textContent =
      `Matchup ${voting.index + 1} of ${voting.total}`;
    document.getElementById('vote-progress').textContent = '';

    const arena = document.getElementById('thumb-choices');
    arena.innerHTML = '';
    arena.classList.toggle('vs-3', m.thumbnails.length >= 3);
    if (!m.results) {
      arena.classList.add('enter');
      if (m.thumbnails.length > 1) sfx('vs');
    } else {
      const total = Object.values(m.results.votes || {}).reduce((a, b) => a + b, 0);
      sfx(m.results.winners.length === 1 && total > 0 ? 'win' : 'tie');
    }

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
      // Creator and artist names stay hidden while voting so nobody votes
      // for a friend; they're revealed alongside the results.
      const creator = hasResults ? (m.title.persona || '') : '';
      const artist = hasResults && t.artistId ? nameOf(t.artistId) : '';
      const creatorInitial = (creator || '?').replace(/^(a|an|the|your|my)\s+/i,'').charAt(0).toUpperCase();
      const ytMeta = `
        <div class="vs-yt-meta">
          <div class="vs-yt-avatar">${hasResults ? creatorInitial : label}</div>
          <div class="vs-yt-text">
            <div class="vs-yt-title">${escapeHtml(m.title.title)}</div>
            ${creator ? `<div class="vs-yt-channel">${escapeHtml(creator)}</div>` : ''}
            ${artist ? `<div class="vs-yt-artist">drawn by ${escapeHtml(artist)}</div>` : ''}
          </div>
        </div>
      `;

      if (hasResults) {
        const isWinner = m.results.winners.includes(t.id);
        const voteCount = m.results.votes[t.id] || 0;
        card.classList.toggle('winner', isWinner);
        card.classList.toggle('loser', !isWinner);
        card.innerHTML = `
          <img src="${t.png}" alt="Thumbnail ${label}" />
          ${ytMeta}
          <div class="vote-result ${isWinner ? 'vote-result-winner' : ''}">
            ${isWinner ? '🏆 ' : ''}${voteCount} vote${voteCount !== 1 ? 's' : ''}
          </div>
        `;
      } else {
        const mine = myThumbIds().includes(t.id);
        card.innerHTML = `
          <img src="${t.png}" alt="Thumbnail ${label}" />
          ${ytMeta}
          <button class="btn btn-primary vote-btn" data-thumb="${t.id}" ${alreadyVoted || mine ? 'disabled' : ''}>${mine ? 'Your thumbnail' : "I'd click this"}</button>
        `;
        if (!mine) {
          card.querySelector('.vote-btn').onclick = () => {
            if (state._myVoteCast) return;
            socket.emit('submit-vote', { thumbnailId: t.id }, (res) => {
              if (res && res.error) return showToast(res.error);
              state._myVoteCast = true;
              showToast('Vote cast!');
              updateVotingInPlace();
            });
          };
        }
      }
      arena.appendChild(card);
    });

    updateVotingInPlace();
  }

  // Thumbnail ids in the current matchup that this player drew (sent
  // privately so artists stay anonymous to everyone else).
  function myThumbIds() {
    return state.private?.myThumbnailIds || [];
  }

  // Lightweight update that runs on every state broadcast WITHOUT rebuilding
  // the card DOM — so other players voting can't destroy your tap target.
  function updateVotingInPlace() {
    const voting = state.public.voting;
    if (!voting || !voting.matchup) return;
    const m = voting.matchup;
    const alreadyVoted = (m.votedBy || []).includes(state.playerId) || state._myVoteCast;
    const statusEl = document.getElementById('vote-status');
    if (m.results) {
      if (statusEl) statusEl.textContent = 'Results! Next matchup coming up…';
      return;
    }
    // Private data can arrive after the public state; lock own thumbnails.
    const mineIds = myThumbIds();
    document.querySelectorAll('.vote-btn').forEach((b) => {
      if (mineIds.includes(b.dataset.thumb)) {
        b.disabled = true;
        b.textContent = 'Your thumbnail';
        b.onclick = null;
      }
    });
    const iDrew = m.thumbnails.some((t) => mineIds.includes(t.id));
    const votes = (m.votedBy || []).length;
    const progress = m.eligibleCount ? ` (${votes}/${m.eligibleCount} voted)` : '';
    if (iDrew && m.thumbnails.length > 1) {
      if (statusEl) statusEl.textContent = `You drew one of these — sit tight while the others vote${progress}`;
    } else if (alreadyVoted) {
      document.querySelectorAll('.vote-btn').forEach((b) => {
        if (!b.disabled) { b.disabled = true; }
      });
      if (statusEl) statusEl.textContent = `Waiting for others…${progress}`;
    } else if (m.thumbnails.length <= 1) {
      if (statusEl) statusEl.textContent = 'Solo reveal — advancing…';
    } else {
      if (statusEl) statusEl.textContent = 'Tap the thumbnail you would click.';
    }
  }

  function renderScoreboard() {
    renderTemplate('tpl-scoreboard');
    const sb = state.public.scoreboard;
    if (!sb) return;
    const nameOf = (id) => {
      const p = state.public.players.find((x) => x.id === id);
      return p ? p.name : (state.public.names?.[id] || 'Unknown');
    };
    const titleEl = document.getElementById('scoreboard-title');
    const subEl = document.getElementById('scoreboard-sub');
    const nextEl = document.getElementById('scoreboard-next');

    const sbKey = `${sb.roundJustFinished}`;
    const animate = state._scoreboardSeen !== sbKey;
    state._scoreboardSeen = sbKey;
    document.getElementById('scoreboard-round-label').textContent = sb.isLastRound
      ? 'Final round complete'
      : `Round ${sb.roundJustFinished} of ${sb.totalRounds} complete`;
    titleEl.textContent = 'Scoreboard';
    const top = Object.entries(sb.deltas || {}).sort((a, b) => b[1] - a[1])[0];
    document.getElementById('scoreboard-winner').innerHTML = top && top[1] > 0
      ? `🏆 Round winner: <strong>${escapeHtml(nameOf(top[0]))}</strong> <span class="delta">+${top[1]}</span>`
      : '';
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
        li.style.setProperty('--i', i);
        if (animate) li.classList.add('sb-enter');
        li.innerHTML = `<span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(row.name)}</span>
          <span class="score"><span class="score-num">${row.s}</span> 👍${deltaHtml}</span>`;
        board.appendChild(li);
        if (animate && d > 0) {
          ThumbFx.countUp(li.querySelector('.score-num'), row.s - d, row.s, {
            duration: 1400,
            tick: i === 0 && !state.public.hasDisplay
          });
        }
      });
  }

  function renderBrowse() {
    renderTemplate('tpl-browse');
    const concepts = (state.public.browse && state.public.browse.concepts) || [];

    // Best Thumbnail grid — each matchup's winning thumbnail(s)
    const thumbGrid = document.getElementById('browse-thumb-grid');
    thumbGrid.innerHTML = '';
    const allThumbs = [];
    concepts.forEach((c) => {
      const thumbs = c.allThumbnails || (c.thumbnail ? [c.thumbnail] : []);
      thumbs.forEach((t) => allThumbs.push({ t, c }));
    });
    allThumbs.forEach(({ t, c }) => {
      const isMyArt = t.artistId === state.playerId;
      const card = document.createElement('div');
      card.className = 'browse-card' + (isMyArt ? ' browse-card-mine' : '');
      card.dataset.voteCat = 'bestThumb';
      card.dataset.voteId = t.id;
      card.innerHTML = `
        ${t.png ? `<img src="${t.png}" alt="" loading="lazy" />` : '<div class="empty-thumb">no thumbnail</div>'}
        <div class="browse-title">${escapeHtml(c.title.title)}</div>
        ${isMyArt ? '<div class="browse-yours">Your art</div>' : ''}
      `;
      if (!isMyArt) {
        card.onclick = () => {
          socket.emit('submit-browse-vote', { category: 'bestThumb', conceptId: t.id }, (res) => {
            if (res && res.error) return showToast(res.error);
            const titleDone = (state.public.browse?.votedBy?.bestTitle || []).includes(state.playerId);
            if (titleDone) return showToast('Voted for Best Thumbnail!');
            showToast('Thumbnail vote in! Now pick the best title ↓');
            setTimeout(() => {
              document.getElementById('browse-title-section')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 150);
          });
        };
      }
      thumbGrid.appendChild(card);
    });

    // Best Title grid
    const titleGrid = document.getElementById('browse-title-grid');
    titleGrid.innerHTML = '';
    concepts.forEach((c) => {
      const isMyTitle = c.writerId === state.playerId;
      const card = document.createElement('div');
      card.className = 'browse-card browse-card-title' + (isMyTitle ? ' browse-card-mine' : '');
      card.dataset.voteCat = 'bestTitle';
      card.dataset.voteId = c.id;
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
    updateBrowseStatus();
  }

  // Status lines, step tracker and "your vote" marks — safe to run on every
  // broadcast because it never replaces the cards.
  function updateBrowseStatus() {
    if (!document.getElementById('browse-thumb-grid')) return;
    const concepts = state.public.browse?.concepts || [];
    const votedBy = state.public.browse?.votedBy || {};
    const thumbVoted = (votedBy.bestThumb || []).includes(state.playerId);
    const titleVoted = (votedBy.bestTitle || []).includes(state.playerId);
    document.getElementById('browse-thumb-status').textContent = thumbVoted
      ? '✓ Voted. Tap a different one to change.'
      : '';
    document.getElementById('browse-title-status').textContent = titleVoted
      ? '✓ Voted. Tap a different one to change.'
      : '';

    // Step tracker: shows which of the two votes are still outstanding, and
    // highlights the title section once the thumbnail vote is done.
    const steps = [
      ['browse-step-thumb', 'browse-thumb-section', thumbVoted, '1'],
      ['browse-step-title', 'browse-title-section', titleVoted, '2']
    ];
    for (const [stepId, sectionId, done, n] of steps) {
      const step = document.getElementById(stepId);
      step.classList.toggle('done', done);
      step.querySelector('.browse-step-check').textContent = done ? '✓' : n;
      document.getElementById(sectionId).classList.toggle('done', done);
    }
    document.getElementById('browse-title-section')
      .classList.toggle('needs-vote', thumbVoted && !titleVoted && concepts.some((c) => c.writerId !== state.playerId));
    markBrowseChoices();
  }

  // Highlight the card this player currently has their vote on.
  function markBrowseChoices() {
    const mine = state.private?.myBrowseVotes || {};
    document.querySelectorAll('.browse-card[data-vote-cat]').forEach((card) => {
      const picked = mine[card.dataset.voteCat] === card.dataset.voteId;
      card.classList.toggle('browse-card-picked', picked);
      let tag = card.querySelector('.browse-picked-tag');
      if (picked && !tag) {
        tag = document.createElement('div');
        tag.className = 'browse-picked-tag';
        tag.textContent = '✓ Your vote';
        card.appendChild(tag);
      } else if (!picked && tag) tag.remove();
    });
  }

  function renderResults() {
    renderTemplate('tpl-results');
    const r = state.public.results;
    if (!state._resultsCelebrated) {
      state._resultsCelebrated = true;
      sfx('fanfare');
      ThumbFx.confetti(r.champion === state.playerId ? 160 : 80);
    }
    const players = state.public.players;
    const nameOf = (id) => {
      const p = players.find((x) => x.id === id);
      return p ? p.name : (state.public.names?.[id] || 'Unknown');
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

    // Final gallery: every matchup with all of its thumbnails and votes.
    renderMatchupGallery(document.getElementById('final-gallery'), r.concepts || [], nameOf);

    const restart = document.getElementById('play-again');
    if (isHost()) {
      restart.onclick = () => socket.emit('restart', {}, () => {});
    } else {
      restart.disabled = true;
      restart.textContent = 'Waiting for host…';
    }
  }

  function renderMatchupGallery(container, concepts, nameOf) {
    container.innerHTML = '';
    container.className = 'matchup-gallery';
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
    const skew = state.clockOffset || 0;
    const remaining = Math.max(0, Math.round((state.public.timerEndsAt - (Date.now() + skew)) / 1000));
    timerPill.hidden = false;
    const totalRounds = state.public.totalRounds || 1;
    const roundPrefix = totalRounds > 1
      ? `R${(state.public.currentRound || 0) + 1}/${totalRounds} `
      : '';
    timerPill.textContent = roundPrefix + formatTime(remaining);
    timerPill.classList.toggle('urgent', remaining <= 10);
    maybeTick(remaining, state.public.phase);
    maybeWarn(remaining, state.public.phase);
  }

  // Big on-screen warning near the end of a timed phase.
  let lastWarnSecond = -1;
  function maybeWarn(remaining, phase) {
    const timed = phase === 'writing' || phase === 'drawing' || phase === 'voting';
    if (!timed) { lastWarnSecond = -1; return; }
    // The vote reveal and solo reveals run on short timers too; counting
    // those down would flash a big number over the results.
    const m = phase === 'voting' ? state.public.voting?.matchup : null;
    if (m && (m.results || m.thumbnails.length <= 1)) { lastWarnSecond = remaining; return; }
    if (remaining === lastWarnSecond) return;
    if (remaining === 10) showToast('⏰ 10 seconds left!');
    if (remaining <= 5 && remaining >= 1) showCountdownFlash(remaining);
    lastWarnSecond = remaining;
  }

  function showCountdownFlash(n) {
    let el = document.getElementById('countdown-flash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'countdown-flash';
      el.className = 'countdown-flash';
      document.body.appendChild(el);
    }
    el.textContent = n;
    el.classList.remove('pop');
    // force reflow to restart animation
    void el.offsetWidth;
    el.classList.add('pop');
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
      // Tear down drawing-phase key handler when leaving drawing.
      if (lastPhase === 'drawing' && state.drawing && state.drawing._keyHandler) {
        document.removeEventListener('keydown', state.drawing._keyHandler);
        state.drawing._keyHandler = null;
      }
      if (phase === 'writing') state.suggestionCache = { personas: null, formats: null };
      if (phase !== 'results') state._resultsCelebrated = false;
      if (phase !== 'browse') state._browseBuilt = false;
      if (phase === 'drawing') {
        if (state.drawing._pollInterval) clearInterval(state.drawing._pollInterval);
        if (state.drawing._autoSubmitInterval) clearInterval(state.drawing._autoSubmitInterval);
        state.drawing = { activeIndex: 0, canvas: null, cachedPngs: {}, cachedStates: {} };
      }
      if (phase === 'voting') { state._votingSig = null; state._myVoteCast = false; }
    }
    if (phase === 'voting') {
      const v = state.public.voting;
      const idx = v ? v.index : null;
      const hasResults = !!(v && v.matchup && v.matchup.results);
      const sig = idx + '|' + hasResults;
      if (sig !== state._votingSig) {
        // New matchup or results just revealed — full rebuild.
        if (idx !== state._lastMatchupIndex) {
          state._lastMatchupIndex = idx;
          state._myVoteCast = false;
        }
        state._votingSig = sig;
        renderVoting();
      } else {
        // Same matchup — just patch status/buttons in place, no DOM rebuild.
        updateVotingInPlace();
      }
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
    else if (phase === 'browse') {
      // Build the page once; later broadcasts (every vote) only update it, so
      // cards don't get replaced under someone's finger mid-tap.
      if (!state._browseBuilt) { state._browseBuilt = true; renderBrowse(); }
      else updateBrowseStatus();
    }
    else if (phase === 'results') renderResults();
  }

  socket.on('state', (pub) => {
    const prevPhase = state.public?.phase;
    state.public = pub;
    // Correct for client/server clock skew so timers are accurate everywhere.
    if (typeof pub.serverNow === 'number') {
      state.clockOffset = pub.serverNow - Date.now();
    }
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
    if (state.public && state.public.phase === 'voting' && document.getElementById('thumb-choices')) {
      updateVotingInPlace();
    }
    if (state.public && state.public.phase === 'browse') markBrowseChoices();
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
