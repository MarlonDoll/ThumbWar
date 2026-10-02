(function () {
  const socket = io();

  // Featured concepts on the home page. Drop image files into
  // /public/images/featured/ and add an entry here for each.
  // Each card needs: { file, title, creator, winner }
  const FEATURED = [
    { file: 'zombies.png', title: 'I make the perfect machine to stop Zombies', creator: 'Stephen', winner: 'nick' },
    { file: 'cult.PNG', title: 'How I infiltrated a cult', creator: 'Stephen', winner: 'nick' },
    { file: 'god.PNG', title: 'I Lived like God for a Day', creator: 'Marlon', winner: 'The Yoan' },
    { file: 'tamigotchi.PNG', title: 'I Let My Tamigotchi Control My Life', creator: 'Marlon', winner: 'nick' }
  ];

  const createForm = document.getElementById('create-form');
  const joinForm = document.getElementById('join-form');
  const hostForm = document.getElementById('host-form');
  const joinError = document.getElementById('join-error');
  const resumeLink = document.getElementById('resume-link');

  // Render the Hall of Thumbs: winners from recent games whose host opted in
  // (newest first), topped up with the hand-picked FEATURED cards. Cards
  // whose image is missing hide themselves; if none load, the whole section
  // hides so there are no broken images.
  const featuredGrid = document.getElementById('featured-grid');
  const featuredSection = document.querySelector('.featured-section');
  const MAX_CARDS = 8;

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function renderHall(cards) {
    if (!featuredGrid) return;
    let loaded = 0;
    let settled = 0;
    const total = cards.length;
    const maybeHideSection = () => {
      if (settled === total && loaded === 0 && featuredSection) featuredSection.hidden = true;
    };
    if (total === 0 && featuredSection) featuredSection.hidden = true;
    for (const f of cards) {
      const card = document.createElement('div');
      card.className = 'featured-card';
      const img = document.createElement('img');
      img.alt = f.title;
      img.loading = 'lazy';
      img.onload = () => { loaded++; settled++; maybeHideSection(); };
      img.onerror = () => { settled++; card.remove(); maybeHideSection(); };
      img.src = f.image;
      const meta = document.createElement('div');
      meta.className = 'featured-meta';
      meta.innerHTML = `
        <div class="featured-card-title">${escapeHtml(f.title)}</div>
        <div class="featured-card-creator">${escapeHtml(f.creator)}</div>
        ${f.artist ? `<div class="featured-card-winner">drawn by ${escapeHtml(f.artist)}</div>` : ''}
        ${f.recent ? '<div class="featured-card-new">New</div>' : ''}
      `;
      card.appendChild(img);
      card.appendChild(meta);
      featuredGrid.appendChild(card);
    }
  }

  const curated = FEATURED.map((f) => ({
    image: `/images/featured/${f.file}`,
    title: f.title,
    creator: f.creator,
    artist: f.winner
  }));
  fetch('/api/hall')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((recent) => {
      const DAY = 24 * 60 * 60 * 1000;
      const fromGames = (Array.isArray(recent) ? recent : []).map((e) => ({
        image: e.image,
        title: e.title,
        creator: e.creator,
        artist: e.artist,
        recent: Date.now() - (e.at || 0) < DAY
      }));
      renderHall([...fromGames, ...curated].slice(0, MAX_CARDS));
    });

  // Code box elements
  const codeBoxes = joinForm.querySelectorAll('.code-box');

  // Show resume link if saved
  try {
    const saved = JSON.parse(localStorage.getItem('thumbwar:session') || 'null');
    if (saved && saved.code && saved.playerId) {
      document.getElementById('resume-wrap').hidden = false;
      resumeLink.href = `/play?code=${saved.code}`;
    }
  } catch {}

  // Pre-fill room code if arriving from /play?code=XXXX or /?code=XXXX
  const urlParams = new URLSearchParams(window.location.search);
  const presetCode = (urlParams.get('code') || '').toUpperCase();
  if (presetCode) {
    // Distribute the preset code across the individual boxes
    for (let i = 0; i < codeBoxes.length; i++) {
      codeBoxes[i].value = presetCode[i] || '';
    }
    setTimeout(() => joinForm.elements['name'].focus(), 50);
    // Highlight the join card so first-time visitors know what to do
    const joinCard = joinForm.closest('.card');
    if (joinCard) joinCard.classList.add('highlight');
  }

  // Wire up code box auto-advance, backspace, and paste
  codeBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const val = box.value.toUpperCase();
      box.value = val;
      if (val && i < codeBoxes.length - 1) {
        codeBoxes[i + 1].focus();
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        codeBoxes[i - 1].focus();
      }
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (let j = 0; j < codeBoxes.length; j++) {
        codeBoxes[j].value = pasted[j] || '';
      }
      // Focus the last filled box or the next empty one
      const nextEmpty = Array.from(codeBoxes).findIndex((b) => !b.value);
      if (nextEmpty >= 0) {
        codeBoxes[nextEmpty].focus();
      } else {
        codeBoxes[codeBoxes.length - 1].focus();
      }
    });
  });

  // Helper to concatenate code boxes
  function getCodeFromBoxes() {
    return Array.from(codeBoxes).map((b) => b.value).join('').toUpperCase();
  }

  function showError(msg) {
    joinError.textContent = msg;
    joinError.hidden = false;
  }

  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = createForm.elements['name'].value.trim();
    if (!name) return;
    socket.emit('create-room', { name }, (res) => {
      if (res.error) return showError(res.error);
      localStorage.setItem(
        'thumbwar:session',
        JSON.stringify({ code: res.code, playerId: res.playerId })
      );
      window.location.href = `/play?code=${res.code}`;
    });
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.hidden = true;
    const code = getCodeFromBoxes();
    const name = joinForm.elements['name'].value.trim();
    if (!code || code.length < 4 || !name) return;
    socket.emit('join-room', { code, name }, (res) => {
      if (res.error) return showError(res.error);
      localStorage.setItem(
        'thumbwar:session',
        JSON.stringify({ code: res.code, playerId: res.playerId })
      );
      window.location.href = `/play?code=${res.code}`;
    });
  });

  hostForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = hostForm.elements['code'].value.trim().toUpperCase();
    if (!code) return;
    window.location.href = `/host?code=${code}`;
  });
})();
