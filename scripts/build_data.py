"""
build_data.py — generate site/data/tournament.json (the static tournament facts
the website's in-browser simulator consumes).

Sources:
  * GROUPS / RATINGS from seattle_wc_sim.py (the validated sim data)
  * annex_c.txt (FIFA's official 495-row third-place allocation table)
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
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from seattle_wc_sim import GROUPS, RATINGS, SLOT_TO_MATCH  # noqa: E402

SCHEDULE_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
OUT_PATH = os.path.join("site", "data", "tournament.json")

# openfootball team spellings -> the names used by the simulator / RATINGS.
NAME_MAP = {
    "Bosnia & Herzegovina": "Bosnia-Herzegovina",
    "Cape Verde": "Cabo Verde",
    "Czech Republic": "Czechia",
    "Curaçao": "Curacao",
    "Ivory Coast": "Cote d'Ivoire",
    "Turkey": "Turkiye",
}

# Verified facts (CLAUDE.md, sourced June 11 2026) used as cross-checks on the
# fetched schedule: third-place R32 slots and the Seattle pipeline.
EXPECTED_THIRD_SLOTS = {
    74: ("1E", "3A/B/C/D/F"), 77: ("1I", "3C/D/F/G/H"), 79: ("1A", "3C/E/F/H/I"),
    80: ("1L", "3E/H/I/J/K"), 81: ("1D", "3B/E/F/I/J"), 82: ("1G", "3A/E/H/I/J"),
    85: ("1B", "3E/F/G/I/J"), 87: ("1K", "3D/E/I/J/L"),
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
    rows = []
    slot_names = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in re.match(r"\d+:\s*(.*)", line).group(1).split(";")]
            key = "".join(sorted(parts[:8]))
            assign = {str(SLOT_TO_MATCH[slot_names[i]]): parts[8 + i].lstrip("3")
                      for i in range(8)}
            rows.append({"key": key, "assign": assign})
    assert len(rows) == 495, f"expected 495 Annex C rows, got {len(rows)}"
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
