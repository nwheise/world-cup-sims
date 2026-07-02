"""
Tests for the live-results pipeline (scripts/update_results.py) — the one
piece of the site that talks to the outside world. Pure-stdlib unittest.

Run from the repo root:  python3 -m unittest test_update_results -v
"""

import importlib.util
import json
import os
import unittest


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestEspnResultsParser(unittest.TestCase):
    """parse_espn: the live-results seam. Uses the committed tournament.json
    so id/kickoff matching is tested for real."""

    @classmethod
    def setUpClass(cls):
        cls.upd = _load_module(
            "update_results", os.path.join("scripts", "update_results.py"))
        with open(os.path.join("site", "data", "tournament.json")) as f:
            cls.tournament = json.load(f)

    @staticmethod
    def event(date, home, away, hs=None, as_=None, completed=False,
              winner=None):
        def side(ha, team, score, win):
            d = {"homeAway": ha, "team": {"displayName": team}}
            if score is not None:
                d["score"] = str(score)
            if win is not None:
                d["winner"] = win
            return d
        return {"date": date, "competitions": [{
            "status": {"type": {"completed": completed}},
            "competitors": [side("home", home, hs, winner == "home" if winner else None),
                            side("away", away, as_, winner == "away" if winner else None)],
        }]}

    def test_group_game_with_name_mapping_and_flip(self):
        # ESPN lists the pair reversed and uses "United States"/"Türkiye".
        ev = self.event("2026-06-25T19:00Z", "Türkiye", "United States",
                        1, 2, completed=True)
        g, k = self.upd.parse_espn([ev], self.tournament, min_events=0)
        (gid, score), = g.items()
        # Whichever orientation tournament.json uses, the score must follow it:
        # USA scored 2, Türkiye 1.
        self.assertEqual(set(gid.split("|")), {"Turkiye", "USA"})
        self.assertEqual(score[gid.split("|").index("USA")], 2)
        self.assertEqual(score[gid.split("|").index("Turkiye")], 1)
        self.assertEqual(k, {})

    def test_incomplete_games_and_placeholders_are_skipped(self):
        evs = [
            self.event("2026-06-12T01:00Z", "South Korea", "Czechia"),  # live/sched
            self.event("2026-07-01T20:00Z", "Group G Winner",
                       "Third Place Group A/E/H/I/J"),                  # M82 TBD
        ]
        g, k = self.upd.parse_espn(evs, self.tournament, min_events=0)
        self.assertEqual((g, k), ({}, {}))

    def test_knockout_participants_then_winner_via_flag(self):
        # M82 kickoff is 2026-07-01T13:00-07:00 == 20:00Z.
        ev = self.event("2026-07-01T20:00Z", "Belgium", "Czechia")
        g, k = self.upd.parse_espn([ev], self.tournament, min_events=0)
        self.assertEqual(k, {"m82": {"team1": "Belgium", "team2": "Czechia"}})
        # Completed on penalties: tied score, winner from ESPN's flag.
        ev = self.event("2026-07-01T20:00Z", "Belgium", "Czechia",
                        1, 1, completed=True, winner="away")
        g, k = self.upd.parse_espn([ev], self.tournament, min_events=0)
        self.assertEqual(k["m82"]["score"], [1, 1])
        self.assertEqual(k["m82"]["winner"], "Czechia")

    def test_unknown_team_in_completed_group_game_raises(self):
        ev = self.event("2026-06-12T01:00Z", "Korea Republic", "Czechia",
                        1, 0, completed=True)
        with self.assertRaises(ValueError):
            self.upd.parse_espn([ev], self.tournament, min_events=0)

    def test_knockout_kickoff_drift_is_still_a_knockout_not_a_group_game(self):
        # Regression: M79 (Mexico City) is scheduled 2026-06-30T19:00-06:00 ==
        # 2026-07-01T01:00Z. Mexico (Group A) vs Ecuador (Group E) is a real
        # R32 matchup, not a group pair. When ESPN's kickoff drifts an hour off
        # the schedule, the pair is still classified as a knockout game (it used
        # to be misread as an unknown group game and abort the whole update).
        ev = self.event("2026-07-01T02:00Z", "Mexico", "Ecuador",
                        2, 1, completed=True, winner="home")
        g, k = self.upd.parse_espn([ev], self.tournament, min_events=0)
        self.assertEqual(g, {})
        self.assertEqual(k, {"m79": {"team1": "Mexico", "team2": "Ecuador",
                                     "score": [2, 1], "winner": "Mexico"}})

    def test_one_unplaceable_game_does_not_discard_the_others(self):
        # A completed real matchup with a kickoff far from every scheduled
        # knockout slot can't be placed, but it must not abort the refresh — the
        # other results still come through. (Partial feed -> nearest fallback.)
        good = self.event("2026-06-25T19:00Z", "Turkiye", "USA",
                          1, 2, completed=True)
        stray = self.event("2026-07-01T09:00Z", "Mexico", "Ecuador",
                           2, 1, completed=True, winner="home")
        g, k = self.upd.parse_espn([good, stray], self.tournament, min_events=0)
        self.assertEqual(set(next(iter(g)).split("|")), {"Turkiye", "USA"})
        self.assertEqual(k, {})

    def test_same_group_knockout_rematch_is_not_read_as_the_group_game(self):
        # Mexico and South Africa are both in Group A; two group-mates can meet
        # again in a knockout (quarter-finals onward). The rematch shares the
        # group game's team pair, so it must be told apart by time — it kicks off
        # after the knockout stage begins — and recorded as a knockout game,
        # leaving the group result intact rather than overwriting it.
        group = self.event("2026-06-11T19:00Z", "Mexico", "South Africa",
                           2, 0, completed=True)
        # m97 (a quarter-final) kicks off 2026-07-09T16:00-04:00 == 20:00Z.
        rematch = self.event("2026-07-09T20:00Z", "Mexico", "South Africa",
                             1, 0, completed=True, winner="home")
        g, k = self.upd.parse_espn([group, rematch], self.tournament, min_events=0)
        self.assertEqual(g.get("Mexico|South Africa"), [2, 0])
        self.assertEqual(k, {"m97": {"team1": "Mexico", "team2": "South Africa",
                                     "score": [1, 0], "winner": "Mexico"}})

    def test_assign_slots_aligns_order_under_a_session_wide_delay(self):
        # Three slots 3.5h apart; a 2h delay to the whole session drifts each
        # game toward the *next* slot's time, so a nearest-time match would
        # scramble them. Order-preserving alignment (full feed) keeps them right.
        assign = self.upd.assign_knockout_slots
        base = 1_000_000.0
        slots = [(base, 101), (base + 3.5 * 3600, 102), (base + 7 * 3600, 103)]
        delayed = [base + 2 * 3600, base + 5.5 * 3600, base + 9 * 3600]
        self.assertEqual(assign(delayed, slots), {0: 101, 1: 102, 2: 103})
        # Given out of order, alignment still pairs by chronological rank.
        self.assertEqual(assign(list(reversed(delayed)), slots),
                         {0: 103, 1: 102, 2: 101})
        # Partial feed (count mismatch) -> nearest-kickoff fallback.
        self.assertEqual(assign([base + 600], slots), {0: 101})

    def test_event_count_guard_raises(self):
        with self.assertRaises(ValueError):
            self.upd.parse_espn([], self.tournament)


class TestBuildData(unittest.TestCase):
    """build_data.py's embedded data integrity + Annex C validation."""

    @classmethod
    def setUpClass(cls):
        cls.bd = _load_module("build_data", os.path.join("scripts", "build_data.py"))

    def test_groups_and_ratings(self):
        teams = [t for g in self.bd.GROUPS.values() for t in g]
        self.assertEqual(len(teams), 48)
        self.assertEqual(len(set(teams)), 48)
        self.assertEqual(set(teams), set(self.bd.RATINGS))
        # ratings unique: they double as the deterministic ranking tiebreaker
        self.assertEqual(len(set(self.bd.RATINGS.values())), 48)

    def test_annex_c_loads_and_validates(self):
        rows = self.bd.load_annex_c()   # raises on any structural violation
        self.assertEqual(len(rows), 495)
        # spot-check: when A/E/H/I/J-heavy combos qualify, M82 gets a legal group
        for r in rows:
            self.assertIn(r["assign"]["82"], set("AEHIJ"))

    def test_committed_tournament_json_matches_embedded_data(self):
        with open(os.path.join("site", "data", "tournament.json")) as f:
            t = json.load(f)
        self.assertEqual(t["groups"], self.bd.GROUPS)
        self.assertEqual(t["ratings"], self.bd.RATINGS)
        self.assertEqual(len(t["annex_c"]), 495)
        self.assertEqual(len(t["group_games"]), 72)
        self.assertEqual([m["num"] for m in t["knockout"]], list(range(73, 105)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
