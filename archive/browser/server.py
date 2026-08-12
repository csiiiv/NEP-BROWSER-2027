"""
NEP Budget Browser -- FastAPI backend.

Serves a hierarchical tree view over the converted JSON data for one or more
fiscal years. Currently hosts FY2026 and FY2027 side-by-side.

Tree structure (toggleable views under Programmed Appropriations):

  Place (default): Dept → Agency → Region → Division → OU → Program → items
  NEP (PDF-like):  Dept → Agency → Program → Region → Division → OU → items

Prefers pre-built assets under data/budget/{year}/browser/ (trees + item shards)
produced by scripts/nep-gaa/build_browser_assets.py. Falls back to scanning
batch files if assets are missing.

Year via ?year=; view via ?view=place|nep.
"""

from __future__ import annotations

import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse

# Force UTF-8 on Windows console.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
# Repo root is two levels up from archive/browser/
DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

if not DATA_DIR.exists():
    raise SystemExit(
        f"Data directory not found: {DATA_DIR}\n"
        f"Run scripts/nep-gaa/converter_fy20XX.py first."
    )


def _read_json(path: Path) -> Any:
    if path.name.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _find_batches(items_dir: Path, fiscal_year: str) -> List[Path]:
    gz = sorted(items_dir.glob(f"nep_{fiscal_year}_batch_*.json.gz"))
    if gz:
        return gz
    return sorted(items_dir.glob(f"nep_{fiscal_year}_batch_*.json"))


# ---------------------------------------------------------------------------
# Reference lookups (year-independent; loaded once)
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else [data]


DEPARTMENTS = {d["code"]: d for d in _load_json(DATA_DIR / "organization" / "departments.json")}
AGENCIES = {a["uacs_code"]: a for a in _load_json(DATA_DIR / "organization" / "agencies.json")}
OPERATING_UNITS = {o["uacs_code"]: o for o in _load_json(DATA_DIR / "organization" / "operating_units.json")}
ORGANIZATIONS = {o["uacs_code"]: o for o in _load_json(DATA_DIR / "organization" / "organizations.json")}
DIVISIONS = {d["code"]: d for d in _load_json(DATA_DIR / "organization" / "divisions.json")}
FUNDING_SOURCES = {f["uacs_code"]: f for f in _load_json(DATA_DIR / "funding_source" / "funding_sources.json")}
SUB_OBJECTS = {s["uacs_code"]: s for s in _load_json(DATA_DIR / "object_code" / "sub_objects.json")}
REGIONS = {r["code"]: r for r in _load_json(DATA_DIR / "location" / "regions.json")}


# ---------------------------------------------------------------------------
# Automatic appropriations detection
# (mirrors scripts/nep-gaa/automatic_appropriations.py; duplicated here so the
# browser doesn't need to import from the scripts/ tree)
# ---------------------------------------------------------------------------

# Each rule: (match_type, match_key, category, name)
# match_type âˆˆ {"fundcd", "fundcd_prefix", "object_code"}
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
    """Return the AA_RULES match_key for this record, or None. First match wins."""
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
    """Pick the single PREXC level to use for a lump-sum AA item."""
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


def _is_automatic(rec: dict) -> bool:
    """True if a record matches any automatic-appropriations rule."""
    return _which_aa_rule(rec) is not None


def _aa_item_levels(match_type: str) -> tuple:
    """PREXC levels to include when listing items for an AA rule."""
    if match_type == "fundcd":
        return (3, 7)
    return (7,)


def _aa_rule_for_key(key: str) -> Optional[tuple]:
    for rule in AA_RULES:
        if rule[1] == key:
            return rule
    return None


def _region_label(region_code: str) -> str:
    if region_code == "_none":
        return "No region specified"
    return REGIONS.get(region_code, {}).get("description", f"Region {region_code}")


def _division_label(division_code: str, division_name: str = "") -> str:
    if division_code == "_none":
        return "No division / direct units"
    return (
        division_name
        or DIVISIONS.get(division_code, {}).get("description")
        or f"Division {division_code}"
    )


def _ou_label(ou_uacs: str) -> str:
    return (
        OPERATING_UNITS.get(ou_uacs, {}).get("description")
        or ORGANIZATIONS.get(ou_uacs, {}).get("description")
        or f"OU {ou_uacs}"
    )


# ---------------------------------------------------------------------------
# Tree node / index
# ---------------------------------------------------------------------------

class Node:
    """A node in the drilldown tree."""

    __slots__ = ("kind", "code", "label", "parent_key",
                 "children", "item_count", "total_amount", "_key", "shard")

    def __init__(self, kind: str, code: str, label: str, parent_key: str,
                 key: Optional[str] = None, shard: Optional[str] = None):
        self.kind = kind
        self.code = code
        self.label = label
        self.parent_key = parent_key
        self.children: Dict[str, "Node"] = {}
        self.item_count = 0
        self.total_amount = 0.0
        # Programs are stored as program:{parent}:{prexc}; override so children
        # parent_key and rollup lookups hit the same all_nodes entry.
        self._key = key
        self.shard = shard

    def key(self) -> str:
        return self._key if self._key is not None else f"{self.kind}:{self.code}"


class TreeIndex:
    """One hierarchy index (place or nep)."""

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


# ---------------------------------------------------------------------------
# Per-year state container
# ---------------------------------------------------------------------------

class YearStore:
    """Everything the browser needs for one fiscal year, built at startup."""

    def __init__(self, fiscal_year: str, items_dir: Path):
        self.fiscal_year = fiscal_year
        self.items_dir = items_dir
        self.budget_dir = items_dir.parent
        self.browser_dir = self.budget_dir / "browser"
        self.batch_files = _find_batches(items_dir, fiscal_year)
        self.asset_mode = False
        self.shard_manifest: Dict[str, Any] = {}
        self._shard_cache: Dict[str, List[dict]] = {}

        self.views: Dict[str, TreeIndex] = {
            "place": TreeIndex("place"),
            "nep": TreeIndex("nep"),
        }

        # Per-AA-rule stats (keyed by match_key).
        self.aa_item_stats: Dict[str, dict] = {}
        for match_type, key, category, name in AA_RULES:
            self.aa_item_stats[key] = {
                "match_type": match_type,
                "category": category,
                "name": name,
                "levels": defaultdict(float),
                "counts": defaultdict(int),
            }

        self.grand_total_thousands = 0.0

    @property
    def tree(self) -> Dict[str, Node]:
        """Default (place) department roots — used by summary counts."""
        return self.views["place"].tree

    @property
    def all_nodes(self) -> Dict[str, Node]:
        return self.views["place"].all_nodes

    def get_view(self, view: str) -> TreeIndex:
        if view not in self.views:
            raise HTTPException(400, f"Unknown view '{view}'. Use place or nep.")
        return self.views[view]

    def load(self) -> None:
        """Prefer pre-built browser assets; else scan batches."""
        meta = self.browser_dir / "meta.json.gz"
        place = self.browser_dir / "place_tree.json.gz"
        nep = self.browser_dir / "nep_tree.json.gz"
        manifest = self.browser_dir / "manifest.json.gz"
        if meta.exists() and place.exists() and nep.exists() and manifest.exists():
            self._load_assets(meta, place, nep, manifest)
            return
        self.build_index()

    def _load_assets(self, meta_path: Path, place_path: Path,
                     nep_path: Path, manifest_path: Path) -> None:
        print(f"[FY{self.fiscal_year}] Loading pre-built browser assets...", flush=True)
        meta = _read_json(meta_path)
        self.grand_total_thousands = meta.get("grand_total_thousands", 0.0)
        for key, info in (meta.get("aa_items") or {}).items():
            if key not in self.aa_item_stats:
                continue
            stats = self.aa_item_stats[key]
            for lv, amt in (info.get("levels") or {}).items():
                stats["levels"][int(lv)] = amt
            for lv, cnt in (info.get("counts") or {}).items():
                stats["counts"][int(lv)] = cnt

        self.views["place"] = self._deserialize_tree(_read_json(place_path))
        self.views["nep"] = self._deserialize_tree(_read_json(nep_path))
        self.shard_manifest = _read_json(manifest_path)
        self.asset_mode = True
        print(f"[FY{self.fiscal_year}] Assets ready: "
              f"place={len(self.views['place'].all_nodes)} nodes, "
              f"nep={len(self.views['nep'].all_nodes)} nodes, "
              f"shards={len(self.shard_manifest.get('all', []))}", flush=True)

    def _deserialize_tree(self, data: dict) -> TreeIndex:
        idx = TreeIndex(data.get("view", "place"))
        raw_nodes = data.get("nodes") or {}
        for key, n in raw_nodes.items():
            node = Node(
                n["kind"], n["code"], n["label"], n.get("parent_key") or "",
                key=key if n["kind"] == "program" else None,
                shard=n.get("shard"),
            )
            # Non-program keys must match kind:code; program uses full key.
            if n["kind"] != "program":
                pass
            idx.all_nodes[key] = node
            node.item_count = n.get("item_count", 0)
            node.total_amount = n.get("total_amount", 0.0)

        for key, n in raw_nodes.items():
            parent = idx.all_nodes[key]
            for map_key, child_key in zip(n.get("children") or [], n.get("child_keys") or []):
                child = idx.all_nodes.get(child_key)
                if child is not None:
                    parent.children[map_key] = child

        for dept_code in data.get("roots") or []:
            node = idx.all_nodes.get(f"dept:{dept_code}")
            if node is not None:
                idx.tree[dept_code] = node
        return idx

    def _load_shard(self, rel: str) -> List[dict]:
        if rel in self._shard_cache:
            return self._shard_cache[rel]
        if rel == "aa.json.gz" or rel == "aa":
            path = self.browser_dir / "aa.json.gz"
        else:
            path = self.browser_dir / "shards" / rel
        if not path.exists():
            self._shard_cache[rel] = []
            return []
        rows = _read_json(path)
        self._shard_cache[rel] = rows if isinstance(rows, list) else []
        return self._shard_cache[rel]

    def shard_paths_for_node(self, view: str, kind: str, code: str,
                             parent_code: Optional[str]) -> List[str]:
        """Return relative shard paths to scan for this node."""
        if not self.asset_mode:
            return []
        man = self.shard_manifest
        if kind == "section" and code == "automatic":
            return ["aa.json.gz"]
        if kind == "aa_item":
            return ["aa.json.gz"]
        if kind == "root" or (kind == "section" and code == "programmed"):
            return list(man.get("all") or [])

        if kind == "dept":
            paths: List[str] = []
            for agency in man.get("dept_agencies", {}).get(code, []):
                paths.extend(man.get("by_agency", {}).get(agency, []))
            return paths
        if kind == "agency":
            return list(man.get("by_agency", {}).get(code, []))

        # Prefer shard stamped on the node (region and below).
        node = self.find_node(view, kind, code, parent_code)
        if node is not None and node.shard:
            return [node.shard]

        if view == "place":
            if kind == "region":
                parts = code.split("|", 1)
                if len(parts) == 2:
                    return [f"{parts[0]}/{parts[1]}.json.gz"]
            if kind in ("division", "ou", "program"):
                # Walk parents for shard
                if node is not None:
                    cur = node
                    while cur is not None:
                        if cur.shard:
                            return [cur.shard]
                        cur = self.views[view].all_nodes.get(cur.parent_key)
        if view == "nep":
            if kind == "program" and parent_code:
                return list(man.get("by_agency", {}).get(parent_code, []))
            if kind in ("region", "division", "ou") and node is not None:
                cur = node
                while cur is not None:
                    if cur.shard:
                        return [cur.shard]
                    cur = self.views[view].all_nodes.get(cur.parent_key)
        return list(man.get("all") or [])

    def iter_records_for_node(self, view: str, kind: str, code: str,
                              parent_code: Optional[str]) -> Iterable[dict]:
        if self.asset_mode:
            seen = set()
            for rel in self.shard_paths_for_node(view, kind, code, parent_code):
                if rel in seen:
                    continue
                seen.add(rel)
                for rec in self._load_shard(rel):
                    yield rec
            return
        yield from self.iter_records()

    def iter_records(self) -> Iterable[dict]:
        """Stream every record across all batches."""
        for batch in self.batch_files:
            for rec in _read_json(batch):
                yield rec

    def build_index(self) -> None:
        """Walk data once: build Place + NEP trees and AA totals."""
        print(f"[FY{self.fiscal_year}] Building index from "
              f"{len(self.batch_files)} batch files...", flush=True)

        count = 0
        for rec in self.iter_records():
            count += 1
            if count % 100_000 == 0:
                print(f"[FY{self.fiscal_year}]   indexed {count:,} records...", flush=True)

            level = rec.get("prexc_level", 0)
            amt = rec.get("amount", 0.0) or 0.0

            if level == 0:
                self.grand_total_thousands += amt

            rule_key = _which_aa_rule(rec)
            if rule_key:
                stats = self.aa_item_stats[rule_key]
                mt = stats["match_type"]
                if mt in ("fundcd_prefix", "object_code") and level != 7:
                    pass
                else:
                    stats["levels"][level] += amt
                    stats["counts"][level] += 1

            org_uacs = rec.get("org_uacs_code")
            if not org_uacs or len(org_uacs) < 12 or level != 7 or rule_key:
                continue

            dept_code = org_uacs[0:2]
            agency_uacs = org_uacs[0:5]
            region_code = rec.get("region_code") or "_none"
            division_code = rec.get("division_code") or "_none"
            division_name = rec.get("division_name") or ""
            prexc = str(rec.get("prexc_fpap_id") or "").zfill(15)
            program_desc = rec.get("description") or ""

            place_leaf = self._place_leaf(
                dept_code, agency_uacs, region_code, division_code, division_name,
                org_uacs, prexc, program_desc,
            )
            self.views["place"].rollup(place_leaf, amt)

            nep_leaf = self._nep_leaf(
                dept_code, agency_uacs, region_code, division_code, division_name,
                org_uacs, prexc, program_desc,
            )
            self.views["nep"].rollup(nep_leaf, amt)

        aa_total = self.aa_total_thousands()
        print(f"[FY{self.fiscal_year}] Index built: "
              f"place={len(self.views['place'].all_nodes)} nodes, "
              f"nep={len(self.views['nep'].all_nodes)} nodes, "
              f"{len(self.tree)} departments.", flush=True)
        print(f"[FY{self.fiscal_year}] Grand total: PHP {self.grand_total_thousands*1000:,.0f}, "
              f"AA: PHP {aa_total*1000:,.0f}, "
              f"Programmed: PHP {(self.grand_total_thousands - aa_total)*1000:,.0f}",
              flush=True)

    def aa_total_thousands(self) -> float:
        return sum(self.aa_item_amount(k) for k in self.aa_item_stats)

    def programmed_total_thousands(self) -> float:
        return self.grand_total_thousands - self.aa_total_thousands()

    def aa_item_amount(self, key: str) -> float:
        stats = self.aa_item_stats[key]
        levels = stats["levels"]
        if stats["match_type"] == "fundcd":
            lv = _pick_level(levels)
            return levels.get(lv, 0.0)
        return sum(levels.values())

    def aa_item_count(self, key: str) -> int:
        stats = self.aa_item_stats[key]
        counts = stats["counts"]
        if stats["match_type"] == "fundcd":
            lv = _pick_level(stats["levels"])
            return counts.get(lv, 0)
        return sum(counts.values())

    def _record_in_aa_item(self, rec: dict, aa_key: Optional[str]) -> bool:
        rule_key = _which_aa_rule(rec)
        if rule_key is None:
            return False
        if aa_key is not None and rule_key != aa_key:
            return False
        level = rec.get("prexc_level", 0)
        rule = _aa_rule_for_key(rule_key)
        if rule is None:
            return False
        return level in _aa_item_levels(rule[0])

    def _record_matches_node(self, view: str, rec: dict, kind: str, code: str,
                             parent_code: Optional[str]) -> bool:
        if kind == "section" and code == "automatic":
            return _is_automatic(rec) and self._record_in_aa_item(rec, None)
        if kind == "aa_item":
            return self._record_in_aa_item(rec, code)
        if kind == "section" and code == "programmed":
            return rec.get("prexc_level") == 7 and not _is_automatic(rec)
        if kind == "root":
            return rec.get("prexc_level") == 0

        level = rec.get("prexc_level", 0)
        if level != 7 or _is_automatic(rec):
            return False
        org_uacs = rec.get("org_uacs_code") or ""
        prexc = str(rec.get("prexc_fpap_id") or "").zfill(15)
        region = rec.get("region_code") or "_none"
        division = rec.get("division_code") or "_none"

        if kind == "dept":
            return org_uacs.startswith(code)
        if kind == "agency":
            return org_uacs.startswith(code)

        if view == "nep":
            if kind == "program":
                if parent_code and not org_uacs.startswith(parent_code):
                    return False
                return prexc == code
            if kind == "region":
                # agency|prexc|region
                parts = code.split("|", 2)
                if len(parts) != 3:
                    return False
                agency, px, reg = parts
                return org_uacs.startswith(agency) and prexc == px and region == reg
            if kind == "division":
                # agency|prexc|region|division
                parts = code.split("|", 3)
                if len(parts) != 4:
                    return False
                agency, px, reg, div = parts
                return (org_uacs.startswith(agency) and prexc == px
                        and region == reg and division == div)
            if kind == "ou":
                # agency|prexc|region|division|org
                parts = code.split("|", 4)
                if len(parts) != 5:
                    return False
                agency, px, reg, div, org = parts
                return (org_uacs == org and prexc == px
                        and region == reg and division == div
                        and org_uacs.startswith(agency))
            return False

        # Place view
        if kind == "region":
            parts = code.split("|", 1)
            if len(parts) != 2:
                return False
            agency, reg = parts
            return org_uacs.startswith(agency) and region == reg
        if kind == "division":
            parts = code.split("|", 2)
            if len(parts) != 3:
                return False
            agency, reg, div = parts
            return (org_uacs.startswith(agency)
                    and region == reg and division == div)
        if kind == "ou":
            return org_uacs == code
        if kind == "program":
            if parent_code and org_uacs != parent_code:
                return False
            return prexc == code
        return False

    # ---- Place: dept â†’ agency â†’ region â†’ division â†’ ou â†’ program --------

    def _place_leaf(self, dept, agency, region, division, div_name, ou, prexc, desc) -> Node:
        idx = self.views["place"]
        parent = self._ensure_division(idx, dept, agency, region, division, div_name)
        ou_node = self._ensure_child(
            idx, parent, "ou", ou, _ou_label(ou), child_map_key=ou,
        )
        return self._ensure_program(idx, ou_node, ou, prexc, desc)

    # ---- NEP: dept â†’ agency â†’ program â†’ region â†’ division â†’ ou ----------

    def _nep_leaf(self, dept, agency, region, division, div_name, ou, prexc, desc) -> Node:
        idx = self.views["nep"]
        agency_node = self._ensure_agency(idx, dept, agency)
        prog = self._ensure_program(idx, agency_node, agency, prexc, desc)
        reg_code = f"{agency}|{prexc}|{region}"
        reg_node = self._ensure_child(
            idx, prog, "region", reg_code, _region_label(region), child_map_key=reg_code,
        )
        div_code = f"{agency}|{prexc}|{region}|{division}"
        div_node = self._ensure_child(
            idx, reg_node, "division", div_code, _division_label(division, div_name),
            child_map_key=div_code,
        )
        ou_code = f"{agency}|{prexc}|{region}|{division}|{ou}"
        return self._ensure_child(
            idx, div_node, "ou", ou_code, _ou_label(ou), child_map_key=ou_code,
        )

    # ---- shared builders ------------------------------------------------

    def _ensure_dept(self, idx: TreeIndex, dept_code: str) -> Node:
        if dept_code in idx.tree:
            return idx.tree[dept_code]
        desc = DEPARTMENTS.get(dept_code, {}).get("description", f"Dept {dept_code}")
        node = Node("dept", dept_code, desc, "")
        idx.tree[dept_code] = node
        idx.all_nodes[node.key()] = node
        return node

    def _ensure_agency(self, idx: TreeIndex, dept_code: str, agency_uacs: str) -> Node:
        parent = self._ensure_dept(idx, dept_code)
        return self._ensure_child(
            idx, parent, "agency", agency_uacs,
            AGENCIES.get(agency_uacs, {}).get("description", f"Agency {agency_uacs}"),
            child_map_key=agency_uacs,
        )

    def _ensure_division(
        self, idx: TreeIndex, dept: str, agency: str, region: str,
        division: str, div_name: str,
    ) -> Node:
        agency_node = self._ensure_agency(idx, dept, agency)
        reg_code = f"{agency}|{region}"
        reg_node = self._ensure_child(
            idx, agency_node, "region", reg_code, _region_label(region),
            child_map_key=reg_code,
        )
        div_code = f"{agency}|{region}|{division}"
        return self._ensure_child(
            idx, reg_node, "division", div_code, _division_label(division, div_name),
            child_map_key=div_code,
        )

    def _ensure_program(
        self, idx: TreeIndex, parent: Node, parent_code: str, prexc: str, desc: str,
    ) -> Node:
        key = f"program:{parent_code}:{prexc}"
        if key in idx.all_nodes:
            node = idx.all_nodes[key]
            if desc and node.label.startswith("FPAP "):
                node.label = desc
            return node
        node = Node(
            "program", prexc, desc or f"FPAP {prexc}", parent.key(), key=key,
        )
        parent.children[prexc] = node
        idx.all_nodes[key] = node
        return node

    def _ensure_child(
        self, idx: TreeIndex, parent: Node, kind: str, code: str, label: str,
        child_map_key: str,
    ) -> Node:
        key = f"{kind}:{code}"
        if key in idx.all_nodes:
            return idx.all_nodes[key]
        node = Node(kind, code, label, parent.key())
        parent.children[child_map_key] = node
        idx.all_nodes[key] = node
        return node

    def find_node(self, view: str, kind: str, code: str,
                  parent_code: Optional[str]) -> Optional[Node]:
        if kind == "section" and code == "automatic":
            return Node("section", "automatic", "Automatic Appropriations", "root")
        if kind == "section" and code == "programmed":
            return Node("section", "programmed", "Programmed Appropriations", "root")
        if kind == "aa_item" and code in self.aa_item_stats:
            name = self.aa_item_stats[code]["name"]
            return Node("aa_item", code, name, "section:automatic")
        idx = self.get_view(view)
        if kind == "dept":
            return idx.tree.get(code)
        if kind in ("agency", "ou", "region", "division"):
            return idx.all_nodes.get(f"{kind}:{code}")
        if kind == "program":
            if not parent_code:
                return None
            return idx.all_nodes.get(f"program:{parent_code}:{code}")
        return None


# ---------------------------------------------------------------------------
# Discover available years and build all indexes
# ---------------------------------------------------------------------------

def _discover_years() -> List[str]:
    """Find all data/budget/<year>/ directories with batch files."""
    budget_root = DATA_DIR / "budget"
    if not budget_root.exists():
        return []
    years = []
    for d in sorted(budget_root.iterdir()):
        if not d.is_dir():
            continue
        if not d.name.isdigit():
            continue
        items_dir = d / "items"
        if items_dir.exists() and _find_batches(items_dir, d.name):
            years.append(d.name)
    return years


AVAILABLE_YEARS = _discover_years()
if not AVAILABLE_YEARS:
    raise SystemExit(
        f"No fiscal year data found under {DATA_DIR / 'budget'}.\n"
        f"Run scripts/nep-gaa/converter_fy20XX.py first."
    )

print(f"\nDiscovered fiscal years: {AVAILABLE_YEARS}\n", flush=True)

STORES: Dict[str, YearStore] = {}
for y in AVAILABLE_YEARS:
    store = YearStore(y, DATA_DIR / "budget" / y / "items")
    store.load()
    STORES[y] = store


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

app = FastAPI(title="NEP Budget Browser", version="3.0")

VALID_VIEWS = ("place", "nep")


def _get_store(year: str) -> YearStore:
    if year not in STORES:
        raise HTTPException(
            404,
            f"Year {year} not available. Known years: {sorted(STORES.keys())}",
        )
    return STORES[year]


def _parse_view(view: str) -> str:
    if view not in VALID_VIEWS:
        raise HTTPException(400, f"view must be one of {VALID_VIEWS}")
    return view


def _node_to_summary(node: Node, store: Optional[YearStore] = None,
                     view: str = "place") -> dict:
    total = node.total_amount
    item_count = node.item_count
    child_count = len(node.children)

    if store and node.kind == "section" and node.code == "automatic":
        total = store.aa_total_thousands()
        item_count = sum(store.aa_item_count(k) for k in store.aa_item_stats)
        child_count = len(AA_RULES)
    elif store and node.kind == "section" and node.code == "programmed":
        idx = store.get_view(view)
        total = store.programmed_total_thousands()
        item_count = sum(d.item_count for d in idx.tree.values())
        child_count = len(idx.tree)
    elif store and node.kind == "aa_item":
        total = store.aa_item_amount(node.code)
        item_count = store.aa_item_count(node.code)
        child_count = 0

    out = {
        "kind": node.kind,
        "code": node.code,
        "label": node.label,
        "item_count": item_count,
        "total_amount": total,
        "amount_display_trillions": total * 1000 / 1e12,
        "child_count": child_count,
    }
    # Programs are keyed by parent (OU in Place, agency in NEP).
    if node.kind == "program" and node.parent_key and ":" in node.parent_key:
        out["parent"] = node.parent_key.split(":", 1)[1]
    return out


def _aa_item_summary(store: YearStore, key: str) -> dict:
    stats = store.aa_item_stats[key]
    amt = store.aa_item_amount(key)
    return {
        "kind": "aa_item",
        "code": key,
        "label": stats["name"],
        "category": stats["category"],
        "match_type": stats["match_type"],
        "item_count": store.aa_item_count(key),
        "total_amount": amt,
        "amount_display_trillions": amt * 1000 / 1e12,
        "child_count": 0,
    }


@app.get("/api/years")
def get_years() -> dict:
    """List available fiscal years."""
    return {"years": sorted(STORES.keys(), reverse=True), "views": list(VALID_VIEWS)}


@app.get("/api/summary")
def get_summary(year: str = Query(...)) -> dict:
    """Top-level totals for a year: grand total, AA, programmed."""
    store = _get_store(year)
    aa_total = store.aa_total_thousands()
    grand = store.grand_total_thousands
    programmed = store.programmed_total_thousands()
    return {
        "fiscal_year": year,
        "grand_total_pesos": grand * 1000,
        "aa_total_pesos": aa_total * 1000,
        "programmed_total_pesos": programmed * 1000,
        "aa_share_pct": (aa_total / grand * 100) if grand else 0,
        "aa_breakdown": [
            {
                "category": store.aa_item_stats[key]["category"],
                "name": store.aa_item_stats[key]["name"],
                "match_type": store.aa_item_stats[key]["match_type"],
                "match_key": key,
                "amount_pesos": store.aa_item_amount(key) * 1000,
                "row_count": store.aa_item_count(key),
            }
            for _, key, _, _ in AA_RULES
        ],
        "departments": len(store.tree),
        "total_nodes": len(store.all_nodes),
        "views": list(VALID_VIEWS),
    }


@app.get("/api/tree")
def get_root_tree(
    year: str = Query(...),
    view: str = Query("place"),
) -> dict:
    """Return Total Appropriations with Automatic and Programmed branches."""
    view = _parse_view(view)
    store = _get_store(year)
    idx = store.get_view(view)
    aa_total = store.aa_total_thousands()
    programmed = store.programmed_total_thousands()
    aa_items = sum(store.aa_item_count(k) for k in store.aa_item_stats)
    prog_items = sum(d.item_count for d in idx.tree.values())
    return {
        "kind": "root",
        "code": "total",
        "label": f"Total Appropriations (FY {year})",
        "view": view,
        "children": [
            {
                "kind": "section",
                "code": "automatic",
                "label": "Automatic Appropriations",
                "item_count": aa_items,
                "total_amount": aa_total,
                "amount_display_trillions": aa_total * 1000 / 1e12,
                "child_count": len(AA_RULES),
            },
            {
                "kind": "section",
                "code": "programmed",
                "label": "Programmed Appropriations",
                "item_count": prog_items,
                "total_amount": programmed,
                "amount_display_trillions": programmed * 1000 / 1e12,
                "child_count": len(idx.tree),
            },
        ],
        "item_count": aa_items + prog_items,
        "total_amount": store.grand_total_thousands,
        "amount_display_trillions": store.grand_total_thousands * 1000 / 1e12,
    }


@app.get("/api/tree/{kind}/{code}")
def get_node(kind: str, code: str,
             parent_code: Optional[str] = Query(None, alias="parent"),
             year: str = Query(...),
             view: str = Query("place")) -> dict:
    """Get a specific node's full info + children."""
    view = _parse_view(view)
    store = _get_store(year)
    idx = store.get_view(view)

    if kind == "section" and code == "automatic":
        children = sorted(
            [_aa_item_summary(store, key) for _, key, _, _ in AA_RULES],
            key=lambda c: c["total_amount"],
            reverse=True,
        )
        node = store.find_node(view, kind, code, parent_code)
        return {**_node_to_summary(node, store, view), "children": children, "view": view}

    if kind == "section" and code == "programmed":
        depts = sorted(idx.tree.values(), key=lambda n: n.total_amount, reverse=True)
        node = store.find_node(view, kind, code, parent_code)
        return {
            **_node_to_summary(node, store, view),
            "children": [_node_to_summary(d, store, view) for d in depts],
            "view": view,
        }

    node = store.find_node(view, kind, code, parent_code)
    if node is None:
        raise HTTPException(404, f"Node not found: {kind}/{code}")
    children = sorted(node.children.values(),
                      key=lambda n: n.total_amount, reverse=True)
    return {
        **_node_to_summary(node, store, view),
        "children": [_node_to_summary(c, store, view) for c in children],
        "view": view,
    }


@app.get("/api/tree/{kind}/{code}/items")
def get_items(kind: str, code: str,
              parent_code: Optional[str] = Query(None, alias="parent"),
              year: str = Query(...),
              view: str = Query("place"),
              amount_filter: str = Query("all", pattern="^(all|nonzero|zero)$"),
              appropriation: str = Query("all", pattern="^(all|aa|programmed)$"),
              search: Optional[str] = None,
              limit: int = Query(100, ge=1, le=1000),
              offset: int = Query(0, ge=0)) -> dict:
    """Return leaf-level line items under a node."""
    view = _parse_view(view)
    store = _get_store(year)

    if kind == "root":
        pass
    elif kind in ("section", "aa_item"):
        if store.find_node(view, kind, code, parent_code) is None:
            raise HTTPException(404, f"Node not found: {kind}/{code}")
    else:
        node = store.find_node(view, kind, code, parent_code)
        if node is None:
            raise HTTPException(404, f"Node not found: {kind}/{code}")

    search_lower = search.strip().lower() if search else None
    matched: List[dict] = []
    total_matched = 0

    for rec in store.iter_records_for_node(view, kind, code, parent_code):
        if not store._record_matches_node(view, rec, kind, code, parent_code):
            continue

        amt = rec.get("amount", 0.0) or 0.0
        if amount_filter == "nonzero" and amt == 0:
            continue
        if amount_filter == "zero" and amt != 0:
            continue

        is_aa = _is_automatic(rec)
        if appropriation == "aa" and not is_aa:
            continue
        if appropriation == "programmed" and is_aa:
            continue

        if search_lower and search_lower not in (rec.get("description") or "").lower():
            continue

        total_matched += 1
        if len(matched) < limit and total_matched > offset:
            enriched = _enrich_item(rec, view=view)
            rule_key = _which_aa_rule(rec)
            enriched["is_automatic"] = rule_key is not None
            enriched["aa_category"] = (
                store.aa_item_stats[rule_key]["category"] if rule_key else None
            )
            matched.append(enriched)

    return {
        "total_matched": total_matched,
        "returned": len(matched),
        "offset": offset,
        "limit": limit,
        "view": view,
        "items": matched,
    }


def _enrich_item(rec: dict, view: str = "place") -> dict:
    """Add human-readable enrichment + breadcrumb for the active view."""
    region_code = rec.get("region_code")
    funding = rec.get("funding_uacs_code")
    obj = rec.get("object_uacs_code")
    org_uacs = rec.get("org_uacs_code")
    division_code = rec.get("division_code")
    division_name = rec.get("division_name") or (
        DIVISIONS.get(division_code, {}).get("description", "") if division_code else ""
    )
    dept_code = org_uacs[0:2] if org_uacs and len(org_uacs) >= 2 else ""
    agency_uacs = org_uacs[0:5] if org_uacs and len(org_uacs) >= 5 else ""
    breadcrumb = []
    if not _is_automatic(rec) and rec.get("prexc_level") == 7 and org_uacs:
        dept_l = DEPARTMENTS.get(dept_code, {}).get("description", dept_code)
        agency_l = AGENCIES.get(agency_uacs, {}).get("description", agency_uacs)
        region_l = _region_label(region_code or "_none")
        div_l = _division_label(division_code or "_none", division_name)
        ou_l = _ou_label(org_uacs)
        prog_l = rec.get("description") or ""
        if view == "nep":
            breadcrumb = [
                "Programmed Appropriations", dept_l, agency_l, prog_l,
                region_l, div_l, ou_l,
            ]
        else:
            breadcrumb = [
                "Programmed Appropriations", dept_l, agency_l, region_l,
                div_l, ou_l, prog_l,
            ]
    return {
        "id": rec.get("id"),
        "description": rec.get("description"),
        "amount": rec.get("amount", 0.0),
        "amount_display_pesos": (rec.get("amount", 0.0) or 0.0) * 1000,
        "prexc_fpap_id": rec.get("prexc_fpap_id"),
        "prexc_level": rec.get("prexc_level"),
        "sorder": rec.get("sorder"),
        "region_code": region_code,
        "region_name": REGIONS.get(region_code, {}).get("description", "") if region_code else "",
        "division_code": division_code,
        "division_name": division_name,
        "funding_uacs_code": funding,
        "funding_name": FUNDING_SOURCES.get(funding, {}).get("description", "") if funding else "",
        "object_uacs_code": obj,
        "object_name": SUB_OBJECTS.get(obj, {}).get("description", "") if obj else "",
        "org_uacs_code": org_uacs,
        "org_name": ORGANIZATIONS.get(org_uacs, {}).get("description", "") if org_uacs else "",
        "breadcrumb": breadcrumb,
        "view": view,
    }


# ---------------------------------------------------------------------------
# Static UI
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html_path = HERE / "index.html"
    if not html_path.exists():
        return HTMLResponse("<h1>index.html not found</h1>", status_code=404)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    import uvicorn
    print("\n" + "=" * 60)
    print("NEP Budget Browser")
    print("=" * 60)
    print(f"Years available: {sorted(STORES.keys())}")
    print(f"Views: {list(VALID_VIEWS)}")
    print(f"Open http://localhost:8000 in your browser")
    print("=" * 60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")

