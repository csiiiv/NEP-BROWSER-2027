"""
Automatic Appropriations analyzer for the Philippine NEP.

Identifies and quantifies automatic appropriations in NEP-FY2026 / NEP-FY2027
data, using a hand-curated list of the canonical items defined in the
Constitution (Art. VI, Sec. 25) and quantified each year in the BESF
(Budget of Expenditures and Sources of Financing).

WHY A HARDCODED LIST (NOT A FUNDCD PREFIX)
------------------------------------------
Earlier analysis suggested tagging anything with FUNDCD prefix "1040" as
automatic. That is WRONG: of the ~58 distinct "104xxxxx" codes in NEP-FY2026,
only 5 are genuine automatic appropriations. The other ~53 are regular
programmed agency operations (immigration, quarantine, AFP modernization,
wildlife management, etc.) that happen to be funded through a special-account
mechanism. Treating all of them as automatic would inflate the AA total by
~₱100B and mislabel dozens of agency programs.

The UACS Authorization field (FUNDCD positions 3-4) is also unreliable: only
4 rows in the entire FY2026 NEP carry AUTH code "04", and all are zero-amount
placeholders. The DBM NEP export simply does not use the AUTH=04 convention
that the UACS reference tables define.

So the most accurate approach is a curated FUNDCD list, cross-checked against
description keywords as a safety net for codes we may have missed.

DOUBLE-COUNTING
---------------
Each automatic appropriation appears at exactly ONE PREXC level in the data:
  - Debt interest (10401110): a single level-7 row
  - NTA (10401258): a single level-3 row, NOT broken down further
  - BARMM block grant (10401257): a single level-3 row
  - Net lending (10401280): a single level-7 row
  - Tax Expenditure Fund (10401105): a single level-3 row

The analyzer takes the amount from whichever level the row appears at, so
there is no double-counting within an item. Cross-level totals (summing
levels 0+3+7) are NOT produced because they overlap.

USAGE
-----
    from automatic_appropriations import analyze, format_report

    result = analyze(fy="2026", data_dir=Path("data"))
    print(format_report(result))

    # Compare two years
    r26 = analyze("2026", data_dir)
    r27 = analyze("2027", data_dir)
    print(format_yoy(r26, r27))

CLI:
    python automatic_appropriations.py              # both years, console report
    python automatic_appropriations.py --year 2026  # one year
    python automatic_appropriations.py --json        # machine-readable output
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

# Force UTF-8 stdout/stderr on Windows (cp1252 chokes on the peso sign).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


# ---------------------------------------------------------------------------
# The canonical list
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AutomaticItem:
    """One canonical automatic appropriation, identified by a matching rule.

    An item is matched by ONE of:
      - Exact FUNDCD (e.g. debt service, NTA, BARMM)
      - FUNDCD prefix (e.g. SAGF = all "10403xxxx" codes)
      - Exact object code (e.g. RLIP = "5010301000", scattered across agencies)

    The detector ensures no row is double-counted: a record matching multiple
    rules is attributed to the first matching rule only. The order of
    AUTOMATIC_ITEMS therefore matters - put more specific items first.
    """
    category: str        # short bucket label
    name: str            # human-readable name
    legal_basis: str     # Constitution / statute reference
    fundcd: str = ""             # exact 8-digit FUNDCD match (optional)
    fundcd_prefix: str = ""      # prefix match on FUNDCD (optional)
    object_code: str = ""        # exact 10-digit UACS object code match (optional)


# Hand-curated from the NEP-FY2027 PDF table of Automatic Appropriations
# (cross-checked against the BESF). Each item's amount was verified against
# the published PDF totals to within 0.1%:
#
#   2026 PDF total: PHP 2,390.35B   |   2027 PDF total: PHP 2,706.10B
#
# Rules are evaluated in order; first match wins (prevents double-counting).
AUTOMATIC_ITEMS: List[AutomaticItem] = [
    # ---- Exact FUNDCD matches (large lump sums) ----
    AutomaticItem(
        fundcd="10401110",
        category="debt_service",
        name="Debt Service - Interest Payments",
        legal_basis="Const. Art. VI, Sec. 25(5); PD 1177; RA 8791",
    ),
    AutomaticItem(
        fundcd="10401258",
        category="lgu_share",
        name="National Tax Allotment (NTA) - LGU share",
        legal_basis="Const. Art. X, Sec. 6; RA 11256 (formerly RA 7166 IRA)",
    ),
    AutomaticItem(
        fundcd="10401257",
        category="lgu_share",
        name="BARMM Annual Block Grant",
        legal_basis="RA 11054 (BOL), Art. XII",
    ),
    AutomaticItem(
        fundcd="10401280",
        category="net_lending",
        name="Net Lending to GOCCs",
        legal_basis="Const. Art. VI, Sec. 25(5); annual GAA",
    ),
    AutomaticItem(
        fundcd="10401105",
        category="tax_expenditure",
        name="Tax Expenditure Fund",
        legal_basis="Annual GAA (special account in the General Fund)",
    ),
    # ---- FUNDCD prefix: SAGF (Special Accounts in the General Fund) ----
    # All 10403xxxx codes. SAGF aggregates ~51 small special-account programs
    # funded from fees/charges/retained income: AFP Modernization, Recovery
    # of Ill-gotten Wealth, Free Public Internet Access, NEFCA, etc. Verified
    # to sum to PHP 30.47B (2026) and PHP 35.59B (2027), matching the PDF.
    AutomaticItem(
        fundcd_prefix="10403",
        category="sagf",
        name="Special Accounts in the General Fund (SAGF)",
        legal_basis="Annual GAA (various special accounts; e.g. RA 10336, RA 7898)",
    ),
    # ---- Object code: RLIP (Retirement and Life Insurance Premiums) ----
    # RLIP is the government employer's contribution to GSIS (~12% of PS),
    # embedded across every agency's PS budget rather than as a lump sum.
    # Identified by UACS object code 5010301000. Verified to sum to
    # PHP 82.27B (2026) and PHP 89.11B (2027) - matches PDF within 0.1%.
    AutomaticItem(
        object_code="5010301000",
        category="statutory",
        name="Retirement and Life Insurance Premiums (RLIP)",
        legal_basis="PD 1146 / RA 8291 (GSIS Act); annual GAA",
    ),
]


def _matches_rule(rec: dict, item: AutomaticItem) -> bool:
    """True if a budget record matches this item's rule."""
    fc = rec.get("funding_uacs_code") or ""
    obj = rec.get("object_uacs_code") or ""
    if item.fundcd and fc == item.fundcd:
        return True
    if item.fundcd_prefix and fc.startswith(item.fundcd_prefix):
        return True
    if item.object_code and obj == item.object_code:
        return True
    return False


# Category labels for display. Order matters for the YoY report.
CATEGORY_LABELS = {
    "debt_service":    "Debt Service - Interest Payments",
    "lgu_share":       "National Tax Allotment + BARMM Block Grant",
    "net_lending":     "Net Lending",
    "tax_expenditure": "Tax Expenditure Fund",
    "sagf":            "Special Accounts in the General Fund (SAGF)",
    "statutory":       "Retirement and Life Insurance Premiums (RLIP)",
    "other":           "Other / unclassified",
}

# Description-keyword fallback for catching items we may have missed.
# If a non-known FUNDCD row has one of these keywords in its description,
# we flag it for review (but do NOT auto-classify, to avoid false positives).
POSSIBLE_AA_KEYWORDS = [
    "indebtedness",
    "interest on debt",
    "debt service",
    "national tax allotment",
    "internal revenue allotment",
    "block grant",
    "net lending",
    "GSIS",
    "SSS",
    "PhilHealth",
    "retirement",
    "pension fund",
]


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class ItemResult:
    """Result for one automatic-appropriation item."""
    category: str
    name: str
    legal_basis: str
    match_type: str               # "fundcd" | "fundcd_prefix" | "object_code"
    match_key: str                # the FUNDCD, prefix, or object code that matched
    amount_thousands: float
    amount_pesos: float
    row_count: int                # number of level-7 rows contributing to the amount
    distinct_codes: int           # for SAGF/prefix rules: how many distinct FUNDCDs matched


@dataclass
class AnalysisResult:
    """Result of analyzing one fiscal year."""
    fiscal_year: str
    items: List[ItemResult] = field(default_factory=list)
    total_amount_thousands: float = 0.0
    total_amount_pesos: float = 0.0
    by_category: Dict[str, float] = field(default_factory=dict)  # category -> pesos
    unclassified_hits: List[dict] = field(default_factory=list)  # suspicious rows for review
    grand_total_thousands: float = 0.0   # the NEP's top grand total (level 0)
    coverage_pct: float = 0.0            # AA total / grand total


# ---------------------------------------------------------------------------
# Core analyzer
# ---------------------------------------------------------------------------

def analyze(fy: str, data_dir: Path) -> AnalysisResult:
    """Analyze automatic appropriations for one fiscal year.

    The detection uses the curated AUTOMATIC_ITEMS list. Each item is matched
    by FUNDCD, FUNDCD prefix, or object code. Rules are evaluated in order;
    the FIRST match wins, so a record is never double-counted across items.

    For amount rollup: lump-sum items (debt, NTA, BARMM, net lending, TEF)
    sit at a single PREXC level (3 or 7) and we take that level's sum.
    Object-code-based items (RLIP) are scattered across many level-7 rows
    and we sum all of them. Prefix-based items (SAGF) are also scattered
    and we sum level-7 rows that match the prefix.

    We deliberately do NOT sum across PREXC levels for any item - that would
    double-count against the level-0 grand total.

    Args:
        fy: Fiscal year string, e.g. "2026" or "2027".
        data_dir: Path to the data root (containing budget/<fy>/items/).

    Returns:
        AnalysisResult with per-item amounts, category totals, and
        unclassified hits for review.
    """
    items_dir = data_dir / "budget" / fy / "items"
    if not items_dir.exists():
        raise FileNotFoundError(
            f"Items directory not found: {items_dir}\n"
            f"Run converter_fy{fy}.py first."
        )

    # Per-item accumulators, indexed by item index in AUTOMATIC_ITEMS.
    n_items = len(AUTOMATIC_ITEMS)
    item_levels: List[Dict[int, float]] = [defaultdict(float) for _ in range(n_items)]
    item_counts: List[Dict[int, int]] = [defaultdict(int) for _ in range(n_items)]
    item_distinct_fundcds: List[set] = [set() for _ in range(n_items)]

    # Keyword-based fallback for catching items we may have missed.
    unclassified_per_fc: Dict[str, Dict[int, float]] = defaultdict(lambda: defaultdict(float))
    unclassified_descs: Dict[str, str] = {}

    grand_total = 0.0

    for batch_file in sorted(items_dir.glob("*.json")):
        with open(batch_file, encoding="utf-8") as f:
            for rec in json.load(f):
                level = rec.get("prexc_level", 0)
                amt = rec.get("amount", 0.0) or 0.0

                if level == 0:
                    grand_total += amt

                # Try each rule in order; first match wins.
                matched_idx = None
                for idx, item in enumerate(AUTOMATIC_ITEMS):
                    if _matches_rule(rec, item):
                        matched_idx = idx
                        break

                if matched_idx is not None:
                    # Only count level-7 rows for object-code and prefix rules
                    # (these are scattered and would double-count with level-3
                    # parent totals). For exact-FUNDCD lump sums we keep all
                    # levels (each appears at exactly one level anyway).
                    item = AUTOMATIC_ITEMS[matched_idx]
                    if item.object_code or item.fundcd_prefix:
                        if level != 7:
                            continue
                    item_levels[matched_idx][level] += amt
                    item_counts[matched_idx][level] += 1
                    if rec.get("funding_uacs_code"):
                        item_distinct_fundcds[matched_idx].add(rec["funding_uacs_code"])
                else:
                    # Not matched by any rule. Check description for keywords
                    # to flag possibly-missed items for review.
                    dsc = (rec.get("description") or "").lower()
                    if any(kw.lower() in dsc for kw in POSSIBLE_AA_KEYWORDS):
                        fc = rec.get("funding_uacs_code") or "(none)"
                        unclassified_per_fc[fc][level] += amt
                        unclassified_descs.setdefault(fc, rec.get("description") or "")

    return _build_result(
        fy=fy,
        item_levels=item_levels,
        item_counts=item_counts,
        item_distinct_fundcds=item_distinct_fundcds,
        unclassified_per_fc=unclassified_per_fc,
        unclassified_descs=unclassified_descs,
        grand_total=grand_total,
    )


def _pick_level(levels: Dict[int, float]) -> int:
    """Pick the single level to take the amount from for a lump-sum AA item.

    Each lump-sum item appears at exactly one non-zero level in practice.
    If multiple levels have data, prefer the most granular (highest level)
    that has a non-zero amount, to avoid the level-0 grand total.
    """
    nonzero_levels = [lv for lv, amt in levels.items() if lv > 0 and amt != 0]
    if not nonzero_levels:
        nonzero_levels = [lv for lv, amt in levels.items() if amt != 0]
    if not nonzero_levels:
        return 0
    if 7 in nonzero_levels:
        return 7
    if 3 in nonzero_levels:
        return 3
    return max(nonzero_levels)


def _build_result(
    fy: str,
    item_levels: List[Dict[int, float]],
    item_counts: List[Dict[int, int]],
    item_distinct_fundcds: List[set],
    unclassified_per_fc: Dict[str, Dict[int, float]],
    unclassified_descs: Dict[str, str],
    grand_total: float,
) -> AnalysisResult:
    result = AnalysisResult(fiscal_year=fy, grand_total_thousands=grand_total)

    # Process each rule.
    for idx, item in enumerate(AUTOMATIC_ITEMS):
        levels = item_levels[idx]
        counts = item_counts[idx]
        if not levels:
            # Item not present in this fiscal year's data; record as zero.
            result.items.append(ItemResult(
                category=item.category,
                name=item.name,
                legal_basis=item.legal_basis,
                match_type=_match_type(item),
                match_key=_match_key(item),
                amount_thousands=0.0,
                amount_pesos=0.0,
                row_count=0,
                distinct_codes=0,
            ))
            continue

        # Determine the match type for display.
        match_type = _match_type(item)
        match_key = _match_key(item)

        # For lump-sum items (exact FUNDCD), pick the level where the amount lives.
        # For scattered items (object_code, prefix), all data is already at level 7
        # because we filtered during accumulation.
        if item.fundcd:
            chosen_level = _pick_level(levels)
            amount_k = levels[chosen_level]
            row_count = counts[chosen_level]
        else:
            # Sum across the level-7 rows we accumulated.
            amount_k = sum(levels.values())
            row_count = sum(counts.values())
            chosen_level = 7

        distinct = len(item_distinct_fundcds[idx])

        result.items.append(ItemResult(
            category=item.category,
            name=item.name,
            legal_basis=item.legal_basis,
            match_type=match_type,
            match_key=match_key,
            amount_thousands=amount_k,
            amount_pesos=amount_k * 1000,
            row_count=row_count,
            distinct_codes=distinct,
        ))

    # Aggregate by category.
    by_cat: Dict[str, float] = defaultdict(float)
    for it in result.items:
        by_cat[it.category] += it.amount_pesos
    result.by_category = dict(by_cat)
    result.total_amount_pesos = sum(by_cat.values())
    result.total_amount_thousands = result.total_amount_pesos / 1000

    # Coverage vs grand total.
    if grand_total > 0:
        result.coverage_pct = (result.total_amount_thousands / grand_total) * 100

    # Add unclassified hits (codes that matched keywords but aren't in the
    # canonical list -- surfaced for manual review).
    for fc, levels in unclassified_per_fc.items():
        total_for_code = sum(levels.values()) * 1000
        result.unclassified_hits.append({
            "fundcd": fc,
            "description": unclassified_descs.get(fc, ""),
            "total_pesos": total_for_code,
            "by_level_pesos": {str(lv): amt * 1000 for lv, amt in levels.items()},
            "note": "Description matched AA keyword but no rule matched.",
        })

    # Sort unclassified by amount desc so the biggest potential misses surface.
    result.unclassified_hits.sort(key=lambda x: -x["total_pesos"])

    return result


def _match_type(item: AutomaticItem) -> str:
    if item.fundcd:
        return "fundcd"
    if item.fundcd_prefix:
        return "fundcd_prefix"
    if item.object_code:
        return "object_code"
    return "?"


def _match_key(item: AutomaticItem) -> str:
    return item.fundcd or item.fundcd_prefix or item.object_code


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _fmt_p(pesos: float) -> str:
    """Format pesos for display: T/B/M/K. Handles negatives."""
    if pesos == 0:
        return "PHP 0"
    sign = "-" if pesos < 0 else ""
    abs_p = abs(pesos)
    if abs_p >= 1e12:
        return f"PHP {sign}{abs_p / 1e12:.2f}T"
    if abs_p >= 1e9:
        return f"PHP {sign}{abs_p / 1e9:.2f}B"
    if abs_p >= 1e6:
        return f"PHP {sign}{abs_p / 1e6:.1f}M"
    if abs_p >= 1e3:
        return f"PHP {sign}{abs_p / 1e3:.0f}K"
    return f"PHP {sign}{abs_p:,.0f}"


def format_report(r: AnalysisResult) -> str:
    """Format an AnalysisResult as a human-readable console report."""
    lines = []
    sep = "=" * 80
    lines.append(sep)
    lines.append(f"AUTOMATIC APPROPRIATIONS - NEP FY {r.fiscal_year}")
    lines.append(sep)
    lines.append("")
    lines.append("Per-item breakdown:")
    lines.append("")
    lines.append(f"  {'Match':<22} {'Amount':>14}  {'Rows':>7}  Name")
    lines.append(f"  {'-'*22} {'-'*14}  {'-'*7}  {'-'*40}")
    for it in r.items:
        match_str = it.match_key
        if it.match_type == "fundcd_prefix":
            match_str = f"{it.match_key}*"
            if it.distinct_codes:
                match_str += f" ({it.distinct_codes} codes)"
        elif it.match_type == "object_code":
            match_str = f"obj:{it.match_key}"
        lines.append(
            f"  {match_str:<22} {_fmt_p(it.amount_pesos):>14}  "
            f"{it.row_count:>7}  {it.name}"
        )
        lines.append(f"  {'':22} {'':14}  {'':7}  basis: {it.legal_basis}")
    lines.append("")
    lines.append(f"  {'TOTAL':<22} {_fmt_p(r.total_amount_pesos):>14}")
    lines.append("")

    lines.append("By category:")
    lines.append("")
    cat_order = ["debt_service", "lgu_share", "net_lending",
                 "tax_expenditure", "sagf", "statutory", "other"]
    for cat in cat_order:
        amt = r.by_category.get(cat, 0.0)
        if amt == 0:
            continue
        pct = (amt / r.total_amount_pesos * 100) if r.total_amount_pesos else 0
        label = CATEGORY_LABELS.get(cat, cat)
        lines.append(f"  {_fmt_p(amt):>14}  ({pct:5.1f}%)  {label}")
    lines.append("")

    lines.append("Context:")
    lines.append("")
    lines.append(f"  NEP grand total (level 0):   {_fmt_p(r.grand_total_thousands * 1000)}")
    lines.append(f"  Automatic appropriations:    {_fmt_p(r.total_amount_pesos)}")
    lines.append(f"  AA share of NEP total:       {r.coverage_pct:.1f}%")
    programmed = r.grand_total_thousands * 1000 - r.total_amount_pesos
    lines.append(f"  Implied programmed:          {_fmt_p(programmed)}")
    lines.append("")

    if r.unclassified_hits:
        lines.append("Review needed - description matched AA keyword but no rule matched:")
        lines.append("")
        for hit in r.unclassified_hits[:10]:
            lines.append(f"  {hit['fundcd']:<9} {_fmt_p(hit['total_pesos']):>14}  "
                         f"{hit['description'][:50]}")
        if len(r.unclassified_hits) > 10:
            lines.append(f"  ... and {len(r.unclassified_hits) - 10} more (see JSON output)")
        lines.append("")

    return "\n".join(lines)


def format_yoy(r_prev: AnalysisResult, r_curr: AnalysisResult) -> str:
    """Format a year-over-year comparison."""
    lines = []
    sep = "=" * 78
    lines.append(sep)
    lines.append(f"AUTOMATIC APPROPRIATIONS - YoY COMPARISON (FY{r_prev.fiscal_year} -> FY{r_curr.fiscal_year})")
    lines.append(sep)
    lines.append("")
    lines.append(f"  {'Category':<45} {'FY'+r_prev.fiscal_year:>14} {'FY'+r_curr.fiscal_year:>14} {'Δ':>14}")
    lines.append(f"  {'-'*45} {'-'*14} {'-'*14} {'-'*14}")
    all_cats = sorted(set(r_prev.by_category) | set(r_curr.by_category),
                       key=lambda c: -max(
                           r_prev.by_category.get(c, 0),
                           r_curr.by_category.get(c, 0),
                       ))
    for cat in all_cats:
        prev = r_prev.by_category.get(cat, 0.0)
        curr = r_curr.by_category.get(cat, 0.0)
        delta = curr - prev
        delta_str = _fmt_p(delta) if delta != 0 else "—"
        label = CATEGORY_LABELS.get(cat, cat)
        lines.append(f"  {label:<45} {_fmt_p(prev):>14} {_fmt_p(curr):>14} {delta_str:>14}")

    delta_total = r_curr.total_amount_pesos - r_prev.total_amount_pesos
    pct_growth = ((delta_total / r_prev.total_amount_pesos) * 100
                   if r_prev.total_amount_pesos else 0)
    lines.append(f"  {'-'*45} {'-'*14} {'-'*14} {'-'*14}")
    lines.append(f"  {'TOTAL':<45} {_fmt_p(r_prev.total_amount_pesos):>14} "
                 f"{_fmt_p(r_curr.total_amount_pesos):>14} {_fmt_p(delta_total):>14}")
    lines.append("")
    lines.append(f"  Growth: {pct_growth:+.1f}%")
    lines.append("")

    return "\n".join(lines)


def result_to_json(r: AnalysisResult) -> dict:
    """Serialize an AnalysisResult to a JSON-serializable dict."""
    return {
        "fiscal_year": r.fiscal_year,
        "grand_total_thousands": r.grand_total_thousands,
        "grand_total_pesos": r.grand_total_thousands * 1000,
        "total_amount_thousands": r.total_amount_thousands,
        "total_amount_pesos": r.total_amount_pesos,
        "coverage_pct": r.coverage_pct,
        "by_category_pesos": r.by_category,
        "items": [asdict(it) for it in r.items],
        "unclassified_hits": r.unclassified_hits,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze automatic appropriations in NEP FY2026 / FY2027 data.",
    )
    here = Path(__file__).resolve().parent
    default_data = here.parent.parent / "data"

    parser.add_argument(
        "--year", choices=["2026", "2027", "both"], default="both",
        help="Fiscal year to analyze (default: both)",
    )
    parser.add_argument(
        "--data-dir", type=Path, default=default_data,
        help=f"Data root (default: {default_data})",
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output machine-readable JSON instead of a text report.",
    )
    args = parser.parse_args()

    if not args.data_dir.exists():
        print(f"Error: data directory not found: {args.data_dir}", file=sys.stderr)
        return 1

    years = ["2026", "2027"] if args.year == "both" else [args.year]
    results: List[AnalysisResult] = []
    for y in years:
        items_dir = args.data_dir / "budget" / y / "items"
        if not items_dir.exists():
            print(f"Skipping FY{y}: {items_dir} not found", file=sys.stderr)
            continue
        results.append(analyze(y, args.data_dir))

    if not results:
        print("No fiscal years analyzed. Run the converters first.", file=sys.stderr)
        return 1

    if args.json:
        out = {
            "years": [result_to_json(r) for r in results],
        }
        if len(results) == 2:
            out["yoy"] = {
                "prev": results[0].fiscal_year,
                "curr": results[1].fiscal_year,
                "delta_pesos": results[1].total_amount_pesos - results[0].total_amount_pesos,
                "growth_pct": (
                    ((results[1].total_amount_pesos - results[0].total_amount_pesos)
                     / results[0].total_amount_pesos * 100)
                    if results[0].total_amount_pesos else 0
                ),
            }
        json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        for r in results:
            print(format_report(r))
        if len(results) == 2:
            print(format_yoy(results[0], results[1]))

    return 0


if __name__ == "__main__":
    sys.exit(main())
