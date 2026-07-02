"""
update_results.py — fetch live 2026 World Cup results and write
site/data/results.json (the dynamic half of the website's data).

Source: ESPN's public scoreboard API (keyless, near-live — it had the opening
match's final score within minutes). If ESPN is merely unreachable this logs a
warning, leaves results.json untouched and exits 0; the next scheduled run tries
again. If the feed comes back but does not parse (a structural surprise), it
exits non-zero so the workflow fails and GitHub notifies us — a silently broken
parser is what let stale results sit for a day.

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

# Fallback tolerance for mapping a lone knockout event to a match number by
# nearest scheduled kickoff (used only for a partial feed — see
# assign_knockout_slots). Wide enough to absorb a real kickoff delay.
KO_KICKOFF_TOLERANCE_S = 6 * 3600

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

def assign_knockout_slots(candidate_ts, ko_matches, tol=KO_KICKOFF_TOLERANCE_S):
    """Map each non-group ("knockout candidate") event to a knockout match
    number. `candidate_ts` is the list of event kickoff timestamps (one per
    candidate); `ko_matches` is [(scheduled_kickoff_ts, num), ...].
    Returns {candidate_index: num}.

    ESPN always carries every knockout match (as a placeholder before its teams
    are known, as a real game after), so a complete feed has exactly one
    candidate per knockout slot. The running order of the knockout stage is
    fixed — a delayed game still kicks off after the game before it and before
    the game after it — so we align the two chronological sequences one-to-one.
    That is robust to a kickoff slipping by any amount (even a whole session
    pushed back hours), which a nearest-time match is not: a delayed game drifts
    toward the next slot's time.

    Only if the feed is partial (candidate count != slot count) do we fall back
    to nearest-kickoff, collision-free (each event and slot used once, closest
    pairs first), within `tol`."""
    if len(candidate_ts) == len(ko_matches):
        cand_order = sorted(range(len(candidate_ts)), key=lambda i: candidate_ts[i])
        slot_order = sorted(ko_matches, key=lambda km: km[0])
        return {ci: slot_order[rank][1] for rank, ci in enumerate(cand_order)}

    pairs = sorted(
        (abs(k_ts - candidate_ts[ci]), ci, num)
        for ci in range(len(candidate_ts))
        for k_ts, num in ko_matches
        if abs(k_ts - candidate_ts[ci]) <= tol)
    assigned, used_nums = {}, set()
    for _gap, ci, num in pairs:
        if ci in assigned or num in used_nums:
            continue
        assigned[ci] = num
        used_nums.add(num)
    return assigned


def parse_espn(events, tournament, min_events=90):
    """Pure parser: ESPN scoreboard events -> (group_results, knockout).
    Raises only on a structural surprise (too few events, or a completed game
    that looks like a group fixture with an unmapped team name — a real config
    bug worth surfacing). Anything else is skipped so one odd event can't
    discard a whole refresh."""
    if len(events) < min_events:   # the full tournament is 104 events
        raise ValueError(f"ESPN returned only {len(events)} events")

    valid_group_ids = {g["id"] for g in tournament["group_games"]}
    known_teams = set(tournament["ratings"])
    ko_matches = [(iso_to_utc_ts(m["kickoff"]), m["num"])
                  for m in tournament["knockout"]]

    # Pass 1: split group games from knockout candidates by the team pair, not
    # the kickoff time. Two teams that form a real group fixture are a group
    # game; any other pair can only meet in the knockout stage. (Kickoff times
    # drift from the published schedule, so a drifted knockout kickoff must not
    # be misread as a bogus group game — that used to abort the entire update.)
    group_results, candidates = {}, []
    for ev in events:
        comp = ev["competitions"][0]
        comps = {c["homeAway"]: c for c in comp["competitors"]}
        home, away = comps["home"], comps["away"]
        t1 = ESPN_NAME_MAP.get(home["team"]["displayName"], home["team"]["displayName"])
        t2 = ESPN_NAME_MAP.get(away["team"]["displayName"], away["team"]["displayName"])
        completed = bool(comp["status"]["type"].get("completed"))

        if f"{t1}|{t2}" in valid_group_ids:
            gid, sides = f"{t1}|{t2}", (home, away)
        elif f"{t2}|{t1}" in valid_group_ids:
            gid, sides = f"{t2}|{t1}", (away, home)
        else:
            gid = None

        if gid is not None:
            # Group game: only completed ones matter (both teams known by
            # construction of a valid group id).
            if completed:
                group_results[gid] = [int(sides[0]["score"]), int(sides[1]["score"])]
            continue

        candidates.append({
            "t1": t1, "t2": t2, "home": home, "away": away, "date": ev["date"],
            "both_real": t1 in known_teams and t2 in known_teams,
            "n_real": (t1 in known_teams) + (t2 in known_teams),
            "completed": completed, "ts": iso_to_utc_ts(ev["date"]),
        })

    # Pass 2: give each candidate its knockout match number, then record it.
    slot_of = assign_knockout_slots([c["ts"] for c in candidates], ko_matches)

    knockout = {}
    for i, c in enumerate(candidates):
        num = slot_of.get(i)
        if num is None:
            if c["completed"] and c["both_real"]:
                # A real matchup we couldn't place (e.g. a kickoff far outside
                # any slot on a partial feed). Skip rather than abort; retry next.
                print(f"WARNING: completed match {c['t1']} vs {c['t2']} at "
                      f"{c['date']} matched no knockout slot — skipped",
                      file=sys.stderr)
            elif c["completed"] and c["n_real"]:
                # One real team, no slot: almost certainly a group game with an
                # unmapped opponent name — a real config bug, surface it.
                raise ValueError(f"unmapped team in completed match "
                                 f"{c['t1']!r} vs {c['t2']!r}")
            # else: unplayed placeholder — ignore.
            continue
        if not c["both_real"]:
            continue   # a "Group A Winner" placeholder for a future knockout
        entry = {"team1": c["t1"], "team2": c["t2"]}
        if c["completed"]:
            entry["score"] = [int(c["home"]["score"]), int(c["away"]["score"])]
            if c["home"].get("winner"):
                entry["winner"] = c["t1"]
            elif c["away"].get("winner"):
                entry["winner"] = c["t2"]
            else:
                print(f"WARNING: completed knockout m{num} has no winner flag "
                      f"— skipped winner", file=sys.stderr)
        knockout[f"m{num}"] = entry
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
    except Exception as exc:
        # Transient: ESPN slow or unreachable. Leave the file and retry next run;
        # not worth alerting on (the cron runs hourly).
        print(f"WARNING: could not reach ESPN ({exc}); leaving results.json "
              f"untouched", file=sys.stderr)
        return

    try:
        group_results, knockout = parse_espn(events, tournament)
    except Exception as exc:
        # Structural: the feed came back but didn't parse (too few events, an
        # unmapped team, a shape change). This needs a human, so exit non-zero —
        # the workflow turns that into a failed run so GitHub notifies us,
        # instead of the pipeline sitting silently broken for days.
        print(f"ERROR: could not parse the ESPN feed ({exc}); results.json left "
              f"untouched — the live-results pipeline needs attention",
              file=sys.stderr)
        sys.exit(2)

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
