"""
World Cup 2026 — Seattle Match Simulator (v2: official FIFA rules)
===================================================================
Estimates which teams are likely to appear in:
  - Match 82 (Round of 32, Seattle, Wed July 1):  Group G winner  vs  3rd place from A/E/H/I/J
  - Match 94 (Round of 16, Seattle, Mon July 6):  Winner M81      vs  Winner M82
    where Match 81 (SF Bay Area, July 1) = Group D winner vs 3rd place from B/E/F/I/J

v2 changes (per official FIFA 2026 regulations):
  * Third-place teams assigned to bracket slots using the REAL Annex C table
    (all 495 combinations, transcribed from the published schedule and
    validated: every combination present once, every assignment a permutation
    of the qualified groups, every slot constraint respected).
  * Within-group tiebreakers: head-to-head points/GD/goals among tied teams
    FIRST, then overall GD, goals, then FIFA ranking. (Team conduct score —
    cards — sits between goals and ranking officially; we can't simulate
    cards, so that step is skipped. It matters only on exact ties, which the
    next criterion resolves deterministically anyway.)
  * Ranking of the 12 third-placed teams: points, GD, goals scored,
    [conduct score — skipped, see above], FIFA ranking. No drawing of lots.

Run:  python3 seattle_wc_sim.py [n_sims]
"""

import sys
import re
import random
import math
from collections import defaultdict
from itertools import combinations

# ---------------------------------------------------------------------------
# DATA — Final groups after the Dec 2025 draw + March 2026 playoff results.
# Ratings: FIFA points (Apr 1, 2026 release) where published; values marked
# (est.) are approximations — EDIT FREELY, or swap in Elo from eloratings.net.
# Ratings also serve as the "FIFA World Ranking" tiebreaker, so keep them
# distinct per team.
# ---------------------------------------------------------------------------

GROUPS = {
    "A": ["Mexico", "South Africa", "South Korea", "Czechia"],
    "B": ["Canada", "Bosnia-Herzegovina", "Qatar", "Switzerland"],
    "C": ["Brazil", "Morocco", "Haiti", "Scotland"],
    "D": ["USA", "Paraguay", "Australia", "Turkiye"],
    "E": ["Germany", "Curacao", "Cote d'Ivoire", "Ecuador"],
    "F": ["Netherlands", "Japan", "Sweden", "Tunisia"],
    "G": ["Belgium", "Egypt", "Iran", "New Zealand"],
    "H": ["Spain", "Cabo Verde", "Saudi Arabia", "Uruguay"],
    "I": ["France", "Senegal", "Iraq", "Norway"],
    "J": ["Argentina", "Algeria", "Austria", "Jordan"],
    "K": ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    "L": ["England", "Croatia", "Ghana", "Panama"],
}

RATINGS = {
    # Published FIFA points, Apr 2026
    "France": 1877, "Spain": 1876, "Argentina": 1875, "England": 1826,
    "Portugal": 1764, "Brazil": 1761, "Netherlands": 1758, "Morocco": 1756,
    "Belgium": 1735, "Germany": 1730, "Croatia": 1717, "Colombia": 1693,
    "Senegal": 1689, "Mexico": 1681, "USA": 1673, "Uruguay": 1673.07,
    "Japan": 1660, "Switzerland": 1649, "Canada": 1610,
    # (est.) — approximations, edit as desired
    "Iran": 1615, "Ecuador": 1595, "South Korea": 1590, "Austria": 1585,
    "Australia": 1575, "Norway": 1565, "Sweden": 1560, "Turkiye": 1555,
    "Egypt": 1525, "Algeria": 1520, "Czechia": 1500, "Tunisia": 1495,
    "Paraguay": 1490, "Scotland": 1485, "Cote d'Ivoire": 1480,
    "Bosnia-Herzegovina": 1480.5, "Panama": 1470, "Uzbekistan": 1450,
    "South Africa": 1450.5, "Qatar": 1445, "Saudi Arabia": 1420,
    "Iraq": 1415, "Jordan": 1405, "DR Congo": 1400, "Ghana": 1400.5,
    "Cabo Verde": 1370, "Curacao": 1310, "Haiti": 1300, "New Zealand": 1300.5,
}

# Round-of-32 slots that receive third-place teams: slot label -> match number.
# Annex C columns are in this order. M82 = Seattle; M81 feeds M94 with M82.
SLOT_TO_MATCH = {"1A": 79, "1B": 85, "1D": 81, "1E": 74,
                 "1G": 82, "1I": 77, "1K": 87, "1L": 80}
SLOT_NAMES = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]


def load_annex_c(path="annex_c.txt"):
    """Load FIFA's official 495-combination allocation table.
    Returns {frozenset(8 group letters): {match_number: group_letter}}."""
    table = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"\d+:\s*(.*)", line)
            parts = [p.strip() for p in m.group(1).split(";")]
            groups = frozenset(parts[:8])
            assign = {SLOT_TO_MATCH[SLOT_NAMES[i]]: parts[8 + i].lstrip("3")
                      for i in range(8)}
            table[groups] = assign
    assert len(table) == 495
    return table


ANNEX_C = load_annex_c()

# ---------------------------------------------------------------------------
# MATCH MODEL — Poisson goals scaled by Elo expectation (FIFA-style 600 scale)
# ---------------------------------------------------------------------------

BASE_GOALS = 2.7  # avg total goals per match


def expected_score(r_a, r_b):
    return 1.0 / (1.0 + 10 ** (-(r_a - r_b) / 600.0))


def poisson(lam):
    L = math.exp(-lam)
    k, p = 0, 1.0
    while True:
        p *= random.random()
        if p <= L:
            return k
        k += 1


def simulate_match(team_a, team_b, knockout=False):
    e = expected_score(RATINGS[team_a], RATINGS[team_b])
    g_a, g_b = poisson(BASE_GOALS * e), poisson(BASE_GOALS * (1 - e))
    if knockout and g_a == g_b:
        # ET + penalties proxy: small skill edge, mostly a coin flip
        if random.random() < 0.5 + 0.4 * (e - 0.5):
            g_a += 1
        else:
            g_b += 1
    return g_a, g_b


# ---------------------------------------------------------------------------
# GROUP STAGE with official 2026 tiebreakers (head-to-head first)
# ---------------------------------------------------------------------------

def rank_group(teams, results):
    """Official order: points; then among tied teams: H2H points, H2H GD,
    H2H goals; then overall GD, overall goals; [conduct — not simulated];
    then FIFA ranking (RATINGS proxy)."""
    pts, gd, gf = (defaultdict(int) for _ in range(3))
    for (a, b), (ga, gb) in results.items():
        gd[a] += ga - gb; gd[b] += gb - ga
        gf[a] += ga; gf[b] += gb
        if ga > gb:
            pts[a] += 3
        elif gb > ga:
            pts[b] += 3
        else:
            pts[a] += 1; pts[b] += 1

    def h2h_stats(tied):
        hp, hgd, hgf = (defaultdict(int) for _ in range(3))
        for (a, b), (ga, gb) in results.items():
            if a in tied and b in tied:
                hgd[a] += ga - gb; hgd[b] += gb - ga
                hgf[a] += ga; hgf[b] += gb
                if ga > gb:
                    hp[a] += 3
                elif gb > ga:
                    hp[b] += 3
                else:
                    hp[a] += 1; hp[b] += 1
        return hp, hgd, hgf

    ranked = []
    for p in sorted(set(pts[t] for t in teams), reverse=True):
        tied = [t for t in teams if pts[t] == p]
        if len(tied) > 1:
            hp, hgd, hgf = h2h_stats(set(tied))
            tied.sort(key=lambda t: (hp[t], hgd[t], hgf[t],
                                     gd[t], gf[t], RATINGS[t]), reverse=True)
        ranked.extend(tied)
    return ranked, pts, gd, gf


def simulate_group(teams):
    results = {(a, b): simulate_match(a, b) for a, b in combinations(teams, 2)}
    return rank_group(teams, results)


# ---------------------------------------------------------------------------
# FULL SIMULATION
# ---------------------------------------------------------------------------

def run(n_sims=20000, seed=None):
    if seed is not None:
        random.seed(seed)

    m82_appear, m94_appear = defaultdict(int), defaultdict(int)
    m82_matchups, m94_matchups = defaultdict(int), defaultdict(int)
    usa_in_94 = 0

    for _ in range(n_sims):
        firsts, thirds, third_key = {}, {}, {}
        for g, teams in GROUPS.items():
            ranked, pts, gd, gf = simulate_group(teams)
            firsts[g] = ranked[0]
            t3 = ranked[2]
            thirds[g] = t3
            # Official third-place ranking key: pts, GD, GF, [conduct], ranking
            third_key[g] = (pts[t3], gd[t3], gf[t3], RATINGS[t3])

        # Best 8 third-place groups, then FIFA's Annex C assignment
        qualified = frozenset(sorted(GROUPS, key=lambda g: third_key[g],
                                     reverse=True)[:8])
        assign = ANNEX_C[qualified]  # {match_number: group}

        # Match 82 (Seattle): 1G vs assigned third
        t82_a, t82_b = firsts["G"], thirds[assign[82]]
        m82_appear[t82_a] += 1
        m82_appear[t82_b] += 1
        m82_matchups[tuple(sorted((t82_a, t82_b)))] += 1

        # Match 81: 1D vs assigned third
        t81_a, t81_b = firsts["D"], thirds[assign[81]]

        ga, gb = simulate_match(t82_a, t82_b, knockout=True)
        w82 = t82_a if ga > gb else t82_b
        ga, gb = simulate_match(t81_a, t81_b, knockout=True)
        w81 = t81_a if ga > gb else t81_b

        m94_appear[w81] += 1
        m94_appear[w82] += 1
        m94_matchups[tuple(sorted((w81, w82)))] += 1
        if "USA" in (w81, w82):
            usa_in_94 += 1

    def table(counts, title, top=20):
        print(f"\n{title}")
        print("-" * len(title))
        for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:top]:
            label = " vs ".join(k) if isinstance(k, tuple) else k
            print(f"  {label:<42s} {100*v/n_sims:6.1f}%")

    print(f"Simulations: {n_sims:,}  (allocation: official FIFA Annex C)")
    table(m82_appear, "P(team appears in MATCH 82 — Seattle R32, Jul 1)")
    table(m82_matchups, "Most likely MATCH 82 matchups", top=12)
    table(m94_appear, "P(team appears in MATCH 94 — Seattle R16, Jul 6)")
    table(m94_matchups, "Most likely MATCH 94 matchups", top=12)
    print(f"\n  P(USA plays in Seattle on Jul 6): {100*usa_in_94/n_sims:.1f}%")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    run(n, seed=42)
