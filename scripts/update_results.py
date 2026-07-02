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
pair the other way around). Group vs knockout is decided by the team pair, not
the kickoff time: a pair that forms a real group fixture is a group game, any
other pair of real teams can only be meeting in the knockout stage. The
knockout match number is then read off the nearest scheduled kickoff (they are
>=3.5h apart, so kickoff drift can't confuse them). The winner comes from
ESPN's explicit per-competitor flag (correct through extra time and penalties).

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

# A knockout ESPN event is mapped to a match number by nearest scheduled
# kickoff. Knockout matches are >=3.5h apart, and real kickoff drift is at most
# ~1h, so the nearest scheduled kickoff within this window is unambiguous.
KO_KICKOFF_TOLERANCE_S = 2 * 3600

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

def nearest_knockout(ts, ko_matches, tol=KO_KICKOFF_TOLERANCE_S):
    """Given an event kickoff `ts` and a list of (kickoff_ts, num) knockout
    matches, return the num of the nearest one within `tol` seconds, else None."""
    best_num, best_gap = None, None
    for k_ts, num in ko_matches:
        gap = abs(k_ts - ts)
        if best_gap is None or gap < best_gap:
            best_gap, best_num = gap, num
    return best_num if best_gap is not None and best_gap <= tol else None


def parse_espn(events, tournament, min_events=90):
    """Pure parser: ESPN scoreboard events -> (group_results, knockout).
    Raises only when a completed game looks like a group fixture with an
    unmapped team name (a real config bug worth surfacing); everything else is
    skipped so one odd event can't discard a whole refresh."""
    if len(events) < min_events:   # the full tournament is 104 events
        raise ValueError(f"ESPN returned only {len(events)} events")

    valid_group_ids = {g["id"] for g in tournament["group_games"]}
    known_teams = set(tournament["ratings"])
    ko_matches = [(iso_to_utc_ts(m["kickoff"]), m["num"])
                  for m in tournament["knockout"]]

    group_results, knockout = {}, {}
    for ev in events:
        comp = ev["competitions"][0]
        comps = {c["homeAway"]: c for c in comp["competitors"]}
        home, away = comps["home"], comps["away"]
        t1 = ESPN_NAME_MAP.get(home["team"]["displayName"], home["team"]["displayName"])
        t2 = ESPN_NAME_MAP.get(away["team"]["displayName"], away["team"]["displayName"])
        both_real = t1 in known_teams and t2 in known_teams
        completed = bool(comp["status"]["type"].get("completed"))

        # Classify by the team pair, not the kickoff time. Two teams that form a
        # real group fixture are a group game; any other pair of real teams can
        # only meet in the knockout stage. (Kickoff times drift from the
        # published schedule, so a drifted knockout kickoff must not be misread
        # as a bogus group game — that used to abort the entire update.)
        if f"{t1}|{t2}" in valid_group_ids:
            gid, sides = f"{t1}|{t2}", (home, away)
        elif f"{t2}|{t1}" in valid_group_ids:
            gid, sides = f"{t2}|{t1}", (away, home)
        else:
            gid, sides = None, None

        if gid is not None:
            # Group game: only completed ones matter (both teams known by
            # construction of a valid group id).
            if not completed:
                continue
            group_results[gid] = [int(sides[0]["score"]), int(sides[1]["score"])]
            continue

        # Not a group fixture. Find its knockout slot by nearest kickoff.
        ko_num = nearest_knockout(iso_to_utc_ts(ev["date"]), ko_matches)

        if ko_num is not None:
            # Knockout slot: record participants once real; winner once completed.
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
            continue

        # Neither a group fixture nor near any scheduled knockout slot.
        if completed and both_real:
            # Two real teams that aren't a group pair are a knockout game whose
            # kickoff drifted too far to place. Skip it rather than abort the
            # whole refresh; the next run retries.
            print(f"WARNING: completed match {t1} vs {t2} at {ev['date']} is not"
                  f" a group fixture and matched no knockout slot — skipped",
                  file=sys.stderr)
        elif completed and not both_real:
            # A completed non-placeholder game with an unmapped team name is
            # almost certainly a group game missing a name mapping — surface it.
            raise ValueError(f"unmapped team in completed match {t1!r} vs {t2!r}")
        # else: unplayed placeholder — ignore.
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
