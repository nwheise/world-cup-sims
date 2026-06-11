/*
 * prefs.js — head-to-head team preference ranking, ported from rank_prefs.py.
 *
 * You're shown two teams and pick the one you'd rather watch live; an
 * Elo-style score updates after each pick and the next pairing is chosen to be
 * maximally informative (the least-compared team against its nearest current
 * rival). Scores are always recomputed by replaying the full pick history, so
 * undo is trivial and the history is the only thing persisted.
 *
 * Pure module (no DOM/localStorage) — the app supplies the team pool and the
 * stored comparison list.
 */

export const INIT_ELO = 1500.0;
export const K = 32.0;
export const ELO_SCALE = 400.0;

function expected(sa, sb) {
  return 1.0 / (1.0 + Math.pow(10, (sb - sa) / ELO_SCALE));
}

/**
 * Replay every pick as an Elo update over `pool` teams. Entries are
 * [winner, loser] for a preference, or [a, b, "="] for declared equal
 * preference (scored as a draw: both pulled toward each other).
 */
export function computeScores(pool, comparisons) {
  const scores = new Map(pool.map((t) => [t, INIT_ELO]));
  for (const [a, b, flag] of comparisons) {
    if (!scores.has(a) || !scores.has(b)) continue; // team outside current pool
    const ea = expected(scores.get(a), scores.get(b));
    const sa = flag === "=" ? 0.5 : 1.0;  // a's "actual score" vs expectation
    scores.set(a, scores.get(a) + K * (sa - ea));
    scores.set(b, scores.get(b) + K * (ea - sa));
  }
  return scores;
}

export function computeCounts(pool, comparisons) {
  const counts = new Map(pool.map((t) => [t, 0]));
  for (const [w, l] of comparisons) {
    for (const t of [w, l]) if (counts.has(t)) counts.set(t, counts.get(t) + 1);
  }
  return counts;
}

/** Min-max normalize scores to [0,1] weights; flat 0.5 before any picks. */
export function computeWeights(scores) {
  const vals = [...scores.values()];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const weights = {};
  for (const [t, s] of scores) {
    weights[t] = hi - lo < 1e-9 ? 0.5 : (s - lo) / (hi - lo);
  }
  return weights;
}

/** With any pins active, unpinned teams top out here — a pinned favorite must
 *  always outrank everything that isn't pinned. */
export const UNPINNED_CAP = 0.85;

/**
 * Apply pinned favorites to a weight map (mutates and returns it): pinned
 * teams are locked at 1.0, and — so that "pinned" always means "above
 * everything else" — all other weights are compressed into [0, UNPINNED_CAP].
 * No pins in the pool -> weights are untouched.
 */
export function applyPins(weights, pinned, cap = UNPINNED_CAP) {
  const active = [...pinned].filter((t) => t in weights);
  if (!active.length) return weights;
  for (const t of Object.keys(weights)) weights[t] *= cap;
  for (const t of active) weights[t] = 1.0;
  return weights;
}

/**
 * Most-informative next pairing: a least-compared team vs. its nearest rival
 * by current score. `avoid` (a 2-element array/set of names) prevents an
 * immediate repeat. `rnd` defaults to Math.random (no reproducibility needed
 * for an interactive picker).
 */
export function pickPair(pool, scores, counts, avoid = null, rnd = Math.random) {
  if (pool.length < 2) return null;
  const fewest = Math.min(...pool.map((t) => counts.get(t) ?? 0));
  const candidates = pool.filter((t) => (counts.get(t) ?? 0) === fewest);
  const a = candidates[Math.floor(rnd() * candidates.length)];
  const others = pool.filter((t) => t !== a).sort((x, y) =>
    (Math.abs(scores.get(x) - scores.get(a)) - Math.abs(scores.get(y) - scores.get(a))) ||
    ((counts.get(x) ?? 0) - (counts.get(y) ?? 0)));
  let b = others[0];
  const avoidSet = avoid ? new Set(avoid) : null;
  if (avoidSet && avoidSet.has(a) && avoidSet.has(b) && others.length > 1) b = others[1];
  // Randomize sides to avoid position bias.
  return rnd() < 0.5 ? [a, b] : [b, a];
}
