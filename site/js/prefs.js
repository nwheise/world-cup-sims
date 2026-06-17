/*
 * prefs.js — head-to-head team preference ranking.
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

/** Strength priors are compressed into INIT_ELO ± PRIOR_SPREAD/2, so the
 *  default order is "best teams first" but a handful of head-to-head picks
 *  can still drag any team across the field (one pick moves ~32 points). */
export const PRIOR_SPREAD = 300;

/**
 * Map team-strength ratings (FIFA points) onto preference-Elo priors:
 * min-max compressed into [INIT_ELO - PRIOR_SPREAD/2, INIT_ELO + PRIOR_SPREAD/2].
 * Default assumption: with no picks yet, you'd rather see stronger teams.
 */
export function ratingPriors(ratings) {
  const vals = Object.values(ratings);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const priors = new Map();
  for (const [t, r] of Object.entries(ratings)) {
    const z = hi - lo < 1e-9 ? 0.5 : (r - lo) / (hi - lo);
    priors.set(t, INIT_ELO + PRIOR_SPREAD * (z - 0.5));
  }
  return priors;
}

/**
 * Replay every pick as an Elo update over `pool` teams. Entries are
 * [winner, loser] for a preference, or [a, b, "="] for declared equal
 * preference (scored as a draw: both pulled toward each other).
 * `priors` (optional Map) seeds each team's starting score.
 */
export function computeScores(pool, comparisons, priors = null) {
  const scores = new Map(pool.map((t) => [t, priors?.get(t) ?? INIT_ELO]));
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

/** Binary entropy of the predicted pick outcome — peaks at scores equal. */
function entropy(p) {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/** Candidates within this fraction of the top information score are drawn
 *  from uniformly — near-optimal pairs only, but no two sessions ask the
 *  exact same sequence. */
export const NEAR_BEST = 0.9;

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Most-informative next pairing, scored over EVERY pair in the pool (48
 * teams = 1128 pairs — trivial to scan per pick). A comparison teaches the
 * most when (a) its outcome is uncertain — scores close, so high outcome
 * entropy — and (b) the teams are still poorly located — few picks, so a
 * result moves them far. Information score:
 *
 *   info(a,b) = (1/(1+count_a) + 1/(1+count_b)) · H(E_ab) / (1 + timesAsked)
 *
 * The repeat divisor (from `comparisons`) keeps the picker from re-asking a
 * settled question. `avoid` prevents an immediate repeat of the last pair.
 * `rnd` defaults to Math.random (no reproducibility needed interactively).
 */
export function pickPair(pool, scores, counts, avoid = null, rnd = Math.random,
                         comparisons = []) {
  if (pool.length < 2) return null;
  const asked = new Map();
  for (const [a, b] of comparisons) {
    const k = pairKey(a, b);
    asked.set(k, (asked.get(k) ?? 0) + 1);
  }
  const avoidSet = avoid ? new Set(avoid) : null;
  const cand = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      if (avoidSet && avoidSet.has(a) && avoidSet.has(b)) continue;
      const unc = 1 / (1 + (counts.get(a) ?? 0)) + 1 / (1 + (counts.get(b) ?? 0));
      const ent = entropy(expected(scores.get(a), scores.get(b)));
      const rep = asked.get(pairKey(a, b)) ?? 0;
      cand.push({ a, b, info: (unc * ent) / (1 + rep) });
    }
  }
  // Pool of 2 with that pair avoided: nothing else to ask — repeat it.
  if (!cand.length) return rnd() < 0.5 ? [pool[0], pool[1]] : [pool[1], pool[0]];
  const best = Math.max(...cand.map((c) => c.info));
  const near = cand.filter((c) => c.info >= best * NEAR_BEST);
  const { a, b } = near[Math.floor(rnd() * near.length)];
  // Randomize sides to avoid position bias.
  return rnd() < 0.5 ? [a, b] : [b, a];
}
