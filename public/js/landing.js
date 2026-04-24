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
