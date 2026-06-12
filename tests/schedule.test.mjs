/*
 * Node test suite for the Must-watch schedule module (site/js/schedule.js):
 * match appeal scoring (the emphasize() identity with the cheer guide's
 * lineup-quality math), tiering (pinned teams are never left out), and the
 * iCalendar export (UTC conversion, RFC 5545 escaping/folding, determinism).
 *
 * Run from the repo root:  node --test "tests/**"
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { emphasize } from "../site/js/sim-core.js";
import {
  scoreMatches, buildTiers, rankMap, matchEvents, buildICS,
  icsStamp, icsEscape, icsFold,
  MUST_COUNT, WORTH_COUNT, PIN_PROB_FLOOR,
} from "../site/js/schedule.js";

const tournament = JSON.parse(readFileSync(new URL("../site/data/tournament.json", import.meta.url)));

// --- fixtures (app-state match descriptor shapes) ------------------------------

const G = (id, a, b, kickoff, group = "A") =>
  ({ kind: "group", id, a, b, group, kickoff, ground: "Seattle" });
const K = (num, kickoff, slot1 = "1A", slot2 = "2B", round = "Round of 32") =>
  ({ kind: "ko", id: `m${num}`, num, round, slot1, slot2,
     kickoff, ground: "Seattle" });
const probsFor = (entries) => ({ matches: entries }); // indexed num-73

const NO_RESULTS = { group_results: {}, knockout: {} };

// --- scoring -------------------------------------------------------------------

test("scoreMatches: group game appeal = emphasize(wA) + emphasize(wB)", () => {
  const w = { Brazil: 0.9, Morocco: 0.3 };
  const [s] = scoreMatches([G("g1", "Brazil", "Morocco", "2026-06-13T12:00:00-07:00", "C")],
    null, w, NO_RESULTS);
  assert.ok(Math.abs(s.score - (emphasize(0.9) + emphasize(0.3))) < 1e-12);
  assert.equal(s.teams[0].team, "Brazil"); // sorted by contribution
  assert.equal(s.slot1, null);
});

test("scoreMatches: knockout appeal = sum of P(appear)·emphasize(w), both slots", () => {
  const w = { Spain: 1.0, Iran: 0.2, Egypt: 0.5 };
  const probs = probsFor([{
    slot1: [["Spain", 0.6], ["Iran", 0.4]],
    slot2: [["Egypt", 1.0]],
    matchups: [],
  }]);
  const [s] = scoreMatches([K(73, "2026-06-28T12:00:00-07:00")], probs, w, NO_RESULTS);
  const want = 0.6 * emphasize(1.0) + 0.4 * emphasize(0.2) + 1.0 * emphasize(0.5);
  assert.ok(Math.abs(s.score - want) < 1e-12);
  assert.deepEqual(s.slot2, [["Egypt", 1.0]]);
});

test("scoreMatches: a team reachable via either slot has its odds summed", () => {
  const w = { Argentina: 1.0 };
  const probs = probsFor([{
    slot1: [["Argentina", 0.3], ["France", 0.7]],
    slot2: [["Argentina", 0.25], ["Spain", 0.75]],
    matchups: [],
  }]);
  const [s] = scoreMatches([K(73, "2026-07-19T15:00:00-04:00")], probs, w, NO_RESULTS);
  const arg = s.teams.find((t) => t.team === "Argentina");
  assert.ok(Math.abs(arg.p - 0.55) < 1e-12);
});

test("scoreMatches: played matches are excluded; KO without probs is skipped", () => {
  const matches = [
    G("Brazil|Morocco", "Brazil", "Morocco", "2026-06-13T12:00:00-07:00", "C"),
    G("Haiti|Scotland", "Haiti", "Scotland", "2026-06-13T15:00:00-07:00", "C"),
    K(73, "2026-06-28T12:00:00-07:00"),
  ];
  const results = {
    group_results: { "Brazil|Morocco": [2, 0] },
    knockout: {},
  };
  // No probs yet (simulation running): KO match skipped, played group game skipped.
  const scored = scoreMatches(matches, null, {}, results);
  assert.deepEqual(scored.map((s) => s.m.id), ["Haiti|Scotland"]);
  // Played knockout match excluded once it has a score.
  const probs = probsFor([{ slot1: [["Spain", 1]], slot2: [["Egypt", 1]], matchups: [] }]);
  const koDone = { group_results: {}, knockout: { m73: { score: [1, 0], winner: "Spain" } } };
  assert.equal(scoreMatches([K(73, "2026-06-28T12:00:00-07:00")], probs, {}, koDone).length, 0);
});

// --- tiering -------------------------------------------------------------------

test("buildTiers: top-N by score, tiers disjoint, complete, and date-sorted", () => {
  // 30 group games with strictly increasing appeal, shuffled kickoff order.
  const matches = [];
  const w = {};
  for (let i = 0; i < 30; i++) {
    const a = `A${i}`, b = `B${i}`;
    w[a] = i / 30; w[b] = i / 30;
    const day = String(1 + ((i * 7) % 28)).padStart(2, "0");
    matches.push(G(`g${i}`, a, b, `2026-06-${day}T12:00:00-07:00`));
  }
  const scored = scoreMatches(matches, null, w, NO_RESULTS);
  const { must, worth, rest } = buildTiers(scored);
  assert.equal(must.length, MUST_COUNT);
  assert.equal(worth.length, WORTH_COUNT);
  assert.equal(rest.length, 30 - MUST_COUNT - WORTH_COUNT);
  const ids = (xs) => xs.map((s) => s.m.id);
  assert.equal(new Set([...ids(must), ...ids(worth), ...ids(rest)]).size, 30);
  // must = the 10 highest-appeal games (teams 20..29)
  assert.deepEqual(new Set(ids(must)),
    new Set(Array.from({ length: 10 }, (_, j) => `g${20 + j}`)));
  // every tier is kickoff-sorted (it's a schedule)
  for (const tier of [must, worth, rest]) {
    for (let i = 1; i < tier.length; i++) {
      assert.ok(tier[i - 1].m.kickoff <= tier[i].m.kickoff);
    }
  }
  // worst tier score never beats best of the tier above (must may hold
  // pin-forced low scorers in other tests, but not here)
  assert.ok(Math.min(...must.map((s) => s.score)) >= Math.max(...worth.map((s) => s.score)) - 1e-12);
});

test("buildTiers: pinned team's games are always must-watch; KO needs p ≥ floor", () => {
  const w = { Pin: 1.0, X: 0.0 };
  for (let i = 0; i < 12; i++) w[`S${i}`] = 0.95; // 6 high-appeal decoy games
  const matches = [];
  for (let i = 0; i < 6; i++) {
    matches.push(G(`big${i}`, `S${2 * i}`, `S${2 * i + 1}`, "2026-06-15T12:00:00-07:00"));
  }
  // Pinned team vs a nobody: low total appeal, must still make the cut.
  matches.push(G("pinGame", "Pin", "X", "2026-06-20T12:00:00-07:00"));
  // Two KO matches: pinned team at 40% (below floor) and 60% (above).
  matches.push(K(73, "2026-06-28T12:00:00-07:00"), K(74, "2026-06-29T12:00:00-07:00"));
  const probs = probsFor([
    { slot1: [["Pin", 0.4], ["X", 0.6]], slot2: [["X", 1]], matchups: [] },
    { slot1: [["Pin", 0.6], ["X", 0.4]], slot2: [["X", 1]], matchups: [] },
  ]);
  const scored = scoreMatches(matches, probs, w, NO_RESULTS);
  const { must } = buildTiers(scored, new Set(["Pin"]), { mustCount: 3, worthCount: 2 });
  const mustIds = new Set(must.map((s) => s.m.id));
  assert.ok(mustIds.has("pinGame"), "pinned team's group game forced into must-watch");
  assert.ok(mustIds.has("m74"), `KO with pinned at 0.6 ≥ ${PIN_PROB_FLOOR} forced in`);
  assert.ok(!mustIds.has("m73"), "KO with pinned at 0.4 not forced in");
});

test("rankMap: pinned favorites first, then by weight — like the My-teams list", () => {
  const ranks = rankMap({ A: 0.9, B: 0.2, C: 0.6 }, new Set(["B"]));
  assert.equal(ranks.get("B"), 1);
  assert.equal(ranks.get("A"), 2);
  assert.equal(ranks.get("C"), 3);
});

// --- iCalendar export ------------------------------------------------------------

test("icsStamp: venue-local kickoff with offset converts to UTC", () => {
  assert.equal(icsStamp("2026-06-11T13:00:00-06:00"), "20260611T190000Z");
  assert.equal(icsStamp("2026-07-19T15:00:00-04:00"), "20260719T190000Z");
});

test("icsEscape: backslash, semicolon, comma, newline", () => {
  assert.equal(icsEscape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
});

test("icsFold: lines ≤ 75 octets, unfolds to the original, flags survive", () => {
  const line = "DESCRIPTION:" + "🇧🇷⚽ World Cup must-watch ".repeat(12);
  const folded = icsFold(line);
  const enc = new TextEncoder();
  for (const part of folded.split("\r\n")) {
    assert.ok(enc.encode(part).length <= 75, `folded line is ${enc.encode(part).length} octets`);
  }
  assert.equal(folded.split("\r\n").slice(1).every((l) => l.startsWith(" ")), true);
  assert.equal(folded.replaceAll("\r\n ", ""), line, "unfolding restores the original");
});

test("buildICS: valid structure, UTC times, durations, deterministic DTSTAMP", () => {
  const w = { Brazil: 0.9, Morocco: 0.3 };
  const matches = [
    G("Brazil|Morocco", "Brazil", "Morocco", "2026-06-13T12:00:00-07:00", "C"),
    K(82, "2026-07-01T13:00:00-07:00", "1G", "3AEHIJ"),
  ];
  const probs = { matches: [] };
  probs.matches[82 - 73] = {
    slot1: [["Belgium", 0.58], ["Iran", 0.27]],
    slot2: [["Czechia", 0.21], ["South Africa", 0.19]],
    matchups: [],
  };
  const scored = scoreMatches(matches, probs, w, NO_RESULTS);
  const now = new Date("2026-06-12T08:00:00Z");
  const ics = buildICS(matchEvents(scored, w), now);

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(buildICS(matchEvents(scored, w), now), ics, "deterministic given now");

  const enc = new TextEncoder();
  for (const line of ics.split("\r\n")) {
    assert.ok(enc.encode(line).length <= 75, `line exceeds 75 octets: ${line}`);
  }
  const unfolded = ics.replaceAll("\r\n ", "").split("\r\n");
  assert.equal(unfolded.filter((l) => l === "BEGIN:VEVENT").length, 2);
  assert.equal(unfolded.filter((l) => l.startsWith("DTSTAMP:")).length, 2);
  assert.ok(unfolded.every((l) => !l.startsWith("DTSTAMP:") || l === "DTSTAMP:20260612T080000Z"));

  // Group game: 19:00Z start, +120 min. Seattle KO: 20:00Z start, +165 min.
  assert.ok(unfolded.includes("DTSTART:20260613T190000Z"));
  assert.ok(unfolded.includes("DTEND:20260613T210000Z"));
  assert.ok(unfolded.includes("DTSTART:20260701T200000Z"));
  assert.ok(unfolded.includes("DTEND:20260701T224500Z"));

  // UIDs are unique and stable
  const uids = unfolded.filter((l) => l.startsWith("UID:"));
  assert.equal(new Set(uids).size, 2);
  assert.ok(uids.includes("UID:wc26-brazil-morocco@worldcupcheerguide.com"));
  assert.ok(uids.includes("UID:wc26-m82@worldcupcheerguide.com"));
});

test("matchEvents: summaries name teams when known, slots when not; ranks in description", () => {
  const w = { Brazil: 0.9, Morocco: 0.3, Belgium: 0.7, Iran: 0.1, Czechia: 0.2,
              Spain: 1.0, Egypt: 0.4 };
  const matches = [
    G("Brazil|Morocco", "Brazil", "Morocco", "2026-06-13T12:00:00-07:00", "C"),
    K(82, "2026-07-01T13:00:00-07:00", "1G", "3AEHIJ"),
    K(89, "2026-07-04T13:00:00-04:00", "W73", "W74", "Round of 16"),
  ];
  const probs = { matches: [] };
  probs.matches[82 - 73] = {
    slot1: [["Belgium", 0.58], ["Iran", 0.27]],
    slot2: [["Czechia", 0.21]], matchups: [],
  };
  probs.matches[89 - 73] = { // locked pairing: single entry per slot
    slot1: [["Spain", 1]], slot2: [["Egypt", 1]], matchups: [],
  };
  const events = matchEvents(scoreMatches(matches, probs, w, NO_RESULTS), w);
  const by = Object.fromEntries(events.map((e) => [e.id, e]));

  assert.equal(by["Brazil|Morocco"].summary, "⚽ Brazil vs Morocco — World Cup Group C");
  assert.match(by["Brazil|Morocco"].description, /Brazil \(your #/);

  assert.match(by.m82.summary, /Group G winner vs 3rd place/);
  assert.match(by.m82.description, /Most likely: Belgium vs Czechia/);
  assert.match(by.m82.description, /58% to be here/);

  assert.equal(by.m89.summary, "⚽ Spain vs Egypt — World Cup R16");
  assert.match(by.m89.description, /your #1/); // Spain is the top-ranked team

  for (const e of events) assert.match(e.description, /worldcupcheerguide\.com/);
});

// --- against the real tournament data -------------------------------------------

test("real data: all 104 matches scored, tiers partition the schedule, ICS builds", () => {
  const groupMatches = tournament.group_games.map((g) => ({ kind: "group", ...g }));
  const ko = tournament.knockout.map((m) => ({ kind: "ko", ...m }));
  const all = [...groupMatches, ...ko].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  // Synthetic appearance odds (every KO match: two coin-flip slots) — the
  // scoring contract, not the simulator, is under test here.
  const teams = Object.keys(tournament.ratings);
  const probs = { matches: tournament.knockout.map((m, i) => ({
    slot1: [[teams[i % 48], 0.5], [teams[(i + 1) % 48], 0.5]],
    slot2: [[teams[(i + 2) % 48], 1]],
    matchups: [],
  })) };
  const weights = Object.fromEntries(teams.map((t, i) => [t, i / 48]));
  const scored = scoreMatches(all, probs, weights, { group_results: {}, knockout: {} });
  assert.equal(scored.length, 104);
  const { must, worth, rest } = buildTiers(scored, new Set([teams[0]]));
  assert.equal(must.length + worth.length + rest.length, 104);
  assert.ok(must.length >= MUST_COUNT);
  const ics = buildICS(matchEvents(must, weights), new Date("2026-06-12T00:00:00Z"));
  assert.equal(ics.replaceAll("\r\n ", "").split("\r\n").filter((l) => l === "BEGIN:VEVENT").length,
    must.length);
});
