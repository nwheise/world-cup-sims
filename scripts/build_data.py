"""
build_data.py — generate site/data/tournament.json (the static tournament facts
the website's in-browser simulator consumes).

Sources:
  * GROUPS / RATINGS below (verified June 11, 2026 — see CLAUDE.md "Verified
    tournament facts" and "Model details")
  * annex_c.txt (FIFA's official 495-row third-place allocation table,
    fully re-validated on every run of this script)
  * openfootball worldcup.json for the 104-match schedule (dates, kickoff
    times, venues, knockout slot codes like "1A" / "2B" / "3A/E/H/I/J" /
    "W81" / "L101")

The output is STATIC — schedule, bracket and ratings don't change during the
tournament — so tournament.json is committed and this script only needs
re-running if FIFA reschedules something or ratings are refreshed.
Live scores are a separate file (results.json, see update_results.py).

Run from the repo root:  python3 scripts/build_data.py
"""

import json
import os
import re
import urllib.request
from itertools import combinations

SCHEDULE_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
OUT_PATH = os.path.join("site", "data", "tournament.json")

# ---------------------------------------------------------------------------
# Tournament data (Dec 2025 draw + March 2026 playoff results — verified).
# Ratings: official FIFA points from the June 11 2026 release (the last ranking
# before the tournament), all 48 teams. The published two-decimal precision
# keeps every rating unique, which matters because ratings also serve as the
# deterministic FIFA-World-Ranking tiebreaker in the simulator.
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
    # Official FIFA points, June 11 2026 release (the last ranking before the
    # tournament). All 48 World Cup teams, transcribed from FIFA's published
    # table; the published two-decimal precision already makes every value
    # unique, which the simulator relies on for the FIFA-ranking tiebreaker.
    "Argentina": 1877.27, "Spain": 1874.71, "France": 1870.70,
    "England": 1828.02, "Portugal": 1767.85, "Brazil": 1765.86,
    "Morocco": 1755.10, "Netherlands": 1753.57, "Belgium": 1742.24,
    "Germany": 1735.77, "Croatia": 1714.87, "Colombia": 1698.35,
    "Mexico": 1687.48, "Senegal": 1684.07, "Uruguay": 1673.07,
    "USA": 1671.23, "Japan": 1661.58, "Switzerland": 1650.06,
    "Iran": 1619.58, "Turkiye": 1605.73, "Ecuador": 1598.52,
    "Austria": 1597.40, "South Korea": 1591.63, "Australia": 1579.34,
    "Algeria": 1571.03, "Egypt": 1562.37, "Canada": 1559.48,
    "Norway": 1557.44, "Cote d'Ivoire": 1540.87, "Panama": 1539.16,
    "Sweden": 1509.79, "Czechia": 1505.74, "Paraguay": 1505.35,
    "Scotland": 1503.34, "Tunisia": 1476.41, "DR Congo": 1474.43,
    "Uzbekistan": 1458.73, "Qatar": 1450.31, "Iraq": 1446.28,
    "South Africa": 1428.38, "Saudi Arabia": 1423.88, "Jordan": 1387.74,
    "Bosnia-Herzegovina": 1387.22, "Cabo Verde": 1371.11, "Ghana": 1346.88,
    "Curacao": 1294.77, "Haiti": 1293.10, "New Zealand": 1275.58,
}

# Annex C column order: assignments for slots 1A;1B;1D;1E;1G;1I;1K;1L =
# these match numbers. M82 = Seattle R32; M81 feeds M94 (Seattle R16) with M82.
SLOT_NAMES = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]
SLOT_TO_MATCH = {"1A": 79, "1B": 85, "1D": 81, "1E": 74,
                 "1G": 82, "1I": 77, "1K": 87, "1L": 80}
# Official per-slot allowed third-place groups (the R32 never rematches
# group-stage opponents) — every annex row is checked against this.
ALLOWED = {
    "1A": set("CEFHI"), "1B": set("EFGIJ"), "1D": set("BEFIJ"),
    "1E": set("ABCDF"), "1G": set("AEHIJ"), "1I": set("CDFGH"),
    "1K": set("DEIJL"), "1L": set("EHIJK"),
}

# Verified third-place R32 slots (CLAUDE.md, sourced June 11 2026), used as a
# cross-check on the fetched schedule.
EXPECTED_THIRD_SLOTS = {
    74: ("1E", "3A/B/C/D/F"), 77: ("1I", "3C/D/F/G/H"), 79: ("1A", "3C/E/F/H/I"),
    80: ("1L", "3E/H/I/J/K"), 81: ("1D", "3B/E/F/I/J"), 82: ("1G", "3A/E/H/I/J"),
    85: ("1B", "3E/F/G/I/J"), 87: ("1K", "3D/E/I/J/L"),
}

# openfootball team spellings -> the names used above.
NAME_MAP = {
    "Bosnia & Herzegovina": "Bosnia-Herzegovina",
    "Cape Verde": "Cabo Verde",
    "Czech Republic": "Czechia",
    "Curaçao": "Curacao",
    "Ivory Coast": "Cote d'Ivoire",
    "Turkey": "Turkiye",
}


def norm(name):
    return NAME_MAP.get(name, name)


def fetch_schedule():
    with urllib.request.urlopen(SCHEDULE_URL, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))["matches"]


def to_iso(date, time):
    """'2026-06-11' + '13:00 UTC-6' -> '2026-06-11T13:00:00-06:00'."""
    m = re.match(r"(\d\d:\d\d) UTC([+-]\d+)(?::(\d\d))?", time or "")
    if not m:
        return f"{date}T12:00:00Z"
    hh, off, offmin = m.group(1), int(m.group(2)), m.group(3) or "00"
    return f"{date}T{hh}:00{off:+03d}:{offmin}"


def load_annex_c(path="annex_c.txt"):
    """Load AND fully validate FIFA's official 495-combination table:
    rows 1..495, every C(12,8) combination exactly once, each row's
    assignments a permutation of its qualified groups, every assignment
    slot-legal. (Absorbed from the former validate_annex_c.py.)"""
    rows, by_num = [], {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"(\d+):\s*(.*)", line)
            num = int(m.group(1))
            parts = [p.strip() for p in m.group(2).split(";")]
            assert len(parts) == 16, f"row {num}: {len(parts)} fields"
            groups = frozenset(parts[:8])
            slot_assign = {SLOT_NAMES[i]: parts[8 + i].lstrip("3") for i in range(8)}
            assert len(groups) == 8, f"row {num}: groups not 8 distinct"
            assert frozenset(slot_assign.values()) == groups, \
                f"row {num}: assignments are not a permutation of the groups"
            for slot, g in slot_assign.items():
                assert g in ALLOWED[slot], f"row {num}: slot {slot} assigned 3{g}"
            by_num[num] = groups
            rows.append({
                "key": "".join(sorted(parts[:8])),
                "assign": {str(SLOT_TO_MATCH[s]): g for s, g in slot_assign.items()},
            })
    assert sorted(by_num) == list(range(1, 496)), "expected rows 1..495"
    combos = {frozenset(c) for c in combinations("ABCDEFGHIJKL", 8)}
    assert set(by_num.values()) == combos, "not every 8-of-12 combination present once"
    assert len({r["key"] for r in rows}) == 495
    return rows


def main():
    schedule = fetch_schedule()
    assert len(schedule) == 104, f"expected 104 matches, got {len(schedule)}"

    group_games, knockout = [], []
    for m in schedule:
        if "group" in m:
            a, b = norm(m["team1"]), norm(m["team2"])
            assert a in RATINGS and b in RATINGS, f"unmapped team in {m}"
            group_games.append({
                "a": a, "b": b, "group": m["group"][-1],
                "kickoff": to_iso(m["date"], m.get("time")),
                "ground": m["ground"],
            })
        else:
            knockout.append(m)

    assert len(group_games) == 72 and len(knockout) == 32
    group_games.sort(key=lambda g: g["kickoff"])
    for g in group_games:
        g["id"] = f"{g['a']}|{g['b']}"

    # Knockout matches: ensure all have nums (3rd-place game and final lack
    # them in the source), normalize, sort 73..104.
    by_round_num = {"Match for third place": 103, "Final": 104}
    ko = []
    for m in knockout:
        num = m.get("num") or by_round_num.get(m["round"])
        assert num, f"knockout match without num: {m}"
        ko.append({
            "id": f"m{num}", "num": num, "round": m["round"],
            "slot1": m["team1"], "slot2": m["team2"],
            "kickoff": to_iso(m["date"], m.get("time")),
            "ground": m["ground"],
        })
    ko.sort(key=lambda m: m["num"])
    assert [m["num"] for m in ko] == list(range(73, 105))

    # Cross-check the third-place slots against the verified table.
    for num, (s1, s2) in EXPECTED_THIRD_SLOTS.items():
        m = ko[num - 73]
        assert (m["slot1"], m["slot2"]) == (s1, s2), \
            f"match {num}: schedule says {m['slot1']} vs {m['slot2']}, expected {s1} vs {s2}"
    # Seattle pipeline sanity.
    assert ko[94 - 73]["slot1"] == "W81" and ko[94 - 73]["slot2"] == "W82"
    assert "Seattle" in ko[82 - 73]["ground"] and "Seattle" in ko[94 - 73]["ground"]

    # Every group plays 6 games and every team appears 3 times.
    for g, teams in GROUPS.items():
        games = [x for x in group_games if x["group"] == g]
        assert len(games) == 6
        for t in teams:
            assert sum(1 for x in games if t in (x["a"], x["b"])) == 3

    data = {
        "generated_from": SCHEDULE_URL,
        "groups": GROUPS,
        "ratings": RATINGS,
        "group_games": group_games,   # chronological; id = "TeamA|TeamB"
        "knockout": ko,               # nums 73..104; slot codes 1A/2A/3../W../L..
        "annex_c": load_annex_c(),    # key = sorted 8 qualified groups
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    print(f"wrote {OUT_PATH}: {len(group_games)} group games, {len(ko)} knockout matches, "
          f"{len(data['annex_c'])} Annex C rows")


if __name__ == "__main__":
    main()
