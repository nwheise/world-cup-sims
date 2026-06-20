# ⚽ worldcupcheerguide.com

**[worldcupcheerguide.com](https://worldcupcheerguide.com)** — attending FIFA World Cup 2026
matches? Tell the site which games you have tickets for and which teams you'd love to see,
and a full-tournament Monte Carlo simulation tells you **who to cheer for in every remaining
game** to maximize the chance your favorite teams end up playing in front of you — plus
live-updating probabilities for every knockout matchup, group, and the title.

Everything runs in your browser. There is no backend, no account, and nothing to pay for:
a static GitHub Pages site, live results refreshed by a scheduled GitHub Action, and your
picks stored in localStorage on your own device.

Web Analytics with GoatCounter: https://worldcupcheerguide.goatcounter.com/

## What it does

Seven tabs, all driven by the one simulation:

1. **🎟️ My matches** — check off any of the 104 matches you're attending. Each match also
   shows the model's predicted win/draw/loss odds.
2. **❤️ My teams** — rank the teams you want to see via quick head-to-head picks
   ("Sweden *or* Algeria?"), with ties, undo, and ⭐ pins for absolute favorites. With no
   picks the ranking already follows team strength, so every other tab works out of the box.
3. **🎺 Cheer guide** — for every remaining game, which result most improves your expected
   *lineup quality* (how much you'll like the teams you end up watching live, favorites
   weighted extra). Includes a **loyalty guard**: it never tells you to root against a team
   you love unless the payoff is real — either that team's own best path to your seats
   (third-place routing is weird; see below) or a bigger boost to another favorite — and it
   never tells you to root against a team you've pinned. It shows the honest probabilities
   either way.
4. **📺 Must-watch** — your team ranking turned into a personalized TV schedule: every
   decided match scored by the expected appeal of the teams on the pitch, split into
   must-watch / worth-a-watch tiers, with one-tap calendar export (`.ics`).
5. **🧭 Team path** — follow one team and every remaining game is scored by how much its
   result extends *their* expected run through the bracket, not just survival but which
   slots and opponents each result steers them toward. It flags honestly when a loss would
   route them somewhere friendlier, but never tells you to root against your own team.
6. **📊 Probabilities** — preference-independent forecasts: per-slot odds for every knockout
   match, top matchups (click a team on each side to query any exact pairing), group
   standings with advancement odds, and champion odds. Your attended matches stay pinned on
   top.
7. **📈 Accuracy** — how good the model's per-match predictions are: a reliability diagram of
   the win/draw/loss calls against real results (do the ~60% calls happen ~60% of the time?),
   a one-line summary of how much better than a random guess the calls have been, and the
   multiclass Brier score. One tournament with correlated outcomes, so it's descriptive rather
   than a verdict.

A **🕰 time machine** in the header rewinds every tab to how it looked right after any
earlier match, using only the results played up to that point.

## How it works

- **Simulation**: 100,000 full tournaments in a Web Worker (a few seconds, seeded for
  reproducibility), implementing the official 2026 rules end to end — head-to-head-first
  group tiebreakers, the ranking of third-placed teams, and FIFA's real **Annex C** table
  (all 495 combinations) that routes the best 8 thirds into the bracket. That table is the
  source of the site's most counterintuitive advice: e.g. a Group A third is routed to
  Match 82 in ~95% of combinations, so "root for your team to *lose* into third place" is
  sometimes genuinely correct — and the guide says so, with numbers.
- **Match model**: goals are Poisson draws scaled by an Elo expectation on FIFA's 600-point
  scale (avg 2.7 goals/match); knockout ties break with a small skill edge as an ET/penalties
  proxy. Ratings are the official June 11, 2026 FIFA points, the last ranking before the
  tournament. No host advantage, no injuries — a planning toy, not a betting model.
- **Live results**: played games are pinned as fact and only the remainder is simulated, so
  every probability sharpens as the tournament unfolds. Results come from ESPN's public
  scoreboard API (keyless, near-live), with the public-domain
  [openfootball](https://github.com/openfootball/worldcup.json) dataset as automatic
  fallback. A GitHub Action refreshes `site/data/results.json` hourly and redeploys when
  anything changed.
- **Instant personalization**: the worker keeps compact per-simulation records (~216
  bytes/sim — every game outcome, every knockout participant), so changing your teams or
  matches re-aggregates instantly without re-simulating.

## Repository layout

| Path | Purpose |
|---|---|
| `site/` | The site: `index.html`, `css/`, `js/` (`sim-core.js` simulator + analysis, `worker.js`, `prefs.js` head-to-head ranking, `schedule.js` must-watch scoring + calendar export, `views.js`/`app.js`/`format.js` UI). |
| `site/data/tournament.json` | Static facts: groups, ratings, full 104-match schedule, bracket, Annex C. Generated by `scripts/build_data.py`; committed. |
| `site/data/results.json` | Live results, regenerated by `scripts/update_results.py` (ESPN primary, openfootball fallback). |
| `annex_c.txt` | FIFA's official Annex C third-place allocation table (all 495 rows), fully re-validated on every `build_data.py` run. |
| `tests/` | JS test suite for the simulator, must-watch scoring, and time machine (`node --test`, no npm deps). |
| `test_update_results.py` | Python tests for the data pipeline (ESPN parser, embedded data, Annex C). |
| `.github/workflows/site.yml` | Push → test + deploy Pages; hourly cron → refresh results, commit if changed, test + deploy. |

## Development

```bash
python3 -m http.server 8123 -d site     # run locally → http://localhost:8123
node --test "tests/**/*.test.mjs"       # simulator tests (node ≥ 20, no npm install)
python3 -m unittest test_update_results # data-pipeline tests
python3 scripts/update_results.py       # refresh live results by hand
python3 scripts/build_data.py           # regenerate static data (only if FIFA reschedules
                                        # or ratings are refreshed)
```

Deployment: GitHub Pages from Actions (repo Settings → Pages → Source "GitHub Actions"),
custom domain `worldcupcheerguide.com` (apex A records → GitHub Pages IPs, `www` CNAME →
`nwheise.github.io`, HTTPS enforced).

## Provenance

Groups, schedule, bracket, kickoff times, the 2026 tiebreaker rules, and Annex C were
verified against the published schedule and regulations on June 11, 2026; `build_data.py`
re-asserts the critical facts (third-place slot table, Seattle pipeline M81/M82 → M94) on
every run. The JS simulator is cross-validated by tests against the original Python
simulator's published findings. See `CLAUDE.md` for the full modeling notes and verified
tournament facts.
