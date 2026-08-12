"""Probe DepEd (dept 07) totals vs NEP PDF breakdown."""
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "budget" / "2026" / "items"
AGENCIES = {a["uacs_code"]: a for a in json.load(open(ROOT / "data/organization/agencies.json", encoding="utf-8"))}
ORGS = {o["uacs_code"]: o for o in json.load(open(ROOT / "data/organization/organizations.json", encoding="utf-8"))}

AA_FUNDS = {"10401110", "10401258", "10401257", "10401280", "10401105"}
AA_PREFIX = "10403"
AA_RLIP = "5010301000"


def is_aa(rec):
    fc = rec.get("funding_uacs_code") or ""
    obj = rec.get("object_uacs_code") or ""
    if fc in AA_FUNDS:
        return True
    if fc.startswith(AA_PREFIX):
        return True
    if obj == AA_RLIP:
        return True
    return False


def main():
    dept = "07"
    by_level = defaultdict(float)
    by_agency_l7 = defaultdict(float)
    by_agency_l7_aa = defaultdict(float)
    by_prexc1 = defaultdict(float)
    prexc1_desc = {}
    by_prexc2 = defaultdict(float)
    prexc2_desc = {}
    by_any_level_agency = defaultdict(lambda: defaultdict(float))
    missing_org_l7 = 0.0
    missing_org_count = 0
    deped_prexc_roots = defaultdict(float)

    for batch in sorted(DATA.glob("*.json")):
        for rec in json.load(open(batch, encoding="utf-8")):
            org = rec.get("org_uacs_code") or ""
            prexc = str(rec.get("prexc_fpap_id") or "")
            if not prexc.startswith("07") and not org.startswith(dept):
                continue
            if not org.startswith(dept) and not prexc.startswith("07"):
                continue

            lvl = rec.get("prexc_level", 0)
            amt = rec.get("amount", 0) or 0
            by_level[lvl] += amt

            if prexc.startswith("07"):
                deped_prexc_roots[prexc[:8] if len(prexc) >= 8 else prexc] += amt if lvl in (1, 2, 3) else 0

            if lvl == 1:
                by_prexc1[prexc] += amt
                prexc1_desc[prexc] = rec.get("description", "")
            if lvl == 2:
                by_prexc2[prexc] += amt
                prexc2_desc[prexc] = rec.get("description", "")

            if lvl == 7:
                if not org or len(org) < 12:
                    missing_org_l7 += amt
                    missing_org_count += 1
                    continue
                agency = org[:5]
                by_any_level_agency[agency][7] += amt
                if is_aa(rec):
                    by_agency_l7_aa[agency] += amt
                else:
                    by_agency_l7[agency] += amt
            elif org.startswith(dept) and len(org) >= 5:
                agency = org[:5]
                by_any_level_agency[agency][lvl] += amt

    print("=== DepEd dept 07 - sums by PREXC level ===")
    for lv in sorted(by_level):
        print(f"  L{lv}: PHP {by_level[lv] * 1000 / 1e9:.3f}B")

    print("\n=== PREXC level-2 children ===")
    for prexc, amt in sorted(by_prexc2.items(), key=lambda x: -x[1])[:20]:
        print(f"  {amt * 1000 / 1e9:.3f}B  {prexc2_desc.get(prexc, '')[:60]}")

    print("\n=== All agencies with ANY level rows under dept 07 ===")
    deped_agencies = ["07001", "07002", "07003", "07004", "07005", "07006", "07007", "07008"]
    for ag in deped_agencies:
        levels = by_any_level_agency.get(ag, {})
        if not levels:
            print(f"  {ag}: NO ROWS IN DATA")
            continue
        name = AGENCIES.get(ag, {}).get("description", ag)
        parts = ", ".join(f"L{lv}={levels[lv]*1000/1e6:.1f}M" for lv in sorted(levels))
        l7 = levels.get(7, 0)
        print(f"  {ag} ({name}): {parts} | L7 total PHP {l7*1000/1e9:.3f}B")

    print("\n=== Sample PREXC roots (L1-L3) starting with 07 ===")
    for px, amt in sorted(deped_prexc_roots.items(), key=lambda x: -x[1])[:15]:
        if amt:
            print(f"  {px}: PHP {amt*1000/1e9:.3f}B")

    print("\n=== Our browser: agency level-7 programmed rollup ===")
    total_ag = sum(by_agency_l7.values())
    for ag, amt in sorted(by_agency_l7.items(), key=lambda x: -x[1]):
        name = AGENCIES.get(ag, {}).get("description", ORGS.get(ag, {}).get("description", ag))
        print(f"  {ag}: PHP {amt * 1000 / 1e9:.3f}B ({amt * 1000 / 1e6:.1f}M)  {name}")

    print(f"\n  Agency L7 programmed sum: PHP {total_ag * 1000 / 1e9:.3f}B")
    print(f"  Agency L7 AA (excluded from tree): PHP {sum(by_agency_l7_aa.values()) * 1000 / 1e9:.3f}B")
    print(f"  L7 rows missing org_uacs: PHP {missing_org_l7 * 1000 / 1e9:.3f}B ({missing_org_count} rows)")


if __name__ == "__main__":
    main()
