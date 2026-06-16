/*
 * Node test suite for the "time machine" results filter (resultsAsOf in
 * site/js/sim-core.js): choosing an earlier match reconstructs exactly the
 * results that had kicked off by then, so the whole site can be re-simulated
 * as of any point in the tournament. The cutoff is a match's kickoff ISO and
 * comparison is by absolute instant, so several matches on the same day are
 * ordered correctly.
 *
 * Run from the repo root:  node --test "tests/**"
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  prepare, prepareResults, runSims, groupProbs, resultsAsOf,
} from "../site/js/sim-core.js";

const tournament = JSON.parse(readFileSync(new URL("../site/data/tournament.json", import.meta.url)));

// A synthetic results blob spanning the group stage and into the bracket, so
// the filter is exercised on both keying schemes (pair strings + m73..).
const firstGroupGame = tournament.group_games[0];           // Jun 11
const lateGroupGame =                                       // a Jun 26 game
  tournament.group_games.find((g) => g.kickoff.slice(0, 10) === "2026-06-26");
const r32 = tournament.knockout.find((m) => m.id === "m73"); // Jun 28
const results = {
  fetched_at: "2026-06-29T00:00:00Z",
  group_results: {
    [firstGroupGame.id]: [2, 0],
    [lateGroupGame.id]: [1, 1],
  },
  knockout: {
    [r32.id]: { team1: "Mexico", team2: "Canada", winner: "Mexico", score: [2, 1] },
  },
};

test("resultsAsOf: falsy cutoff returns results untouched", () => {
  assert.equal(resultsAsOf(tournament, results, null), results);
  assert.equal(resultsAsOf(tournament, results, ""), results);
});

test("resultsAsOf: keeps only matches that kicked off at or before the cutoff", () => {
  // As of the opener: only that game is visible.
  const d1 = resultsAsOf(tournament, results, firstGroupGame.kickoff);
  assert.deepEqual(Object.keys(d1.group_results), [firstGroupGame.id]);
  assert.deepEqual(Object.keys(d1.knockout), []);

  // As of the late group game: both group games, still no bracket.
  const d26 = resultsAsOf(tournament, results, lateGroupGame.kickoff);
  assert.equal(Object.keys(d26.group_results).length, 2);
  assert.deepEqual(Object.keys(d26.knockout), []);

  // As of the R32 game: everything is visible.
  const d28 = resultsAsOf(tournament, results, r32.kickoff);
  assert.equal(Object.keys(d28.group_results).length, 2);
  assert.deepEqual(Object.keys(d28.knockout), [r32.id]);
});

test("resultsAsOf: the cutoff match itself is included (boundary inclusive)", () => {
  const asOpener = resultsAsOf(tournament, results, firstGroupGame.kickoff);
  assert.ok(firstGroupGame.id in asOpener.group_results,
    "selecting a match shows that match's own result");
  assert.equal(asOpener.asOf, firstGroupGame.kickoff);
});

test("resultsAsOf: orders by absolute instant, not local clock time", () => {
  // Same calendar day; by venue-local clock B (11:00) looks earlier than A
  // (13:00), but by absolute instant A (17:00Z) precedes B (19:00Z). A cutoff
  // at A's kickoff must include A and exclude B — a date-string or local-clock
  // compare would wrongly include B.
  const t = {
    group_games: [
      { id: "A", kickoff: "2026-06-20T13:00:00-04:00" }, // 17:00Z
      { id: "B", kickoff: "2026-06-20T11:00:00-08:00" }, // 19:00Z
    ],
    knockout: [],
  };
  const res = { group_results: { A: [1, 0], B: [2, 2] }, knockout: {} };
  const asA = resultsAsOf(t, res, "2026-06-20T13:00:00-04:00");
  assert.deepEqual(Object.keys(asA.group_results), ["A"]);
});

test("resultsAsOf: a cutoff before any match yields the pristine baseline", () => {
  const pre = resultsAsOf(tournament, results, "2026-06-01T00:00:00Z");
  assert.deepEqual(pre.group_results, {});
  assert.deepEqual(pre.knockout, {});
});

test("resultsAsOf: filtered results round-trip through prepareResults", () => {
  const prep = prepare(tournament);
  assert.equal(prepareResults(prep, resultsAsOf(tournament, results, "2026-06-01T00:00:00Z")).playedCount, 0);
  assert.equal(prepareResults(prep, resultsAsOf(tournament, results, lateGroupGame.kickoff)).playedCount, 2);
});

test("resultsAsOf: re-simulating before kickoff matches the no-results baseline", () => {
  // End-to-end: winding back before the opener must give the same advancement
  // odds as simulating with an empty results blob (seed-pinned).
  const prep = prepare(tournament);
  const N = 3000;
  const baseline = groupProbs(prep, runSims(prep, prepareResults(prep, { group_results: {}, knockout: {} }), N, 42));
  const wound = groupProbs(prep, runSims(prep, prepareResults(prep, resultsAsOf(tournament, results, "2026-06-01T00:00:00Z")), N, 42));
  for (let i = 0; i < prep.teams.length; i++) {
    assert.equal(wound.advance[i], baseline.advance[i]);
  }
});

test("resultsAsOf: does not mutate the input results", () => {
  const before = JSON.stringify(results);
  resultsAsOf(tournament, results, firstGroupGame.kickoff);
  assert.equal(JSON.stringify(results), before);
});
