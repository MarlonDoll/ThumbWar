// Shared "juice" for the phone and TV screens: synthesized sound effects
// (no audio files), counting-up scores, and confetti.
//
// Exposes window.ThumbFx.

(function (global) {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('thumbwar:muted') === '1'; } catch {}

  function audio() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Browsers only allow audio after a user gesture; unlock on the first one.
  function unlockOnGesture() {
    const unlock = () => {
      audio();
      global.removeEventListener('pointerdown', unlock, true);
      global.removeEventListener('keydown', unlock, true);
    };
    global.addEventListener('pointerdown', unlock, true);
    global.addEventListener('keydown', unlock, true);
  }
  unlockOnGesture();

  function canPlay() {
    return !muted && ctx && ctx.state === 'running';
  }

  function tone(freq, start, dur, { type = 'sine', gain = 0.08, slideTo = null } = {}) {
    const a = ctx;
    const t0 = a.currentTime + start;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(start, dur, { gain = 0.06, from = 400, to = 4000 } = {}) {
    const a = ctx;
    const t0 = a.currentTime + start;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(a.destination);
    src.start(t0);
  }

  const sounds = {
    // New matchup: whoosh in, then a punchy "VS" hit.
    vs() {
      noise(0, 0.35, { gain: 0.07, from: 300, to: 3000 });
      tone(110, 0.3, 0.35, { type: 'square', gain: 0.07, slideTo: 55 });
      tone(220, 0.3, 0.2, { type: 'sawtooth', gain: 0.03 });
    },
    // A card flipping over during the matchup reveal.
    flip() {
      noise(0, 0.12, { gain: 0.05, from: 2000, to: 6000 });
      tone(520, 0.02, 0.12, { type: 'triangle', gain: 0.05, slideTo: 880 });
    },
    // The VS badge slamming down between cards.
    slam() {
      tone(90, 0, 0.3, { type: 'square', gain: 0.07, slideTo: 45 });
      noise(0, 0.15, { gain: 0.05, from: 200, to: 900 });
    },
    // Winner reveal: quick rising arpeggio.
    win() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.3, { type: 'triangle', gain: 0.08 }));
    },
    // Tie / nobody voted: two soft notes.
    tie() {
      tone(440, 0, 0.25, { type: 'triangle', gain: 0.06 });
      tone(440, 0.15, 0.3, { type: 'triangle', gain: 0.05 });
    },
    // Scoreboard counter tick.
    tick() {
      tone(1200, 0, 0.04, { type: 'square', gain: 0.025 });
    },
    // Champion fanfare.
    fanfare() {
      const notes = [[523, 0], [523, 0.15], [523, 0.3], [659, 0.45], [784, 0.75], [1047, 1.0]];
      notes.forEach(([f, t]) => tone(f, t, 0.35, { type: 'sawtooth', gain: 0.05 }));
      notes.forEach(([f, t]) => tone(f / 2, t, 0.35, { type: 'triangle', gain: 0.05 }));
    }
  };

  function play(name) {
    try {
      if (canPlay() && sounds[name]) sounds[name]();
    } catch {}
  }

  // Timing for revealing a matchup's cards one at a time (seconds). Shared
  // by the phone and TV so their animations and sounds line up.
  const REVEAL_STEP = 0.45;
  function revealDelays(count) {
    return {
      card: (i) => i * REVEAL_STEP,
      vs: (i) => i * REVEAL_STEP - 0.2, // badge before card i (i >= 1)
      total: (count - 1) * REVEAL_STEP + 0.5
    };
  }

  // Play flip/slam sounds in step with the reveal. `stillCurrent` lets the
  // caller cancel if the matchup has already moved on.
  function playReveal(count, stillCurrent = () => true) {
    const d = revealDelays(count);
    for (let i = 0; i < count; i++) {
      setTimeout(() => stillCurrent() && play('flip'), d.card(i) * 1000);
      if (i > 0) setTimeout(() => stillCurrent() && play('slam'), d.vs(i) * 1000 + 120);
    }
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('thumbwar:muted', muted ? '1' : '0'); } catch {}
    if (!muted) audio();
  }

  // Animate the number in `el` from `from` to `to`, ticking as it goes.
  function countUp(el, from, to, { duration = 1200, suffix = '', tick = false } = {}) {
    if (from === to) { el.textContent = to + suffix; return; }
    const start = performance.now();
    let lastTick = 0;
    const step = (now) => {
      if (!el.isConnected) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (to - from) * eased) + suffix;
      if (tick && now - lastTick > 90 && t < 1) { lastTick = now; play('tick'); }
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = from + suffix;
    requestAnimationFrame(step);
  }

  function confetti(count = 120) {
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#ff2d55', '#ffd400', '#00e5ff', '#1eb854', '#8b4cff', '#ff8a00', '#ffffff'];
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = Math.random() * 0.8 + 's';
      p.style.animationDuration = 2.2 + Math.random() * 1.8 + 's';
      p.style.setProperty('--drift', (Math.random() * 40 - 20) + 'vw');
      p.style.setProperty('--spin', (Math.random() * 1440 - 720) + 'deg');
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 5000);
  }

  global.ThumbFx = {
    play,
    setMuted,
    isMuted: () => muted,
    isUnlocked: () => !!ctx && ctx.state === 'running',
    unlock: audio,
    countUp,
    confetti,
    revealDelays,
    playReveal
  };
})(window);
