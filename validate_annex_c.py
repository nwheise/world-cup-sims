"""Validate the Annex C transcription."""
import re
from itertools import combinations

SLOT_NAMES = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]
ALLOWED = {
    "1A": set("CEFHI"), "1B": set("EFGIJ"), "1D": set("BEFIJ"),
    "1E": set("ABCDF"), "1G": set("AEHIJ"), "1I": set("CDFGH"),
    "1K": set("DEIJL"), "1L": set("EHIJK"),
}

rows = {}
with open("annex_c.txt") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"(\d+):\s*(.*)", line)
        num = int(m.group(1))
        parts = [p.strip() for p in m.group(2).split(";")]
        assert len(parts) == 16, f"row {num}: {len(parts)} fields"
        groups = frozenset(parts[:8])
        assign = {SLOT_NAMES[i]: parts[8 + i].lstrip("3") for i in range(8)}
        rows[num] = (groups, assign)

errors = []
# 1. completeness: rows 1..495, every combination exactly once
assert sorted(rows) == list(range(1, 496)), "missing/extra row numbers"
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
    errors.append(f"{len(missing)} combinations missing, e.g. {sorted(next(iter(missing)))}")

# 2. each row: assignment is a permutation of its groups, and slot-legal
for num, (groups, assign) in rows.items():
    if frozenset(assign.values()) != groups:
        errors.append(f"row {num}: assignments {sorted(assign.values())} != groups {sorted(groups)}")
    for slot, g in assign.items():
        if g not in ALLOWED[slot]:
            errors.append(f"row {num}: slot {slot} assigned 3{g}, allowed {sorted(ALLOWED[slot])}")

if errors:
    print(f"FAILED — {len(errors)} error(s):")
    for e in errors[:20]:
        print(" ", e)
else:
    print(f"OK — all 495 rows valid: every C(12,8) combination present exactly once,")
    print("each row's assignments are a permutation of its qualified groups,")
    print("and every slot assignment respects the official allowed-group sets.")
