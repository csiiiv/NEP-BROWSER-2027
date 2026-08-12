"""Quick check: attached DepEd agencies in JSON (no full Excel load)."""
import json
from pathlib import Path

# Known L7 row counts from Excel probe
EXPECTED = {
    "002": 137,
    "003": 58,
    "004": 224,
    "005": 111,
    "007": 83,
    "008": 53,
}

# Load agency prexc sets from a cached run - use description heuristics instead
AGENCY_MARKERS = {
    "002": "National Book Development",
    "003": "National Council for Children's Television",
    "004": "National Museum of the Philippines",
    "005": "Philippine High School for the Arts",
    "007": "National Academy of Sports",
    "008": "Teacher Education Council",
}

no_org = 0
no_org_amt = 0
with_org_07001_only = 0

for batch in sorted(Path("data/budget/2026/items").glob("*.json")):
    for rec in json.load(open(batch, encoding="utf-8")):
        if rec.get("prexc_level") != 7:
            continue
        org = rec.get("org_uacs_code") or ""
        if org.startswith("07001"):
            with_org_07001_only += 1
        elif not org:
            no_org += 1
            no_org_amt += rec.get("amount", 0) or 0

print(f"L7 rows org=07001*: {with_org_07001_only}")
print(f"L7 rows no org: {no_org}  total PHP {no_org_amt*1000/1e9:.2f}B")
