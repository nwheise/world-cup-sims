# CLAUDE.md — worldcupcheerguide.com (World Cup 2026 cheer guide)

## What this project is

A **static website** — live at **https://worldcupcheerguide.com** (GitHub Pages, zero
backend) — for people attending FIFA World Cup 2026 matches (June 11 – July 19, 2026,
USA/Mexico/Canada): pick the matches you're attending and rank the teams you'd love to see,
and an in-browser Monte Carlo simulation of the whole tournament tells you who to cheer for
in every remaining game, plus preference-independent probabilities for every knockout slot,
matchup, group, and the title.

The project began as a Python CLI focused on the two Seattle matches (M82/M94 at Lumen
Field); the site absorbed and generalized all of it, and the CLI was deleted June 12, 2026
(git history has it). The Python findings remain the cross-validation anchors for the JS
test suite (see "Key findings").

## Files

| File | Purpose |
|---|---|
| `site/index.html`, `site/css/style.css` | Single-page app shell + styles (dark, mobile-friendly, no framework). |
| `site/js/sim-core.js` | **The simulator + analysis engine** (pure ESM — identical in the Web Worker and under node tests). Official FIFA 2026 rules end to end; simulates all 104 matches, honoring real results (`prepareResults`): played group games pinned, known knockout winners honored when they match the simulated lineup. Packs per-sim records (~216 bytes: 72 group outcomes, 48 group positions, 64 knockout participants, 32 winners) so re-analysis never re-simulates. Hosts `appearanceProbs` (per-slot + full joint matchup distributions + champion), `groupProbs`, `analyzeCheer` (cheer guide incl. loyalty guard, per-liked-team conditionals, top-picks summary), `analyzeTeamPath` (fan mode — see "The team-path math"), `assessLoyalty`, `emphasize`. Constants: `EMPHASIS=2.0`, `LIKE_FLOOR=0.5`, `SWING_THRESHOLD=0.03`, seed 42, default 20k sims. |
| `site/js/worker.js` | Web Worker wrapper: `simulate` once (progress events), then `analyze` (weights + attended matches) and `teampath` (followed team) requests are instant re-aggregations. |
| `site/js/prefs.js` | Head-to-head preference ranking (Elo replay over the pick history): `computeScores` (supports `[a,b,"="]` equal-preference entries scored as draws, and optional priors), `ratingPriors` (FIFA ratings compressed into `INIT_ELO ± PRIOR_SPREAD/2 = ±150` — zero picks already means "best teams first", ~6 picks flip any prior gap), `computeWeights` (min-max to [0,1]), `applyPins` (pinned favorites locked at 1.0, unpinned compressed below `UNPINNED_CAP=0.85`), `pickPair` (adaptive most-informative pairing). |
| `site/js/views.js`, `site/js/app.js`, `site/js/format.js` | Rendering (pure state→HTML), state/persistence/worker wiring (localStorage keys `wc26:comparisons`, `wc26:attended`, `wc26:pinned`, `wc26:settings`, `wc26:fanteam`), and display helpers (names/flags, venue-local kickoff times, viewer-local timestamps, slot descriptions). |
| `site/data/tournament.json` | **Static facts** (committed): groups, ratings, all 104 matches with kickoffs/venues/slot codes, Annex C. Regenerate via `build_data.py` only if FIFA reschedules or ratings are refreshed. |
| `site/data/results.json` | **Live results** (committed, refreshed by the cron): `group_results` keyed `"TeamA\|TeamB"` (90-min scores), `knockout` keyed `m73..m104` (participants once known; score + winner once played). |
| `scripts/build_data.py` | Generates tournament.json. Self-contained: embeds GROUPS/RATINGS (see Model details) and fully validates `annex_c.txt` on every run (rows 1–495, every C(12,8) combo exactly once, per-row permutation, per-slot legality); cross-checks the fetched openfootball schedule against the verified third-place slot table below. |
| `scripts/update_results.py` | Live results → results.json. **Primary: ESPN public scoreboard API** (keyless, near-live; group games matched by team pair, knockout events by unique UTC kickoff; winner from ESPN's per-competitor flag so ET/pens are correct). **Fallback: openfootball** (volunteer-run; unreliable mid-tournament — in 2022 its JSON got scores backfilled years later). Idempotent; no-op after Aug 1, 2026. `parse_espn()` is pure and tested. |
| `annex_c.txt` | FIFA's official Annex C third-place allocation table — all 495 C(12,8) combinations, transcribed from the published schedule. **Do not regenerate or hand-edit**; `build_data.py` re-validates it structurally on every run. |
| `tests/sim-core.test.mjs` | **JS suite** (`node --test "tests/**/*.test.mjs"`, no npm deps, node ≥ 20). Invariants (groups/ratings/annex, H2H-beats-GD tiebreaker case, bracket wiring, seed reproducibility) + cross-validation against the Python sim's published findings + behavior pins: real results pinning, known-knockout-winner honoring, per-slot probs sum to 1, matchup joint↔marginal consistency, loyalty guard (self/other/suppress incl. the Switzerland/Canada/M85 regression), bucket==pinned-run conditioning (cheer AND team-path), team-path internal identities (survival-curve monotonicity, tail-sum E[depth], cross-checks vs groupProbs/appearanceProbs), equal-preference Elo, pin dominance. |
| `test_update_results.py` | **Python suite** (`python3 -m unittest test_update_results`). ESPN parser (name mapping, pair flip, placeholders, pens-decided winner, malformed-feed guard) + build_data embedded-data integrity + Annex C validation + committed-tournament.json consistency. |
| `.github/workflows/site.yml` | One workflow: push to main → tests + Pages deploy; **2-hour cron** / manual dispatch → refresh results.json, commit if changed, tests + deploy. Single workflow on purpose: GITHUB_TOKEN pushes don't trigger other workflows. |

## Deployment / domain

- GitHub Pages via Actions (Settings → Pages → Source "GitHub Actions"), repo
  `nwheise/world-cup-sims` (public — required for free Pages).
- Custom domain **worldcupcheerguide.com**: apex A records → 185.199.108–111.153, `www`
  CNAME → `nwheise.github.io`, HTTPS enforced (set June 11, 2026). The github.io URL
  redirects. All site URLs are relative, so it works at any root.

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

### Bracket structure (encoded in tournament.json as slot codes)

R32 = matches 73–88, R16 = 89–96, QF = 97–100, SF = 101–102, 3rd place = 103, final = 104.
Slot codes are openfootball-style: `1A`/`2B` (group winner/runner-up), `3A/E/H/I/J`
(third-place slot), `W81`/`L101` (winner/loser of match). M94 (Seattle R16) = W81 vs W82.

### Round-of-32 third-place slots (8 of 16 R32 matches receive a 3rd-place team)

| Match | Winner of | 3rd from | Venue |
|---|---|---|---|
| 74 | E | A/B/C/D/F | Boston |
| 77 | I | C/D/F/G/H | NY/NJ |
| 79 | A | C/E/F/H/I | Mexico City |
| 80 | L | E/H/I/J/K | Atlanta |
| 81 | D | B/E/F/I/J | SF Bay Area |
| 82 | G | A/E/H/I/J | Seattle |
| 85 | B | E/F/G/I/J | Vancouver |
| 87 | K | D/E/I/J/L | Kansas City |

`annex_c.txt` column order is: 8 qualified groups, then assignments for **1A; 1B; 1D; 1E;
1G; 1I; 1K; 1L** = matches **79, 85, 81, 74, 82, 77, 87, 80** in that order. This mapping
and the per-slot allowed-group sets are encoded in `scripts/build_data.py`
(`SLOT_TO_MATCH`, `ALLOWED`).

### Official ranking rules (FIFA 2026 regulations — these changed from prior World Cups)

- **Within-group tiebreakers, in order**: points; then **head-to-head first** among tied teams
  (H2H points, H2H GD, H2H goals — new for 2026, UEFA-style); then overall GD, overall goals;
  then team conduct score (cards); then FIFA World Ranking.
- **Ranking of the 12 third-placed teams** (best 8 advance): points → GD → goals scored →
  team conduct score → FIFA World Ranking. **No drawing of lots in 2026.**
- Third-place teams are assigned to bracket slots by the **fixed Annex C lookup table** —
  no second draw, no discretion. R32 never rematches group-stage opponents.

## Model details (`site/js/sim-core.js`; data embedded in `scripts/build_data.py`)

- **Ratings**: FIFA points from the **April 1, 2026** release for the published top ~20;
  everything else is an estimate (marked in build_data.py). Fractional offsets (e.g.
  1673.07) keep ratings unique because they double as the deterministic FIFA-ranking
  tiebreaker. Ratings only enter via pairwise differences. **Improvement candidate**:
  swap in Elo from eloratings.net or the final pre-tournament FIFA list (Argentina #1),
  then re-run `build_data.py`.
- **Match model**: Elo expectation `E = 1/(1+10^(-diff/600))` (FIFA's 600 scale); goals are
  independent Poisson with `λ_a = 2.7·E`, `λ_b = 2.7·(1−E)` (2.7 = recent World Cup average
  total goals; the gap changes the split, not the sum). Knockout ties broken with
  probability `0.5 + 0.4·(E−0.5)` as an ET/penalties proxy (caps the favorite at 70%).
- **Conduct score is NOT simulated** (no cards model); skipped in both tiebreaker chains —
  the next criterion (unique ratings) resolves ties deterministically. Negligible distortion.
- **Absent by design**: no host advantage (likely understates USA), static ratings (no
  injuries/momentum). Seeded RNG (mulberry32, seed 42) for reproducibility.
- **Live mode**: played group games are pinned to real scores; known knockout winners
  honored only when they match the simulated lineup (guards against partial/stale feeds);
  only the remainder is simulated.

## Key findings (20k sims, seed 42, pre-tournament ratings — JS test anchors)

These were the original Python sim's published findings; `tests/sim-core.test.mjs` asserts
the JS engine reproduces them, so they double as regression anchors. (Live results will
shift the actual displayed numbers as the tournament progresses — the anchors test the
no-results baseline.)

- **Match 82 appearance** (Seattle R32): Belgium ~58%, Iran ~27%; third-place slot:
  Czechia ~21%, South Africa ~19%, South Korea ~18%, Mexico ~12%.
- **Annex C structural bias (the big non-obvious result)**: when Group A's third qualifies,
  the table routes it to Seattle in **314/330 = 95%** of combinations (H 26%, J 15%, I 12%,
  **E only 2%**). "Germany finishes 3rd and comes to Seattle" is ~dead (~0.2%). Same effect
  for M81/SF: Group B third → slot 81 in 329/330 combinations. This is why "root for your
  favorite to LOSE into 3rd place" is sometimes genuinely correct advice — and why the
  loyalty guard exists.
- **Match 94 appearance** (Seattle R16): Belgium ~42%, **USA ~31%** (win Group D → win M81),
  Iran ~17%. Most likely matchup: **Belgium vs USA ~13%** (also asserted on the joint
  matchup distribution).

## The cheer-guide math (in `analyzeCheer`)

- **Objective**: maximize expected **lineup quality** = per simulated tournament,
  `Σ emphasize(weight[t])` over the DISTINCT teams appearing in the user's attended
  matches. `emphasize(w) = (e^(γw)−1)/(e^γ−1)` with `γ = EMPHASIS = 2.0` — anchored convex
  curve (f(0)=0, f(1)=1): a beloved team outweighs several lukewarm ones, but a second
  favorite still adds real value.
- **Method**: ONE big MC; bucket each undecided game by outcome (A-win/draw/B-win for group
  games; winner for knockout games whose real participants are known) and compare mean
  utility. Valid as a causal effect because games are independent given ratings — verified
  by a test asserting bucketed conditionals equal fresh pinned-result runs. A 3σ noise
  floor hides games swamped by sampling error.
- **Weights**: min-max-normalized Elo from head-to-head picks (`prefs.js`), seeded with
  strength priors (default = "see the best teams", so the guide works with zero picks),
  ties supported; pinned favorites locked at 1.0 with everything unpinned compressed
  below 0.85.
- **Loyalty guard** (`assessLoyalty`): when the utility-max advice roots *against* a team
  you like (weight ≥ `LIKE_FLOOR`), the call is kept only if SOME liked team gains ≥
  `SWING_THRESHOLD` between the recommended result and the denied team's own win:
  `kind="self"` (their 3rd-place route pays — annotated "23% with this result vs 8% if they
  win"), `kind="other"` (a different favorite gains — annotated with the beneficiary; this
  cross-team case was missed by the original Seattle-only guard), or `kind="none"` →
  demoted to a "loyalty notes" footnote. Per-liked-team conditionals (`pLineup`) are
  exposed per row and rendered as the "how this result moves your teams" table.
- **Pinned override**: the guide NEVER advises rooting against a pinned team, regardless
  of utility. When the math-best outcome would deny a pin, the headline flips to that
  team's win and the row carries `pinnedOverride` ({mathBest, against, pWin, pRec}) —
  rendered as an honest "their odds are better if they lose, but that's not what being a
  fan is about" note (worker passes the pinned list via `opts.pinned`).

## The team-path math (in `analyzeTeamPath`; "🧭 Team path" tab)

- **Fan mode**: follow ONE team; per simulated tournament its utility is **progress** =
  knockout rounds survived (0 = out in groups, 1 = reached R32, … 5 = reached the final,
  6 = champion; the third-place match adds no depth). Same outcome-bucketing as the cheer
  guide over the same packed store — `teampath` worker requests are instant.
- Baseline `pReach[k] = P(progress ≥ k+1)` is a survival curve (monotone; `pReach[0]` ==
  `groupProbs.advance`, `pReach[5]` == champion odds; `expDepth` == Σ pReach by the
  tail-sum identity — all pinned by tests). `decided` flags a fully-determined fate.
- **Three display tiers** (the team's own games dwarf everything else by ~10×, so a single
  3σ cliff would hide the feature's point): full cards for `impact > 3·se`, a compact
  "smaller bracket-shapers" lean list for 2σ–3σ (capped at 10 — these shape WHO the team
  meets, ~0.05–0.1 expected rounds each), and a noise footnote for the rest.
- **Fan axiom**: the headline never roots against the followed team in its own games;
  when the math disagrees, `ownOverride.mathBest` carries the honest note (same
  philosophy as the cheer guide's `pinnedOverride`).

## Provenance / trust notes

- Groups, playoff results, match slots, kickoff times, ranking rules, and Annex C were all
  verified via web search/fetch on June 11, 2026 (FIFA schedule via Wikipedia's knockout
  stage page, ESPN/Olympics for playoff results, multiple outlets for the 2026 tiebreaker
  changes). `build_data.py` re-asserts the critical facts on every run.
- ESPN was chosen as the live source after openfootball failed empirically on opening
  night (no score 2h after FT; in 2022 its JSON was backfilled years later). ESPN had the
  opening final score within minutes. If ESPN's endpoint changes shape, `parse_espn`
  raises and the workflow falls back to openfootball.
- Anything about *actual tournament results* must come from the live pipeline — do not
  trust model memory for results.
- After ANY change to `site/js` or the scripts: `node --test "tests/**/*.test.mjs"` and
  `python3 -m unittest test_update_results`. Browser smoke tests are driven via headless
  Chrome + CDP (navigate, click, screenshot — see git history for the pattern).

## Next steps / backlog

1. Swap estimated ratings for real Elo / the final June FIFA ranking, re-run
   `scripts/build_data.py` (anchors in the JS tests may need loosening if ratings shift).
2. Optionally simulate cards for the conduct tiebreaker (low value).
3. Nice-to-haves: shareable URL state, what-if toggles for undecided games, conditional
   queries ("P(USA in M94 | USA wins group)"), weight M94 above M82 in the objective
   (the R16 ticket is the marquee one).
