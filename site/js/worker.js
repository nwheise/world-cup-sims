/*
 * worker.js — Web Worker wrapper around sim-core.js.
 *
 * Protocol (postMessage):
 *   in:  { type: "simulate", tournament, results, nSims, seed }
 *   out: { type: "progress", done, total }            (every ~2000 sims)
 *        { type: "simulated", probs, groupProbs, meta }
 *   in:  { type: "analyze", weights, attended, reqId } (after "simulated")
 *   out: { type: "analysis", reqId, rows, summary }
 *
 * The packed per-sim store (~216 bytes/sim) stays in worker memory, so
 * "analyze" — the only call that depends on the user's preferences and
 * attended matches — is a fast aggregation, not a re-simulation.
 */

import {
  prepare, prepareResults, runSims,
  appearanceProbs, groupProbs, analyzeCheer,
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
    self.postMessage({
      type: "simulated",
      probs: {
        // serialize with team names
        matches: probs.matches.map(({ slot1, slot2 }) => ({
          slot1: slot1.map(([t, p]) => [prep.teams[t], p]),
          slot2: slot2.map(([t, p]) => [prep.teams[t], p]),
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
      },
    });
  } else if (msg.type === "analyze") {
    if (!store) return;
    const { rows, summary } = analyzeCheer(
      prep, fixed, store, msg.weights, msg.attended);
    self.postMessage({ type: "analysis", reqId: msg.reqId, rows, summary });
  }
};
