// Build drawing assignments for each round.
//
// Every title gets its own matchup. Each title is drawn by (up to) two
// players who didn't write it, so every player draws two thumbnails per
// round and every title becomes a VS battle. This works the same for odd
// and even player counts:
//
//   - Drawers are shuffled into a ring each round. The player at ring
//     position p draws the titles written by positions p+1 and p+2, so the
//     load is exactly 2 thumbnails each and nobody draws their own title.
//   - Titles whose writer isn't drawing this round (they dropped out after
//     submitting) are handed to the least-loaded drawers.
//   - With only 2 drawers, each title can only be drawn by the other person,
//     so matchups are solo reveals. With 1 player they draw their own.
//
// Returns: { [writerId]: [drawerId, ...], ... }

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// titleWriterIds: writers whose titles need thumbnails this round.
// drawerIds: players available to draw (connected, not spectating).
function buildAssignments(titleWriterIds, drawerIds, rand = Math.random) {
  const assignments = {};
  const drawers = shuffle(drawerIds, rand);
  const n = drawers.length;
  if (n === 0) return assignments;

  if (n === 1) {
    for (const w of titleWriterIds) assignments[w] = [drawers[0]];
    return assignments;
  }

  const perTitle = Math.min(2, n - 1);
  const load = Object.fromEntries(drawers.map((d) => [d, 0]));
  const ringPos = new Map(drawers.map((d, i) => [d, i]));

  // Titles from players in the ring: the two players "behind" them draw it.
  const leftovers = [];
  for (const w of titleWriterIds) {
    if (!ringPos.has(w)) { leftovers.push(w); continue; }
    const p = ringPos.get(w);
    const group = [];
    for (let k = 1; k <= perTitle; k++) group.push(drawers[(p - k + n) % n]);
    group.forEach((d) => load[d]++);
    assignments[w] = group;
  }

  // Titles whose writer isn't drawing: give them to whoever has least to do.
  for (const w of shuffle(leftovers, rand)) {
    const group = drawers
      .slice()
      .sort((a, b) => load[a] - load[b])
      .slice(0, perTitle);
    group.forEach((d) => load[d]++);
    assignments[w] = group;
  }

  return assignments;
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
