/*
 * worker.js — Web Worker wrapper around sim-core.js.
 *
 * Protocol (postMessage):
 *   in:  { type: "simulate", tournament, results, nSims, seed }
 *   out: { type: "progress", done, total }            (every ~2000 sims)
 *        { type: "simulated", probs, groupProbs, meta }
 *   in:  { type: "analyze", weights, attended, reqId } (after "simulated")
 *   out: { type: "analysis", reqId, rows, summary }
 *   in:  { type: "teampath", team, reqId }              (after "simulated")
 *   out: { type: "teampath", reqId, team, baseline, rows }
 *
 * The packed per-sim store (~216 bytes/sim) stays in worker memory, so
 * "analyze" — the only call that depends on the user's preferences and
 * attended matches — is a fast aggregation, not a re-simulation.
 */

import {
  prepare, prepareResults, runSims,
  appearanceProbs, groupProbs, forcedKnockout, analyzeCheer, analyzeTeamPath,
} from "./sim-core.js";

let prep = null, fixed = null, store = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "simulate") {
    prep = prepare(msg.tournament);
    fixed = prepareResults(prep, msg.results);
    store = runSims(prep, fixed, msg.nSims, msg.seed,
      (done, total) => self.postMessage({ type: "progress", done, total }));
    const probs = appearanceProbs(prep, store);
    const gp = groupProbs(prep, store);
    // A knockout slot the bracket routes the same team into in every sim is
    // forced by the results so far (the must-watch tab's "decided" signal).
    // Merge both-known forced matchups into fixed.koKnown so the cheer guide
    // and team path can bucket them; this never re-runs the sim (the store is
    // already built, and simulateTournament attributes recorded winners by
    // participants, not by koKnown).
    const forced = forcedKnockout(prep, store);
    forced.forEach(([t1, t2], i) => {
      if (!fixed.koKnown[i] && t1 !== null && t2 !== null) fixed.koKnown[i] = [t1, t2];
    });
    self.postMessage({
      type: "simulated",
      probs: {
        // serialize with team names
        matches: probs.matches.map(({ slot1, slot2, matchups }) => ({
          slot1: slot1.map(([t, p]) => [prep.teams[t], p]),
          slot2: slot2.map(([t, p]) => [prep.teams[t], p]),
          matchups: matchups.map(([t1, t2, p]) => [prep.teams[t1], prep.teams[t2], p]),
        })),
        champion: probs.champion.map(([t, p]) => [prep.teams[t], p]),
      },
      groupProbs: Object.fromEntries(prep.teams.map((t, i) => [t, {
        first: gp.first[i], second: gp.second[i],
        third: gp.third[i], advance: gp.advance[i],
      }])),
      meta: {
        nSims: msg.nSims, seed: msg.seed,
        playedCount: fixed.playedCount,
        koKnown: prep.ko
          .map((m, i) => [m.id, fixed.koKnown[i]?.map((t) => prep.teams[t]) ?? null])
          .filter(([, v]) => v)
          .reduce((o, [k, v]) => ((o[k] = v), o), {}),
        // Per-side forced participants (a locked side shows even while the
        // other is still a distribution): match id -> [name|null, name|null].
        koSlots: prep.ko
          .map((m, i) => [m.id, [
            forced[i][0] === null ? null : prep.teams[forced[i][0]],
            forced[i][1] === null ? null : prep.teams[forced[i][1]],
          ]])
          .filter(([, [a, b]]) => a || b)
          .reduce((o, [k, v]) => ((o[k] = v), o), {}),
      },
    });
  } else if (msg.type === "analyze") {
    if (!store) return;
    const { rows, summary } = analyzeCheer(
      prep, fixed, store, msg.weights, msg.attended, { pinned: msg.pinned });
    self.postMessage({ type: "analysis", reqId: msg.reqId, rows, summary });
  } else if (msg.type === "teampath") {
    if (!store) return;
    const res = analyzeTeamPath(prep, fixed, store, msg.team);
    self.postMessage({ type: "teampath", reqId: msg.reqId, team: msg.team,
                       baseline: res?.baseline ?? null, rows: res?.rows ?? [] });
  }
};
