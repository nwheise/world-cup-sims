"""
Reproducible test suite for the World Cup 2026 Seattle simulator + preference tools.

Run all:        python3 -m unittest test_sim -v
Run one class:  python3 -m unittest test_sim.TestRankGroup -v
Or just:        python3 test_sim.py

Pure stdlib (unittest), no dependencies. All randomized tests are seeded, so
results are deterministic. Expects annex_c.txt in the working directory.
"""

import random
import unittest
from itertools import combinations

import seattle_wc_sim as sim
import rank_prefs
import cheer_guide
from validate_annex_c import validate, ALLOWED


# ---------------------------------------------------------------------------
# Annex C transcription
# ---------------------------------------------------------------------------
class TestAnnexC(unittest.TestCase):
    def test_validator_passes(self):
        errors = validate("annex_c.txt")
        self.assertEqual(errors, [], f"annex_c.txt invalid:\n" + "\n".join(errors))

    def test_loaded_table_size(self):
        # C(12,8) = 495 combinations, each a frozenset key
        self.assertEqual(len(sim.ANNEX_C), 495)
        self.assertEqual(len(sim.ANNEX_C),
                         len(list(combinations("ABCDEFGHIJKL", 8))))

    def test_every_assignment_is_slot_legal(self):
        # Cross-check the loaded table (not just the text) against allowed sets.
        slot_for_match = {m: s for s, m in sim.SLOT_TO_MATCH.items()}
        for groups, assign in sim.ANNEX_C.items():
            self.assertEqual(frozenset(assign.values()), groups)
            for match_no, g in assign.items():
                self.assertIn(g, ALLOWED[slot_for_match[match_no]])


# ---------------------------------------------------------------------------
# Data integrity: groups, ratings
# ---------------------------------------------------------------------------
class TestData(unittest.TestCase):
    def test_twelve_groups_of_four(self):
        self.assertEqual(len(sim.GROUPS), 12)
        for g, teams in sim.GROUPS.items():
            self.assertEqual(len(teams), 4, f"group {g}")

    def test_48_distinct_teams(self):
        teams = [t for ts in sim.GROUPS.values() for t in ts]
        self.assertEqual(len(teams), 48)
        self.assertEqual(len(set(teams)), 48, "duplicate team across groups")

    def test_every_team_has_a_rating(self):
        for ts in sim.GROUPS.values():
            for t in ts:
                self.assertIn(t, sim.RATINGS, f"{t} missing from RATINGS")

    def test_ratings_are_unique(self):
        # The FIFA-ranking tiebreaker is the deterministic last resort, so no two
        # teams may share a rating (the fractional offsets in RATINGS ensure this).
        vals = list(sim.RATINGS.values())
        self.assertEqual(len(vals), len(set(vals)), "duplicate rating values")


# ---------------------------------------------------------------------------
# Match model
# ---------------------------------------------------------------------------
class TestMatchModel(unittest.TestCase):
    def test_expected_score_symmetry(self):
        a, b = sim.expected_score(1700, 1500), sim.expected_score(1500, 1700)
        self.assertAlmostEqual(a + b, 1.0, places=9)

    def test_expected_score_equal_is_half(self):
        self.assertAlmostEqual(sim.expected_score(1600, 1600), 0.5, places=9)

    def test_expected_score_monotonic(self):
        self.assertGreater(sim.expected_score(1700, 1500),
                           sim.expected_score(1600, 1500))

    def test_simulate_match_nonnegative_ints(self):
        random.seed(1)
        for _ in range(200):
            ga, gb = sim.simulate_match("Brazil", "Haiti")
            self.assertIsInstance(ga, int)
            self.assertIsInstance(gb, int)
            self.assertGreaterEqual(ga, 0)
            self.assertGreaterEqual(gb, 0)

    def test_knockout_never_ties(self):
        random.seed(2)
        for _ in range(500):
            ga, gb = sim.simulate_match("Germany", "Curacao", knockout=True)
            self.assertNotEqual(ga, gb, "knockout must produce a winner")


# ---------------------------------------------------------------------------
# Group ranking & official tiebreakers
# ---------------------------------------------------------------------------
class TestRankGroup(unittest.TestCase):
    def test_simple_total_order(self):
        teams = ["A", "B", "C", "D"]
        # Inject A>B>C>D ratings so the tiebreaker is well-defined if needed.
        sim.RATINGS.update({"A": 4000, "B": 3000, "C": 2000, "D": 1000})
        try:
            results = {
                ("A", "B"): (1, 0), ("A", "C"): (1, 0), ("A", "D"): (1, 0),
                ("B", "C"): (1, 0), ("B", "D"): (1, 0), ("C", "D"): (1, 0),
            }
            ranked, _, _, _ = sim.rank_group(teams, results)
            self.assertEqual(ranked, ["A", "B", "C", "D"])
        finally:
            for t in ("A", "B", "C", "D"):
                sim.RATINGS.pop(t, None)

    def test_head_to_head_beats_overall_gd(self):
        # X and Y both finish on 6 pts. Y has the better OVERALL goal difference,
        # but X won their head-to-head meeting. The 2026 rules apply H2H FIRST,
        # so X must rank above Y.
        teams = ["X", "Y", "Z", "W"]
        sim.RATINGS.update({"X": 100, "Y": 200, "Z": 300, "W": 400})
        try:
            results = {
                ("X", "Y"): (1, 0),   # X beats Y head-to-head
                ("X", "Z"): (0, 3),   # X loses big -> drags X's overall GD down
                ("X", "W"): (1, 0),
                ("Y", "Z"): (2, 0),   # Y piles up goals -> better overall GD
                ("Y", "W"): (2, 0),
                ("Z", "W"): (0, 1),
            }
            ranked, pts, gd, _ = sim.rank_group(teams, results)
            self.assertEqual(pts["X"], pts["Y"], "precondition: X and Y tie on pts")
            self.assertGreater(gd["Y"], gd["X"], "precondition: Y better overall GD")
            self.assertLess(ranked.index("X"), ranked.index("Y"),
                            "H2H winner X must outrank Y despite worse overall GD")
        finally:
            for t in ("X", "Y", "Z", "W"):
                sim.RATINGS.pop(t, None)


# ---------------------------------------------------------------------------
# Full tournament structure & invariants
# ---------------------------------------------------------------------------
class TestSimulateTournament(unittest.TestCase):
    def setUp(self):
        # slot 82 third comes from these groups; slot 81 (feeds M94) from these.
        self.slot82_groups = ALLOWED["1G"]          # A E H I J
        self.slot81_groups = ALLOWED["1D"]          # B E F I J
        self.group_pool = {g: set(ts) for g, ts in sim.GROUPS.items()}

    def _teams_in(self, group_letters):
        out = set()
        for g in group_letters:
            out |= self.group_pool[g]
        return out

    def test_structure_and_invariants(self):
        random.seed(42)
        slot82_pool = self._teams_in(self.slot82_groups)
        slot81_pool = self._teams_in(self.slot81_groups)
        d_winner_pool = self.group_pool["D"]
        for _ in range(400):
            rec = sim.simulate_tournament()
            # 12 groups x C(4,2)=6 games = 72 group games recorded
            self.assertEqual(len(rec["group_results"]), 72)
            self.assertEqual(len(rec["m82"]), 2)
            self.assertEqual(len(rec["m94"]), 2)

            t82_a, t82_b = rec["m82"]
            self.assertIn(t82_a, self.group_pool["G"], "M82 home team = Group G winner")
            self.assertIn(t82_b, slot82_pool, "M82 third from an allowed group")

            w81, w82 = rec["m94"]
            self.assertIn(w82, rec["m82"], "M94: w82 came from M82")
            self.assertIn(w81, d_winner_pool | slot81_pool,
                          "M94: w81 is Group D winner or an allowed slot-81 third")

            self.assertEqual(rec["seattle_teams"],
                             set(rec["m82"]) | set(rec["m94"]))

    def test_reproducible_with_seed(self):
        random.seed(123)
        a = [sim.simulate_tournament()["m94"] for _ in range(50)]
        random.seed(123)
        b = [sim.simulate_tournament()["m94"] for _ in range(50)]
        self.assertEqual(a, b)


# ---------------------------------------------------------------------------
# Preference tooling (rank_prefs)
# ---------------------------------------------------------------------------
class TestPrefs(unittest.TestCase):
    def test_pool_is_feeder_groups_only(self):
        self.assertEqual(len(rank_prefs.TEAMS), 36)
        excluded = set(sim.GROUPS["C"]) | set(sim.GROUPS["K"]) | set(sim.GROUPS["L"])
        self.assertEqual(excluded & set(rank_prefs.TEAMS), set(),
                         "C/K/L teams must not be in the preference pool")

    def test_single_comparison_orders_winner_above_loser(self):
        teams = rank_prefs.TEAMS
        w, l = teams[0], teams[1]
        scores = rank_prefs.compute_scores([(w, l)])
        self.assertGreater(scores[w], scores[l])

    def test_counts_track_appearances(self):
        teams = rank_prefs.TEAMS
        comps = [(teams[0], teams[1]), (teams[0], teams[2])]
        counts = rank_prefs.compute_counts(comps)
        self.assertEqual(counts[teams[0]], 2)
        self.assertEqual(counts[teams[1]], 1)
        self.assertEqual(counts[teams[3]], 0)

    def test_weights_normalized_and_monotone(self):
        teams = rank_prefs.TEAMS
        scores = rank_prefs.compute_scores([(teams[0], teams[1])])
        weights = rank_prefs.compute_weights(scores)
        self.assertTrue(all(0.0 <= v <= 1.0 for v in weights.values()))
        self.assertEqual(max(weights.values()), 1.0)
        self.assertEqual(min(weights.values()), 0.0)
        self.assertGreater(weights[teams[0]], weights[teams[1]])

    def test_weights_flat_when_no_comparisons(self):
        weights = rank_prefs.compute_weights(rank_prefs.compute_scores([]))
        self.assertTrue(all(v == 0.5 for v in weights.values()))

    def test_pick_pair_returns_two_distinct_pool_teams(self):
        rng = random.Random(0)
        scores = rank_prefs.compute_scores([])
        counts = rank_prefs.compute_counts([])
        a, b = rank_prefs.pick_pair(scores, counts, rng)
        self.assertNotEqual(a, b)
        self.assertIn(a, rank_prefs.TEAMS)
        self.assertIn(b, rank_prefs.TEAMS)


# ---------------------------------------------------------------------------
# Cheering guide analysis core
# ---------------------------------------------------------------------------
class TestCheerGuide(unittest.TestCase):
    def _weights(self):
        w = {t: 0.1 for t in rank_prefs.TEAMS}
        w["Belgium"] = 1.0   # strong Group G favorite -> its winner goes to Seattle
        return w

    def test_pair_group_covers_all_72_games(self):
        self.assertEqual(len(cheer_guide.PAIR_GROUP), 72)

    def test_emphasize_anchored_and_convex(self):
        f = cheer_guide.emphasize
        self.assertAlmostEqual(f(0.0), 0.0, places=9)
        self.assertAlmostEqual(f(1.0), 1.0, places=9)
        # strictly increasing
        self.assertLess(f(0.3), f(0.6))
        self.assertLess(f(0.6), f(0.9))
        # convex: a favorite outweighs its linear share -> midpoint sits below 0.5
        self.assertLess(f(0.5), 0.5)

    def test_analyze_shape_and_sorting(self):
        rows, summary = cheer_guide.analyze(self._weights(), n_sims=1500, seed=7)
        self.assertEqual(len(rows), 72)
        impacts = [r["impact"] for r in rows]
        self.assertEqual(impacts, sorted(impacts, reverse=True), "rows sorted by impact")
        self.assertTrue(0.0 <= summary["p_top_in_seattle"] <= 1.0)
        # utility is a SUM over up to ~3 distinct Seattle teams, so >1 is allowed.
        self.assertTrue(0.0 <= summary["baseline_u"] <= 4.0)
        self.assertEqual(summary["top_team"], "Belgium")

    def test_top_impact_game_is_in_group_g(self):
        # With Belgium (Group G) the sole favorite, the most decisive games must
        # be in Group G, whose winner plays Match 82 in Seattle.
        rows, _ = cheer_guide.analyze(self._weights(), n_sims=4000, seed=7)
        significant = [r for r in rows if r["significant"]]
        self.assertTrue(significant, "expected at least one significant game")
        self.assertEqual(rows[0]["group"], "G")
        self.assertTrue(all(r["group"] == "G" for r in significant[:3]),
                        "top significant games should be Group G")

    def test_analyze_reproducible(self):
        w = self._weights()
        r1, _ = cheer_guide.analyze(w, n_sims=800, seed=99)
        r2, _ = cheer_guide.analyze(w, n_sims=800, seed=99)
        self.assertEqual([(r["a"], r["b"], r["impact"]) for r in r1],
                         [(r["a"], r["b"], r["impact"]) for r in r2])

    def test_analyze_attaches_loyalty_and_pseat(self):
        rows, _ = cheer_guide.analyze(self._weights(), n_sims=1500, seed=7)
        for r in rows:
            # both participants have a per-outcome Seattle probability in [0,1]
            for t in (r["a"], r["b"]):
                self.assertIn(t, r["p_seat"])
                for o, p in r["p_seat"][t].items():
                    self.assertTrue(0.0 <= p <= 1.0)
            # loyalty is either absent (not perverse) or a well-formed verdict
            self.assertIn("loyalty", r)
            if r["loyalty"] is not None:
                loy = r["loyalty"]
                self.assertIn(loy["against"], (r["a"], r["b"]))
                self.assertAlmostEqual(loy["swing"], loy["p_rec"] - loy["p_win"])
                self.assertEqual(loy["suppressible"],
                                 loy["swing"] < cheer_guide.SWING_THRESHOLD)


class TestLoyaltyGuard(unittest.TestCase):
    """assess_loyalty: never advise cheering against a favorite unless it
    meaningfully improves their odds of reaching Seattle."""

    def test_rooting_for_your_favorite_is_not_perverse(self):
        # You're advised to root for the team you prefer (a) — nothing perverse.
        w = {"Mexico": 1.0, "South Africa": 0.1}
        p_seat = {"Mexico": {"A": 0.3, "B": 0.02, "D": 0.05},
                  "South Africa": {"A": 0.0, "B": 0.0, "D": 0.0}}
        self.assertIsNone(
            cheer_guide.assess_loyalty("Mexico", "South Africa", "A", p_seat, w))

    def test_indifferent_when_you_dont_like_the_denied_team(self):
        # Advised to root for b, denying a — but a is barely liked (below floor).
        w = {"Mexico": 0.2, "South Africa": 0.1}
        p_seat = {"Mexico": {"A": 0.02, "B": 0.3, "D": 0.05},
                  "South Africa": {"A": 0.0, "B": 0.0, "D": 0.0}}
        self.assertIsNone(
            cheer_guide.assess_loyalty("Mexico", "South Africa", "B", p_seat, w))

    def test_worth_it_perverse_call_is_kept(self):
        # Favorite Mexico only reaches Seattle by losing (3rd-place route), and
        # it genuinely pays off: 2% -> 30%. Flagged perverse but NOT suppressed.
        w = {"Mexico": 1.0, "South Africa": 0.1}
        p_seat = {"Mexico": {"A": 0.02, "B": 0.30, "D": 0.05},
                  "South Africa": {"A": 0.0, "B": 0.0, "D": 0.0}}
        loy = cheer_guide.assess_loyalty("Mexico", "South Africa", "B", p_seat, w)
        self.assertEqual(loy["against"], "Mexico")
        self.assertAlmostEqual(loy["swing"], 0.28)
        self.assertFalse(loy["suppressible"])

    def test_pointless_perverse_call_is_suppressed(self):
        # Same setup but the losing route barely helps (2% -> 4%): suppressed.
        w = {"Germany": 1.0, "Ecuador": 0.1}
        p_seat = {"Germany": {"A": 0.02, "B": 0.04, "D": 0.03},
                  "Ecuador": {"A": 0.0, "B": 0.0, "D": 0.0}}
        loy = cheer_guide.assess_loyalty("Germany", "Ecuador", "B", p_seat, w)
        self.assertEqual(loy["against"], "Germany")
        self.assertAlmostEqual(loy["swing"], 0.02)
        self.assertTrue(loy["suppressible"])

    def test_draw_that_denies_a_favorite_is_perverse(self):
        w = {"Mexico": 1.0, "South Africa": 0.1}
        p_seat = {"Mexico": {"A": 0.30, "B": 0.02, "D": 0.04},
                  "South Africa": {"A": 0.0, "B": 0.0, "D": 0.0}}
        loy = cheer_guide.assess_loyalty("Mexico", "South Africa", "D", p_seat, w)
        self.assertEqual(loy["against"], "Mexico")
        # swing vs. Mexico winning (A): 0.04 - 0.30 < 0 -> clearly suppressible
        self.assertTrue(loy["suppressible"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
