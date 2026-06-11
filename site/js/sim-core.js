/*
 * sim-core.js — World Cup 2026 Monte Carlo simulator, ported from
 * seattle_wc_sim.py / cheer_guide.py and generalized: instead of tracking only
 * Seattle's two matches, every simulation records the participants and winner
 * of all 32 knockout matches plus every group finishing position, packed into
 * compact typed arrays. That lets the UI recompute personalized analyses
 * (different preference weights, different attended-match sets) instantly
 * without re-simulating.
 *
 * Pure module — no DOM, no fetch — so it runs identically in the Web Worker
 * and under `node --test` (tests/sim-core.test.mjs).
 *
 * Model (identical to the Python sim; see CLAUDE.md "Model details"):
 *   Elo expectation E = 1/(1+10^(-diff/600)) (FIFA's 600 scale); goals are
 *   independent Poisson with lambda_a = 2.7*E, lambda_b = 2.7*(1-E); knockout
 *   ties break with probability 0.5 + 0.4*(E-0.5) as an ET/penalties proxy.
 *   2026 tiebreakers: points, then head-to-head (points/GD/goals) among tied
 *   teams, then overall GD/goals, then FIFA ranking (conduct not simulated).
 *   Best 8 third-placed teams routed to bracket slots by FIFA's Annex C table.
 */

export const BASE_GOALS = 2.7;
export const EMPHASIS = 2.0;        // convexity of the preference curve
export const LIKE_FLOOR = 0.5;      // loyalty guard: "a team you clearly like"
export const SWING_THRESHOLD = 0.03; // loyalty guard: minimum worthwhile swing

const GROUP_LETTERS = "ABCDEFGHIJKL";
const NONE = 255;

// --- RNG (mulberry32) — seeded for reproducibility -------------------------

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Match model ------------------------------------------------------------

export function expectedScore(ra, rb) {
  return 1.0 / (1.0 + Math.pow(10, -(ra - rb) / 600.0));
}

export function poisson(lam, rnd) {
  const L = Math.exp(-lam);
  let k = 0, p = 1.0;
  for (;;) {
    p *= rnd();
    if (p <= L) return k;
    k += 1;
  }
}

export function simulateMatch(ra, rb, knockout, rnd) {
  const e = expectedScore(ra, rb);
  let ga = poisson(BASE_GOALS * e, rnd);
  let gb = poisson(BASE_GOALS * (1 - e), rnd);
  if (knockout && ga === gb) {
    if (rnd() < 0.5 + 0.4 * (e - 0.5)) ga += 1; else gb += 1;
  }
  return [ga, gb];
}

// --- Data preparation --------------------------------------------------------

/**
 * Index the static tournament.json into the structures the hot loop needs.
 * Teams get stable integer ids (alphabetical); group games keep their
 * chronological order (index 0..71).
 */
export function prepare(tournament) {
  const teams = Object.values(tournament.groups).flat().slice().sort();
  const ti = new Map(teams.map((t, i) => [t, i]));
  const ratings = new Float64Array(teams.length);
  for (const [t, r] of Object.entries(tournament.ratings)) ratings[ti.get(t)] = r;

  // groupTeams[g][0..3] = team ids of group GROUP_LETTERS[g]
  const groupTeams = [];
  for (const L of GROUP_LETTERS) {
    groupTeams.push(tournament.groups[L].map((t) => ti.get(t)));
  }

  const groupGames = tournament.group_games.map((g, idx) => ({
    idx, id: g.id, a: ti.get(g.a), b: ti.get(g.b),
    group: GROUP_LETTERS.indexOf(g.group),
    kickoff: g.kickoff, ground: g.ground,
  }));
  const gamesOfGroup = GROUP_LETTERS.split("").map(() => []);
  for (const g of groupGames) gamesOfGroup[g.group].push(g);

  const ko = tournament.knockout.map((m) => ({
    num: m.num, id: m.id, slot1: m.slot1, slot2: m.slot2,
    round: m.round, kickoff: m.kickoff, ground: m.ground,
  }));

  const annex = new Map(tournament.annex_c.map((r) => [r.key, r.assign]));

  return { teams, ti, ratings, groupTeams, groupGames, gamesOfGroup, ko, annex };
}

/**
 * Index results.json into fast lookups.
 * Returns { scores: Int16Array(144) (-1 = unplayed, else [2i]=ga,[2i+1]=gb),
 *           koWinner: Uint8Array(32) (team id or NONE),
 *           koKnown:  Array(32) of [t1,t2] or null (real participants known),
 *           playedCount }
 */
export function prepareResults(prep, results) {
  const scores = new Int16Array(prep.groupGames.length * 2).fill(-1);
  const byId = new Map(prep.groupGames.map((g) => [g.id, g.idx]));
  let playedCount = 0;
  for (const [id, [ga, gb]] of Object.entries(results?.group_results || {})) {
    const idx = byId.get(id);
    if (idx === undefined) continue;
    scores[2 * idx] = ga;
    scores[2 * idx + 1] = gb;
    playedCount += 1;
  }
  const koWinner = new Uint8Array(prep.ko.length).fill(NONE);
  const koKnown = prep.ko.map(() => null);
  for (const [id, entry] of Object.entries(results?.knockout || {})) {
    const i = prep.ko.findIndex((m) => m.id === id);
    if (i < 0) continue;
    const t1 = prep.ti.get(entry.team1), t2 = prep.ti.get(entry.team2);
    if (t1 !== undefined && t2 !== undefined) koKnown[i] = [t1, t2];
    const w = prep.ti.get(entry.winner);
    if (w !== undefined) koWinner[i] = w;
  }
  return { scores, koWinner, koKnown, playedCount };
}

// --- Group ranking (official 2026 tiebreakers) -------------------------------

/**
 * Rank 4 team ids by: points; then among point-tied teams head-to-head
 * points/GD/goals; then overall GD, goals; then rating (FIFA-ranking proxy).
 * `games` is the group's 6 fixtures with scores filled in.
 * Returns { order: [4 ids best->worst], pts, gd, gf } (per-team-id maps).
 */
export function rankGroup(teamIds, games, ratings) {
  const pts = new Map(), gd = new Map(), gf = new Map();
  for (const t of teamIds) { pts.set(t, 0); gd.set(t, 0); gf.set(t, 0); }
  for (const { a, b, ga, gb } of games) {
    gd.set(a, gd.get(a) + ga - gb); gd.set(b, gd.get(b) + gb - ga);
    gf.set(a, gf.get(a) + ga); gf.set(b, gf.get(b) + gb);
    if (ga > gb) pts.set(a, pts.get(a) + 3);
    else if (gb > ga) pts.set(b, pts.get(b) + 3);
    else { pts.set(a, pts.get(a) + 1); pts.set(b, pts.get(b) + 1); }
  }

  const order = [];
  const levels = [...new Set(teamIds.map((t) => pts.get(t)))].sort((x, y) => y - x);
  for (const p of levels) {
    const tied = teamIds.filter((t) => pts.get(t) === p);
    if (tied.length > 1) {
      const inTied = new Set(tied);
      const hp = new Map(), hgd = new Map(), hgf = new Map();
      for (const t of tied) { hp.set(t, 0); hgd.set(t, 0); hgf.set(t, 0); }
      for (const { a, b, ga, gb } of games) {
        if (!inTied.has(a) || !inTied.has(b)) continue;
        hgd.set(a, hgd.get(a) + ga - gb); hgd.set(b, hgd.get(b) + gb - ga);
        hgf.set(a, hgf.get(a) + ga); hgf.set(b, hgf.get(b) + gb);
        if (ga > gb) hp.set(a, hp.get(a) + 3);
        else if (gb > ga) hp.set(b, hp.get(b) + 3);
        else { hp.set(a, hp.get(a) + 1); hp.set(b, hp.get(b) + 1); }
      }
      tied.sort((x, y) =>
        (hp.get(y) - hp.get(x)) || (hgd.get(y) - hgd.get(x)) || (hgf.get(y) - hgf.get(x)) ||
        (gd.get(y) - gd.get(x)) || (gf.get(y) - gf.get(x)) ||
        (ratings[y] - ratings[x]));
    }
    order.push(...tied);
  }
  return { order, pts, gd, gf };
}

// --- One full tournament ------------------------------------------------------

const RE_FIRST = /^1([A-L])$/, RE_SECOND = /^2([A-L])$/, RE_WINNER = /^W(\d+)$/,
      RE_LOSER = /^L(\d+)$/;

/**
 * Simulate one tournament, honoring known results in `fixed` (from
 * prepareResults). Writes the packed record at sim slot `s` of `store`.
 */
export function simulateTournament(prep, fixed, rnd, store, s) {
  const { ratings, groupTeams, gamesOfGroup, ko, annex } = prep;
  const { outcomes, positions, koTeams, koWin } = store;
  const oBase = s * 72, pBase = s * 48, tBase = s * 64, wBase = s * 32;

  // Group stage: real scores where present, simulated otherwise.
  const thirds = new Array(12);
  const thirdKey = new Array(12);
  for (let g = 0; g < 12; g++) {
    const games = [];
    for (const game of gamesOfGroup[g]) {
      let ga = fixed.scores[2 * game.idx], gb = fixed.scores[2 * game.idx + 1];
      if (ga < 0) {
        [ga, gb] = simulateMatch(ratings[game.a], ratings[game.b], false, rnd);
      }
      games.push({ a: game.a, b: game.b, ga, gb });
      outcomes[oBase + game.idx] = ga > gb ? 0 : ga < gb ? 2 : 1;
    }
    const { order, pts, gd, gf } = rankGroup(groupTeams[g], games, ratings);
    for (let i = 0; i < 4; i++) positions[pBase + 4 * g + i] = order[i];
    const t3 = order[2];
    thirds[g] = t3;
    thirdKey[g] = [pts.get(t3), gd.get(t3), gf.get(t3), ratings[t3]];
  }

  // Best 8 thirds -> Annex C row -> {matchNum: groupLetter}.
  const groupIdxs = [...Array(12).keys()];
  groupIdxs.sort((x, y) => {
    const a = thirdKey[x], b = thirdKey[y];
    return (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]) || (b[3] - a[3]);
  });
  const qualified = groupIdxs.slice(0, 8).map((g) => GROUP_LETTERS[g]).sort();
  const assign = annex.get(qualified.join(""));

  // Knockout bracket in match-number order; slots reference earlier results.
  const winners = new Map(), losers = new Map();
  for (let i = 0; i < ko.length; i++) {
    const m = ko[i];
    const resolve = (code) => {
      let r;
      if ((r = RE_FIRST.exec(code))) return positions[pBase + 4 * GROUP_LETTERS.indexOf(r[1])];
      if ((r = RE_SECOND.exec(code))) return positions[pBase + 4 * GROUP_LETTERS.indexOf(r[1]) + 1];
      if ((r = RE_WINNER.exec(code))) return winners.get(+r[1]);
      if ((r = RE_LOSER.exec(code))) return losers.get(+r[1]);
      // "3A/E/H/I/J" — the third assigned to THIS match by Annex C
      return thirds[GROUP_LETTERS.indexOf(assign[String(m.num)])];
    };
    const t1 = resolve(m.slot1), t2 = resolve(m.slot2);
    let w = fixed.koWinner[i];
    if (w !== t1 && w !== t2) {        // unknown, or stale vs. simulated lineup
      const [ga, gb] = simulateMatch(ratings[t1], ratings[t2], true, rnd);
      w = ga > gb ? t1 : t2;
    }
    winners.set(m.num, w);
    losers.set(m.num, w === t1 ? t2 : t1);
    koTeams[tBase + 2 * i] = t1;
    koTeams[tBase + 2 * i + 1] = t2;
    koWin[wBase + i] = w;
  }
}

/**
 * Run n simulations. Returns the packed store; ~216 bytes per sim.
 * onProgress(done, total) is called every few thousand sims if given.
 */
export function runSims(prep, fixed, n, seed = 42, onProgress = null) {
  const store = {
    n,
    outcomes: new Uint8Array(n * 72),
    positions: new Uint8Array(n * 48),
    koTeams: new Uint8Array(n * 64),
    koWin: new Uint8Array(n * 32),
  };
  const rnd = makeRng(seed);
  for (let s = 0; s < n; s++) {
    simulateTournament(prep, fixed, rnd, store, s);
    if (onProgress && (s + 1) % 2000 === 0) onProgress(s + 1, n);
  }
  return store;
}

// --- Preference-independent probabilities --------------------------------------

/**
 * P(team appears in knockout match), tallied separately per slot (home/away
 * sides of the bracket line), plus the joint MATCHUP distribution, for all 32
 * matches + champion odds.
 * matches[i] = { slot1: [[teamIdx, p] desc...], slot2: [...],
 *                matchups: [[teamIdx1, teamIdx2, p] desc...] (every observed
 *                pair, so the UI can answer arbitrary "X vs Y?" queries) }.
 */
export function appearanceProbs(prep, store, topMatchups = Infinity) {
  const { n, koTeams, koWin } = store;
  const nt = prep.teams.length;
  const counts1 = Array.from({ length: 32 }, () => new Float64Array(nt));
  const counts2 = Array.from({ length: 32 }, () => new Float64Array(nt));
  const pairs = Array.from({ length: 32 }, () => new Map());
  const champ = new Float64Array(nt);
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < 32; i++) {
      const t1 = koTeams[s * 64 + 2 * i], t2 = koTeams[s * 64 + 2 * i + 1];
      counts1[i][t1] += 1;
      counts2[i][t2] += 1;
      const key = t1 * 64 + t2;
      pairs[i].set(key, (pairs[i].get(key) ?? 0) + 1);
    }
    champ[koWin[s * 32 + 31]] += 1;
  }
  const toSorted = (arr) => {
    const out = [];
    for (let t = 0; t < nt; t++) if (arr[t] > 0) out.push([t, arr[t] / n]);
    out.sort((a, b) => b[1] - a[1]);
    return out;
  };
  const topPairs = (m) => [...m.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topMatchups)
    .map(([key, c]) => [Math.floor(key / 64), key % 64, c / n]);
  return {
    matches: counts1.map((c1, i) => ({
      slot1: toSorted(c1), slot2: toSorted(counts2[i]), matchups: topPairs(pairs[i]),
    })),
    champion: toSorted(champ),
  };
}

/** Per team: P(finish 1st / 2nd / 3rd in group) and P(reach knockout). */
export function groupProbs(prep, store) {
  const { n, positions, koTeams } = store;
  const nt = prep.teams.length;
  const pos = Array.from({ length: 3 }, () => new Float64Array(nt));
  const reach = new Float64Array(nt);
  const seen = new Int32Array(nt).fill(-1);
  for (let s = 0; s < n; s++) {
    for (let g = 0; g < 12; g++) {
      for (let i = 0; i < 3; i++) pos[i][positions[s * 48 + 4 * g + i]] += 1;
    }
    for (let i = 0; i < 16; i++) {   // R32 participants = advanced from group
      for (const t of [koTeams[s * 64 + 2 * i], koTeams[s * 64 + 2 * i + 1]]) {
        if (seen[t] !== s) { seen[t] = s; reach[t] += 1; }
      }
    }
  }
  return {
    first: pos[0].map((c) => c / n),
    second: pos[1].map((c) => c / n),
    third: pos[2].map((c) => c / n),
    advance: Array.from(reach, (c) => c / n),
  };
}

// --- Personalized cheer-guide analysis ------------------------------------------

export function emphasize(w, gamma = EMPHASIS) {
  if (gamma === 0) return w;
  return (Math.exp(gamma * w) - 1.0) / (Math.exp(gamma) - 1.0);
}

/**
 * Loyalty guard, generalized from cheer_guide.assess_loyalty. Decides whether
 * recommending `best` ("A"/"B"/"D") for the game a-vs-b roots AGAINST a team
 * you like, and if so whether the payoff justifies it. Unlike the original
 * (Seattle-era) version, the payoff can arrive via ANY liked team — e.g.
 * rooting against Canada because it lifts Switzerland's group-winner path —
 * not only via the denied team's own third-place routing.
 *
 * Args object:
 *   a, b           participant team names
 *   wa, wb         their preference weights
 *   best           recommended outcome
 *   pSeatA, pSeatB {outcome: P(participant in your attended lineup | outcome)}
 *   likedP         {teamName: {outcome: p}} for every liked team (may include
 *                  a/b; the denied team is excluded from the beneficiary scan)
 *
 * Returns null when the recommendation isn't perverse, else:
 *   { against, againstW, pRec, pWin, swing, kind, suppressible,
 *     beneficiary?, benRec?, benWin?, benSwing? }
 * kind: "self"  — the denied team itself gains enough (their best path),
 *       "other" — a different liked team gains enough (beneficiary fields set),
 *       "none"  — helps nobody you like => suppressible.
 */
export function assessLoyalty({ a, b, wa, wb, best, pSeatA, pSeatB,
                                likedP = {} }, opts = {}) {
  const likeFloor = opts.likeFloor ?? LIKE_FLOOR;
  const swingThreshold = opts.swingThreshold ?? SWING_THRESHOLD;
  let againstIsA, againstW, rootedForW;
  if (best === "A") { againstIsA = false; againstW = wb; rootedForW = wa; }
  else if (best === "B") { againstIsA = true; againstW = wa; rootedForW = wb; }
  else { againstIsA = wa >= wb; againstW = Math.max(wa, wb); rootedForW = -1.0; }
  if (againstW < likeFloor || againstW <= rootedForW) return null;
  const against = againstIsA ? a : b;
  const p = againstIsA ? pSeatA : pSeatB;
  const oWin = againstIsA ? "A" : "B";  // the denied team's own-win outcome
  const pRec = p[best] ?? 0.0, pWin = p[oWin] ?? 0.0;
  const swing = pRec - pWin;
  const out = { against, againstW, pRec, pWin, swing };
  if (swing >= swingThreshold) {
    return { ...out, kind: "self", suppressible: false };
  }
  // The denied team doesn't gain — does another liked team?
  let ben = null;
  for (const [team, pt] of Object.entries(likedP)) {
    if (team === against) continue;
    const gain = (pt[best] ?? 0.0) - (pt[oWin] ?? 0.0);
    if (gain >= swingThreshold && (!ben || gain > ben.benSwing)) {
      ben = { beneficiary: team, benRec: pt[best] ?? 0.0,
              benWin: pt[oWin] ?? 0.0, benSwing: gain };
    }
  }
  if (ben) return { ...out, ...ben, kind: "other", suppressible: false };
  return { ...out, kind: "none", suppressible: true };
}

/**
 * The cheer guide: given preference weights (team name -> [0,1]) and the set
 * of attended match ids (group ids "A|B" and knockout ids "m73".."m104"),
 * score every UNDECIDED game by how much its outcome swings the expected
 * emphasized total preference of your attended lineup.
 *
 * Group games bucket by A-win/draw/B-win. Knockout games are included once
 * their REAL participants are known (fixed.koKnown) but the match is unplayed
 * — they bucket by winner. Already-played games are skipped (their outcome is
 * a constant across sims).
 *
 * Returns { rows, summary }; rows sorted by impact desc, each:
 *   { kind, id, a, b, group?, best, means, counts, impact, significant,
 *     pSeatA, pSeatB, loyalty }
 * with a/b as team NAMES and loyalty.against as a team name.
 */
export function analyzeCheer(prep, fixed, store, weights, attendedIds, opts = {}) {
  const gamma = opts.emphasis ?? EMPHASIS;
  const likeFloor = opts.likeFloor ?? LIKE_FLOOR;
  const { n, outcomes, koTeams } = store;
  const nt = prep.teams.length;

  const ew = new Float64Array(nt);
  for (let t = 0; t < nt; t++) ew[t] = emphasize(weights[prep.teams[t]] ?? 0.0, gamma);

  // Teams you clearly like: tracked per game/outcome so the loyalty guard can
  // credit cross-team payoffs and the UI can show the full-lineup reasoning.
  // Capped at the 10 highest-weighted (counter cost is per liked team per game).
  const likedIdx = [];
  for (let t = 0; t < nt; t++) if ((weights[prep.teams[t]] ?? 0.0) >= likeFloor) likedIdx.push(t);
  likedIdx.sort((x, y) => (weights[prep.teams[y]] ?? 0) - (weights[prep.teams[x]] ?? 0));
  likedIdx.length = Math.min(likedIdx.length, 10);
  const nLiked = likedIdx.length;

  // Attended matches -> the indices the per-sim lineup is built from.
  const attended = new Set(attendedIds);
  const attGroup = prep.groupGames.filter((g) => attended.has(g.id));
  const attKo = [];
  prep.ko.forEach((m, i) => { if (attended.has(m.id)) attKo.push(i); });

  // Undecided games to score.
  const groupRows = prep.groupGames.filter((g) => fixed.scores[2 * g.idx] < 0);
  const koRows = [];
  prep.ko.forEach((m, i) => {
    if (fixed.koKnown[i] && fixed.koWinner[i] === NONE) koRows.push(i);
  });

  // Buckets: per game per outcome ->
  //   [sumU, count, aInLineup, bInLineup, perLikedTeamInLineup[]]
  const mkCell = () => [0, 0, 0, 0, new Float64Array(nLiked)];
  const mkBucket = () => ({ A: mkCell(), D: mkCell(), B: mkCell() });
  const gBuckets = groupRows.map(mkBucket);
  const kBuckets = koRows.map(mkBucket);

  const mark = new Int32Array(nt).fill(-1);
  let totalU = 0, totalU2 = 0;
  let topIdx = -1, topW = -Infinity;
  for (let t = 0; t < nt; t++) if (ew[t] > topW) { topW = ew[t]; topIdx = t; }
  let topIn = 0;

  for (let s = 0; s < n; s++) {
    // Lineup = distinct teams across attended matches this sim.
    let u = 0;
    for (const g of attGroup) {
      for (const t of [g.a, g.b]) if (mark[t] !== s) { mark[t] = s; u += ew[t]; }
    }
    for (const i of attKo) {
      for (const t of [koTeams[s * 64 + 2 * i], koTeams[s * 64 + 2 * i + 1]]) {
        if (mark[t] !== s) { mark[t] = s; u += ew[t]; }
      }
    }
    totalU += u; totalU2 += u * u;
    if (mark[topIdx] === s) topIn += 1;

    for (let r = 0; r < groupRows.length; r++) {
      const g = groupRows[r];
      const o = outcomes[s * 72 + g.idx];
      const cell = gBuckets[r][o === 0 ? "A" : o === 1 ? "D" : "B"];
      cell[0] += u; cell[1] += 1;
      if (mark[g.a] === s) cell[2] += 1;
      if (mark[g.b] === s) cell[3] += 1;
      for (let l = 0; l < nLiked; l++) if (mark[likedIdx[l]] === s) cell[4][l] += 1;
    }
    for (let r = 0; r < koRows.length; r++) {
      const i = koRows[r];
      const [t1, t2] = fixed.koKnown[i];
      const w = store.koWin[s * 32 + i];
      // Sims where the simulated lineup differs from the real one tell us
      // nothing about this real matchup — skip them.
      if ((koTeams[s * 64 + 2 * i] !== t1 || koTeams[s * 64 + 2 * i + 1] !== t2) &&
          (koTeams[s * 64 + 2 * i] !== t2 || koTeams[s * 64 + 2 * i + 1] !== t1)) continue;
      const cell = kBuckets[r][w === t1 ? "A" : "B"];
      cell[0] += u; cell[1] += 1;
      if (mark[t1] === s) cell[2] += 1;
      if (mark[t2] === s) cell[3] += 1;
      for (let l = 0; l < nLiked; l++) if (mark[likedIdx[l]] === s) cell[4][l] += 1;
    }
  }

  const varU = Math.max(totalU2 / n - (totalU / n) ** 2, 0);

  const buildRow = (kind, id, aIdx, bIdx, bucket, extra) => {
    const means = {}, counts = {}, pSeatA = {}, pSeatB = {};
    const pLineup = {};
    for (let l = 0; l < nLiked; l++) pLineup[prep.teams[likedIdx[l]]] = {};
    for (const o of ["A", "D", "B"]) {
      const [sum, c, ra, rb, lc] = bucket[o];
      if (!c) continue;
      means[o] = sum / c; counts[o] = c;
      pSeatA[o] = ra / c; pSeatB[o] = rb / c;
      for (let l = 0; l < nLiked; l++) pLineup[prep.teams[likedIdx[l]]][o] = lc[l] / c;
    }
    const os = Object.keys(means);
    if (os.length < 2) return null;   // outcome effectively decided in-sim
    let best = os[0], worst = os[0];
    for (const o of os) {
      if (means[o] > means[best]) best = o;
      if (means[o] < means[worst]) worst = o;
    }
    const impact = means[best] - means[worst];
    const se = varU > 0
      ? Math.sqrt(varU * (1 / counts[best] + 1 / counts[worst])) : 0;
    const a = prep.teams[aIdx], b = prep.teams[bIdx];
    const loyalty = assessLoyalty({
      a, b,
      wa: weights[a] ?? 0.0, wb: weights[b] ?? 0.0,
      best, pSeatA, pSeatB, likedP: pLineup,
    }, opts);
    return {
      kind, id, a, b,
      means, counts, best, impact, significant: impact > 3 * se,
      pSeatA, pSeatB, pLineup, loyalty, ...extra,
    };
  };

  const rows = [];
  groupRows.forEach((g, r) => {
    const row = buildRow("group", g.id, g.a, g.b, gBuckets[r],
                         { group: GROUP_LETTERS[g.group], kickoff: g.kickoff, ground: g.ground });
    if (row) rows.push(row);
  });
  koRows.forEach((i, r) => {
    const m = prep.ko[i];
    const [t1, t2] = fixed.koKnown[i];
    const row = buildRow("ko", m.id, t1, t2, kBuckets[r],
                         { round: m.round, kickoff: m.kickoff, ground: m.ground });
    if (row) rows.push(row);
  });
  rows.sort((x, y) => y.impact - x.impact);

  return {
    rows,
    summary: {
      nSims: n,
      baselineU: totalU / n,
      topTeam: prep.teams[topIdx],
      pTopInLineup: topIn / n,
    },
  };
}
