// Scale test: verifies buildAssignments, draw tasks, voting, browse, and results
// for various player counts (1-12). Run with: PORT=3008 node scripts/scale-test.js
//
// Requires the server already running on $PORT.

const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT || 3008}`;

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

async function testWithNPlayers(N) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Testing with N=${N} players`);
  console.log(`${'='.repeat(60)}`);

  const clients = [];
  const names = [];
  for (let i = 0; i < N; i++) {
    names.push(`Player${i + 1}`);
    clients.push(makeClient());
  }

  // Wait for all connections
  await Promise.all(clients.map((c) => once(c, 'connect')));

  // Host creates
  const created = await emitAsync(clients[0], 'create-room', { name: names[0] });
  if (!created.ok) throw new Error(`create-room failed: ${JSON.stringify(created)}`);
  const code = created.code;
  const playerIds = [created.playerId];

  // Others join
  for (let i = 1; i < N; i++) {
    const joined = await emitAsync(clients[i], 'join-room', { code, name: names[i] });
    if (joined.error) throw new Error(`join-room failed for ${names[i]}: ${joined.error}`);
    playerIds.push(joined.playerId);
  }

  // Track state and private data per client
  const states = new Array(N).fill(null);
  const privs = new Array(N).fill(null);
  clients.forEach((c, i) => {
    c.on('state', (s) => (states[i] = s));
    c.on('private', (pv) => (privs[i] = pv));
  });

  await wait(200);

  // Set rounds to 1 for speed
  await emitAsync(clients[0], 'set-rounds', { rounds: 1 });
  await wait(100);

  // Start game
  const start = await emitAsync(clients[0], 'start-game', {});
  if (start.error) throw new Error(`start-game failed: ${start.error}`);
  await wait(200);

  if (states[0].phase !== 'writing') {
    throw new Error(`Expected writing phase, got: ${states[0].phase}`);
  }
  console.log(`  [OK] Phase: writing`);

  // Submit titles
  for (let i = 0; i < N; i++) {
    const r = await emitAsync(clients[i], 'submit-title', {
      persona: `Creator${i + 1}`,
      title: `Title by Player ${i + 1}`,
      format: ''
    });
    if (r.error) throw new Error(`submit-title failed for ${names[i]}: ${r.error}`);
  }

  await wait(300);
  if (states[0].phase !== 'drawing') {
    throw new Error(`Expected drawing phase, got: ${states[0].phase}`);
  }
  console.log(`  [OK] Phase: drawing`);

  // Verify draw task distribution
  const taskCounts = {};
  let anyDrawsOwn = false;
  for (let i = 0; i < N; i++) {
    const tasks = privs[i]?.tasks || [];
    taskCounts[names[i]] = tasks.length;

    // Check no player draws their own title (except solo mode)
    if (N > 1) {
      for (const t of tasks) {
        if (t.writerId === playerIds[i]) {
          anyDrawsOwn = true;
          console.log(`  [FAIL] ${names[i]} is assigned to draw their own title!`);
        }
      }
    }
  }

  console.log(`  Task distribution: ${JSON.stringify(taskCounts)}`);

  // Verify balance: all players should have the same number of tasks
  const counts = Object.values(taskCounts);
  const allSame = counts.every((c) => c === counts[0]);
  if (allSame) {
    console.log(`  [OK] All players have ${counts[0]} draw task(s) each`);
  } else {
    console.log(`  [WARN] Uneven task distribution: min=${Math.min(...counts)}, max=${Math.max(...counts)}`);
  }

  if (!anyDrawsOwn || N === 1) {
    console.log(`  [OK] No player draws their own title${N === 1 ? ' (solo exception)' : ''}`);
  }

  // Submit drawings
  for (let i = 0; i < N; i++) {
    const tasks = privs[i]?.tasks || [];
    for (const t of tasks) {
      const r = await emitAsync(clients[i], 'submit-drawing', { writerId: t.writerId, png: PNG });
      if (r.error) {
        throw new Error(`submit-drawing failed for ${names[i]} -> ${t.writerId}: ${r.error}`);
      }
    }
  }

  await wait(400);
  if (states[0].phase !== 'voting') {
    throw new Error(`Expected voting phase, got: ${states[0].phase}`);
  }
  console.log(`  [OK] Phase: voting`);

  // Voting loop — budget plenty of iterations for the 4-second result
  // reveal that fires between each matchup (N matchups * ~10 checks each).
  let matchupCount = 0;
  let maxWait = N * 20 + 40; // safety limit
  while (states[0].phase === 'voting' && maxWait-- > 0) {
    const voting = states[0].voting;
    if (!voting || !voting.matchup) {
      await wait(200);
      continue;
    }
    const m = voting.matchup;

    // If results are showing, just wait for the next matchup
    if (m.results) {
      await wait(300);
      continue;
    }

    matchupCount++;
    const thumbs = m.thumbnails || [];

    if (thumbs.length <= 1) {
      // Solo — auto-advances
      await wait(3500);
      continue;
    }

    // Each player votes for the first thumbnail they can (not their own)
    for (let i = 0; i < N; i++) {
      // Try to vote for each thumbnail until one is accepted
      for (const t of thumbs) {
        const r = await emitAsync(clients[i], 'submit-vote', { thumbnailId: t.id });
        if (!r.error) break; // vote accepted
        // errors like "Already voted" or "Cannot vote for your own" are OK
      }
    }
    await wait(400);
  }
  console.log(`  [OK] Voted through ${matchupCount} matchup(s)`);

  // Wait for results reveal timeouts (4s per remaining matchup)
  for (let i = 0; i < N * 12 && states[0].phase === 'voting'; i++) await wait(500);

  if (states[0].phase !== 'browse') {
    throw new Error(`Expected browse phase, got: ${states[0].phase}`);
  }
  console.log(`  [OK] Phase: browse`);

  // Browse vote
  const concepts = states[0].browse?.concepts || [];
  for (let i = 0; i < N; i++) {
    const c = concepts[i % concepts.length];
    const r = await emitAsync(clients[i], 'submit-browse-vote', {
      category: 'best',
      conceptId: c.id
    });
    if (r.error) console.log(`  [WARN] browse vote error for ${names[i]}: ${r.error}`);
  }

  // Wait for results
  for (let i = 0; i < 20 && states[0].phase !== 'results'; i++) await wait(300);

  if (states[0].phase !== 'results') {
    throw new Error(`Expected results phase, got: ${states[0].phase}`);
  }
  console.log(`  [OK] Phase: results`);
  console.log(`  Champion: ${states[0].results.champion}`);
  console.log(`  Scores: ${JSON.stringify(states[0].results.scores)}`);
  console.log(`  Concepts: ${states[0].results.concepts.length}`);

  // Cleanup
  clients.forEach((c) => c.close());
  console.log(`  [PASS] N=${N} completed successfully`);
}

async function main() {
  const testCounts = [3, 5, 7, 10, 11, 12];
  let failures = 0;

  // Also test the pairings module directly
  console.log('\n--- Direct pairings module test (N=1..12) ---');
  const { buildAssignments, drawTasksByPlayer } = require('../src/pairings');

  for (let n = 1; n <= 12; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const assignments = buildAssignments(ids);
    const tasks = drawTasksByPlayer(assignments);

    // Verify each title has at least one drawer
    for (const id of ids) {
      if (!assignments[id] || assignments[id].length === 0) {
        console.log(`  [FAIL] N=${n}: title ${id} has no drawers`);
        failures++;
      }
    }

    // Verify no player draws their own title (except solo)
    if (n > 1) {
      for (const [writerId, drawers] of Object.entries(assignments)) {
        if (drawers.includes(writerId)) {
          console.log(`  [FAIL] N=${n}: ${writerId} draws their own title`);
          failures++;
        }
      }
    }

    // Verify balanced workload
    const taskArr = Object.values(tasks).map((t) => t.length);
    const min = Math.min(...taskArr);
    const max = Math.max(...taskArr);
    const balanced = max - min <= 0;

    console.log(
      `  N=${String(n).padStart(2)}: ` +
      `drawers/title=${assignments[ids[0]].length}, ` +
      `tasks/player=${min}${min !== max ? '-' + max : ''} ` +
      `${balanced ? '[BALANCED]' : '[UNEVEN]'}`
    );
  }

  // Now run full integration tests
  console.log('\n--- Full integration tests (server required) ---');
  for (const n of testCounts) {
    try {
      await testWithNPlayers(n);
    } catch (e) {
      console.log(`  [FAIL] N=${n}: ${e.message}`);
      failures++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (failures > 0) {
    console.log(`  ${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('  ALL TESTS PASSED');
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
