"""
NEP-FY2027 streaming converter.

Reads the intermediate JSON produced by scripts/nep-gaa-excel/converter_nep2025.py
and produces:

  data/budget/2027/
    budget-mapping.json
    items/nep_2027_batch_XXXX.json.gz   (~100k records per batch, gzipped)

  data/organization/
    departments.json, agencies.json, operating_unit_classes.json,
    operating_units.json, organizations.json

  data/funding_source/
    fund_clusters.json, financing_sources.json, authorizations.json,
    fund_categories.json, funding_sources.json

  data/object_code/
    classifications.json, sub_classes.json, groups.json,
    objects.json, sub_objects.json

  data/location/
    regions.json

  data/pap/
    sector_outcomes.json, horizontal_programs.json

Each output file conforms to the shape expected by sync.py in the upstream
open-budget-data repo (verified against sync.py at commit db1b6c2).

Usage:
    python converter_fy2027.py                 # full run
    python converter_fy2027.py --limit 5000    # dry run on first 5000 rows
    python converter_fy2027.py --input PATH    # custom intermediate JSON path
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import ijson

# Force UTF-8 stdout/stderr so Filipino text and currency symbols print
# correctly on Windows (default cp1252 would crash on peso sign etc.).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

# Make the lookups package importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent))
from lookups import funding_source_components as fsc  # noqa: E402
from lookups import sector_outcomes as so  # noqa: E402

# Constants matching the upstream schema.
BUDGET_TYPE = "NEP"
FISCAL_YEAR = "2027"
BATCH_SIZE = 100_000
SOURCE_HASH_CHUNK = 1 << 20  # 1 MiB


class FY2027Converter:
    """Streaming converter and reference extractor for NEP-FY2027."""

    def __init__(self, input_path: Path, output_root: Path):
        self.input_path = input_path
        self.output_root = output_root

        # Output directories (mirrors upstream repo layout).
        self.budget_dir = output_root / "budget" / FISCAL_YEAR
        self.items_dir = self.budget_dir / "items"
        self.org_dir = output_root / "organization"
        self.funding_dir = output_root / "funding_source"
        self.object_dir = output_root / "object_code"
        self.location_dir = output_root / "location"
        self.pap_dir = output_root / "pap"

        for d in (
            self.items_dir, self.org_dir, self.funding_dir,
            self.object_dir, self.location_dir, self.pap_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)

        # Reference-entity accumulators. Dicts keyed on the unique code so
        # duplicates collapse naturally.
        self.departments: Dict[str, dict] = {}
        self.agencies: Dict[str, dict] = {}
        self.ou_classes: Dict[str, dict] = {}
        self.operating_units: Dict[str, dict] = {}
        self.organizations: Dict[str, dict] = {}

        self.funding_sources: Dict[str, dict] = {}
        self.fund_categories: Dict[str, dict] = {}

        self.classifications: Dict[str, dict] = {}
        self.sub_classes: Dict[str, dict] = {}
        self.groups: Dict[str, dict] = {}
        self.objects: Dict[str, dict] = {}
        self.sub_objects: Dict[str, dict] = {}

        self.regions: Dict[str, dict] = {}
        self.divisions: Dict[str, dict] = {}

        # Statistics for the budget-mapping.json + diagnostics.
        self.stats = Counter()
        self.code_anomalies: Dict[str, Counter] = {
            "org": Counter(),
            "funding": Counter(),
            "object": Counter(),
            "region": Counter(),
        }
        self.total_amount = 0.0
        # Track amount by PREXC_LEVEL so budget-mapping.json can document
        # that amounts are NOT additive across levels (parent PAPs overlap
        # with their child line items).
        self.amount_by_level: Dict[int, Dict[str, float]] = {}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean(value: Any) -> str:
        """Strip and normalize a cell value to a string."""
        if value is None:
            return ""
        return str(value).strip()

    @staticmethod
    def _clean_amount(value: Any) -> float:
        if value is None or value == "":
            return 0.0
        try:
            return float(str(value).replace(",", ""))
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _sha256(path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(SOURCE_HASH_CHUNK), b""):
                h.update(chunk)
        return h.hexdigest()

    # ------------------------------------------------------------------
    # Per-row extractors
    # ------------------------------------------------------------------

    def _add_department(self, code: str, description: str) -> None:
        if not code or code == "00":
            return
        self.departments.setdefault(
            code,
            {
                "code": code,
                "description": description,
                "abbreviation": _extract_abbreviation(description),
                "status": "Active",
            },
        )

    def _add_agency(self, dept_code: str, agency_code: str, description: str) -> None:
        if not dept_code or not agency_code:
            return
        uacs = f"{dept_code}{agency_code}"  # 5-digit
        if uacs == "00000":
            return
        self.agencies.setdefault(
            uacs,
            {
                "code": agency_code,
                "description": description,
                "department_code": dept_code,
                "uacs_code": uacs,
                "status": "Active",
            },
        )

    def _add_operating_unit(
        self,
        dept_code: str,
        agency_code: str,
        operunit_raw: str,
        description: str,
    ) -> Optional[str]:
        """Add OU + org + (synthesized) OU class. Returns 12-digit org UACS or None."""
        if not dept_code or not agency_code or not operunit_raw:
            return None

        # OPERUNIT in NEP-FY2027 is 7 digits (class + lower_ou). Pad if short.
        # "0000000" is valid for NON-IU attached agencies (e.g. DepEd NBDB → 070020000000).
        operunit = operunit_raw.zfill(7)

        if len(operunit) != 7:
            self.code_anomalies["org"][f"operunit_len_{len(operunit)}"] += 1
            return None

        class_code = operunit[0:2]
        lower_ou = operunit[2:7]
        uacs_12 = f"{dept_code}{agency_code}{operunit}"
        if uacs_12 == "000000000000":
            return None

        # Operating Unit Class (synthesized; description left blank unless
        # we recognize a common code).
        self.ou_classes.setdefault(
            class_code,
            {
                "code": class_code,
                "description": _COMMON_OU_CLASSES.get(class_code, ""),
                "status": "Active",
            },
        )

        # Operating Unit.
        self.operating_units.setdefault(
            uacs_12,
            {
                "code": operunit,
                "description": description,
                "uacs_code": uacs_12,
                "department_code": dept_code,
                "agency_code": agency_code,
                "class_code": class_code,
                "lower_ou_code": lower_ou,
                "status": "Active",
            },
        )

        # Organization composite (what BudgetRecord joins to).
        self.organizations.setdefault(
            uacs_12,
            {
                "uacs_code": uacs_12,
                "description": description,
                "department_code": dept_code,
                "agency_code": agency_code,
                "operating_unit_code": operunit,
                "class_code": class_code,
                "lower_ou_code": lower_ou,
                "status": "Active",
            },
        )

        return uacs_12

    def _add_funding(self, fundcd_raw: str, category_description: str) -> Optional[str]:
        if not fundcd_raw:
            return None
        fundcd = str(fundcd_raw).strip()
        if len(fundcd) != 8 or fundcd == "00000000":
            self.code_anomalies["funding"][f"len_{len(fundcd)}"] += 1
            return None

        try:
            parts = fsc.parse_funding_code(fundcd)
        except ValueError:
            self.code_anomalies["funding"]["parse_fail"] += 1
            return None

        uacs = parts["uacs_code"]

        # FundingSource (8-digit composite) -- what BudgetRecord joins to.
        self.funding_sources.setdefault(
            uacs,
            {
                "uacs_code": uacs,
                "description": category_description or _build_funding_desc(parts),
                "fund_cluster_code": parts["fund_cluster_code"],
                "financing_source_code": parts["financing_source_code"],
                "authorization_code": parts["authorization_code"],
                "category_code": parts["category_code"],
                "status": "Active",
            },
        )

        # FundCategory -- sync.py joins funding hierarchy through this node,
        # matching on description strings for the parent references.
        self.fund_categories.setdefault(
            uacs,
            {
                "uacs_code": uacs,
                "code": parts["category_code"],
                "description": category_description,
                "sub_category": category_description,
                "fund_cluster": parts["fund_cluster"],
                "financing_source": parts["financing_source"],
                "authorization": parts["authorization"],
                "status": "Active",
            },
        )

        return uacs

    def _add_object(self, obj_cd_raw: str, classification_code: str,
                    classification_desc: str, description: str) -> Optional[str]:
        if not obj_cd_raw:
            return None
        obj_cd = str(obj_cd_raw).strip()
        # Some NEP exports store floats (e.g. 5010101000.0). Strip trailing .0.
        if obj_cd.endswith(".0"):
            obj_cd = obj_cd[:-2]
        obj_cd = obj_cd.zfill(10)
        if len(obj_cd) != 10 or obj_cd == "0000000000":
            self.code_anomalies["object"][f"len_{len(obj_cd)}"] += 1
            return None

        class_code = obj_cd[0:1]
        subclass_code = obj_cd[1:3]
        group_full = obj_cd[0:5]
        group_code = obj_cd[3:5]
        object_full = obj_cd[0:8]
        object_code = obj_cd[5:8]
        subobject_code = obj_cd[8:10]

        # Prefer the row's own classification code/description if present.
        c_code = classification_code.zfill(1) if classification_code else class_code
        c_desc = classification_desc or ""

        self.classifications.setdefault(
            c_code,
            {"code": c_code, "description": c_desc or _EXP_CLASSIFICATION.get(c_code, ""),
             "uacs_code": c_code, "status": "Active"},
        )

        subclass_key = f"{c_code}{subclass_code}"
        self.sub_classes.setdefault(
            subclass_code,
            {
                "code": subclass_code,
                "simple_code": subclass_code,
                "description": "",  # NEP doesn't carry subclass descriptions.
                "classification_code": c_code,
                "uacs_code": subclass_key,
                "status": "Active",
            },
        )

        self.groups.setdefault(
            group_full,
            {
                "code": group_code,
                "full_code": group_full,
                "description": "",
                "sub_class_code": subclass_code,
                "classification_code": c_code,
                "uacs_code": group_full,
                "status": "Active",
            },
        )

        self.objects.setdefault(
            object_full,
            {
                "code": object_code,
                "full_code": object_full,
                "description": "",
                "group_code": group_code,
                "sub_class_code": subclass_code,
                "classification_code": c_code,
                "uacs_code": object_full,
                "status": "Active",
            },
        )

        self.sub_objects.setdefault(
            obj_cd,
            {
                "code": subobject_code,
                "uacs_code": obj_cd,
                "description": description,
                "object_code": object_code,
                "group_code": group_code,
                "sub_class_code": subclass_code,
                "classification_code": c_code,
                "expense_category": _EXP_CATEGORY.get(c_code, ""),
                "status": "Active",
            },
        )

        return obj_cd

    def _add_region(self, region_raw: str, description: str) -> Optional[str]:
        if not region_raw:
            return None
        region = str(region_raw).strip()
        # Tolerate trailing .0 from float storage.
        if region.endswith(".0"):
            region = region[:-2]
        region = region.zfill(2)
        if region == "00" or not region.isdigit():
            self.code_anomalies["region"][f"value_{region_raw}"] += 1
            return None
        self.regions.setdefault(
            region,
            {"code": region, "description": description,
             "psgc_code": region, "status": "Active"},
        )
        return region

    def _add_division(self, operdiv_raw: str, description: str) -> tuple:
        """Return (division_code, division_name). Division is the DepEd Schools
        Division (or equivalent) from UACS_OPERDIV_ID / UACS_DIV_DSC."""
        if not operdiv_raw:
            return None, ""
        code = _strip_float(operdiv_raw).zfill(7)
        if code == "0000000" or len(code) != 7:
            return None, ""
        name = description or ""
        self.divisions.setdefault(
            code,
            {
                "code": code,
                "description": name,
                "status": "Active",
            },
        )
        if name and not self.divisions[code].get("description"):
            self.divisions[code]["description"] = name
        return code, self.divisions[code].get("description") or name

    # ------------------------------------------------------------------
    # Streaming read + budget-record conversion
    # ------------------------------------------------------------------

    def _convert_record(self, record: dict, record_number: int) -> dict:
        dept_raw = self._clean(record.get("DEPARTMENT"))
        agency_raw = self._clean(record.get("AGENCY"))
        operunit_raw = self._clean(record.get("OPERUNIT"))
        fundcd_raw = self._clean(record.get("FUNDCD"))
        obj_cd_raw = self._clean(record.get("UACS_OBJ_CD"))
        region_raw = self._clean(record.get("UACS_REG_ID"))
        amt = self._clean_amount(record.get("AMT"))

        # Strip trailing .0 from numeric-stored codes (Excel float artifacts).
        dept = _strip_float(dept_raw).zfill(2)
        agency = _strip_float(agency_raw).zfill(3)
        operunit = _strip_float(operunit_raw)
        fundcd = _strip_float(fundcd_raw)
        obj_cd = _strip_float(obj_cd_raw)
        region_in = _strip_float(region_raw)

        dsc = self._clean(record.get("DSC"))
        prexc_id = _strip_float(self._clean(record.get("PREXC_FPAP_ID"))).zfill(15)
        sorder = self._clean(record.get("SORDER"))
        try:
            prexc_level = int(_strip_float(self._clean(record.get("PREXC_LEVEL"))) or 0)
        except ValueError:
            prexc_level = 0

        # Track amount by PREXC_LEVEL for the budget-mapping.json analysis.
        # NEP exports include parent-PAP totals that overlap with their
        # child line items; summing all rows double-counts. Tracking by
        # level lets downstream consumers pick the right cut.
        level_stats = self.amount_by_level.setdefault(
            prexc_level, {"count": 0, "sum": 0.0}
        )
        level_stats["count"] += 1
        level_stats["sum"] += amt

        # Build reference entities (dedup happens inside each _add_* method).
        self._add_department(dept, self._clean(record.get("UACS_DPT_DSC")))
        self._add_agency(dept, agency, self._clean(record.get("UACS_AGY_DSC")))
        org_code = self._add_operating_unit(
            dept, agency, operunit, self._clean(record.get("UACS_OPER_DSC"))
        )
        funding_code = self._add_funding(
            fundcd, self._clean(record.get("UACS_FUNDSUBCAT_DSC"))
        )
        object_code = self._add_object(
            obj_cd,
            self._clean(record.get("UACS_EXP_CD")),
            self._clean(record.get("UACS_EXP_DSC")),
            self._clean(record.get("UACS_OBJ_DSC")),
        )
        region_code = self._add_region(
            region_in, self._clean(record.get("UACS_REG_DSC"))
        )
        division_code, division_name = self._add_division(
            self._clean(record.get("UACS_OPERDIV_ID")),
            self._clean(record.get("UACS_DIV_DSC")),
        )
        ou_class_code = None
        if operunit and len(operunit.zfill(7)) == 7:
            ou_class_code = operunit.zfill(7)[0:2]

        # Build the budget record (matches upstream schema + SORDER + PREXC_LEVEL).
        record_id = f"{BUDGET_TYPE}-{FISCAL_YEAR}-{str(record_number).zfill(10)}"
        out = {
            "id": record_id,
            "budget_type": BUDGET_TYPE,
            "fiscal_year": FISCAL_YEAR,
            "amount": amt,
            "description": dsc,
            "prexc_fpap_id": prexc_id,
            "prexc_level": prexc_level,
            "sorder": sorder,
        }
        if org_code:
            out["org_uacs_code"] = org_code
        if region_code:
            out["region_code"] = region_code
        if division_code:
            out["division_code"] = division_code
            if division_name:
                out["division_name"] = division_name
        if ou_class_code:
            out["ou_class_code"] = ou_class_code
        if funding_code:
            out["funding_uacs_code"] = funding_code
        if object_code:
            out["object_uacs_code"] = object_code

        # Stats.
        self.stats["rows"] += 1
        self.stats["rows_with_org"] += 1 if org_code else 0
        self.stats["rows_with_funding"] += 1 if funding_code else 0
        self.stats["rows_with_object"] += 1 if object_code else 0
        self.stats["rows_with_region"] += 1 if region_code else 0
        self.stats["rows_with_division"] += 1 if division_code else 0
        self.stats["rows_with_amount"] += 1 if amt != 0 else 0
        self.total_amount += amt

        return out

    def stream(self, limit: Optional[int] = None) -> None:
        """Stream the intermediate JSON, emit budget batches incrementally."""
        start = time.time()
        print(f"Streaming: {self.input_path}")
        print(f"Output:    {self.output_root}")
        if limit:
            print(f"Limit:     first {limit:,} rows (dry run)")
        print()

        batch: List[dict] = []
        batch_number = 1
        batch_files: List[str] = []
        record_number = 0

        # ijson.items yields each element of the top-level array lazily.
        with open(self.input_path, "rb") as f:
            items = ijson.items(f, "item")
            for record in items:
                record_number += 1
                converted = self._convert_record(record, record_number)
                batch.append(converted)

                if len(batch) >= BATCH_SIZE:
                    name = f"{BUDGET_TYPE.lower()}_{FISCAL_YEAR}_batch_{str(batch_number).zfill(4)}.json.gz"
                    _write_json(self.items_dir / name, batch)
                    batch_files.append(name)
                    print(f"  Batch {batch_number}: {len(batch):,} records -> {name}")
                    batch = []
                    batch_number += 1

                if record_number % 50_000 == 0:
                    elapsed = time.time() - start
                    rate = record_number / elapsed if elapsed else 0
                    print(f"  Progress: {record_number:,} rows "
                          f"({rate:,.0f} rows/s, {elapsed:.1f}s)")

                if limit and record_number >= limit:
                    break

        # Flush remaining partial batch.
        if batch:
            name = f"{BUDGET_TYPE.lower()}_{FISCAL_YEAR}_batch_{str(batch_number).zfill(4)}.json.gz"
            _write_json(self.items_dir / name, batch)
            batch_files.append(name)
            print(f"  Batch {batch_number}: {len(batch):,} records -> {name}")

        elapsed = time.time() - start
        print(f"\nStreamed {record_number:,} rows in {elapsed:.1f}s "
              f"({record_number / elapsed:,.0f} rows/s)")

        self._write_reference_jsons()
        self._write_budget_mapping(batch_files, record_number)
        self._print_summary()

    # ------------------------------------------------------------------
    # Reference JSON writers
    # ------------------------------------------------------------------

    def _write_reference_jsons(self) -> None:
        # Organization.
        _write_json(self.org_dir / "departments.json", list(self.departments.values()))
        _write_json(self.org_dir / "agencies.json", list(self.agencies.values()))
        _write_json(self.org_dir / "operating_unit_classes.json", list(self.ou_classes.values()))
        _write_json(self.org_dir / "operating_units.json", list(self.operating_units.values()))
        _write_json(self.org_dir / "organizations.json", list(self.organizations.values()))
        _write_json(self.org_dir / "_metadata.json", [{
            "entity": "organization",
            "total_departments": len(self.departments),
            "total_agencies": len(self.agencies),
            "total_operating_unit_classes": len(self.ou_classes),
            "total_operating_units": len(self.operating_units),
            "total_organizations": len(self.organizations),
            "source": "derived from NEP-FY2027",
            "conversion_date": datetime.now().isoformat(),
        }])

        # Funding source. Fund cluster/financing/auth come from the hardcoded
        # lookup so the sync.py relationship joins (which match on description
        # strings) have something to match against.
        fsc_records = fsc.as_neo4j_records()
        _write_json(self.funding_dir / "fund_clusters.json", fsc_records["fund_clusters"])
        _write_json(self.funding_dir / "financing_sources.json", fsc_records["financing_sources"])
        _write_json(self.funding_dir / "authorizations.json", fsc_records["authorizations"])
        _write_json(self.funding_dir / "fund_categories.json", list(self.fund_categories.values()))
        _write_json(self.funding_dir / "funding_sources.json", list(self.funding_sources.values()))
        _write_json(self.funding_dir / "_metadata.json", [{
            "entity": "funding_source",
            "total_fund_clusters": len(fsc_records["fund_clusters"]),
            "total_financing_sources": len(fsc_records["financing_sources"]),
            "total_authorizations": len(fsc_records["authorizations"]),
            "total_fund_categories": len(self.fund_categories),
            "total_funding_sources": len(self.funding_sources),
            "source_clusters_etc": "FY2026 reference (stable, hardcoded)",
            "source_funding_sources": "derived from NEP-FY2027",
            "conversion_date": datetime.now().isoformat(),
        }])

        # Object code.
        _write_json(self.object_dir / "classifications.json", list(self.classifications.values()))
        _write_json(self.object_dir / "sub_classes.json", list(self.sub_classes.values()))
        _write_json(self.object_dir / "groups.json", list(self.groups.values()))
        _write_json(self.object_dir / "objects.json", list(self.objects.values()))
        _write_json(self.object_dir / "sub_objects.json", list(self.sub_objects.values()))
        _write_json(self.object_dir / "_metadata.json", [{
            "entity": "object_code",
            "total_classifications": len(self.classifications),
            "total_sub_classes": len(self.sub_classes),
            "total_groups": len(self.groups),
            "total_objects": len(self.objects),
            "total_sub_objects": len(self.sub_objects),
            "source": "derived from NEP-FY2027",
            "conversion_date": datetime.now().isoformat(),
        }])

        # Location (regions only -- NEP doesn't carry lower-level PSGC).
        _write_json(self.location_dir / "regions.json", list(self.regions.values()))
        _write_json(self.location_dir / "_metadata.json", [{
            "entity": "location",
            "total_regions": len(self.regions),
            "total_provinces": 0,
            "total_cities_municipalities": 0,
            "total_barangays": 0,
            "note": "NEP-FY2027 only carries region-level geography",
            "source": "derived from NEP-FY2027",
            "conversion_date": datetime.now().isoformat(),
        }])
        # Schools Division / equivalent (from UACS_OPERDIV_ID).
        _write_json(self.org_dir / "divisions.json", list(self.divisions.values()))

        # PAP (only the two files sync.py actually reads).
        so_records = so.as_neo4j_records()
        _write_json(self.pap_dir / "sector_outcomes.json", so_records["sector_outcomes"])
        _write_json(self.pap_dir / "horizontal_programs.json", so_records["horizontal_programs"])
        _write_json(self.pap_dir / "_metadata.json", [{
            "entity": "pap",
            "total_sector_outcomes": len(so_records["sector_outcomes"]),
            "total_horizontal_programs": len(so_records["horizontal_programs"]),
            "source": "hardcoded (transcribed from DBM UACS)",
            "conversion_date": datetime.now().isoformat(),
        }])

    def _write_budget_mapping(self, batch_files: List[str], total_records: int) -> None:
        mapping = {
            "metadata": {
                "budget_type": BUDGET_TYPE,
                "fiscal_year": FISCAL_YEAR,
                "total_records": total_records,
                "total_amount": self.total_amount,
                "conversion_date": datetime.now().isoformat(),
                "source_file": str(self.input_path.name),
                "source_sha256": self._sha256(self.input_path),
            },
            "batch_info": {
                "batch_size": BATCH_SIZE,
                "total_batches": len(batch_files),
                "batch_files": batch_files,
            },
            "statistics": {
                "rows_with_org_uacs": self.stats["rows_with_org"],
                "rows_with_funding_uacs": self.stats["rows_with_funding"],
                "rows_with_object_uacs": self.stats["rows_with_object"],
                "rows_with_region": self.stats["rows_with_region"],
                "rows_with_division": self.stats["rows_with_division"],
                "rows_with_nonzero_amount": self.stats["rows_with_amount"],
                "coverage": {
                    "org_pct": _pct(self.stats["rows_with_org"], total_records),
                    "funding_pct": _pct(self.stats["rows_with_funding"], total_records),
                    "object_pct": _pct(self.stats["rows_with_object"], total_records),
                    "region_pct": _pct(self.stats["rows_with_region"], total_records),
                    "division_pct": _pct(self.stats["rows_with_division"], total_records),
                    "amount_pct": _pct(self.stats["rows_with_amount"], total_records),
                },
            },
            "unique_counts": {
                "departments": len(self.departments),
                "agencies": len(self.agencies),
                "operating_unit_classes": len(self.ou_classes),
                "operating_units": len(self.operating_units),
                "organizations": len(self.organizations),
                "divisions": len(self.divisions),
                "funding_sources": len(self.funding_sources),
                "fund_categories": len(self.fund_categories),
                "classifications": len(self.classifications),
                "sub_classes": len(self.sub_classes),
                "groups": len(self.groups),
                "objects": len(self.objects),
                "sub_objects": len(self.sub_objects),
                "regions": len(self.regions),
            },
            "code_anomalies": {
                k: dict(v.most_common(20)) for k, v in self.code_anomalies.items()
            },
            "amount_analysis": self._build_amount_analysis(),
        }
        _write_json(self.budget_dir / "budget-mapping.json", mapping)

    def _build_amount_analysis(self) -> dict:
        """Build the per-PREXC_LEVEL amount analysis block.

        NEP exports include parent-PAP totals (PREXC_LEVEL=0 grand total,
        =3 program totals) that overlap with the lowest-level line items
        (=7). Summing all rows double-counts. We document this so
        downstream consumers know which filter to use.
        """
        level_meanings = {
            0: "Top grand-total row(s)",
            1: "Cost-structure / sector outcome headers",
            2: "Organizational outcome headers",
            3: "Program totals (includes lump-sum SPFs not itemized lower)",
            4: "Sub-program headers",
            5: "Activity-type headers",
            6: "Activity headers",
            7: "Lowest-level line items",
        }
        by_level = {}
        for level in sorted(self.amount_by_level.keys()):
            stats = self.amount_by_level[level]
            by_level[str(level)] = {
                "count": stats["count"],
                "sum_in_thousands": stats["sum"],
                "meaning": level_meanings.get(level, f"PREXC_LEVEL {level}"),
            }

        line_item_stats = self.amount_by_level.get(7, {"count": 0, "sum": 0.0})
        return {
            "note": (
                "AMT values are in THOUSANDS of pesos (per source NEP title "
                "row). Multiply by 1,000 for actual pesos."
            ),
            "warning": (
                "Amounts are NOT additive across PREXC_LEVELs. Levels 0, 3, "
                "and 7 contain overlapping totals (parent PAPs roll up to "
                "their children). metadata.total_amount sums ALL rows and "
                "should NOT be used as a budget total -- it double-counts."
            ),
            "amounts_by_prexc_level": by_level,
            "recommended_filter_for_line_items": "prexc_level == 7",
            "line_item_total_in_thousands": line_item_stats["sum"],
            "line_item_total_in_pesos": line_item_stats["sum"] * 1000,
            "line_item_count": line_item_stats["count"],
        }

    def _print_summary(self) -> None:
        print("\n" + "=" * 60)
        print("CONVERSION SUMMARY")
        print("=" * 60)
        print(f"  Budget records:   {self.stats['rows']:,}")
        print(f"  Total amount:     ₱{self.total_amount:,.0f}")
        print(f"  With org code:    {self.stats['rows_with_org']:,} "
              f"({_pct(self.stats['rows_with_org'], self.stats['rows']):.1f}%)")
        print(f"  With funding:     {self.stats['rows_with_funding']:,} "
              f"({_pct(self.stats['rows_with_funding'], self.stats['rows']):.1f}%)")
        print(f"  With object:      {self.stats['rows_with_object']:,} "
              f"({_pct(self.stats['rows_with_object'], self.stats['rows']):.1f}%)")
        print(f"  With region:      {self.stats['rows_with_region']:,} "
              f"({_pct(self.stats['rows_with_region'], self.stats['rows']):.1f}%)")
        print(f"  With division:    {self.stats['rows_with_division']:,} "
              f"({_pct(self.stats['rows_with_division'], self.stats['rows']):.1f}%)")
        print()
        print(f"  Departments:      {len(self.departments):,}")
        print(f"  Agencies:         {len(self.agencies):,}")
        print(f"  OU classes:       {len(self.ou_classes):,}")
        print(f"  Operating units:  {len(self.operating_units):,}")
        print(f"  Organizations:    {len(self.organizations):,}")
        print(f"  Divisions:        {len(self.divisions):,}")
        print(f"  Funding sources:  {len(self.funding_sources):,}")
        print(f"  Fund categories:  {len(self.fund_categories):,}")
        print(f"  Sub-objects:      {len(self.sub_objects):,}")
        print(f"  Regions:          {len(self.regions):,}")

        # Surface any code anomalies.
        any_anomalies = any(v for v in self.code_anomalies.values())
        if any_anomalies:
            print("\n  Code anomalies (top 5 per dimension):")
            for dim, counter in self.code_anomalies.items():
                if counter:
                    top = ", ".join(f"{k}={v}" for k, v in counter.most_common(5))
                    print(f"    {dim}: {top}")


# ----------------------------------------------------------------------
# Module-level helpers
# ----------------------------------------------------------------------

def _write_json(path: Path, data: Any) -> None:
    """Write JSON; gzip when path ends with .gz (compact for large batches)."""
    if path.name.endswith(".gz"):
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        return
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _strip_float(value: str) -> str:
    """Remove a trailing .0 from a string that was stored as a float."""
    if not value:
        return value
    if value.endswith(".0"):
        return value[:-2]
    return value


def _extract_abbreviation(name: str) -> str:
    """Pull text in trailing parentheses as an abbreviation (e.g. 'DepEd')."""
    if "(" in name and ")" in name:
        return name[name.rfind("(") + 1:name.rfind(")")].strip()
    return ""


def _pct(num: int, denom: int) -> float:
    return (num * 100.0 / denom) if denom else 0.0


def _build_funding_desc(parts: dict) -> str:
    return " - ".join(
        p for p in (
            parts["fund_cluster"],
            parts["financing_source"],
            parts["authorization"],
        ) if p
    )


# Common Operating Unit Class codes (positions 5-6 of 12-digit org UACS).
# Source: DBM UACS Operating Unit Class table. Not exhaustive -- unknown
# codes will still appear but with empty description.
_COMMON_OU_CLASSES = {
    "01": "Central Office",
    "02": "Regional Office",
    "03": "Provincial Office",
    "04": "City Office",
    "05": "Municipal Office",
    "06": "District Office",
    "07": "Branch Office",
    "08": "Hospital",
    "09": "School",
    "10": "Research Institution",
    "11": "Training Center",
    "12": "Laboratory",
    "13": "Production Unit",
    "14": "Service Center",
    "15": "Resettlement Area",
    "16": "Dam/Reservoir",
    "17": "Irrigation System",
    "18": "Power Plant",
    "19": "Transmission Line",
    "20": "Substation",
    "21": "Port/Harbor",
    "22": "Airport",
    "23": "Roads and Bridges",
    "24": "Buildings and Structures",
    "25": "Other Infrastructure",
    "99": "Other Operating Units",
}

# UACS expense classification codes (1-digit, first digit of object code).
_EXP_CLASSIFICATION = {
    "1": "Personnel Services",
    "2": "Maintenance and Other Operating Expenses",
    "3": "Financial Expenses",
    "4": "Non-Cash Expenses",
    "5": "Capital Outlays",
    "6": "Net Lending",
    "7": "Interest Payments",
    "8": "Tax Expenditures",
    "9": "Other Expenses",
}

# Maps single-digit classification to the canonical PS/MOOE/CO bucket used
# by the SubObject.expense_category field in sync.py.
_EXP_CATEGORY = {
    "1": "PS",
    "2": "MOOE",
    "3": "MOOE",
    "4": "MOOE",
    "5": "CO",
    "6": "CO",
    "7": "CO",
    "8": "CO",
    "9": "MOOE",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="NEP-FY2027 streaming converter")
    here = Path(__file__).resolve().parent
    default_input = here / "input" / "NEP-FY2027.json"
    default_output = here.parent.parent / "data"

    parser.add_argument(
        "--input", type=Path, default=default_input,
        help=f"Intermediate JSON path (default: {default_input})",
    )
    parser.add_argument(
        "--output", type=Path, default=default_output,
        help=f"Output root (default: {default_output})",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only the first N rows (dry run)",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        return 1

    converter = FY2027Converter(args.input, args.output)
    converter.stream(limit=args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
