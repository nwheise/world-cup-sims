# World Cup 2026 — Seattle Match Simulator

A Monte Carlo simulator for the two FIFA World Cup 2026 knockout matches at Lumen Field, Seattle,
plus a personal **cheering guide** that tells you which group-stage results to root for.

- **Match 82** — Round of 32, Wed Jul 1, 2026: Group G winner vs a 3rd-place team
- **Match 94** — Round of 16, Mon Jul 6, 2026: winner of Match 81 vs winner of Match 82

It simulates all 72 group games from team ratings, applies the official FIFA 2026 rules
(head-to-head-first tiebreakers + the real Annex C third-place allocation table), and estimates which
teams are most likely to play in Seattle.

## Requirements

Python 3 (3.8+). No third-party packages — standard library only.

## Quick start

```bash
# 1. Who is likely to appear in the Seattle matches?
python3 seattle_wc_sim.py            # 20,000 sims (pass a number to change, e.g. 50000)

# 2. Tell the tool which teams YOU want to see (head-to-head picks).
python3 rank_prefs.py                # interactive; saves preferences.json; stop anytime with q

# 3. Get your personal cheering guide for every group game.
python3 cheer_guide.py               # 50,000 sims; reads preferences.json
```

### 1. `seattle_wc_sim.py` — appearance probabilities
Prints the chance each team appears in Match 82 and Match 94, plus the most likely matchups.
Optional arg = number of simulations (default 20000, seeded for reproducibility).

### 2. `rank_prefs.py` — rank the teams you want to see
Shows two teams at a time; pick the one you'd rather watch play in Seattle:

```
[12] Belgium  vs  Uruguay ?  >
   1 = left   2 = right   s = skip   u = undo   q = quit & save
```

It adaptively picks the most useful matchups and you can stop whenever you like — the ranking just
keeps sharpening. Progress is saved after every pick to `preferences.json` (re-run to resume). Only the
36 teams that can actually reach a Seattle match are included.

### 3. `cheer_guide.py` — who to cheer for, game by game
Using your saved preferences, it ranks all 72 group-stage games by how much each result swings your odds
of seeing your favorites in Seattle, and tells you what to root for:

```
[+0.555] Grp G  Belgium vs Iran
          → cheer Belgium    (Belgium 1.12  |  draw 0.86  |  Iran 0.57)
```

`E[lineup]` is the expected total preference value of your Seattle lineup (favorites weighted more
heavily); `impact` is how much a single game's result moves it. It also surfaces non-obvious calls —
sometimes the best move is to root for a team to *lose* so it finishes 3rd and gets routed to Seattle.
Optional arg = number of simulations (default 50000).

## Tests

```bash
python3 -m unittest test_sim -v      # 27 tests; pure stdlib, fully reproducible
python3 validate_annex_c.py          # standalone check of the Annex C table
```

## How it works (briefly)

- **Match model:** goals are Poisson, scaled by an Elo win expectation from each team's rating.
- **Group stage:** official 2026 tiebreakers — head-to-head first, then overall GD/goals, then ranking.
- **Third place:** the best 8 of 12 third-placed teams advance and are slotted by FIFA's fixed Annex C
  lookup table (all 495 combinations, validated).
- **Cheering guide:** one big simulation records every game's result and the resulting Seattle lineup;
  bucketing the lineup value by each game's outcome gives the effect of cheering for one side. See
  `CLAUDE.md` for the full modeling notes, assumptions, and verified tournament facts.

> Note: ratings are pre-tournament estimates and results are not modeled live — this is a
> for-fun planning tool, not a betting model.
