// Scoring rules (per spec: reward both title writing and thumbnail art,
// and endgame concept awards):
//
//   - Winning a clickability matchup (as artist): 1000 pts
//   - Every click/vote your thumbnail receives:    150 pts
//   - Title whose matchup drew unanimous votes (writer bonus): 300 pts
//   - Endgame award win (writer credited):        1500 pts
//   - Endgame award runner-up:                     500 pts
//
// Ties in a matchup: all tied thumbnails count as winners.

const POINTS = {
  MATCHUP_WIN: 1000,
  PER_CLICK: 150,
  UNANIMOUS_TITLE_BONUS: 300,
  ENDGAME_AWARD_WIN: 1500,
  ENDGAME_AWARD_RUNNER_UP: 500
};

function zero(players) {
  const scores = {};
  for (const p of players) scores[p.id] = 0;
  return scores;
}

// voteTallies: [{ writerId, votes: { [thumbnailId]: count }, thumbnails: [{id, artistId}] }]
function scoreMatchups(voteTallies, scores) {
  for (const tally of voteTallies) {
    let max = -1;
    for (const id of Object.keys(tally.votes)) {
      if (tally.votes[id] > max) max = tally.votes[id];
    }
    const winners = new Set(
      Object.keys(tally.votes).filter((id) => tally.votes[id] === max && max > 0)
    );

    let totalVotes = 0;
    for (const id of Object.keys(tally.votes)) totalVotes += tally.votes[id];

    for (const thumb of tally.thumbnails) {
      const v = tally.votes[thumb.id] || 0;
      scores[thumb.artistId] =
        (scores[thumb.artistId] || 0) + v * POINTS.PER_CLICK;
      if (winners.has(thumb.id)) {
        scores[thumb.artistId] =
          (scores[thumb.artistId] || 0) + POINTS.MATCHUP_WIN;
      }
    }

    // Unanimous: one thumbnail got all the votes (and there were at least 2 options).
    if (tally.thumbnails.length >= 2 && winners.size === 1 && totalVotes > 0) {
      const winnerId = [...winners][0];
      const winning = tally.thumbnails.find((t) => t.id === winnerId);
      const onlyThisGotVotes = Object.keys(tally.votes).every(
        (id) => id === winnerId || (tally.votes[id] || 0) === 0
      );
      if (onlyThisGotVotes && winning) {
        scores[tally.writerId] =
          (scores[tally.writerId] || 0) + POINTS.UNANIMOUS_TITLE_BONUS;
      }
    }
  }
}

// awardTallies: { bestTitle: { [conceptId]: count }, bestThumb: { [thumbnailId]: count } }
// concepts: [{ id, writerId, artistId, allThumbnails: [{id, artistId}] }]
function scoreAwards(awardTallies, concepts, scores) {
  const results = {};
  for (const key of Object.keys(awardTallies)) {
    const votes = awardTallies[key];
    const sorted = Object.keys(votes)
      .map((id) => ({ id, v: votes[id] }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    if (sorted.length === 0) {
      results[key] = null;
      continue;
    }
    const topVotes = sorted[0].v;
    const winners = sorted.filter((r) => r.v === topVotes);

    const findOwners = (targetId) => {
      if (key === 'bestThumb') {
        for (const c of concepts) {
          const t = (c.allThumbnails || []).find((x) => x.id === targetId);
          if (t) return { writerId: c.writerId, artistId: t.artistId, conceptId: c.id };
        }
        return null;
      }
      // bestTitle votes by conceptId
      const c = concepts.find((x) => x.id === targetId);
      if (!c) return null;
      return { writerId: c.writerId, artistId: c.artistId, conceptId: c.id };
    };

    for (const w of winners) {
      const owners = findOwners(w.id);
      if (!owners) continue;
      if (key === 'bestThumb') {
        // Artist of the winning thumbnail gets the award
        scores[owners.artistId] =
          (scores[owners.artistId] || 0) + POINTS.ENDGAME_AWARD_WIN;
      } else {
        // Title writer gets the award; sometimes credit the artist too
        scores[owners.writerId] =
          (scores[owners.writerId] || 0) + POINTS.ENDGAME_AWARD_WIN;
      }
    }
    const runnerUps = sorted.filter((r) => r.v < topVotes).slice(0, 1);
    for (const r of runnerUps) {
      const owners = findOwners(r.id);
      if (!owners) continue;
      const credit = key === 'bestThumb' ? owners.artistId : owners.writerId;
      scores[credit] = (scores[credit] || 0) + POINTS.ENDGAME_AWARD_RUNNER_UP;
    }
    results[key] = { winners: winners.map((w) => w.id), tallies: votes };
  }
  return results;
}

module.exports = { POINTS, zero, scoreMatchups, scoreAwards };
