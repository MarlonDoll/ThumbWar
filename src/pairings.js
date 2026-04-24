// Build drawing assignments for each title.
//
// Rules:
// - Every title gets at least one drawing.
// - No player ever draws their own title.
// - Workload is split as evenly as possible across players.
// - For 4+ players we rotate offsets so pairings don't repeat.
//
// Returns: { [writerId]: [drawerId, drawerId, ...], ... }
function buildAssignments(playerIds) {
  const n = playerIds.length;
  const assignments = {};

  if (n === 0) return assignments;

  if (n === 1) {
    // Solo: the one player draws their own title (self-review / gallery).
    assignments[playerIds[0]] = [playerIds[0]];
    return assignments;
  }

  if (n === 2) {
    // Swap mode: each player draws the other's title.
    assignments[playerIds[0]] = [playerIds[1]];
    assignments[playerIds[1]] = [playerIds[0]];
    return assignments;
  }

  if (n === 3) {
    // Classic battle: the other two players draw each title.
    for (let i = 0; i < n; i++) {
      assignments[playerIds[i]] = [
        playerIds[(i + 1) % n],
        playerIds[(i + 2) % n]
      ];
    }
    return assignments;
  }

  // 4+ players: 2 drawers per title. Drawer k for writer i is
  // player[(i + k + 1) % n] with k in {0, 1}. This keeps each
  // player drawing exactly 2 titles and rotates matchups.
  const drawersPerTitle = n >= 6 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const drawers = [];
    for (let k = 1; k <= drawersPerTitle; k++) {
      drawers.push(playerIds[(i + k) % n]);
    }
    assignments[playerIds[i]] = drawers;
  }
  return assignments;
}

// Flatten assignments into a list of (writerId, drawerId) tasks per player.
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
