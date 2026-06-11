"""
rank_prefs.py — build your personal "teams I'd most like to see" ranking by
head-to-head comparisons.

You're shown two teams; pick the one you'd rather watch play in Seattle. An
Elo-style score updates after each pick, and the next pairing is chosen to be
maximally informative (the team you've rated least, against its current nearest
rival). Stop whenever you like — the ranking just keeps sharpening.

Only the 36 teams in the 9 groups that can actually reach a Seattle match
(A, B, D, E, F, G, H, I, J) are included; groups C, K, L can't appear in
Match 82 or Match 94, so ranking them would be wasted clicks.

Output -> preferences.json, consumed by cheer_guide.py. Re-run anytime to resume.

Run:  python3 rank_prefs.py
"""

import json
import os
import random

from seattle_wc_sim import GROUPS

PREFS_PATH = "preferences.json"
FEEDER_GROUPS = "ABDEFGHIJ"   # the only groups that can reach a Seattle match
TEAMS = [t for g in FEEDER_GROUPS for t in GROUPS[g]]

INIT_ELO = 1500.0
K = 32.0      # Elo update step
ELO_SCALE = 400.0


def expected(score_a, score_b):
    return 1.0 / (1.0 + 10 ** ((score_b - score_a) / ELO_SCALE))


def compute_scores(comparisons):
    """Replay every (winner, loser) pick as an Elo update. Recomputing from the
    full history (rather than updating in place) keeps undo trivial."""
    scores = {t: INIT_ELO for t in TEAMS}
    for w, l in comparisons:
        if w not in scores or l not in scores:
            continue  # team no longer in pool (e.g. roster change) — ignore
        ew = expected(scores[w], scores[l])
        scores[w] += K * (1 - ew)
        scores[l] -= K * (1 - ew)
    return scores


def compute_counts(comparisons):
    counts = {t: 0 for t in TEAMS}
    for w, l in comparisons:
        for t in (w, l):
            if t in counts:
                counts[t] += 1
    return counts


def compute_weights(scores):
    """Min-max normalize Elo scores to [0, 1] — the desire-to-see weights the
    cheering guide consumes. Falls back to 0.5 across the board before any picks."""
    lo, hi = min(scores.values()), max(scores.values())
    if hi - lo < 1e-9:
        return {t: 0.5 for t in scores}
    return {t: (s - lo) / (hi - lo) for t, s in scores.items()}


def load_state():
    if os.path.exists(PREFS_PATH):
        with open(PREFS_PATH) as f:
            data = json.load(f)
        return [tuple(c) for c in data.get("comparisons", [])]
    return []


def save_state(comparisons):
    scores = compute_scores(comparisons)
    data = {
        "comparisons": [list(c) for c in comparisons],
        "scores": scores,
        "counts": compute_counts(comparisons),
        "weights": compute_weights(scores),
    }
    # Atomic-ish write so a Ctrl-C mid-save can't corrupt the file.
    tmp = PREFS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, PREFS_PATH)


def pick_pair(scores, counts, rng, avoid=None):
    """Most-informative pairing: the least-compared team, matched against its
    nearest current rival. `avoid` is the previous pair, to prevent repeats."""
    fewest = min(counts[t] for t in TEAMS)
    a = rng.choice([t for t in TEAMS if counts[t] == fewest])
    others = sorted((t for t in TEAMS if t != a),
                    key=lambda t: (abs(scores[t] - scores[a]), counts[t]))
    b = others[0]
    if avoid is not None and {a, b} == avoid and len(others) > 1:
        b = others[1]
    return a, b


def print_ranking(scores, counts):
    order = sorted(TEAMS, key=lambda t: scores[t], reverse=True)
    weights = compute_weights(scores)
    print("\nYour ranking (most → least want to see):")
    print("-" * 48)
    for i, t in enumerate(order, 1):
        flag = "  (few comparisons)" if counts[t] < 2 else ""
        print(f"  {i:2d}. {t:<22s} weight {weights[t]:.2f}{flag}")


def main():
    rng = random.Random()
    comparisons = load_state()
    scores = compute_scores(comparisons)
    counts = compute_counts(comparisons)

    print(f"Preference ranking — {len(TEAMS)} teams that can reach Seattle.")
    if comparisons:
        print(f"Resuming: {len(comparisons)} comparisons so far.")
    print("Pick who you'd rather see play in Seattle.")
    print("  [1] left   [2] right   [s] skip   [u] undo   [q] quit & save\n")

    last_pair = None
    while True:
        a, b = pick_pair(scores, counts, rng, avoid=last_pair)
        if rng.random() < 0.5:        # randomize sides to avoid position bias
            a, b = b, a
        done = len(comparisons)
        ans = input(f"  [{done}] {a}  vs  {b} ?  > ").strip().lower()

        if ans in ("q", "quit", ""):
            break
        elif ans == "s":
            last_pair = {a, b}
            continue
        elif ans == "u":
            if comparisons:
                comparisons.pop()
                scores = compute_scores(comparisons)
                counts = compute_counts(comparisons)
                save_state(comparisons)
                print("    ↩ undid last pick.")
            else:
                print("    (nothing to undo)")
            last_pair = None
            continue
        elif ans in ("1", "2"):
            winner, loser = (a, b) if ans == "1" else (b, a)
            comparisons.append((winner, loser))
            scores = compute_scores(comparisons)
            counts = compute_counts(comparisons)
            save_state(comparisons)
            last_pair = {a, b}
        else:
            print("    ? use 1 / 2 / s / u / q")

    save_state(comparisons)
    print_ranking(scores, counts)
    print(f"\nSaved {len(comparisons)} comparisons → {PREFS_PATH}")
    print("Next: python3 cheer_guide.py")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\n(interrupted — progress was saved after each pick)")
