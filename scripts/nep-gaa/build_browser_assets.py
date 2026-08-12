"""
Build pre-generated browser assets from budget batch files.

Writes for each fiscal year under data/budget/{year}/browser/:

  meta.json.gz          grand total + AA rollups
  place_tree.json.gz    Place-view tree (dept→…→program)
  nep_tree.json.gz      NEP-view tree (dept→…→ou)
  shards/{agency}/{region}.json.gz   L7 programmed line items
  aa.json.gz            automatic-appropriation records
  manifest.json.gz      shard path index

The browser loads trees from these files (instant startup) and opens only
the shard(s) needed for an items query instead of scanning every batch.

Usage:
    python build_browser_assets.py
    python build_browser_assets.py --year 2027
    python build_browser_assets.py --data PATH
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from json_io import find_batch_files, iter_json_array, read_json, write_json

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

# Mirror browser/server.py AA rules.
AA_RULES = [
    ("fundcd",        "10401110",   "debt_service",    "Debt Service - Interest Payments"),
    ("fundcd",        "10401258",   "lgu_share",       "National Tax Allotment (NTA)"),
    ("fundcd",        "10401257",   "lgu_share",       "BARMM Annual Block Grant"),
    ("fundcd",        "10401280",   "net_lending",     "Net Lending to GOCCs"),
    ("fundcd",        "10401105",   "tax_expenditure", "Tax Expenditure Fund"),
    ("fundcd_prefix", "10403",      "sagf",            "Special Accounts in the General Fund (SAGF)"),
    ("object_code",   "5010301000", "statutory",       "Retirement and Life Insurance Premiums (RLIP)"),
]


def _which_aa_rule(rec: dict) -> Optional[str]:
    fc = rec.get("funding_uacs_code") or ""
    obj = rec.get("object_uacs_code") or ""
    for match_type, key, _, _ in AA_RULES:
        if match_type == "fundcd" and fc == key:
            return key
        if match_type == "fundcd_prefix" and fc.startswith(key):
            return key
        if match_type == "object_code" and obj == key:
            return key
    return None


def _pick_level(levels: Dict[int, float]) -> int:
    nonzero = [lv for lv, amt in levels.items() if lv > 0 and amt != 0]
    if not nonzero:
        nonzero = [lv for lv, amt in levels.items() if amt != 0]
    if not nonzero:
        return 0
    if 7 in nonzero:
        return 7
    if 3 in nonzero:
        return 3
    return max(nonzero)


def _load_ref_map(path: Path, key: str) -> Dict[str, dict]:
    if not path.exists():
        return {}
    data = read_json(path)
    rows = data if isinstance(data, list) else [data]
    return {str(r.get(key, "")): r for r in rows if r.get(key) is not None}


class Node:
    __slots__ = ("kind", "code", "label", "parent_key", "children",
                 "item_count", "total_amount", "_key", "shard")

    def __init__(self, kind: str, code: str, label: str, parent_key: str,
                 key: Optional[str] = None, shard: Optional[str] = None):
        self.kind = kind
        self.code = code
        self.label = label
        self.parent_key = parent_key
        self.children: Dict[str, "Node"] = {}
        self.item_count = 0
        self.total_amount = 0.0
        self._key = key
        self.shard = shard

    def key(self) -> str:
        return self._key if self._key is not None else f"{self.kind}:{self.code}"


class TreeIndex:
    def __init__(self, name: str):
        self.name = name
        self.tree: Dict[str, Node] = {}
        self.all_nodes: Dict[str, Node] = {}

    def rollup(self, leaf: Node, amt: float) -> None:
        leaf.item_count += 1
        leaf.total_amount += amt
        key = leaf.parent_key
        while key:
            node = self.all_nodes.get(key)
            if node is None:
                break
            node.item_count += 1
            node.total_amount += amt
            key = node.parent_key


def _serialize_tree(idx: TreeIndex) -> dict:
    nodes = {}
    for key, node in idx.all_nodes.items():
        child_map_keys = list(node.children.keys())
        child_node_keys = [c.key() for c in node.children.values()]
        nodes[key] = {
            "kind": node.kind,
            "code": node.code,
            "label": node.label,
            "parent_key": node.parent_key,
            "item_count": node.item_count,
            "total_amount": node.total_amount,
            "shard": node.shard,
            "children": child_map_keys,
            "child_keys": child_node_keys,
        }
    return {"view": idx.name, "roots": list(idx.tree.keys()), "nodes": nodes}


class AssetBuilder:
    def __init__(self, data_root: Path, year: str, refs: dict):
        self.data_root = data_root
        self.year = year
        self.budget_dir = data_root / "budget" / year
        self.items_dir = self.budget_dir / "items"
        self.out_dir = self.budget_dir / "browser"
        self.shards_dir = self.out_dir / "shards"
        self.refs = refs

        self.place = TreeIndex("place")
        self.nep = TreeIndex("nep")
        self.grand_total = 0.0
        self.aa_stats: Dict[str, dict] = {}
        for match_type, key, category, name in AA_RULES:
            self.aa_stats[key] = {
                "match_type": match_type,
                "category": category,
                "name": name,
                "levels": defaultdict(float),
                "counts": defaultdict(int),
            }

        self.shard_recs: Dict[str, List[dict]] = defaultdict(list)
        self.aa_recs: List[dict] = []
        self.dept_agencies: Dict[str, set] = defaultdict(set)
        self.agency_shards: Dict[str, set] = defaultdict(set)

    def _label_dept(self, code: str) -> str:
        return self.refs["departments"].get(code, {}).get("description", f"Dept {code}")

    def _label_agency(self, code: str) -> str:
        return self.refs["agencies"].get(code, {}).get("description", f"Agency {code}")

    def _label_ou(self, code: str) -> str:
        return (
            self.refs["organizations"].get(code, {}).get("description")
            or self.refs["operating_units"].get(code, {}).get("description")
            or f"OU {code}"
        )

    def _label_region(self, code: str) -> str:
        if code == "_none":
            return "No region"
        return self.refs["regions"].get(code, {}).get("description", f"Region {code}")

    def _label_division(self, code: str, name: str) -> str:
        if code == "_none":
            return "No division"
        if name:
            return name
        return self.refs["divisions"].get(code, {}).get("description", f"Division {code}")

    def _ensure_dept(self, idx: TreeIndex, dept: str) -> Node:
        if dept in idx.tree:
            return idx.tree[dept]
        node = Node("dept", dept, self._label_dept(dept), "")
        idx.tree[dept] = node
        idx.all_nodes[node.key()] = node
        return node

    def _ensure_agency(self, idx: TreeIndex, dept: str, agency: str) -> Node:
        parent = self._ensure_dept(idx, dept)
        key = f"agency:{agency}"
        if key in idx.all_nodes:
            return idx.all_nodes[key]
        node = Node("agency", agency, self._label_agency(agency), parent.key())
        parent.children[agency] = node
        idx.all_nodes[key] = node
        return node

    def _ensure_child(
        self, idx: TreeIndex, parent: Node, kind: str, code: str, label: str,
        child_map_key: str, shard: Optional[str] = None,
    ) -> Node:
        key = f"{kind}:{code}"
        if key in idx.all_nodes:
            node = idx.all_nodes[key]
            if shard and not node.shard:
                node.shard = shard
            return node
        node = Node(kind, code, label, parent.key(), shard=shard)
        parent.children[child_map_key] = node
        idx.all_nodes[key] = node
        return node

    def _ensure_program(
        self, idx: TreeIndex, parent: Node, parent_code: str, prexc: str, desc: str,
        shard: Optional[str] = None,
    ) -> Node:
        key = f"program:{parent_code}:{prexc}"
        if key in idx.all_nodes:
            node = idx.all_nodes[key]
            if desc and node.label.startswith("FPAP "):
                node.label = desc
            if shard and not node.shard:
                node.shard = shard
            return node
        node = Node(
            "program", prexc, desc or f"FPAP {prexc}", parent.key(),
            key=key, shard=shard,
        )
        parent.children[prexc] = node
        idx.all_nodes[key] = node
        return node

    def _place_leaf(
        self, dept, agency, region, division, div_name, ou, prexc, desc, shard,
    ) -> Node:
        agency_node = self._ensure_agency(self.place, dept, agency)
        reg_code = f"{agency}|{region}"
        reg_node = self._ensure_child(
            self.place, agency_node, "region", reg_code, self._label_region(region),
            reg_code, shard=shard,
        )
        div_code = f"{agency}|{region}|{division}"
        div_node = self._ensure_child(
            self.place, reg_node, "division", div_code,
            self._label_division(division, div_name), div_code, shard=shard,
        )
        ou_node = self._ensure_child(
            self.place, div_node, "ou", ou, self._label_ou(ou), ou, shard=shard,
        )
        return self._ensure_program(
            self.place, ou_node, ou, prexc, desc, shard=shard,
        )

    def _nep_leaf(
        self, dept, agency, region, division, div_name, ou, prexc, desc, shard,
    ) -> Node:
        agency_node = self._ensure_agency(self.nep, dept, agency)
        prog = self._ensure_program(
            self.nep, agency_node, agency, prexc, desc, shard=None,
        )
        reg_code = f"{agency}|{prexc}|{region}"
        reg_node = self._ensure_child(
            self.nep, prog, "region", reg_code, self._label_region(region),
            reg_code, shard=shard,
        )
        div_code = f"{agency}|{prexc}|{region}|{division}"
        div_node = self._ensure_child(
            self.nep, reg_node, "division", div_code,
            self._label_division(division, div_name), div_code, shard=shard,
        )
        ou_code = f"{agency}|{prexc}|{region}|{division}|{ou}"
        return self._ensure_child(
            self.nep, div_node, "ou", ou_code, self._label_ou(ou),
            ou_code, shard=shard,
        )

    def ingest(self) -> None:
        batches = find_batch_files(self.items_dir, self.year)
        if not batches:
            raise SystemExit(f"No batch files under {self.items_dir}")
        print(f"[FY{self.year}] Reading {len(batches)} batch files...", flush=True)
        n = 0
        for batch in batches:
            for rec in iter_json_array(batch):
                n += 1
                if n % 100_000 == 0:
                    print(f"[FY{self.year}]   {n:,} records...", flush=True)
                self._ingest_rec(rec)
        print(f"[FY{self.year}] Ingested {n:,} records.", flush=True)

    def _ingest_rec(self, rec: dict) -> None:
        level = rec.get("prexc_level", 0)
        amt = rec.get("amount", 0.0) or 0.0
        if level == 0:
            self.grand_total += amt

        rule_key = _which_aa_rule(rec)
        if rule_key:
            stats = self.aa_stats[rule_key]
            mt = stats["match_type"]
            if not (mt in ("fundcd_prefix", "object_code") and level != 7):
                stats["levels"][level] += amt
                stats["counts"][level] += 1
            self.aa_recs.append(rec)

        org_uacs = rec.get("org_uacs_code")
        if not org_uacs or len(org_uacs) < 12 or level != 7 or rule_key:
            return

        dept = org_uacs[0:2]
        agency = org_uacs[0:5]
        region = rec.get("region_code") or "_none"
        division = rec.get("division_code") or "_none"
        div_name = rec.get("division_name") or ""
        prexc = str(rec.get("prexc_fpap_id") or "").zfill(15)
        desc = rec.get("description") or ""
        shard = f"{agency}/{region}.json.gz"

        self.dept_agencies[dept].add(agency)
        self.agency_shards[agency].add(shard)
        self.shard_recs[shard].append(rec)

        self.place.rollup(
            self._place_leaf(dept, agency, region, division, div_name, org_uacs, prexc, desc, shard),
            amt,
        )
        self.nep.rollup(
            self._nep_leaf(dept, agency, region, division, div_name, org_uacs, prexc, desc, shard),
            amt,
        )

    def _aa_amount(self, key: str) -> float:
        stats = self.aa_stats[key]
        levels = stats["levels"]
        if stats["match_type"] == "fundcd":
            return levels.get(_pick_level(levels), 0.0)
        return sum(levels.values())

    def _aa_count(self, key: str) -> int:
        stats = self.aa_stats[key]
        counts = stats["counts"]
        if stats["match_type"] == "fundcd":
            return counts.get(_pick_level(stats["levels"]), 0)
        return sum(counts.values())

    def write(self) -> None:
        if self.out_dir.exists():
            # Clear previous shards to avoid stale files.
            import shutil
            shutil.rmtree(self.out_dir)
        self.shards_dir.mkdir(parents=True, exist_ok=True)

        aa_total = sum(self._aa_amount(k) for k in self.aa_stats)
        meta = {
            "fiscal_year": self.year,
            "grand_total_thousands": self.grand_total,
            "aa_total_thousands": aa_total,
            "programmed_total_thousands": self.grand_total - aa_total,
            "aa_items": {
                key: {
                    "match_type": stats["match_type"],
                    "category": stats["category"],
                    "name": stats["name"],
                    "amount_thousands": self._aa_amount(key),
                    "item_count": self._aa_count(key),
                    "levels": {str(k): v for k, v in stats["levels"].items()},
                    "counts": {str(k): v for k, v in stats["counts"].items()},
                }
                for key, stats in self.aa_stats.items()
            },
            "place_nodes": len(self.place.all_nodes),
            "nep_nodes": len(self.nep.all_nodes),
            "shard_count": len(self.shard_recs),
        }
        write_json(self.out_dir / "meta.json.gz", meta)
        write_json(self.out_dir / "place_tree.json.gz", _serialize_tree(self.place))
        write_json(self.out_dir / "nep_tree.json.gz", _serialize_tree(self.nep))
        write_json(self.out_dir / "aa.json.gz", self.aa_recs)

        all_shards = sorted(self.shard_recs.keys())
        for rel, rows in self.shard_recs.items():
            write_json(self.shards_dir / rel, rows)

        manifest = {
            "all": all_shards,
            "by_agency": {
                a: sorted(paths) for a, paths in self.agency_shards.items()
            },
            "dept_agencies": {
                d: sorted(ags) for d, ags in self.dept_agencies.items()
            },
        }
        write_json(self.out_dir / "manifest.json.gz", manifest)

        # Rough size report
        total = sum(p.stat().st_size for p in self.out_dir.rglob("*") if p.is_file())
        print(f"[FY{self.year}] Wrote browser assets -> {self.out_dir}", flush=True)
        print(f"[FY{self.year}]   place={len(self.place.all_nodes)} nodes, "
              f"nep={len(self.nep.all_nodes)} nodes, "
              f"shards={len(all_shards)}, aa_rows={len(self.aa_recs):,}", flush=True)
        print(f"[FY{self.year}]   total size {total / 1e6:.1f} MB", flush=True)


def _load_refs(data_root: Path) -> dict:
    org = data_root / "organization"
    return {
        "departments": _load_ref_map(org / "departments.json", "code"),
        "agencies": _load_ref_map(org / "agencies.json", "uacs_code"),
        "organizations": _load_ref_map(org / "organizations.json", "uacs_code"),
        "operating_units": _load_ref_map(org / "operating_units.json", "uacs_code"),
        "divisions": _load_ref_map(org / "divisions.json", "code"),
        "regions": _load_ref_map(data_root / "location" / "regions.json", "code"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data", type=Path,
        default=Path(__file__).resolve().parent.parent.parent / "data",
    )
    parser.add_argument("--year", action="append", dest="years",
                        help="Fiscal year(s); default: all under data/budget/")
    args = parser.parse_args()

    budget_root = args.data / "budget"
    if args.years:
        years = args.years
    else:
        years = sorted(
            d.name for d in budget_root.iterdir()
            if d.is_dir() and d.name.isdigit()
            and find_batch_files(d / "items", d.name)
        )
    if not years:
        raise SystemExit(f"No years with batch files under {budget_root}")

    refs = _load_refs(args.data)
    for year in years:
        b = AssetBuilder(args.data, year, refs)
        b.ingest()
        b.write()


if __name__ == "__main__":
    main()
