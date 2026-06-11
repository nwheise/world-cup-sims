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

Loyalty guard: a team outside the two feeder-winner groups (D, G) can only reach
Seattle by finishing 3rd, so the raw utility-max move is to root for your own
favorite to LOSE. We track each participant's P(reach Seattle | outcome) per
game and, when the advised result roots against a team you like (weight ≥
LIKE_FLOOR), check how much it actually helps: if their Seattle odds swing by
less than SWING_THRESHOLD between the recommended (losing) result and them
winning, the call is demoted to a footnote instead of headlining the guide —
you're not told to cheer against a favorite for a payoff that isn't there.

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

# --- Loyalty guard ---------------------------------------------------------
# A team that can only reach Seattle by finishing 3rd in its group (everyone
# outside the two feeder-winner groups D and G) creates a perverse pull: the
# utility-maximizing move is to root for your own favorite to LOSE so they drop
# to 3rd and the Annex C table happens to route them to Seattle. That can be
# genuinely worth it (a Group A third reaches Seattle ~95% of the time) or
# nearly pointless (a Group E third only ~2%). We never want to advise cheering
# against a team you love unless doing so meaningfully improves their odds.
#
# LIKE_FLOOR: on the min-max [0,1] weight scale, a team at or above this is one
#   you clearly like — worth protecting from "root against them" advice.
# SWING_THRESHOLD: minimum gain in P(that team reaches Seattle) — recommended
#   (losing) outcome vs. the outcome where they win their match — for a perverse
#   "root against your favorite" call to be worth surfacing. Below it, the call
#   is demoted to a footnote with the honest (tiny) probabilities. Swing-based,
#   not absolute: it isolates how much THIS one game moves their odds.
# Both are module constants — edit to taste.
LIKE_FLOOR = 0.5
SWING_THRESHOLD = 0.03


def emphasize(w):
    """Anchored exponential: f(0)=0, f(1)=1, convex in between."""
    if EMPHASIS == 0:
        return w
    return (math.exp(EMPHASIS * w) - 1.0) / (math.exp(EMPHASIS) - 1.0)


def assess_loyalty(a, b, best, p_seat, weights, liked_p=None):
    """Decide whether recommending outcome `best` for game a-vs-b means rooting
    AGAINST a team you like, and if so whether the payoff justifies it.

    `best` is "A"/"B"/"D" (a wins / b wins / draw). `p_seat[t]` maps each
    outcome to P(team t reaches Seattle | that outcome). `liked_p` (optional)
    maps OTHER liked teams (any team with weight >= LIKE_FLOOR, possibly
    including a/b) to the same outcome->probability dicts — because the payoff
    for rooting against a favorite can arrive via a DIFFERENT favorite (e.g.
    a draw that denies Canada but protects Switzerland's group-winner path),
    not only via the denied team's own third-place routing.

    Returns None when the recommendation is not perverse (you're rooting for
    the team you prefer, or you don't care about either side), otherwise:
        {against, against_w, p_rec, p_win, swing, kind, suppressible,
         [beneficiary, ben_rec, ben_win, ben_swing]}
    kind: "self"  — the denied team itself gains >= SWING_THRESHOLD,
          "other" — a different liked team does (beneficiary fields present),
          "none"  — nobody you like meaningfully gains => suppressible."""
    wa, wb = weights.get(a, 0.0), weights.get(b, 0.0)
    if best == "A":            # rooting for a -> denying b
        against, against_w, rooted_for_w = b, wb, wa
    elif best == "B":          # rooting for b -> denying a
        against, against_w, rooted_for_w = a, wa, wb
    else:                      # draw -> denying both; the liked one is the cost
        against = a if wa >= wb else b
        against_w, rooted_for_w = max(wa, wb), -1.0
    # Not perverse if you don't really like the denied team, or you're being
    # told to root for the side you actually prefer (or an equal coin-flip).
    if against_w < LIKE_FLOOR or against_w <= rooted_for_w:
        return None
    o_win = "A" if against == a else "B"
    p = p_seat[against]
    p_rec, p_win = p.get(best, 0.0), p.get(o_win, 0.0)
    swing = p_rec - p_win
    out = {"against": against, "against_w": against_w, "p_rec": p_rec,
           "p_win": p_win, "swing": swing}
    if swing >= SWING_THRESHOLD:
        return {**out, "kind": "self", "suppressible": False}
    # The denied team doesn't gain — does another liked team?
    best_ben = None
    for team, pt in (liked_p or {}).items():
        if team == against:
            continue
        gain = pt.get(best, 0.0) - pt.get(o_win, 0.0)
        if gain >= SWING_THRESHOLD and (best_ben is None or gain > best_ben[1]):
            best_ben = (team, gain, pt.get(best, 0.0), pt.get(o_win, 0.0))
    if best_ben:
        team, gain, ben_rec, ben_win = best_ben
        return {**out, "kind": "other", "beneficiary": team, "ben_rec": ben_rec,
                "ben_win": ben_win, "ben_swing": gain, "suppressible": False}
    return {**out, "kind": "none", "suppressible": True}


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

    # Teams you clearly like: tracked per game/outcome so the loyalty guard can
    # credit cross-team payoffs (rooting against one favorite because it helps
    # another). Capped at the 10 highest-weighted.
    liked = sorted((t for t, w in weights.items() if w >= LIKE_FLOOR),
                   key=weights.get, reverse=True)[:10]

    # buckets[(a,b)][outcome] = [sum_utility, count, a_in_seattle, b_in_seattle,
    #                            per_liked_team_in_seattle list]
    # outcome in {"A","D","B"}; the membership counts give P(team reaches
    # Seattle | outcome), used to judge "is rooting against them worth it?".
    buckets = defaultdict(lambda: {o: [0.0, 0, 0, 0, [0] * len(liked)]
                                   for o in ("A", "D", "B")})
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
        liked_in = [i for i, t in enumerate(liked) if t in seattle]
        for (a, b), (ga, gb) in rec["group_results"].items():
            o = "A" if ga > gb else ("B" if gb > ga else "D")
            cell = buckets[(a, b)][o]
            cell[0] += u
            cell[1] += 1
            if a in seattle:
                cell[2] += 1
            if b in seattle:
                cell[3] += 1
            for i in liked_in:
                cell[4][i] += 1

    # Variance of the utility, for a per-game Monte Carlo noise floor: the
    # impact of two bucket means is only meaningful if it clears sampling error.
    var_u = max(total_u2 / n_sims - (total_u / n_sims) ** 2, 0.0)

    # Per-game: mean utility per outcome, recommended cheer, impact, noise floor.
    rows = []
    for (a, b), bk in buckets.items():
        means = {o: (cell[0] / cell[1]) for o, cell in bk.items() if cell[1]}
        counts = {o: cell[1] for o, cell in bk.items() if cell[1]}
        # P(participant reaches Seattle | each outcome) — drives the loyalty guard.
        p_seat = {a: {o: bk[o][2] / counts[o] for o in counts},
                  b: {o: bk[o][3] / counts[o] for o in counts}}
        # Same, for every liked team (cross-team payoffs + transparency).
        p_lineup = {t: {o: bk[o][4][i] / counts[o] for o in counts}
                    for i, t in enumerate(liked)}
        best = max(means, key=means.get)
        worst = min(means, key=means.get)
        impact = means[best] - means[worst]
        # SE of (best mean − worst mean); flag significant at ~3 sigma.
        se = math.sqrt(var_u * (1.0 / counts[best] + 1.0 / counts[worst])) \
            if var_u > 0 else 0.0
        rows.append({"a": a, "b": b, "means": means, "best": best,
                     "impact": impact, "significant": impact > 3 * se,
                     "group": PAIR_GROUP[frozenset((a, b))], "p_seat": p_seat,
                     "p_lineup": p_lineup,
                     "loyalty": assess_loyalty(a, b, best, p_seat, weights,
                                               liked_p=p_lineup)})
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
    # A significant game whose advice is "root against a team you like" for too
    # little payoff (loyalty.suppressible) is demoted out of the main list.
    suppressed = [r for r in significant
                  if r["loyalty"] and r["loyalty"]["suppressible"]]
    main_rows = [r for r in significant if r not in suppressed]

    print("=" * 78)
    print("GAMES THAT MATTER MOST  (root for the listed outcome)")
    print("=" * 78)
    if not main_rows:
        print("  None clear the Monte Carlo noise floor — your favorites' path to")
        print("  Seattle barely depends on any single group game (or run more sims).")
    for r in main_rows:
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
        # Worth-it perverse call: be explicit that it means rooting against a
        # team you like, and show the payoff that justifies it — either the
        # denied team's own best path, or a different favorite's gain.
        loy = r["loyalty"]
        if loy and loy["kind"] == "other":
            print(f"            ↳ yes, this roots AGAINST {loy['against']} — but it"
                  f" lifts {loy['beneficiary']}'s Seattle odds: "
                  f"{100*loy['ben_win']:.0f}% → {100*loy['ben_rec']:.0f}% "
                  f"(+{100*loy['ben_swing']:.0f}pp)")
        elif loy:
            print(f"            ↳ yes, this roots AGAINST {loy['against']} — but it's"
                  f" their best Seattle path: {100*loy['p_win']:.0f}% → "
                  f"{100*loy['p_rec']:.0f}% (+{100*loy['swing']:.0f}pp)")

    if suppressed:
        print(f"\nLOYALTY NOTES  (skipped above — rooting against a favorite "
              f"helps no team you like enough)")
        for r in sorted(suppressed, key=lambda r: -r["loyalty"]["swing"]):
            loy = r["loyalty"]
            print(f"  • Grp {r['group']}  {r['a']} vs {r['b']}: pure utility says "
                  f"root against {loy['against']}, but no favorite gains "
                  f"{100*SWING_THRESHOLD:.0f}pp from it ({loy['against']} "
                  f"themselves: {100*loy['p_win']:.0f}% → {100*loy['p_rec']:.0f}%)"
                  f" — just root for {loy['against']}.")

    if negligible:
        max_tail = max(r["impact"] for r in negligible)
        print(f"\n({len(negligible)} other games are within sampling noise "
              f"(impact ≤ {max_tail:.3f}) — they don't meaningfully move your odds.)")


if __name__ == "__main__":
    main()
