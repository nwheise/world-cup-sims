"""
update_results.py — fetch live 2026 World Cup results and write
site/data/results.json (the dynamic half of the website's data).

Source: ESPN's public scoreboard API (keyless, near-live — it had the opening
match's final score within minutes). If the ESPN endpoint ever breaks, this
script logs a warning and leaves results.json untouched; the next scheduled run
tries again.

Run by the scheduled GitHub Action (see .github/workflows/site.yml); commits
only when something changed.

Output schema (everything in simulator team names):
{
  "fetched_at": "<UTC ISO timestamp>",
  "source": "<ESPN scoreboard URL>",
  "group_results": { "TeamA|TeamB": [goalsA, goalsB], ... },   # 90-min scores
  "knockout": {
    "m73": { "team1": "X", "team2": "Y",       # present once participants known
             "score": [a, b], "winner": "X" }, # present once played
    ...
  }
}

Group ids match tournament.json's group_games ids (canonical "TeamA|TeamB" in
the schedule's listed order; flipped automatically if the source lists the
pair the other way around). Knockout events are identified by their UTC
kickoff instant — unique per knockout match in the official schedule — and the
winner comes from ESPN's explicit per-competitor flag (correct through extra
time and penalties).

Run from the repo root:  python3 scripts/update_results.py
"""

import datetime
import json
import os
import sys
import urllib.request

ESPN_URL = ("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/"
            "scoreboard?dates=20260611-20260719&limit=200")
OUT_PATH = os.path.join("site", "data", "results.json")
TOURNAMENT_PATH = os.path.join("site", "data", "tournament.json")

# Tournament ends July 19, 2026. After a grace period, become a no-op so the
# scheduled workflow stops churning commits.
SHUTOFF = datetime.date(2026, 8, 1)

# ESPN team spellings -> the names used by the simulator / RATINGS.
ESPN_NAME_MAP = {
    "Cape Verde": "Cabo Verde",
    "Congo DR": "DR Congo",
    "Curaçao": "Curacao",
    "Ivory Coast": "Cote d'Ivoire",
    "Türkiye": "Turkiye",
    "United States": "USA",
}


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def iso_to_utc_ts(iso):
    """Both '2026-06-11T19:00Z' (ESPN) and '2026-06-11T13:00:00-06:00' (ours)
    -> a comparable UTC timestamp."""
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


# ---------------------------------------------------------------------------
# ESPN (primary)
# ---------------------------------------------------------------------------

def parse_espn(events, tournament, min_events=90):
    """Pure parser: ESPN scoreboard events -> (group_results, knockout).
    Raises on structural surprises so the caller can fall back."""
    if len(events) < min_events:   # the full tournament is 104 events
        raise ValueError(f"ESPN returned only {len(events)} events")

    valid_group_ids = {g["id"] for g in tournament["group_games"]}
    known_teams = set(tournament["ratings"])
    ko_num_by_ts = {iso_to_utc_ts(m["kickoff"]): m["num"]
                    for m in tournament["knockout"]}

    group_results, knockout = {}, {}
    for ev in events:
        comp = ev["competitions"][0]
        comps = {c["homeAway"]: c for c in comp["competitors"]}
        home, away = comps["home"], comps["away"]
        t1 = ESPN_NAME_MAP.get(home["team"]["displayName"], home["team"]["displayName"])
        t2 = ESPN_NAME_MAP.get(away["team"]["displayName"], away["team"]["displayName"])
        both_real = t1 in known_teams and t2 in known_teams
        completed = bool(comp["status"]["type"].get("completed"))
        ko_num = ko_num_by_ts.get(iso_to_utc_ts(ev["date"]))

        if ko_num is not None:
            # Knockout: record participants once real; winner once completed.
            if not both_real:
                continue   # still "Group A Winner" style placeholders
            entry = {"team1": t1, "team2": t2}
            if completed:
                entry["score"] = [int(home["score"]), int(away["score"])]
                if home.get("winner"):
                    entry["winner"] = t1
                elif away.get("winner"):
                    entry["winner"] = t2
                else:
                    print(f"WARNING: completed knockout m{ko_num} has no winner"
                          f" flag — skipped winner", file=sys.stderr)
            knockout[f"m{ko_num}"] = entry
        else:
            # Group game: only completed ones matter.
            if not completed:
                continue
            if not both_real:
                raise ValueError(f"unmapped group team in {t1!r} vs {t2!r}")
            gid, score = f"{t1}|{t2}", [int(home["score"]), int(away["score"])]
            if gid not in valid_group_ids:
                gid, score = f"{t2}|{t1}", [score[1], score[0]]
            if gid not in valid_group_ids:
                raise ValueError(f"unknown group game {t1} vs {t2}")
            group_results[gid] = score
    return group_results, knockout


# ---------------------------------------------------------------------------

def main():
    if datetime.date.today() > SHUTOFF:
        print("past shutoff date — tournament over, nothing to update")
        return

    with open(TOURNAMENT_PATH) as f:
        tournament = json.load(f)

    try:
        events = fetch_json(ESPN_URL).get("events", [])
        group_results, knockout = parse_espn(events, tournament)
    except Exception as exc:
        print(f"WARNING: ESPN source failed ({exc}); leaving results.json untouched",
              file=sys.stderr)
        return

    out = {
        "fetched_at": datetime.datetime.now(datetime.timezone.utc)
                      .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": ESPN_URL,
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
          f"{len(knockout)} knockout entries (source: ESPN)")


if __name__ == "__main__":
    main()
