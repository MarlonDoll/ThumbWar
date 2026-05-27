// Build drawing assignments for each round.
//
// Each player draws exactly 1 thumbnail per round. Titles are paired
// into VS battles (2 drawers each). With odd player counts, one
// matchup becomes a 3-way VS to use the extra player.
//
// Not all titles get drawn each round — only enough to give every
// player exactly 1 task. Over multiple rounds, different titles
// rotate in.
//
// Returns: { [writerId]: [drawerId, ...], ... }
//   Only titles that are being drawn have entries.

function buildAssignments(playerIds, roundIndex) {
  const n = playerIds.length;
  const assignments = {};

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
    // 3 players: 1 title gets all 3 drawing it (3-way VS). Rotate
    // which title is picked based on round index.
    const writerIdx = (roundIndex || 0) % n;
    const writerId = playerIds[writerIdx];
    const drawers = playerIds.filter((id) => id !== writerId);
    // Add the writer too so it's a 3-way (writer also draws their own?
    // No — writer shouldn't draw own. With 3 players, 1 title, 2
    // drawers means one player has nothing to draw. Instead: pick 1
    // title drawn by the other 2 (2-way VS), and... the 3rd player
    // draws a second title for a separate reveal.
    //
    // Simpler: 3 players = special case. Pick 1 title for 2-way VS,
    // second title for solo reveal by the remaining player.
    const d1 = playerIds[(writerIdx + 1) % n];
    const d2 = playerIds[(writerIdx + 2) % n];
    const writer2 = d1;
    assignments[writerId] = [d1, d2];
    assignments[writer2] = [playerIds[writerIdx]];
    return assignments;
  }

  // 4+ players: pair drawers into 2-player VS battles.
  // Each player draws exactly 1 thumbnail.
  // Use a rotation offset based on roundIndex so different titles
  // get drawn each round.
  const offset = ((roundIndex || 0) * 2) % n;

  if (n % 2 === 0) {
    // Even: N/2 titles, 2 drawers each
    for (let i = 0; i < n; i += 2) {
      const d1 = playerIds[(i + offset) % n];
      const d2 = playerIds[(i + 1 + offset) % n];
      // Pick a title neither drew — use a different offset
      const writerIdx = (i + offset + Math.floor(n / 2)) % n;
      const writerId = playerIds[writerIdx];
      if (!assignments[writerId]) {
        assignments[writerId] = [d1, d2];
      } else {
        // Collision — find another unused title
        for (let j = 0; j < n; j++) {
          const alt = playerIds[(writerIdx + j) % n];
          if (!assignments[alt] && alt !== d1 && alt !== d2) {
            assignments[alt] = [d1, d2];
            break;
          }
        }
      }
    }
  } else {
    // Odd: (N-3)/2 titles with 2 drawers + 1 title with 3 drawers
    // First, pair everyone except the last 3
    const paired = n - 3;
    for (let i = 0; i < paired; i += 2) {
      const d1 = playerIds[(i + offset) % n];
      const d2 = playerIds[(i + 1 + offset) % n];
      const writerIdx = (i + offset + Math.floor(n / 2)) % n;
      let writerId = playerIds[writerIdx];
      if (assignments[writerId] || writerId === d1 || writerId === d2) {
        for (let j = 0; j < n; j++) {
          const alt = playerIds[(writerIdx + j) % n];
          if (!assignments[alt] && alt !== d1 && alt !== d2) {
            writerId = alt;
            break;
          }
        }
      }
      assignments[writerId] = [d1, d2];
    }
    // Last 3 form a 3-way VS
    const last3 = [
      playerIds[(paired + offset) % n],
      playerIds[(paired + 1 + offset) % n],
      playerIds[(paired + 2 + offset) % n]
    ];
    // Find a title not already assigned, not written by any of the 3
    let triWriter = null;
    for (let j = 0; j < n; j++) {
      const cand = playerIds[(paired + offset + Math.floor(n / 2) + j) % n];
      if (!assignments[cand] && !last3.includes(cand)) {
        triWriter = cand;
        break;
      }
    }
    if (!triWriter) {
      // Fallback: use any unassigned title
      for (let j = 0; j < n; j++) {
        const cand = playerIds[j];
        if (!assignments[cand]) { triWriter = cand; break; }
      }
    }
    if (triWriter) {
      assignments[triWriter] = last3;
    }
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
