/*
 * Node test suite for the per-match accuracy feature (site/js/sim-core.js):
 *   matchWDL            — closed-form win/draw/loss odds for one match
 *   analyzeMatchCalibration — grades those odds against real results and bins
 *                             them into a reliability diagram + Brier score
 *
 * No npm deps; run from the repo root:  node --test "tests/**"
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  prepare, makeRng, simulateMatch, expectedScore,
  matchWDL, analyzeMatchCalibration, CALIB_BINS,
} from "../site/js/sim-core.js";

const tournament = JSON.parse(readFileSync(new URL("../site/data/tournament.json", import.meta.url)));
const prep = prepare(tournament);

// --- matchWDL ----------------------------------------------------------------

test("matchWDL (regulation): a proper distribution; even teams are symmetric", () => {
  const r = matchWDL(1700, 1700, false);
  assert.ok(r.pWin > 0 && r.pDraw > 0 && r.pLoss > 0);
  assert.ok(Math.abs(r.pWin + r.pDraw + r.pLoss - 1) < 1e-9);
  assert.ok(Math.abs(r.pWin - r.pLoss) < 1e-9, "equal ratings => win == loss");

  // win(a vs b) mirrors loss(b vs a)
  const ab = matchWDL(1800, 1600, false), ba = matchWDL(1600, 1800, false);
  assert.ok(Math.abs(ab.pWin - ba.pLoss) < 1e-9);
  assert.ok(Math.abs(ab.pDraw - ba.pDraw) < 1e-9);
  assert.ok(ab.pWin > ab.pLoss, "stronger team favored");
});

test("matchWDL (knockout): no draws, and the proxy adds win mass", () => {
  const reg = matchWDL(1800, 1600, false);
  const ko = matchWDL(1800, 1600, true);
  assert.equal(ko.pDraw, 0);
  assert.ok(Math.abs(ko.pWin + ko.pLoss - 1) < 1e-9);
  assert.ok(ko.pWin > reg.pWin, "favorite's KO win-prob exceeds regulation win-prob");
  // The proxy redistributes the drawn games; the favorite's SHARE of them is
  // capped near 70% (it's 0.5 + 0.4*(E-0.5), with E <= 1).
  const drawShareToFav = (ko.pWin - reg.pWin) / reg.pDraw;
  assert.ok(drawShareToFav > 0.5 && drawShareToFav <= 0.7 + 1e-9);
});

test("matchWDL agrees with a Monte Carlo over many draws", () => {
  const ra = 1820, rb = 1620;
  const closed = matchWDL(ra, rb, false);
  const rnd = makeRng(7);
  const N = 40000;
  let w = 0, d = 0, l = 0;
  for (let i = 0; i < N; i++) {
    const [ga, gb] = simulateMatch(ra, rb, false, rnd);
    if (ga > gb) w++; else if (ga === gb) d++; else l++;
  }
  assert.ok(Math.abs(w / N - closed.pWin) < 0.02);
  assert.ok(Math.abs(d / N - closed.pDraw) < 0.02);
  assert.ok(Math.abs(l / N - closed.pLoss) < 0.02);
});

// --- analyzeMatchCalibration -------------------------------------------------

// Two group games and one decided knockout match.
const g1 = tournament.group_games[0];
const g2 = tournament.group_games[1];

function fixtureResults() {
  return {
    group_results: { [g1.id]: [2, 0], [g2.id]: [1, 1] },          // home win, draw
    knockout: { m73: { team1: g1.a, team2: g1.b, winner: g1.a, score: [1, 0] } },
  };
}
const wdl = (a, b, ko) => matchWDL(prep.ratings[prep.ti.get(a)], prep.ratings[prep.ti.get(b)], ko);

test("analyzeMatchCalibration: match counts, categories, diagram points", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  assert.equal(cal.nMatches, 3);                 // 2 group + 1 knockout
  assert.equal(cal.byCategory.group.count, 2);
  assert.equal(cal.byCategory.ko.count, 1);
  // pooled diagram points: 3 per group game + 2 per knockout = 8.
  assert.equal(cal.points.length, 8);
  // each match has exactly one realized class, so o===1 totals the match count.
  assert.equal(cal.points.filter((p) => p.o === 1).length, cal.nMatches);
});

test("multiclass Brier matches an independent recompute (sklearn definition)", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  const a = wdl(g1.a, g1.b, false);  // g1 home win -> class W
  const b1 = (a.pWin - 1) ** 2 + a.pDraw ** 2 + a.pLoss ** 2;
  const b = wdl(g2.a, g2.b, false);  // g2 draw -> class D
  const b2 = b.pWin ** 2 + (b.pDraw - 1) ** 2 + b.pLoss ** 2;
  const c = wdl(g1.a, g1.b, true);   // m73 team1 wins -> class W
  const b3 = (c.pWin - 1) ** 2 + c.pLoss ** 2;
  assert.ok(Math.abs(cal.brier - (b1 + b2 + b3) / 3) < 1e-12);
  assert.ok(Math.abs(cal.byCategory.group.brier - (b1 + b2) / 2) < 1e-12);
});

test("multiclass Brier hits its [0,2] bounds for confident forecasts", () => {
  // Synthetic 2-team prep with a huge rating gap -> near-certain forecast.
  const mini = {
    ratings: [2000, 1000], ti: new Map([["A", 0], ["B", 1]]),
    groupGames: [{ id: "A|B", a: 0, b: 1 }], ko: [],
  };
  const right = analyzeMatchCalibration(mini, { group_results: { "A|B": [3, 0] }, knockout: {} });
  assert.ok(right.brier < 0.05, "confident and correct -> near 0");
  assert.ok(right.avgProbActual > 0.9);
  const wrong = analyzeMatchCalibration(mini, { group_results: { "A|B": [0, 3] }, knockout: {} });
  assert.ok(wrong.brier > 1.7, "confident and wrong -> near 2");
});

test("no-skill baseline: 2/3 per group game, 1/2 per knockout", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  assert.ok(Math.abs(cal.byCategory.group.brierBaseline - 2 / 3) < 1e-12);
  assert.ok(Math.abs(cal.byCategory.ko.brierBaseline - 1 / 2) < 1e-12);
  assert.ok(Math.abs(cal.brierBaseline - (2 / 3 + 2 / 3 + 1 / 2) / 3) < 1e-12);
  // baselineProbActual is the average 1/nClasses given to the actual result.
  assert.ok(Math.abs(cal.baselineProbActual - (1 / 3 + 1 / 3 + 1 / 2) / 3) < 1e-12);
});

test("avgProbActual averages the probability placed on the realized result", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  const expected = (wdl(g1.a, g1.b, false).pWin + wdl(g2.a, g2.b, false).pDraw
    + wdl(g1.a, g1.b, true).pWin) / 3;
  assert.ok(Math.abs(cal.avgProbActual - expected) < 1e-12);
});

test("ignores unplayed / undecided matches, and handles empty", () => {
  const cal = analyzeMatchCalibration(prep, {
    group_results: { [g1.id]: [3, 1] },
    knockout: { m73: { team1: g1.a, team2: g1.b } },  // participants but no winner
  });
  assert.equal(cal.nMatches, 1);
  assert.equal(cal.byCategory.ko.count, 0);
  assert.equal(cal.points.length, 3);

  const empty = analyzeMatchCalibration(prep, { group_results: {}, knockout: {} });
  assert.equal(empty.nMatches, 0);
  assert.equal(empty.brier, null);
  assert.deepEqual(empty.bins, []);
});

// --- binning -----------------------------------------------------------------

// A fuller fixture: 24 group games -> 72 pooled diagram points.
function manyResults() {
  const group_results = {};
  for (const g of tournament.group_games.slice(0, 24)) group_results[g.id] = [2, 0];
  return { group_results, knockout: {} };
}

test("equal-count bins (default) partition the points with near-equal sizes", () => {
  const cal = analyzeMatchCalibration(prep, manyResults());
  assert.equal(cal.binMode, "count");
  assert.equal(cal.bins.reduce((s, b) => s + b.n, 0), cal.points.length);
  const sizes = cal.bins.map((b) => b.n);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "bin sizes differ by at most 1");
  for (let i = 1; i < cal.bins.length; i++) assert.ok(cal.bins[i].lo >= cal.bins[i - 1].lo);
});

test("even-width bins partition on CALIB_BINS", () => {
  const cal = analyzeMatchCalibration(prep, manyResults(), { binMode: "width" });
  assert.equal(cal.binMode, "width");
  assert.equal(cal.bins.length, CALIB_BINS.length - 1);
  assert.equal(cal.bins.reduce((s, b) => s + b.n, 0), cal.points.length);
  for (const b of cal.bins) {
    const inBin = cal.points.filter((p) => p.p >= b.lo && (b.hi === 1 ? p.p <= 1 : p.p < b.hi));
    assert.equal(b.n, inBin.length);
    if (b.n) {
      const obs = inBin.reduce((s, p) => s + p.o, 0) / b.n;
      assert.ok(Math.abs(b.obsFreq - obs) < 1e-12);
    } else {
      assert.equal(b.obsFreq, null);
    }
  }
});
