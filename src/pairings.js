// Build drawing assignments for each round.
//
// Each player draws exactly 1 thumbnail per round. Players are paired
// into VS battles using a round-robin tournament rotation so different
// people face each other every round. With odd player counts, one
// matchup becomes a 3-way VS to use the extra player.
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

  // Round-robin pairing: rotate everyone except the first player.
  // This ensures over (n-1) rounds, every pair faces off exactly once.
  const rotated = roundRobinOrder(playerIds, round);
  const pairs = pairUpRotated(rotated);

  // For each pair, pick a title to draw that wasn't written by either drawer.
  // Use a writer rotation that also depends on round to vary titles.
  const titleOffset = (round * Math.floor(n / 2)) % n;
  const usedWriters = new Set();
  for (const pair of pairs) {
    const writerId = pickTitleForPair(playerIds, pair, titleOffset, usedWriters);
    if (writerId) {
      usedWriters.add(writerId);
      assignments[writerId] = pair;
    }
  }

  return assignments;
}

// Standard round-robin scheduling: keep first player fixed, rotate rest.
// For odd n, we treat the last player as a "bye marker" — they form a
// 3-way matchup with the pair that would have had the bye.
function roundRobinOrder(playerIds, round) {
  const n = playerIds.length;
  const m = n % 2 === 0 ? n : n + 1; // even total for rotation
  // Build a virtual list where last slot is "bye" if odd
  const order = playerIds.slice();
  if (n % 2 !== 0) order.push(null); // null = bye marker

  // Rotate everything except index 0 by `round` positions
  // (clockwise rotation of slots 1..m-1)
  const rotated = [order[0]];
  for (let i = 1; i < m; i++) {
    const from = ((i - 1 + round) % (m - 1)) + 1;
    rotated.push(order[from]);
  }
  return rotated;
}

function pairUpRotated(order) {
  // Standard round-robin pairing: pair index i with index m-1-i
  const m = order.length;
  const pairs = [];
  for (let i = 0; i < m / 2; i++) {
    const a = order[i];
    const b = order[m - 1 - i];
    if (a == null || b == null) {
      // Pair with bye — that player doesn't draw this round in pure
      // round-robin, but we want everyone to draw. So find who got
      // the bye and merge them into the previous pair as a 3-way.
      const survivor = a == null ? b : a;
      if (pairs.length > 0) {
        pairs[pairs.length - 1] = [...pairs[pairs.length - 1], survivor];
      }
    } else {
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function pickTitleForPair(playerIds, pair, titleOffset, usedWriters) {
  const n = playerIds.length;
  const pairSet = new Set(pair);
  // Start at titleOffset and find the first writer not in the pair and not used
  for (let i = 0; i < n; i++) {
    const cand = playerIds[(titleOffset + i) % n];
    if (!pairSet.has(cand) && !usedWriters.has(cand)) {
      return cand;
    }
  }
  // Fallback: just find any unused writer
  for (const cand of playerIds) {
    if (!usedWriters.has(cand)) return cand;
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
