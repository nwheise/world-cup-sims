# CLAUDE.md — World Cup 2026 Seattle Match Simulator

## What this project is

This project assumes tickets to two FIFA World Cup 2026 knockout matches at Lumen Field, Seattle:

- **Match 82** — Round of 32, **Wed July 1, 2026, 13:00 PT**: Group G winner vs 3rd place from Group A/E/H/I/J
- **Match 94** — Round of 16, **Mon July 6, 2026, 17:00 PT**: Winner of Match 81 vs Winner of Match 82
  - **Match 81** — Round of 32, July 1, Levi's Stadium (SF Bay Area): Group D winner vs 3rd place from Group B/E/F/I/J

Goal: Monte Carlo simulation to estimate which teams will appear in those two matches, so a
ticketholder knows which group-stage outcomes to root for to maximize the chance of seeing
marquee teams live.

Tournament runs June 11 – July 19, 2026. Group stage ends June 27. **As of June 11 (project
start), zero group matches had been played** — the sim simulates all 72 group games from ratings.

## Files

| File | Purpose |
|---|---|
| `seattle_wc_sim_v2.py` | **Current simulator.** Official FIFA rules end to end. Run: `python3 seattle_wc_sim_v2.py [n_sims]` (default 20000, seed=42). Expects `annex_c.txt` in cwd. |
| `annex_c.txt` | FIFA's official Annex C third-place allocation table — all 495 C(12,8) combinations. Transcribed from the published schedule (via Wikipedia's "2026 FIFA World Cup knockout stage" page, which reproduces the regulations). **Validated — do not regenerate or hand-edit without re-running the validator.** |
| `validate_annex_c.py` | Structural validator for `annex_c.txt`. Checks: rows 1–495 present, every 8-of-12 combination appears exactly once, each row's 8 assignments are a permutation of its 8 qualified groups, every assignment respects the per-slot allowed-group sets. Last run: all checks pass. |
| `seattle_wc_sim.py` (v1) | Deprecated. Used a random-valid-matching approximation for third-place allocation instead of the real Annex C table, and wrong (pre-2026) tiebreaker order. Kept only for reference; its third-place slot probabilities are materially wrong. |

## Verified tournament facts (do not re-derive; sourced and checked June 11, 2026)

### Final groups (Dec 5, 2025 draw + March 2026 playoff winners)

Playoff winners, all confirmed March 31, 2026: Bosnia-Herzegovina (UEFA Path A → Group B),
Sweden (Path B → F), Türkiye (Path C → D), Czechia (Path D → A), DR Congo (FIFA Playoff 1 → K),
Iraq (FIFA Playoff 2 → I). Italy missed a third straight World Cup (lost Path A final on pens).

- A: Mexico, South Africa, South Korea, Czechia
- B: Canada, Bosnia-Herzegovina, Qatar, Switzerland
- C: Brazil, Morocco, Haiti, Scotland
- D: USA, Paraguay, Australia, Türkiye
- E: Germany, Curaçao, Côte d'Ivoire, Ecuador
- F: Netherlands, Japan, Sweden, Tunisia
- G: Belgium, Egypt, Iran, New Zealand
- H: Spain, Cabo Verde, Saudi Arabia, Uruguay
- I: France, Senegal, Iraq, Norway
- J: Argentina, Algeria, Austria, Jordan
- K: Portugal, DR Congo, Uzbekistan, Colombia
- L: England, Croatia, Ghana, Panama

### Round-of-32 third-place slots (8 of 16 R32 matches receive a 3rd-place team)

| Match | Winner of | 3rd from | Venue |
|---|---|---|---|
| 74 | E | A/B/C/D/F | Boston |
| 77 | I | C/D/F/G/H | NY/NJ |
| 79 | A | C/E/F/H/I | Mexico City |
| 80 | L | E/H/I/J/K | Atlanta |
| **81** | **D** | **B/E/F/I/J** | **SF Bay Area** (feeds M94) |
| **82** | **G** | **A/E/H/I/J** | **SEATTLE** |
| 85 | B | E/F/G/I/J | Vancouver |
| 87 | K | D/E/I/J/L | Kansas City |

`annex_c.txt` column order is: 8 qualified groups, then assignments for **1A; 1B; 1D; 1E; 1G;
1I; 1K; 1L** = matches **79, 85, 81, 74, 82, 77, 87, 80** in that order. This mapping is
encoded in `SLOT_TO_MATCH` in the simulator and in the validator's `ALLOWED` dict.

### Official ranking rules (FIFA 2026 regulations — these changed from prior World Cups)

- **Within-group tiebreakers, in order**: points; then **head-to-head first** among tied teams
  (H2H points, H2H GD, H2H goals — new for 2026, UEFA-style); then overall GD, overall goals;
  then team conduct score (cards: yellow −1, second-yellow red −3, direct red −4, yellow+direct
  red −5); then FIFA World Ranking.
- **Ranking of the 12 third-placed teams** (best 8 advance): points → GD → goals scored →
  team conduct score → FIFA World Ranking. **No drawing of lots in 2026** (removed from
  regulations; FIFA ranking is the final criterion).
- Third-place teams are assigned to bracket slots by the **fixed Annex C lookup table** —
  no second draw, no discretion. R32 never rematches group-stage opponents.

## Model details (`seattle_wc_sim_v2.py`)

- **Ratings** (`RATINGS` dict): FIFA points from the **April 1, 2026** release for the
  published top ~20; everything else is an estimate (marked in comments). Some values have
  fractional offsets (e.g. 1673.07) purely to keep the FIFA-ranking tiebreaker deterministic.
  Ratings only enter via pairwise differences. **Improvement candidate**: replace with current
  Elo from eloratings.net, or the final pre-tournament FIFA ranking (released June 9-11, 2026 —
  Argentina reclaimed #1 just before kickoff; the April list had France #1, Spain #2,
  Argentina #3).
- **Match model**: Elo expectation `E = 1/(1+10^(-diff/600))` (FIFA's 600 scale); goals are
  independent Poisson with `λ_a = 2.7·E`, `λ_b = 2.7·(1−E)`. Knockout ties broken with
  probability `0.5 + 0.4·(E−0.5)` as an ET/penalties proxy.
- **Conduct score is NOT simulated** (we don't model cards). It's skipped in both tiebreaker
  chains; the next criterion (FIFA ranking via `RATINGS`) resolves ties deterministically.
  Only matters on exact pts/GD/GF ties — negligible distortion, but worth stating honestly.
- Group ranking implements the full H2H-first algorithm including re-ranking within tied
  clusters (`rank_group`).

## Key findings (20k sims, seed 42, pre-tournament ratings)

- **Match 82 appearance**: Belgium ~58%, Iran ~27% (Group G is weak; the winner is very likely
  one of these two). Third-place slot: Czechia ~21%, South Africa ~19%, South Korea ~18%,
  Mexico ~12%, Egypt ~13% (Egypt via winning G).
- **Annex C structural bias (the big non-obvious result)**: when Group A's third qualifies,
  the table routes it to Seattle in **314/330 = 95%** of combinations. Conditional rates for
  the other eligible groups: H 26%, J 15%, I 12%, **E only 2%**. So the Seattle R32 opponent
  is overwhelmingly a Group A story; "Germany finishes 3rd and comes to Seattle" is ~dead
  (~0.2%). For M81/SF the same effect: Group B third → slot 81 in 329/330 = ~100%.
  (Per-combination counts, not probability-weighted, but the bias dominates.)
- **Match 94 appearance**: Belgium ~42%, **USA ~31%** (path: win Group D → win M81 → Seattle),
  Iran ~17%, Australia ~12%, Türkiye ~10%. Most likely matchup: **Belgium vs USA ~13%**.
- **Cheering guide**: (1) USA must *win* Group D — runner-up routes to Dallas, only the winner's
  path reaches Seattle; (2) Belgium to win Group G; (3) root for **Mexico to finish 3rd in
  Group A** (best realistic "cool opponent" outcome — Mexico–Belgium at Lumen), with Uruguay
  3rd in H as the secondary angle. Bonus: Egypt vs Iran is at Lumen June 26 (Match 63).

## Next steps / backlog

1. **Live results mode** (top priority — group stage is underway as of June 11): add a
   `RESULTS = {("TeamA","TeamB"): (ga,gb), ...}` dict; `simulate_group` uses actual scores
   where present and simulates only remaining fixtures. Probabilities will sharpen daily.
   Actual scores must come from web/live data — do not trust model memory for results.
2. Swap estimated ratings for real Elo / final June FIFA ranking (see Model details).
3. Optionally simulate cards for the conduct tiebreaker (low value).
4. Nice-to-haves: CLI flags (n_sims, seed, ratings file), conditional queries ("P(USA in M94 |
   USA wins group)"), per-scenario what-if mode for the final matchday.

## Provenance / trust notes

- Groups, playoff results, match slots, kickoff times, ranking rules, and Annex C were all
  verified via web search/fetch on June 11, 2026 (sources: FIFA schedule via Wikipedia knockout
  stage page, ESPN/Olympics for playoff results, Visit Seattle/Seattle FWC26 for local match
  details, multiple outlets for the 2026 tiebreaker changes).
- `annex_c.txt` passed full structural validation. If it's ever edited, re-run
  `validate_annex_c.py` before trusting simulation output.
- Anything about *actual tournament results* post–June 11 is unknown to this codebase and must
  be fetched fresh.