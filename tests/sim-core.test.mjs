/*
 * Node test suite for the site's simulator (site/js/sim-core.js) and
 * preference module (site/js/prefs.js). Crucially, it cross-validates the
 * engine against the original Python simulator's published findings
 * (CLAUDE.md "Key findings"): Belgium ~58% to appear in Match 82, USA ~31%
 * in Match 94, etc. — those anchors survive the Python code's removal.
 *
 * Run from the repo root:  node --test "tests/**"
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  makeRng, expectedScore, simulateMatch, rankGroup,
  prepare, prepareResults, runSims,
  appearanceProbs, groupProbs, analyzeCheer,
  emphasize, assessLoyalty,
} from "../site/js/sim-core.js";
import {
  computeScores, computeCounts, computeWeights, applyPins, pickPair,
  UNPINNED_CAP,
} from "../site/js/prefs.js";

const tournament = JSON.parse(readFileSync(new URL("../site/data/tournament.json", import.meta.url)));
const prep = prepare(tournament);
const noResults = prepareResults(prep, { group_results: {}, knockout: {} });

const GROUP_LETTERS = "ABCDEFGHIJKL";
const teamIdx = (name) => prep.teams.indexOf(name);

// Shared seeded run used by several tests (5k sims keeps the suite fast).
const N = 5000;
const store = runSims(prep, noResults, N, 42);

// --- data integrity ----------------------------------------------------------

test("prepare: 48 distinct rated teams, 72 group games, 32 knockout matches", () => {
  assert.equal(prep.teams.length, 48);
  assert.equal(new Set(prep.teams).size, 48);
  for (const r of prep.ratings) assert.ok(r > 1000);
  assert.equal(new Set(prep.ratings).size, 48, "ratings must stay unique (FIFA-ranking tiebreaker)");
  assert.equal(prep.groupGames.length, 72);
  assert.equal(prep.ko.length, 32);
  assert.equal(prep.annex.size, 495);
  for (const games of prep.gamesOfGroup) assert.equal(games.length, 6);
});

test("match model: Elo symmetry and knockout never ties", () => {
  assert.ok(Math.abs(expectedScore(1500, 1500) - 0.5) < 1e-12);
  assert.ok(Math.abs(expectedScore(1800, 1500) + expectedScore(1500, 1800) - 1) < 1e-12);
  assert.ok(expectedScore(1800, 1500) > 0.5);
  const rnd = makeRng(7);
  for (let i = 0; i < 2000; i++) {
    const [ga, gb] = simulateMatch(1600, 1600, true, rnd);
    assert.notEqual(ga, gb);
  }
});

// --- group ranking (2026 head-to-head-first tiebreakers) ----------------------

test("rankGroup: head-to-head beats overall goal difference", () => {
  // W beats L head-to-head but ends with much worse overall GD; both finish
  // on 6 points. 2026 rules: H2H first => W ranks above L.
  const ids = [0, 1, 2, 3]; // W, L, m1, m2
  const ratings = new Float64Array([1500, 1510, 1400, 1410]);
  const games = [
    { a: 0, b: 1, ga: 1, gb: 0 },  // W beats L h2h
    { a: 0, b: 2, ga: 1, gb: 0 },  // W beats m1
    { a: 0, b: 3, ga: 0, gb: 1 },  // W loses to m2  -> W: 6 pts, GD 0
    { a: 1, b: 2, ga: 9, gb: 0 },  // L crushes m1
    { a: 1, b: 3, ga: 2, gb: 1 },  // L beats m2     -> L: 6 pts, GD +9
    { a: 2, b: 3, ga: 0, gb: 0 },
  ];
  const { order, pts, gd } = rankGroup(ids, games, ratings);
  assert.equal(pts.get(0), 6);
  assert.equal(pts.get(1), 6);
  assert.ok(gd.get(1) > gd.get(0), "L must have better overall GD for the test to bite");
  assert.equal(order[0], 0, "head-to-head winner must rank first despite worse GD");
  assert.equal(order[1], 1);
});

test("rankGroup: points dominate everything", () => {
  const ids = [0, 1, 2, 3];
  const ratings = new Float64Array([1400, 1500, 1600, 1700]);
  const games = [
    { a: 0, b: 1, ga: 1, gb: 0 }, { a: 0, b: 2, ga: 1, gb: 0 },
    { a: 0, b: 3, ga: 1, gb: 0 }, { a: 1, b: 2, ga: 0, gb: 0 },
    { a: 1, b: 3, ga: 0, gb: 0 }, { a: 2, b: 3, ga: 0, gb: 0 },
  ];
  const { order } = rankGroup(ids, games, ratings);
  assert.equal(order[0], 0);
});

// --- full-tournament invariants ------------------------------------------------

test("simulation invariants across sims", () => {
  const gIdx = GROUP_LETTERS.indexOf("G");
  const thirdSlots = { 74: "ABCDF", 77: "CDFGH", 79: "CEFHI", 80: "EHIJK",
                       81: "BEFIJ", 82: "AEHIJ", 85: "EFGIJ", 87: "DEIJL" };
  const groupOf = new Map();
  GROUP_LETTERS.split("").forEach((L, g) =>
    tournament.groups[L].forEach((t) => groupOf.set(teamIdx(t), L)));

  for (let s = 0; s < Math.min(N, 500); s++) {
    // every group position is filled by a team from that group
    for (let g = 0; g < 12; g++) {
      const four = [0, 1, 2, 3].map((i) => store.positions[s * 48 + 4 * g + i]);
      assert.equal(new Set(four).size, 4);
      for (const t of four) assert.equal(groupOf.get(t), GROUP_LETTERS[g]);
    }
    // M82 home team is the Group G winner
    const m82i = 82 - 73;
    assert.equal(store.koTeams[s * 64 + 2 * m82i],
                 store.positions[s * 48 + 4 * gIdx]);
    // third-place slots are filled from slot-legal groups
    for (const [num, allowed] of Object.entries(thirdSlots)) {
      const i = +num - 73;
      const third = store.koTeams[s * 64 + 2 * i + 1];
      assert.ok(allowed.includes(groupOf.get(third)),
        `m${num} third from group ${groupOf.get(third)} not in ${allowed}`);
    }
    // M94 participants are the winners of M81 and M82
    const m94i = 94 - 73;
    assert.equal(store.koTeams[s * 64 + 2 * m94i], store.koWin[s * 32 + (81 - 73)]);
    assert.equal(store.koTeams[s * 64 + 2 * m94i + 1], store.koWin[s * 32 + (82 - 73)]);
    // the final's winner is one of its participants
    const fi = 104 - 73;
    assert.ok([store.koTeams[s * 64 + 2 * fi], store.koTeams[s * 64 + 2 * fi + 1]]
      .includes(store.koWin[s * 32 + fi]));
  }
});

test("seed reproducibility", () => {
  const a = runSims(prep, noResults, 200, 123);
  const b = runSims(prep, noResults, 200, 123);
  assert.deepEqual(a.koWin, b.koWin);
  assert.deepEqual(a.outcomes, b.outcomes);
  const c = runSims(prep, noResults, 200, 124);
  assert.notDeepEqual(a.koWin, c.koWin);
});

// --- cross-validation against the Python sim's published findings ---------------

test("appearance probabilities match the Python sim's findings", () => {
  const probs = appearanceProbs(prep, store);
  // appearanceProbs returns team INDICES per slot (the worker maps to names)
  const p = (matchNum, team) => {
    const { slot1, slot2 } = probs.matches[matchNum - 73];
    const hit = [...slot1, ...slot2].find(([t]) => t === teamIdx(team));
    return hit ? hit[1] : 0;
  };
  // CLAUDE.md key findings (20k sims): Belgium ~58% / Iran ~27% in M82;
  // Belgium ~42%, USA ~31% in M94. Allow generous MC slack at 5k sims.
  assert.ok(Math.abs(p(82, "Belgium") - 0.58) < 0.05, `Belgium m82 = ${p(82, "Belgium")}`);
  assert.ok(Math.abs(p(82, "Iran") - 0.27) < 0.05, `Iran m82 = ${p(82, "Iran")}`);
  assert.ok(Math.abs(p(94, "Belgium") - 0.42) < 0.05, `Belgium m94 = ${p(94, "Belgium")}`);
  assert.ok(Math.abs(p(94, "USA") - 0.31) < 0.05, `USA m94 = ${p(94, "USA")}`);
  // Annex C structural bias: Germany 3rd -> Seattle is ~dead (~0.2%)
  assert.ok(p(82, "Germany") < 0.02, `Germany m82 = ${p(82, "Germany")}`);
  // each slot's probabilities sum to 1
  for (const { slot1, slot2 } of probs.matches) {
    for (const list of [slot1, slot2]) {
      const sum = list.reduce((acc, [, q]) => acc + q, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9);
    }
  }
  const champSum = probs.champion.reduce((acc, [, q]) => acc + q, 0);
  assert.ok(Math.abs(champSum - 1) < 1e-9);
});

test("matchup distributions: complete, coherent, and matching the published finding", () => {
  const probs = appearanceProbs(prep, store);
  for (const { matchups, slot1 } of probs.matches) {
    // full joint distribution: sums to 1, sorted desc
    const sum = matchups.reduce((acc, [, , p]) => acc + p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `matchup sum ${sum}`);
    for (let i = 1; i < matchups.length; i++) {
      assert.ok(matchups[i - 1][2] >= matchups[i][2], "sorted desc");
    }
    // marginal consistency: P(slot1 = top team) equals its pair-sum
    const [topTeam, topP] = slot1[0];
    const pairSum = matchups.filter(([t1]) => t1 === topTeam)
      .reduce((acc, [, , p]) => acc + p, 0);
    assert.ok(Math.abs(pairSum - topP) < 1e-9, "joint marginalizes to slot prob");
  }
  // CLAUDE.md key finding: most likely M94 matchup is Belgium vs USA ~13%.
  const m94 = probs.matches[94 - 73].matchups;
  const [t1, t2, p] = m94[0];
  const names = [prep.teams[t1], prep.teams[t2]].sort();
  assert.deepEqual(names, ["Belgium", "USA"], `top M94 matchup: ${names}`);
  assert.ok(Math.abs(p - 0.13) < 0.05, `P(Belgium vs USA in M94) = ${p}`);
});

test("group probabilities are coherent", () => {
  const gp = groupProbs(prep, store);
  for (const t of ["USA", "Belgium", "Haiti"]) {
    const i = teamIdx(t);
    const top2 = gp.first[i] + gp.second[i];
    assert.ok(gp.advance[i] >= top2 - 1e-9, `${t}: advance >= top2`);
    assert.ok(gp.advance[i] <= top2 + gp.third[i] + 1e-9, `${t}: advance <= top2+third`);
  }
  const usa = teamIdx("USA");
  assert.ok(gp.first[usa] > 0.3, "USA should usually be in the top 2 of group D");
});

// --- known results are honored ---------------------------------------------------

test("prepareResults: real scores pin outcomes; played games leave the cheer rows", () => {
  const g0 = prep.groupGames[0]; // Mexico vs South Africa
  const fixed = prepareResults(prep, {
    group_results: { [g0.id]: [3, 0] },
    knockout: {},
  });
  assert.equal(fixed.playedCount, 1);
  const st = runSims(prep, fixed, 300, 42);
  for (let s = 0; s < 300; s++) {
    assert.equal(st.outcomes[s * 72 + g0.idx], 0, "fixed result must hold in every sim");
  }
  const { rows } = analyzeCheer(prep, fixed, st, { Mexico: 1.0 }, ["m82", "m94"]);
  assert.ok(!rows.some((r) => r.id === g0.id), "played game must not be recommended");
});

test("prepareResults: known knockout winner is honored when participants match", () => {
  // Pin every Group A game so Mexico wins the group deterministically, then
  // pin M79 (1A vs third): winner = Mexico.
  const groupA = tournament.groups.A;
  const fixedScores = {};
  for (const g of prep.groupGames.filter((g) => g.group === 0)) {
    const aName = prep.teams[g.a], bName = prep.teams[g.b];
    if (aName === "Mexico") fixedScores[g.id] = [2, 0];
    else if (bName === "Mexico") fixedScores[g.id] = [0, 2];
    else fixedScores[g.id] = [1, 1];
  }
  const fixed = prepareResults(prep, {
    group_results: fixedScores,
    knockout: { m79: { team1: "Mexico", team2: "whoever", winner: "Mexico" } },
  });
  const st = runSims(prep, fixed, 200, 42);
  const i79 = 79 - 73;
  for (let s = 0; s < 200; s++) {
    assert.equal(prep.teams[st.koTeams[s * 64 + 2 * i79]], "Mexico");
    assert.equal(prep.teams[st.koWin[s * 32 + i79]], "Mexico");
  }
  assert.equal(groupA.length, 4);
});

// --- preference math ----------------------------------------------------------------

test("emphasize: anchored, convex", () => {
  assert.equal(emphasize(0), 0);
  assert.ok(Math.abs(emphasize(1) - 1) < 1e-12);
  assert.ok(emphasize(0.5) < 0.5, "convex curve dips below the diagonal");
  assert.equal(emphasize(0.5, 0), 0.5, "gamma=0 is linear");
});

test("prefs: Elo replay, weights, pair picking", () => {
  const pool = ["A", "B", "C", "D"];
  const scores = computeScores(pool, [["A", "B"], ["A", "C"], ["B", "C"]]);
  assert.ok(scores.get("A") > scores.get("B"));
  assert.ok(scores.get("B") > scores.get("C"));
  const weights = computeWeights(scores);
  assert.equal(Math.max(...Object.values(weights)), 1);
  assert.equal(Math.min(...Object.values(weights)), 0);
  const flat = computeWeights(computeScores(pool, []));
  assert.equal(flat.A, 0.5);
  const counts = computeCounts(pool, [["A", "B"]]);
  const rnd = makeRng(1);
  const pair = pickPair(pool, scores, counts, null, rnd);
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0], pair[1]);
  // least-compared teams (C has 2... D has 0) must be offered
  assert.ok(pair.includes("D"), "least-compared team should be in the next pair");
});

test("computeScores: equal-preference entries pull scores together", () => {
  const pool = ["A", "B"];
  // A tie between fresh teams changes nothing.
  let scores = computeScores(pool, [["A", "B", "="]]);
  assert.equal(scores.get("A"), scores.get("B"));
  // A win then a tie: A still ahead, but by less than after the win alone.
  const winOnly = computeScores(pool, [["A", "B"]]);
  const winThenTie = computeScores(pool, [["A", "B"], ["A", "B", "="]]);
  assert.ok(winThenTie.get("A") > winThenTie.get("B"), "A still preferred");
  assert.ok(winThenTie.get("A") < winOnly.get("A"), "tie narrowed the gap");
  // Symmetric zero-sum: total Elo is conserved.
  assert.ok(Math.abs(winThenTie.get("A") + winThenTie.get("B") - 3000) < 1e-9);
  // Ties count toward comparison counts (drives the adaptive pair picker).
  const counts = computeCounts(pool, [["A", "B", "="]]);
  assert.equal(counts.get("A"), 1);
  assert.equal(counts.get("B"), 1);
});

test("applyPins: pinned teams strictly outrank every unpinned team", () => {
  // No pins -> untouched (the head-to-head top keeps weight 1.0).
  let w = applyPins({ A: 1.0, B: 0.7, C: 0.0 }, new Set());
  assert.deepEqual(w, { A: 1.0, B: 0.7, C: 0.0 });
  // Pin C (the head-to-head WORST): it takes 1.0, everyone else compresses
  // below the cap — so nothing unpinned can tie a pin.
  w = applyPins({ A: 1.0, B: 0.7, C: 0.0 }, new Set(["C"]));
  assert.equal(w.C, 1.0);
  assert.ok(Math.abs(w.A - UNPINNED_CAP) < 1e-12, `A=${w.A}`);
  assert.ok(w.B < UNPINNED_CAP && w.A < w.C);
  // Multiple pins both sit at 1.0; pins outside the pool are ignored.
  w = applyPins({ A: 1.0, B: 0.7 }, new Set(["A", "B", "NotInPool"]));
  assert.deepEqual(w, { A: 1.0, B: 1.0 });
});

// --- loyalty guard -------------------------------------------------------------------

test("assessLoyalty: self-benefit semantics (ported)", () => {
  const base = { a: "X", b: "Y", wa: 0.9, wb: 0.1 };
  // Rooting for B against a liked A, with a big swing -> perverse but worth it
  // via A's OWN path (3rd-place routing).
  let loy = assessLoyalty({ ...base, best: "B",
    pSeatA: { A: 0.09, B: 0.25 }, pSeatB: { A: 0.0, B: 0.0 } });
  assert.equal(loy.against, "X");
  assert.equal(loy.kind, "self");
  assert.ok(Math.abs(loy.swing - 0.16) < 1e-9);
  assert.equal(loy.suppressible, false);
  // Tiny swing, nobody else gains -> suppressible.
  loy = assessLoyalty({ ...base, best: "B",
    pSeatA: { A: 0.02, B: 0.03 }, pSeatB: { A: 0, B: 0 } });
  assert.equal(loy.kind, "none");
  assert.ok(loy.suppressible);
  // Not perverse: you're told to root FOR the team you prefer.
  assert.equal(assessLoyalty({ ...base, best: "A",
    pSeatA: { A: 0.5, B: 0.1 }, pSeatB: { A: 0, B: 0 } }), null);
  // Not perverse: you don't like either side.
  assert.equal(assessLoyalty({ a: "X", b: "Y", wa: 0.2, wb: 0.1, best: "B",
    pSeatA: { A: 0.5, B: 0.1 }, pSeatB: { A: 0, B: 0 } }), null);
  // Draw recommended against the liked side.
  loy = assessLoyalty({ a: "X", b: "Y", wa: 0.8, wb: 0.2, best: "D",
    pSeatA: { A: 0.10, B: 0.0, D: 0.12 }, pSeatB: { A: 0, B: 0, D: 0 } });
  assert.equal(loy.against, "X");
  assert.ok(Math.abs(loy.swing - 0.02) < 1e-9);
});

test("assessLoyalty: cross-team payoff rescues the call (kind=other)", () => {
  const base = {
    a: "Canada", b: "Bosnia", wa: 0.55, wb: 0.0, best: "D",
    // The draw HURTS Canada's own odds...
    pSeatA: { A: 0.48, D: 0.26, B: 0.10 },
    pSeatB: { A: 0.02, D: 0.12, B: 0.33 },
  };
  // ...but lifts another liked team enough -> kept, with the beneficiary named.
  let loy = assessLoyalty({ ...base, likedP: {
    Canada: { A: 0.48, D: 0.26, B: 0.10 },
    Switzerland: { A: 0.31, D: 0.43, B: 0.38 },
  } });
  assert.equal(loy.against, "Canada");
  assert.equal(loy.kind, "other");
  assert.equal(loy.beneficiary, "Switzerland");
  assert.ok(Math.abs(loy.benSwing - 0.12) < 1e-9, `benSwing=${loy.benSwing}`);
  assert.equal(loy.suppressible, false);
  // The denied team itself never counts as its own beneficiary.
  loy = assessLoyalty({ ...base, likedP: {
    Canada: { A: 0.48, D: 0.26, B: 0.10 },
  } });
  assert.equal(loy.kind, "none");
  assert.ok(loy.suppressible);
  // Largest-gain liked team wins the beneficiary slot.
  loy = assessLoyalty({ ...base, likedP: {
    Switzerland: { A: 0.31, D: 0.43, B: 0.38 },
    Qatar: { A: 0.10, D: 0.30, B: 0.10 },
  } });
  assert.equal(loy.beneficiary, "Qatar");
});

// --- cheer guide end-to-end ------------------------------------------------------------

test("analyzeCheer: USA fan attending Seattle wants USA to win its group games", () => {
  const weights = Object.fromEntries(prep.teams.map((t) => [t, 0.05]));
  weights.USA = 1.0;
  const { rows, summary } = analyzeCheer(prep, noResults, store, weights, ["m82", "m94"]);
  assert.equal(summary.topTeam, "USA");
  assert.ok(summary.pTopInLineup > 0.15 && summary.pTopInLineup < 0.5,
    `P(USA in Seattle lineup) = ${summary.pTopInLineup} (Python: ~0.31)`);
  // top-picks summary: USA first, up to 5 entries, probabilities in [0,1]
  assert.equal(summary.topTeams[0].team, "USA");
  assert.equal(summary.topTeams[0].p, summary.pTopInLineup);
  assert.ok(summary.topTeams.length <= 5);
  for (const { p, weight } of summary.topTeams) {
    assert.ok(p >= 0 && p <= 1 && weight > 0);
  }
  assert.equal(rows.length, 72, "all group games scored, none played yet");
  // USA's three group games should advise rooting for USA, and they should be
  // among the highest-impact games (USA must WIN group D to route to Seattle).
  const usaRows = rows.filter((r) => r.a === "USA" || r.b === "USA");
  assert.equal(usaRows.length, 3);
  for (const r of usaRows) {
    const rec = r.best === "A" ? r.a : r.best === "B" ? r.b : "DRAW";
    assert.equal(rec, "USA", `${r.a} vs ${r.b}: expected USA, got ${rec}`);
    assert.ok(r.significant, "USA games must clear the noise floor");
    assert.equal(r.loyalty, null, "rooting for your favorite is never perverse");
  }
  const top10 = rows.slice(0, 10);
  assert.ok(top10.some((r) => r.a === "USA" || r.b === "USA"),
    "a USA game should be among the most impactful");
});

test("loyalty percentages are true conditional probabilities (bucket == pinned run)", () => {
  // The guard displays P(team appears in a match you attend | outcome). That
  // bucketed conditional must equal the probability measured by a SEPARATE
  // simulation where the outcome is pinned as a real played result — the
  // definition of conditioning when games are independent. Uses the verified
  // headline case: Mexico losing to South Africa jumps Mexico's Seattle odds
  // (Group A third -> M82 in ~95% of Annex C rows), ~8% -> ~23%.
  const gid = "Mexico|South Africa";
  const { rows } = analyzeCheer(prep, noResults, store, { Mexico: 1.0 }, ["m82", "m94"]);
  const r = rows.find((x) => x.id === gid);
  assert.equal(r.best, "B", "utility-max: root for South Africa");
  assert.equal(r.loyalty.kind, "self");

  const mexIdx = teamIdx("Mexico");
  const i82 = 82 - 73, i94 = 94 - 73;
  const pinnedP = (score) => {
    const fixed = prepareResults(prep, { group_results: { [gid]: score }, knockout: {} });
    const st = runSims(prep, fixed, 4000, 1234);
    let hits = 0;
    for (let s = 0; s < st.n; s++) {
      const t = st.koTeams;
      if (t[s*64+2*i82] === mexIdx || t[s*64+2*i82+1] === mexIdx ||
          t[s*64+2*i94] === mexIdx || t[s*64+2*i94+1] === mexIdx) hits++;
    }
    return hits / st.n;
  };
  // 2-0 loss vs the bucket's average over all losing scorelines: allow MC +
  // scoreline-mix slack, but the agreement must be tight enough to prove the
  // displayed numbers mean what the UI says they mean.
  const lossPinned = pinnedP([0, 2]);
  assert.ok(Math.abs(lossPinned - r.pSeatA.B) < 0.05,
    `bucket ${r.pSeatA.B} vs pinned ${lossPinned}`);
  const winPinned = pinnedP([2, 0]);
  assert.ok(Math.abs(winPinned - r.pSeatA.A) < 0.05,
    `bucket ${r.pSeatA.A} vs pinned ${winPinned}`);
  // And the headline effect itself: losing ~triples Mexico's Seattle odds.
  assert.ok(r.pSeatA.B > 2 * r.pSeatA.A,
    `losing must dwarf winning: ${r.pSeatA.A} -> ${r.pSeatA.B}`);
});

test("analyzeCheer: full-lineup optimization trades one liked team for a more-loved one", () => {
  // Love Switzerland, like Canada (same group B), attend M85 (Vancouver:
  // Group B winner vs a 3rd from E/F/G/I/J — so a Group B THIRD can't get
  // there; only the group winner matters). Canada's own odds of reaching M85
  // are maximized by Canada WINNING Canada-vs-Bosnia, but the guide must
  // recommend the outcome that's best for the WHOLE lineup — the draw, which
  // protects Switzerland's group-winner path. Stable at 5k sims across seeds.
  const weights = { Switzerland: 1.0, Canada: 0.55 };
  const { rows } = analyzeCheer(prep, noResults, store, weights, ["m85"]);
  const r = rows.find((x) => x.id === "Canada|Bosnia-Herzegovina");
  assert.ok(r, "Canada vs Bosnia-Herzegovina row exists");
  // Canada's own appearance odds ARE maximized by a Canada win...
  assert.ok(r.pSeatA.A > r.pSeatA.D && r.pSeatA.A > r.pSeatA.B,
    "premise: Canada-win maximizes Canada's own odds");
  // ...yet the recommendation weighs Switzerland too and picks the draw.
  assert.equal(r.best, "D");
  assert.ok(r.significant);
  // The loyalty guard credits the cross-team payoff instead of suppressing.
  assert.equal(r.loyalty.against, "Canada");
  assert.equal(r.loyalty.kind, "other");
  assert.equal(r.loyalty.beneficiary, "Switzerland");
  assert.equal(r.loyalty.suppressible, false);
  assert.ok(r.loyalty.benSwing > 0.03);
  // And the per-team conditional probabilities are exposed for the UI.
  assert.ok(r.pLineup.Switzerland.D > r.pLineup.Switzerland.A,
    "draw must help Switzerland vs a Canada win");
});

test("analyzeCheer: attended group game contributes its fixed teams", () => {
  // Attending only a single group game: lineup is deterministic, so NO group
  // game can swing the utility — nothing should be significant.
  const weights = Object.fromEntries(prep.teams.map((t) => [t, 0.0]));
  weights.Mexico = 1.0;
  const g0 = prep.groupGames[0]; // Mexico vs South Africa, attended
  const { rows, summary } = analyzeCheer(prep, noResults, store, weights, [g0.id]);
  assert.ok(Math.abs(summary.baselineU - 1.0) < 1e-9, "Mexico always in lineup");
  assert.ok(rows.every((r) => !r.significant), "deterministic lineup => no leverage");
});

test("analyzeCheer: known-participant unplayed knockout match gets a recommendation", () => {
  // Pin all group games with simulated-but-fixed scores so the bracket is
  // deterministic, mark M82's participants known but unplayed.
  const rnd = makeRng(99);
  const fixedScores = {};
  for (const g of prep.groupGames) {
    const [ga, gb] = simulateMatch(prep.ratings[g.a], prep.ratings[g.b], false, rnd);
    fixedScores[g.id] = [ga, gb];
  }
  let fixed = prepareResults(prep, { group_results: fixedScores, knockout: {} });
  const st0 = runSims(prep, fixed, 50, 1);
  const i82 = 82 - 73;
  const t1 = prep.teams[st0.koTeams[2 * i82]], t2 = prep.teams[st0.koTeams[2 * i82 + 1]];
  fixed = prepareResults(prep, {
    group_results: fixedScores,
    knockout: { m82: { team1: t1, team2: t2 } },
  });
  const st = runSims(prep, fixed, 3000, 7);
  const weights = Object.fromEntries(prep.teams.map((t) => [t, 0.0]));
  weights[t1] = 1.0;
  const { rows } = analyzeCheer(prep, fixed, st, weights, ["m94"]);
  const r82 = rows.find((r) => r.id === "m82");
  assert.ok(r82, "m82 should be scored once participants are known");
  assert.equal(r82.kind, "ko");
  const rec = r82.best === "A" ? r82.a : r82.b;
  assert.equal(rec, t1, "you attend M94: root for your favorite to win M82");
  assert.ok(r82.significant);
});
