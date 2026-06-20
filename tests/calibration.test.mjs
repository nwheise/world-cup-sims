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

// Two group games and one decided knockout match. Mexico|South Africa is the
// opener (group A); pick a second group game and m73 for the bracket.
const g1 = tournament.group_games[0];
const g2 = tournament.group_games[1];
const m73 = tournament.knockout.find((m) => m.id === "m73");

function fixtureResults() {
  return {
    group_results: { [g1.id]: [2, 0], [g2.id]: [1, 1] },
    knockout: {
      m73: { team1: g1.a, team2: g1.b, winner: g1.a, score: [1, 0] },
    },
  };
}

test("analyzeMatchCalibration: counts, categories, and realized outcomes", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  // 3 points per group game (2 games) + 2 per decided KO (1 game) = 8.
  assert.equal(cal.count, 8);
  assert.equal(cal.byCategory.group.count, 6);
  assert.equal(cal.byCategory.ko.count, 2);
  assert.equal(cal.byCategory.group.count + cal.byCategory.ko.count, cal.count);

  // g1 was a home win (2-0): exactly one of its three points has o === 1, on the
  // win class, whose probability equals matchWDL's pWin.
  const winP = matchWDL(prep.ratings[prep.ti.get(g1.a)], prep.ratings[prep.ti.get(g1.b)], false).pWin;
  const g1pts = cal.points.filter((p) => p.id === g1.id);
  assert.equal(g1pts.filter((p) => p.o === 1).length, 1);
  const hit = g1pts.find((p) => p.o === 1);
  assert.ok(Math.abs(hit.p - winP) < 1e-12);

  // g2 was a draw (1-1): the o===1 point sits on the draw probability.
  const g2pts = cal.points.filter((p) => p.id === g2.id);
  assert.equal(g2pts.filter((p) => p.o === 1).length, 1);
});

test("analyzeMatchCalibration: ignores unplayed and not-yet-decided matches", () => {
  // Knockout entry with participants but no winner must not be graded.
  const cal = analyzeMatchCalibration(prep, {
    group_results: { [g1.id]: [3, 1] },
    knockout: { m73: { team1: g1.a, team2: g1.b } },
  });
  assert.equal(cal.count, 3);          // only the one group game
  assert.equal(cal.byCategory.ko.count, 0);

  const empty = analyzeMatchCalibration(prep, { group_results: {}, knockout: {} });
  assert.equal(empty.count, 0);
  assert.equal(empty.brier, null);
});

// --- binning + Brier ---------------------------------------------------------

test("bins partition the points and report correct means", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  const total = cal.bins.reduce((s, b) => s + b.n, 0);
  assert.equal(total, cal.count, "every point lands in exactly one bin");
  assert.equal(cal.bins.length, CALIB_BINS.length - 1);

  // Recompute each bin's observed frequency straight from the points.
  for (const b of cal.bins) {
    const inBin = cal.points.filter((p) =>
      p.p >= b.lo && (b.hi === 1 ? p.p <= 1 : p.p < b.hi));
    assert.equal(b.n, inBin.length);
    if (b.n) {
      const obs = inBin.reduce((s, p) => s + p.o, 0) / b.n;
      assert.ok(Math.abs(b.obsFreq - obs) < 1e-12);
    } else {
      assert.equal(b.obsFreq, null);
    }
  }
});

test("Brier is mean squared error, and a perfect forecast scores 0", () => {
  const cal = analyzeMatchCalibration(prep, fixtureResults());
  const manual = cal.points.reduce((s, p) => s + (p.p - p.o) ** 2, 0) / cal.count;
  assert.ok(Math.abs(cal.brier - manual) < 1e-12);
  assert.ok(cal.brier >= 0 && cal.brier <= 1);
});

test("custom (fine-low) bins still partition the data", () => {
  const fine = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1];
  const cal = analyzeMatchCalibration(prep, fixtureResults(), { bins: fine });
  assert.equal(cal.bins.length, fine.length - 1);
  assert.equal(cal.bins.reduce((s, b) => s + b.n, 0), cal.count);
  assert.deepEqual(cal.meta.bins, fine);
});
