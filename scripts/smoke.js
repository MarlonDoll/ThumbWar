// End-to-end smoke test: 3 players play a full round.
// Requires the server already running on $PORT (default 3001).
const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT || 3001}`;

function makeClient() {
  return io(URL, { transports: ['websocket'] });
}

function once(sock, ev) {
  return new Promise((res) => sock.once(ev, res));
}
function emitAsync(sock, ev, payload) {
  return new Promise((res) =>
    sock.emit(ev, payload, (r) => res(r))
  );
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function run() {
  const host = makeClient();
  const p2 = makeClient();
  const p3 = makeClient();
  await Promise.all([once(host, 'connect'), once(p2, 'connect'), once(p3, 'connect')]);

  const created = await emitAsync(host, 'create-room', { name: 'Alice' });
  console.log('create-room:', created);

  const code = created.code;
  const joined1 = await emitAsync(p2, 'join-room', { code, name: 'Bob' });
  const joined2 = await emitAsync(p3, 'join-room', { code, name: 'Carol' });
  console.log('joined bob/carol:', joined1.ok, joined2.ok);

  // Capture each client's public state updates
  const states = { host: null, p2: null, p3: null };
  host.on('state', (s) => (states.host = s));
  p2.on('state', (s) => (states.p2 = s));
  p3.on('state', (s) => (states.p3 = s));

  const privs = { host: null, p2: null, p3: null };
  host.on('private', (pv) => (privs.host = pv));
  p2.on('private', (pv) => (privs.p2 = pv));
  p3.on('private', (pv) => (privs.p3 = pv));

  await wait(150);
  console.log('players in lobby:', states.host.players.length);

  const start = await emitAsync(host, 'start-game', {});
  console.log('start-game:', start);
  await wait(150);
  console.log('phase after start:', states.host.phase);

  // Submit titles
  await emitAsync(host, 'submit-title', { persona: 'MrBeast', title: 'I Gave Alice $10,000', format: '' });
  await emitAsync(p2, 'submit-title', { persona: 'Santa', title: 'Bob Runs the North Pole', format: '' });
  await emitAsync(p3, 'submit-title', { persona: 'Gordon Ramsay', title: 'Carol Cooks Trash', format: '' });

  await wait(200);
  console.log('phase after titles:', states.host.phase);

  // Submit drawings - each player draws 2 titles
  async function drawAll(client, who) {
    const tasks = privs[who]?.tasks || [];
    for (const t of tasks) {
      const r = await emitAsync(client, 'submit-drawing', { writerId: t.writerId, png: PNG });
      if (r.error) console.log(who, 'draw error:', r.error);
    }
  }
  await drawAll(host, 'host');
  await drawAll(p2, 'p2');
  await drawAll(p3, 'p3');

  await wait(300);
  console.log('phase after drawings:', states.host.phase);

  // Voting loop — each non-artist player votes on the current matchup
  while (states.host.phase === 'voting') {
    const m = states.host.voting.matchup;
    if (!m) break;
    // Players who aren't artists can vote
    // We don't have artistId in public state, so each client tries to vote for thumb 0
    // and the server will reject if they're an artist.
    for (const [who, sock] of [['host', host], ['p2', p2], ['p3', p3]]) {
      const target = m.thumbnails[0];
      if (!target) break;
      await emitAsync(sock, 'submit-vote', { thumbnailId: target.id });
    }
    // Try a second thumbnail for remaining voters
    if (m.thumbnails.length > 1) {
      for (const [who, sock] of [['host', host], ['p2', p2], ['p3', p3]]) {
        const target = m.thumbnails[1];
        if (!target) break;
        await emitAsync(sock, 'submit-vote', { thumbnailId: target.id });
      }
    }
    await wait(250);
  }
  console.log('phase after voting:', states.host.phase);

  // Browse vote
  if (states.host.phase === 'browse') {
    const concepts = states.host.browse.concepts;
    for (const cat of ['funniest', 'clickbait', 'interesting']) {
      for (const [, sock] of [['host', host], ['p2', p2], ['p3', p3]]) {
        await emitAsync(sock, 'submit-browse-vote', {
          category: cat,
          conceptId: concepts[Math.floor(Math.random() * concepts.length)].id
        });
      }
    }
  }

  // Force finish (timer will fire) — wait up to 5s
  for (let i = 0; i < 20 && states.host.phase !== 'results'; i++) await wait(300);
  console.log('final phase:', states.host.phase);
  if (states.host.phase === 'results') {
    console.log('champion:', states.host.results.champion);
    console.log('scores:', states.host.results.scores);
    console.log('concepts count:', states.host.results.concepts.length);
  }

  host.close();
  p2.close();
  p3.close();
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
