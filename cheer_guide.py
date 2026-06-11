"""
cheer_guide.py — turn your personal team ranking into a per-game cheering guide.

Objective: maximize the total enjoyment of your Seattle lineup, weighted toward
your favorites. For each simulated tournament, the value sums an EMPHASIZED
desire-weight over the distinct teams you'd watch across your two tickets (Match
82's two teams plus Match 94's other team):
        utility = sum(emphasize(weight[t]) for t in Seattle teams)
`emphasize` is a convex (exponential) remap of the [0,1] weight, so a beloved
team is worth far more than several lukewarm ones — yet a second favorite still
adds real value (USA *and* Brazil beats USA *and* a minnow). The guide reports,
for every group-stage game, which outcome to root for to maximize the expected
value of that utility — i.e. which result most improves your overall Seattle
lineup across Match 82 (Seattle R32) and Match 94 (Seattle R16).

How it works (one sim, then bucket):
  We run ONE big Monte Carlo. Each sim records every group-game scoreline and
  the resulting utility. For each game we then average utility within the sims
  where team A won / it was a draw / team B won. Because group games are drawn
  independently from fixed ratings (no confounders), E[utility | A won game g]
  from this bucketing equals the causal "if A wins, my expected payoff" — so no
  per-game conditional re-runs are needed. This also surfaces counterintuitive
  calls automatically (e.g. rooting for a strong team to LOSE so it drops to 3rd
  and the Annex C table happens to route it to Seattle).

Note: even games in groups C/K/L (whose teams can't reach Seattle) can have a
small nonzero impact — a third-place finish there can change which 8 thirds
qualify, shifting the Annex C row. So all 72 games are scored and ranked.

Run:  python3 cheer_guide.py [n_sims]      (default 50000, seed 42)
Needs preferences.json from rank_prefs.py.
"""

import json
import math
import os
import random
import sys
from collections import defaultdict

from seattle_wc_sim import GROUPS, RATINGS, simulate_tournament

PREFS_PATH = "preferences.json"

# Convexity of the preference curve. Each team's normalized weight w in [0,1] is
# remapped through emphasize(w) before summing, so highly-preferred teams count
# disproportionately more. Higher EMPHASIS = steeper (more top-heavy); EMPHASIS=0
# is the plain linear sum. At EMPHASIS=2 a mid-table (w=0.5) team is worth ~0.39 of
# a favorite and a barely-liked (w=0.1) team ~0.07 — a gentle tilt toward favorites.
EMPHASIS = 2.0


def emphasize(w):
    """Anchored exponential: f(0)=0, f(1)=1, convex in between."""
    if EMPHASIS == 0:
        return w
    return (math.exp(EMPHASIS * w) - 1.0) / (math.exp(EMPHASIS) - 1.0)


# pair (frozenset of two teams) -> group letter, for labeling games
PAIR_GROUP = {}
for _g, _teams in GROUPS.items():
    for _i in range(len(_teams)):
        for _j in range(_i + 1, len(_teams)):
            PAIR_GROUP[frozenset((_teams[_i], _teams[_j]))] = _g


def load_weights():
    if not os.path.exists(PREFS_PATH):
        sys.exit(f"No {PREFS_PATH} found. Run:  python3 rank_prefs.py  first.")
    with open(PREFS_PATH) as f:
        data = json.load(f)
    weights = data.get("weights", {})
    if not weights:
        sys.exit(f"{PREFS_PATH} has no weights yet — make some picks in rank_prefs.py.")
    return weights, len(data.get("comparisons", []))


def analyze(weights, n_sims, seed=42):
    """Run the Monte Carlo and return (rows, summary) — no printing, so this is
    the testable core. `rows` is one dict per game sorted by impact desc;
    `summary` holds baseline stats."""
    top_team = max(weights, key=weights.get)
    random.seed(seed)

    # buckets[(a,b)][outcome] = [sum_utility, count];  outcome in {"A","D","B"}
    buckets = defaultdict(lambda: {"A": [0.0, 0], "D": [0.0, 0], "B": [0.0, 0]})
    total_u = 0.0
    total_u2 = 0.0
    top_in_seattle = 0

    for _ in range(n_sims):
        rec = simulate_tournament()
        seattle = rec["seattle_teams"]
        # Sum the emphasized weight of each distinct team you'd watch — rewards
        # multiple favorites, but convexly tilted toward your top picks.
        u = sum(emphasize(weights.get(t, 0.0)) for t in seattle)
        total_u += u
        total_u2 += u * u
        if top_team in seattle:
            top_in_seattle += 1
        for (a, b), (ga, gb) in rec["group_results"].items():
            o = "A" if ga > gb else ("B" if gb > ga else "D")
            cell = buckets[(a, b)][o]
            cell[0] += u
            cell[1] += 1

    # Variance of the utility, for a per-game Monte Carlo noise floor: the
    # impact of two bucket means is only meaningful if it clears sampling error.
    var_u = max(total_u2 / n_sims - (total_u / n_sims) ** 2, 0.0)

    # Per-game: mean utility per outcome, recommended cheer, impact, noise floor.
    rows = []
    for (a, b), bk in buckets.items():
        means = {o: (s / n) for o, (s, n) in bk.items() if n}
        counts = {o: n for o, (s, n) in bk.items() if n}
        best = max(means, key=means.get)
        worst = min(means, key=means.get)
        impact = means[best] - means[worst]
        # SE of (best mean − worst mean); flag significant at ~3 sigma.
        se = math.sqrt(var_u * (1.0 / counts[best] + 1.0 / counts[worst])) \
            if var_u > 0 else 0.0
        rows.append({"a": a, "b": b, "means": means, "best": best,
                     "impact": impact, "significant": impact > 3 * se,
                     "group": PAIR_GROUP[frozenset((a, b))]})
    rows.sort(key=lambda r: r["impact"], reverse=True)

    summary = {"top_team": top_team, "n_sims": n_sims,
               "p_top_in_seattle": top_in_seattle / n_sims,
               "baseline_u": total_u / n_sims}
    return rows, summary


def main():
    n_sims = int(sys.argv[1]) if len(sys.argv) > 1 else 50000
    weights, n_compares = load_weights()

    spread = max(weights.values()) - min(weights.values())
    if spread < 0.05:
        print("⚠  Your preferences are nearly flat — make more picks in rank_prefs.py "
              "for a sharper guide.\n")

    rows, summary = analyze(weights, n_sims)
    top_team = summary["top_team"]

    # ---- output ----------------------------------------------------------
    print(f"Simulations: {n_sims:,}   |   preferences from {n_compares} comparisons")
    print(f"Most-wanted team: {top_team} (weight {weights[top_team]:.2f})")
    print(f"  P({top_team} reaches a Seattle match): {100*summary['p_top_in_seattle']:.1f}%")
    print(f"  Baseline E[total preference in Seattle lineup]: {summary['baseline_u']:.3f}\n")
    print(f"E[lineup] = expected summed preference of your teams in the Seattle lineup, with "
          f"favorites emphasized (γ={EMPHASIS:g}).")
    print("impact = how much this one result swings E[lineup]. Bigger = matters more.\n")

    name = {"A": lambda r: r["a"], "B": lambda r: r["b"], "D": lambda r: "a DRAW"}

    def outcome_label(r, o):
        if o == "D":
            return f"draw {r['means']['D']:.2f}"
        team = r["a"] if o == "A" else r["b"]
        return f"{team} {r['means'][o]:.2f}"

    significant = [r for r in rows if r["significant"]]
    negligible = [r for r in rows if not r["significant"]]

    print("=" * 78)
    print("GAMES THAT MATTER MOST  (root for the listed outcome)")
    print("=" * 78)
    if not significant:
        print("  None clear the Monte Carlo noise floor — your favorites' path to")
        print("  Seattle barely depends on any single group game (or run more sims).")
    for r in significant:
        rec_team = name[r["best"]](r)
        verb = "root for" if r["best"] == "D" else "cheer"
        # flag when the advised side is the rating underdog (counterintuitive)
        upset = ""
        if r["best"] in ("A", "B"):
            adv = r["a"] if r["best"] == "A" else r["b"]
            opp = r["b"] if r["best"] == "A" else r["a"]
            if RATINGS.get(adv, 0) < RATINGS.get(opp, 0):
                upset = "  ← upset!"
        outs = "  |  ".join(outcome_label(r, o) for o in ("A", "D", "B")
                            if o in r["means"])
        print(f"[+{r['impact']:.3f}] Grp {r['group']}  {r['a']} vs {r['b']}")
        print(f"          → {verb} {rec_team:<14s} ({outs}){upset}")

    if negligible:
        max_tail = max(r["impact"] for r in negligible)
        print(f"\n({len(negligible)} other games are within sampling noise "
              f"(impact ≤ {max_tail:.3f}) — they don't meaningfully move your odds.)")


if __name__ == "__main__":
    main()
