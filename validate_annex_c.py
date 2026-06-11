"""Validate the Annex C transcription.

`validate(path)` returns a list of human-readable error strings (empty == valid),
so it can be driven both as a standalone script and from the test suite.
"""
import re
from itertools import combinations

SLOT_NAMES = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]
ALLOWED = {
    "1A": set("CEFHI"), "1B": set("EFGIJ"), "1D": set("BEFIJ"),
    "1E": set("ABCDF"), "1G": set("AEHIJ"), "1I": set("CDFGH"),
    "1K": set("DEIJL"), "1L": set("EHIJK"),
}


def validate(path="annex_c.txt"):
    """Return a list of error strings for annex_c.txt (empty list == all valid)."""
    errors = []
    rows = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"(\d+):\s*(.*)", line)
            num = int(m.group(1))
            parts = [p.strip() for p in m.group(2).split(";")]
            if len(parts) != 16:
                errors.append(f"row {num}: {len(parts)} fields (expected 16)")
                continue
            groups = frozenset(parts[:8])
            assign = {SLOT_NAMES[i]: parts[8 + i].lstrip("3") for i in range(8)}
            rows[num] = (groups, assign)

    # 1. completeness: rows 1..495, every combination exactly once
    if sorted(rows) != list(range(1, 496)):
        errors.append("missing/extra row numbers (expected 1..495)")
    seen = set()
    for num, (groups, _) in rows.items():
        if len(groups) != 8:
            errors.append(f"row {num}: groups not 8 distinct")
        if groups in seen:
            errors.append(f"row {num}: duplicate combination")
        seen.add(groups)
    all_combos = {frozenset(c) for c in combinations("ABCDEFGHIJKL", 8)}
    missing = all_combos - seen
    if missing:
        errors.append(f"{len(missing)} combinations missing, "
                      f"e.g. {sorted(next(iter(missing)))}")

    # 2. each row: assignment is a permutation of its groups, and slot-legal
    for num, (groups, assign) in rows.items():
        if frozenset(assign.values()) != groups:
            errors.append(f"row {num}: assignments {sorted(assign.values())} "
                          f"!= groups {sorted(groups)}")
        for slot, g in assign.items():
            if g not in ALLOWED[slot]:
                errors.append(f"row {num}: slot {slot} assigned 3{g}, "
                              f"allowed {sorted(ALLOWED[slot])}")
    return errors


if __name__ == "__main__":
    errs = validate()
    if errs:
        print(f"FAILED — {len(errs)} error(s):")
        for e in errs[:20]:
            print(" ", e)
    else:
        print("OK — all 495 rows valid: every C(12,8) combination present exactly once,")
        print("each row's assignments are a permutation of its qualified groups,")
        print("and every slot assignment respects the official allowed-group sets.")
