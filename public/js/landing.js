(function () {
  const socket = io();

  const createForm = document.getElementById('create-form');
  const joinForm = document.getElementById('join-form');
  const hostForm = document.getElementById('host-form');
  const joinError = document.getElementById('join-error');
  const resumeLink = document.getElementById('resume-link');

  // Show resume link if saved
  try {
    const saved = JSON.parse(localStorage.getItem('thumbwar:session') || 'null');
    if (saved && saved.code && saved.playerId) {
      resumeLink.hidden = false;
      resumeLink.href = `/play?code=${saved.code}`;
    }
  } catch {}

  // Pre-fill room code if arriving from /play?code=XXXX or /?code=XXXX
  const urlParams = new URLSearchParams(window.location.search);
  const presetCode = (urlParams.get('code') || '').toUpperCase();
  if (presetCode) {
    joinForm.elements['code'].value = presetCode;
    setTimeout(() => joinForm.elements['name'].focus(), 50);
    // Highlight the join card so first-time visitors know what to do
    document.querySelectorAll('.card').forEach((c) => c.classList.remove('highlight'));
    const joinCard = joinForm.closest('.card');
    if (joinCard) joinCard.classList.add('highlight');
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
    const code = joinForm.elements['code'].value.trim().toUpperCase();
    const name = joinForm.elements['name'].value.trim();
    if (!code || !name) return;
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
