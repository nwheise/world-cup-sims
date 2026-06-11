"""
update_results.py — fetch live 2026 World Cup results from openfootball and
write site/data/results.json (the dynamic half of the website's data).

Run by the scheduled GitHub Action (see .github/workflows/site.yml) every few
hours during the tournament; commits only when something changed. Free, no API
key: openfootball/worldcup.json is public-domain data on raw.githubusercontent.

Output schema (everything in simulator team names):
{
  "fetched_at": "<UTC ISO timestamp>",
  "source": "<url>",
  "group_results": { "TeamA|TeamB": [goalsA, goalsB], ... },   # 90-min scores
  "knockout": {
    "m73": { "team1": "X", "team2": "Y",       # present once participants known
             "score": [a, b], "winner": "X" }, # present once played
    ...
  }
}

Group ids match tournament.json's group_games ids (canonical "TeamA|TeamB" in
the schedule's listed order). Knockout winner honors penalties ("p") over extra
time ("et") over full time ("ft").

Run from the repo root:  python3 scripts/update_results.py
"""

import datetime
import json
import os
import sys
import urllib.request

SCHEDULE_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
OUT_PATH = os.path.join("site", "data", "results.json")
TOURNAMENT_PATH = os.path.join("site", "data", "tournament.json")

# Tournament ends July 19, 2026. After a grace period, become a no-op so the
# scheduled workflow stops churning commits.
SHUTOFF = datetime.date(2026, 8, 1)

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


def decided_score(score):
    """Return ([a, b], decisive_stage) for a played match, else (None, None).
    Penalties decide over ET over FT; the returned score is the decisive one."""
    if not isinstance(score, dict):
        return None, None
    for stage in ("p", "et", "ft"):
        s = score.get(stage)
        if isinstance(s, list) and len(s) == 2 and all(isinstance(x, int) for x in s):
            return s, stage
    return None, None


def main():
    if datetime.date.today() > SHUTOFF:
        print("past shutoff date — tournament over, nothing to update")
        return

    with open(TOURNAMENT_PATH) as f:
        tournament = json.load(f)
    valid_group_ids = {g["id"] for g in tournament["group_games"]}
    known_teams = set(tournament["ratings"])
    ko_by_round = {"Match for third place": 103, "Final": 104}

    with urllib.request.urlopen(SCHEDULE_URL, timeout=30) as r:
        matches = json.loads(r.read().decode("utf-8"))["matches"]

    group_results, knockout = {}, {}
    for m in matches:
        if "group" in m:
            a, b = norm(m["team1"]), norm(m["team2"])
            ft = (m.get("score") or {}).get("ft")
            if not (isinstance(ft, list) and len(ft) == 2):
                continue
            gid = f"{a}|{b}"
            if gid not in valid_group_ids:
                # Schedule listed the pair the other way around; flip.
                gid, ft = f"{b}|{a}", [ft[1], ft[0]]
            if gid not in valid_group_ids:
                print(f"WARNING: unknown group game {a} vs {b} — skipped", file=sys.stderr)
                continue
            group_results[gid] = ft
        else:
            num = m.get("num") or ko_by_round.get(m["round"])
            if not num:
                continue
            t1, t2 = norm(m["team1"]), norm(m["team2"])
            if t1 not in known_teams or t2 not in known_teams:
                continue  # still slot codes like "1A" / "W81" — not yet known
            entry = {"team1": t1, "team2": t2}
            score, stage = decided_score(m.get("score"))
            if score is not None and score[0] != score[1]:
                entry["score"] = score
                entry["winner"] = t1 if score[0] > score[1] else t2
            elif stage is not None:
                print(f"WARNING: knockout m{num} has a tied decisive score — skipped winner",
                      file=sys.stderr)
            knockout[f"m{num}"] = entry

    out = {
        "fetched_at": datetime.datetime.now(datetime.timezone.utc)
                      .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SCHEDULE_URL,
        "group_results": group_results,
        "knockout": knockout,
    }

    # Don't churn a commit when only fetched_at changed.
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH) as f:
            old = json.load(f)
        if (old.get("group_results"), old.get("knockout")) == (group_results, knockout):
            print(f"no new results ({len(group_results)} group games, "
                  f"{len(knockout)} knockout entries) — leaving file untouched")
            return

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"wrote {OUT_PATH}: {len(group_results)} group results, "
          f"{len(knockout)} knockout entries")


if __name__ == "__main__":
    main()
