// Build drawing assignments for each round.
//
// Each player draws exactly 1 thumbnail per round. Players are paired
// into VS battles using the circle-method round-robin so different
// people face each other every round. With odd player counts, one
// matchup becomes a 3-way VS so nobody sits idle.
//
// Returns: { [writerId]: [drawerId, ...], ... }

function buildAssignments(playerIds, roundIndex) {
  const n = playerIds.length;
  const assignments = {};
  const round = roundIndex || 0;

  if (n === 0) return assignments;

  if (n === 1) {
    assignments[playerIds[0]] = [playerIds[0]];
    return assignments;
  }

  if (n === 2) {
    assignments[playerIds[0]] = [playerIds[1]];
    assignments[playerIds[1]] = [playerIds[0]];
    return assignments;
  }

  if (n === 3) {
    // Classic 3-player battle: rotate which title is featured each round,
    // the other two players draw it (2-way VS). The writer sits out drawing
    // (they wrote it) — respects no-self-draw.
    const writerIdx = round % 3;
    const writer = playerIds[writerIdx];
    assignments[writer] = [
      playerIds[(writerIdx + 1) % 3],
      playerIds[(writerIdx + 2) % 3]
    ];
    return assignments;
  }

  // 4+ players: circle-method round-robin pairing of drawers.
  const pairs = roundRobinPairs(playerIds, round);

  // Odd player count leaves one person out — attach them to a rotating
  // pair as a 3rd drawer so everyone draws exactly once.
  const paired = new Set();
  pairs.forEach((p) => p.forEach((id) => paired.add(id)));
  const leftover = playerIds.filter((id) => !paired.has(id));
  if (leftover.length === 1 && pairs.length > 0) {
    const idx = round % pairs.length;
    pairs[idx] = [...pairs[idx], leftover[0]];
  }

  // Give each group a title written by someone NOT in the group.
  const titleOffset = (round * 2) % n;
  const used = new Set();
  for (const group of pairs) {
    const writerId = pickTitleForGroup(playerIds, group, titleOffset, used);
    if (writerId) {
      used.add(writerId);
      assignments[writerId] = group;
    }
  }

  return assignments;
}

// Circle method: fix the first player, rotate the rest by `round`.
// Over (n-1) rounds every pair meets exactly once.
function roundRobinPairs(players, round) {
  const arr = players.slice();
  if (arr.length % 2 === 1) arr.push(null); // bye marker
  const m = arr.length;
  const fixed = arr[0];
  const rest = arr.slice(1);
  const r = round % (m - 1);
  const rotated = rest.slice(r).concat(rest.slice(0, r));
  const lineup = [fixed, ...rotated];

  const pairs = [];
  for (let i = 0; i < m / 2; i++) {
    const a = lineup[i];
    const b = lineup[m - 1 - i];
    if (a !== null && b !== null) pairs.push([a, b]);
  }
  return pairs;
}

function pickTitleForGroup(playerIds, group, titleOffset, used) {
  const n = playerIds.length;
  const groupSet = new Set(group);
  for (let i = 0; i < n; i++) {
    const cand = playerIds[(titleOffset + i) % n];
    if (!groupSet.has(cand) && !used.has(cand)) return cand;
  }
  for (const cand of playerIds) {
    if (!used.has(cand) && !groupSet.has(cand)) return cand;
  }
  return null;
}

// Flatten assignments into a list of writerIds each player must draw.
function drawTasksByPlayer(assignments) {
  const tasks = {};
  for (const [writerId, drawers] of Object.entries(assignments)) {
    for (const drawerId of drawers) {
      if (!tasks[drawerId]) tasks[drawerId] = [];
      tasks[drawerId].push(writerId);
    }
  }
  return tasks;
}

module.exports = { buildAssignments, drawTasksByPlayer };
