"""
Output validator for NEP-FY2027 conversion.

Checks:
1. Every expected JSON file exists and is valid JSON.
2. Reference counts are non-zero for dimensions NEP-FY2027 carries.
3. Every required field is present on every record (no silent sync.py failures).
4. UACS codes have correct lengths (catches upstream format regressions).
5. Every code referenced by a BudgetRecord exists in the corresponding
   reference file (referential integrity).
6. Coverage stats from budget-mapping.json look reasonable.

Usage:
    python validate_output.py
    python validate_output.py --data PATH
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

# Force UTF-8 stdout/stderr on Windows.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


# Expected schema for each output file. Maps field name -> required (True)
# or optional (False). Required-ness is from sync.py's perspective.
SCHEMAS: Dict[str, Dict[str, Dict[str, bool]]] = {
    "budget/2027/items": {
        "id": {"required": True},
        "budget_type": {"required": True},
        "fiscal_year": {"required": True},
        "amount": {"required": True},
        "description": {"required": True},
        "prexc_fpap_id": {"required": True},
        "org_uacs_code": {"required": False},
        "region_code": {"required": False},
        "division_code": {"required": False},
        "division_name": {"required": False},
        "ou_class_code": {"required": False},
        "funding_uacs_code": {"required": False},
        "object_uacs_code": {"required": False},
        "prexc_level": {"required": False},
        "sorder": {"required": False},
    },
    "organization/departments.json": {
        "code": {"required": True, "length": 2},
        "description": {"required": True},
    },
    "organization/agencies.json": {
        "code": {"required": True, "length": 3},
        "uacs_code": {"required": True, "length": 5},
        "department_code": {"required": True, "length": 2},
        "description": {"required": True},
    },
    "organization/operating_unit_classes.json": {
        "code": {"required": True, "length": 2},
    },
    "organization/operating_units.json": {
        "uacs_code": {"required": True, "length": 12},
        "department_code": {"required": True, "length": 2},
        "agency_code": {"required": True, "length": 3},
        "class_code": {"required": True, "length": 2},
    },
    "organization/organizations.json": {
        "uacs_code": {"required": True, "length": 12},
    },
    "funding_source/fund_clusters.json": {
        "code": {"required": True, "length": 2},
        "description": {"required": True},
    },
    "funding_source/financing_sources.json": {
        "code": {"required": True},
        "description": {"required": True},
    },
    "funding_source/authorizations.json": {
        "code": {"required": True, "length": 2},
        "description": {"required": True},
        "financing_source": {"required": True},
    },
    "funding_source/fund_categories.json": {
        "uacs_code": {"required": True, "length": 8},
        "fund_cluster": {"required": True},
        "financing_source": {"required": True},
        "authorization": {"required": True},
    },
    "funding_source/funding_sources.json": {
        "uacs_code": {"required": True, "length": 8},
    },
    "object_code/classifications.json": {
        "code": {"required": True, "length": 1},
    },
    "object_code/sub_classes.json": {
        "code": {"required": True, "length": 2},
        "classification_code": {"required": True, "length": 1},
    },
    "object_code/groups.json": {
        "full_code": {"required": True, "length": 5},
    },
    "object_code/objects.json": {
        "full_code": {"required": True, "length": 8},
    },
    "object_code/sub_objects.json": {
        "uacs_code": {"required": True, "length": 10},
    },
    "location/regions.json": {
        "code": {"required": True, "length": 2},
        "description": {"required": True},
    },
    "pap/sector_outcomes.json": {
        "code": {"required": True},
        "description": {"required": True},
    },
    "pap/horizontal_programs.json": {
        "code": {"required": True},
        "description": {"required": True},
    },
}


class Report:
    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.info: List[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def note(self, msg: str) -> None:
        self.info.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors


def _load(path: Path):
    import gzip
    opener = gzip.open if path.name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else [data]


def _check_schema(report: Report, rel_path: str, records: list) -> None:
    schema = SCHEMAS.get(rel_path)
    if not schema:
        return
    missing = Counter()
    bad_len = Counter()
    for rec in records:
        for field, spec in schema.items():
            if spec.get("required") and field not in rec:
                missing[f"{rel_path}.{field}"] += 1
            elif spec.get("length") and field in rec:
                v = str(rec[field])
                if len(v) != spec["length"]:
                    bad_len[f"{rel_path}.{field}(len={len(v)},exp={spec['length']})"] += 1
    for k, v in missing.items():
        report.error(f"missing field: {k} ({v} records)")
    for k, v in bad_len.items():
        report.warn(f"bad field length: {k} ({v} records)")


def _check_referential_integrity(
    report: Report, data_root: Path, budget_records: list
) -> None:
    """Every code on a BudgetRecord must exist in the corresponding reference file."""
    refs = {
        "org_uacs_code": ("organization/organizations.json", "uacs_code"),
        "funding_uacs_code": ("funding_source/funding_sources.json", "uacs_code"),
        "object_uacs_code": ("object_code/sub_objects.json", "uacs_code"),
        "region_code": ("location/regions.json", "code"),
    }
    for rec_field, (ref_rel, ref_key) in refs.items():
        ref_path = data_root / ref_rel
        if not ref_path.exists():
            report.warn(f"reference file missing: {ref_rel}")
            continue
        ref_values = {str(r.get(ref_key, "")) for r in _load(ref_path)}
        missing = Counter()
        for rec in budget_records:
            v = rec.get(rec_field)
            if v is not None and str(v) not in ref_values:
                missing[str(v)] += 1
        if missing:
            top = ", ".join(f"{k}={v}" for k, v in missing.most_common(5))
            report.error(
                f"dangling references in BudgetRecord.{rec_field}: "
                f"{len(missing)} unique codes missing from {ref_rel} "
                f"(top: {top})"
            )


def _check_budget_mapping(report: Report, mapping: dict) -> None:
    stats = mapping.get("statistics", {})
    coverage = stats.get("coverage", {})
    for key, pct in coverage.items():
        if pct < 50:
            report.warn(f"low coverage: {key} = {pct:.1f}%")
    if mapping.get("metadata", {}).get("total_amount", 0) <= 0:
        report.error("total_amount is non-positive")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate NEP-FY2027 output")
    here = Path(__file__).resolve().parent
    parser.add_argument(
        "--data", type=Path, default=here.parent.parent / "data",
        help="Data root directory",
    )
    args = parser.parse_args()

    report = Report()

    if not args.data.exists():
        print(f"Error: data directory not found: {args.data}", file=sys.stderr)
        return 2

    print(f"Validating: {args.data}\n")

    # 1. Existence + parse-ability + schema.
    expected_files = [
        "budget/2027/budget-mapping.json",
        "organization/departments.json",
        "organization/agencies.json",
        "organization/operating_unit_classes.json",
        "organization/operating_units.json",
        "organization/organizations.json",
        "funding_source/fund_clusters.json",
        "funding_source/financing_sources.json",
        "funding_source/authorizations.json",
        "funding_source/fund_categories.json",
        "funding_source/funding_sources.json",
        "object_code/classifications.json",
        "object_code/sub_classes.json",
        "object_code/groups.json",
        "object_code/objects.json",
        "object_code/sub_objects.json",
        "location/regions.json",
        "pap/sector_outcomes.json",
        "pap/horizontal_programs.json",
    ]

    counts: Dict[str, int] = {}
    for rel in expected_files:
        p = args.data / rel
        if not p.exists():
            report.error(f"missing expected file: {rel}")
            continue
        try:
            records = _load(p)
        except json.JSONDecodeError as e:
            report.error(f"invalid JSON in {rel}: {e}")
            continue
        counts[rel] = len(records)
        report.note(f"{rel}: {len(records):,} records")
        _check_schema(report, rel, records)

    # 2. Non-zero counts for dimensions NEP-FY2027 carries.
    for rel in [
        "organization/departments.json",
        "organization/agencies.json",
        "organization/organizations.json",
        "funding_source/funding_sources.json",
        "object_code/sub_objects.json",
        "location/regions.json",
    ]:
        if counts.get(rel, 0) == 0:
            report.error(f"empty file (should have data): {rel}")

    # 3. Budget record batches exist + load.
    items_dir = args.data / "budget" / "2027" / "items"
    if not items_dir.exists():
        report.error("missing budget/2027/items directory")
    else:
        batch_files = sorted(items_dir.glob("nep_2027_batch_*.json.gz"))
        if not batch_files:
            batch_files = sorted(items_dir.glob("nep_2027_batch_*.json"))
        if not batch_files:
            report.error("no batch files in budget/2027/items")
        else:
            all_budget: list = []
            for bf in batch_files:
                try:
                    all_budget.extend(_load(bf))
                except json.JSONDecodeError as e:
                    report.error(f"invalid JSON in {bf.name}: {e}")
            report.note(f"budget records (total): {len(all_budget):,}")
            _check_schema(report, "budget/2027/items", all_budget)
            _check_referential_integrity(report, args.data, all_budget)

    # 4. Budget mapping checks.
    mapping_path = args.data / "budget" / "2027" / "budget-mapping.json"
    if mapping_path.exists():
        try:
            mapping = _load(mapping_path)[0]
            _check_budget_mapping(report, mapping)
        except (json.JSONDecodeError, IndexError) as e:
            report.error(f"cannot read budget-mapping.json: {e}")

    # Print report.
    print("\n" + "=" * 60)
    print("VALIDATION REPORT")
    print("=" * 60)
    for line in report.info:
        print(f"  ℹ {line}")
    for line in report.warnings:
        print(f"  ⚠ {line}")
    for line in report.errors:
        print(f"  ✗ {line}")

    print()
    if report.ok:
        print(f"PASS — {len(report.warnings)} warning(s), 0 errors")
        return 0
    else:
        print(f"FAIL — {len(report.errors)} error(s), {len(report.warnings)} warning(s)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
