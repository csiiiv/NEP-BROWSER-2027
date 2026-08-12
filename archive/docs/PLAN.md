# NEP-FY2027 → Structured JSON: Implementation Plan

## Context

We're transforming `NEP-FY2027.xlsx` (~756k rows, ~69 MB) into the structured
JSON layout used by [bettergovph/open-budget-data](https://github.com/bettergovph/open-budget-data/tree/db1b6c28b30b2000eeb6cc4203d58082f80fccde)
so it can be loaded into Neo4j via the repo's `sync.py`.

This document captures the analysis of the upstream scripts, the source file,
the downstream contract (`sync.py`), and the recommended approach.

---

## TL;DR — Recommendation

**Use "Path B": derive all reference data from NEP-FY2027 itself**, supplemented
with a small hardcoded lookup for fund cluster / financing source / authorization
code→description mappings (these are stable across years, ~25 total entries).

This gives full `sync.py` compatibility without needing to download 11+ UACS
master XLSX files or hit the UACS barangay API.

| Dimension | Approach | sync.py compatibility |
|---|---|---|
| Organization (all 5 files) | Derive from NEP columns | ✅ Full |
| Object code (all 5 files) | Derive by slicing 10-digit code + `UACS_EXP_CD` | ✅ Full |
| Location regions | Derive from `UACS_REG_ID` + `UACS_REG_DSC` | ✅ Full |
| Location provinces/cities/barangays | Skip (NEP doesn't have them) | ✅ sync.py tolerates absence |
| Funding source (8-digit) | Derive from `FUNDCD` + `UACS_FUNDSUBCAT_DSC` | ✅ Full |
| Fund cluster / financing / authorization | Hardcoded lookup (~25 entries) | ✅ Full |
| PAP sector outcomes | Hardcoded (already in mfo-pap converter) | ✅ Full |
| PAP programs/subprograms/activities | Skip — sync.py doesn't read them | ✅ N/A |
| Budget records | Patch upstream converter to preserve `SORDER` + `PREXC_LEVEL` | ✅ Full |

---

## Source data: NEP-FY2027.xlsx

Columns (verified by inspection):

```
SORDER, DEPARTMENT, UACS_DPT_DSC, AGENCY, UACS_AGY_DSC,
PREXC_FPAP_ID, PREXC_LEVEL, DSC, UACS_OPERDIV_ID, UACS_DIV_DSC,
OPERUNIT, UACS_OPER_DSC, UACS_REG_ID, UACS_REG_DSC,
FUNDCD, UACS_FUNDSUBCAT_DSC, UACS_EXP_CD, UACS_EXP_DSC,
UACS_OBJ_CD, UACS_OBJ_DSC, AMT
```

**Critical observation:** The NEP file carries descriptive names alongside
every code (`UACS_DPT_DSC`, `UACS_AGY_DSC`, `UACS_OPER_DSC`, `UACS_REG_DSC`,
`UACS_FUNDSUBCAT_DSC`, `UACS_EXP_DSC`, `UACS_OBJ_DSC`). The upstream
`nep-gaa/converter.py` discards these and assumes you'll join against
separately-generated reference JSONs — which is wasteful for a single-year
conversion.

---

## Pipeline design

### Two-pass strategy

**Pass 1: Excel → intermediate JSON**

Use `scripts/nep-gaa-excel/converter_nep2025.py` as-is (already downloaded).
Reads with `dtype=str` to preserve leading zeros in codes. Produces
`NEP-FY2027.json` (~1 GB).

**Pass 2: Intermediate JSON → all output JSONs (streaming)**

A new script `scripts/nep-gaa/converter_fy2027.py` (does **not** modify
upstream code) that:

1. Streams the intermediate JSON using `ijson` (iterative parser, low memory).
2. Maintains in-memory dicts for each reference entity, keyed on UACS code,
   deduplicating as it goes.
3. Writes budget record batches incrementally to `data/budget/2027/items/`.
4. Writes all reference JSONs at the end.

### Output structure

```
data/
├── budget/2027/
│   ├── budget-mapping.json              (metadata, statistics, batch list)
│   └── items/
│       ├── nep_2027_batch_0001.json
│       └── ... (~8 batches at 100k each)
│
├── organization/
│   ├── _metadata.json
│   ├── departments.json
│   ├── agencies.json
│   ├── operating_unit_classes.json
│   ├── operating_units.json
│   └── organizations.json
│
├── funding_source/
│   ├── _metadata.json
│   ├── fund_clusters.json               (hardcoded lookup)
│   ├── financing_sources.json           (hardcoded lookup)
│   ├── authorizations.json              (hardcoded lookup)
│   ├── fund_categories.json             (derived + lookup)
│   └── funding_sources.json             (derived from FUNDCD)
│
├── object_code/
│   ├── _metadata.json
│   ├── classifications.json
│   ├── sub_classes.json
│   ├── groups.json
│   ├── objects.json
│   └── sub_objects.json
│
├── location/
│   ├── _metadata.json
│   └── regions.json
│
└── pap/
    ├── _metadata.json
    └── sector_outcomes.json             (hardcoded)
```

---

## Downstream contract: what sync.py reads

Verified by reading `sync.py`. Each file's required fields and unique key:

### Organization

| File | Required fields | Unique key | Relationship logic |
|---|---|---|---|
| `departments.json` | `code` (2-digit) | `code` | Direct MERGE |
| `agencies.json` | `uacs_code` (5-digit), `department_code` | `uacs_code` | Linked via `department_code` |
| `operating_unit_classes.json` | `code` (2-digit) | `code` | Direct MERGE |
| `operating_units.json` | `uacs_code` (12-digit), `department_code`, `agency_code`, `class_code` | `uacs_code` | **String concat**: `ou.department_code + ou.agency_code = a.uacs_code` |
| `organizations.json` | `uacs_code` (12-digit) | `uacs_code` | **BudgetRecord joins here** |

### Funding source

| File | Required fields | Unique key |
|---|---|---|
| `fund_clusters.json` | `code`, `description` | `code` |
| `financing_sources.json` | `code`, `description` | `code` |
| `authorizations.json` | `code`, `description` | `code` |
| `fund_categories.json` | `uacs_code` (8-digit), `fund_cluster`, `financing_source`, `authorization` (**all description strings, not codes**) | `uacs_code` |
| `funding_sources.json` | `uacs_code` (8-digit) | `uacs_code` — **BudgetRecord joins here** |

**⚠️ Critical:** `sync.py` joins fund cluster/financing/auth relationships on
**description strings**, not codes:

```cypher
MATCH (fc:FundCluster)
MATCH (fcat:FundCategory {fund_cluster: fc.description})
MATCH (fin:FinancingSource {description: fcat.financing_source})
MERGE (fc)-[:HAS_FINANCING_SOURCE]->(fin)
```

So `fund_categories.json` must have parent references as description strings.
NEP-FY2027 doesn't carry these — we need a hardcoded lookup.

### Location

| File | Required fields | Unique key |
|---|---|---|
| `regions.json` | `code` (2-digit) | `code` — **BudgetRecord joins here** |
| `provinces.json` | `psgc_code`, `region_code` | `psgc_code` |
| `cities_municipalities.json` | `psgc_code`, `region_code`, `province_code` | `psgc_code` |
| `barangays.json` | `psgc_code` (9-digit), `region_code`, `province_code`, `city_code` | `psgc_code` |

sync.py gracefully skips missing files via `if data:` guards. Provinces,
cities, barangays can be omitted.

### Object code

| File | Required fields | Unique key |
|---|---|---|
| `classifications.json` | `code` (1-digit) | `code` |
| `sub_classes.json` | `code` (2-digit), `classification_code` | `code` |
| `groups.json` | `full_code` (5-digit), `sub_class_code`, `classification_code` | `full_code` |
| `objects.json` | `full_code` (8-digit), `group_code`, `sub_class_code`, `classification_code` | `full_code` |
| `sub_objects.json` | `uacs_code` (10-digit), `object_code`, `group_code`, `sub_class_code`, `classification_code` | `uacs_code` — **BudgetRecord joins here** |

All fields derivable by string-slicing the 10-digit `UACS_OBJ_CD`. ✅

### PAP

sync.py only reads `sector_outcomes.json` and `horizontal_programs.json`.
Notably, it does **not** read `programs.json`, `sub_programs.json`,
`activities.json` — those are produced by the mfo-pap converter but unused.

### Budget records

`data/budget/<year>/items/nep_<year>_batch_*.json`

Joined fields used by sync.py:
- `id` (unique)
- `fiscal_year`, `budget_type`
- `funding_uacs_code` → `FundingSource.uacs_code`
- `org_uacs_code` → `Organization.uacs_code`
- `region_code` (skipped if `'00'`) → `Region.code`
- `object_uacs_code` → `SubObject.uacs_code`

Additional fields (`amount`, `description`, `prexc_fpap_id`, and our patched
`SORDER`, `PREXC_LEVEL`) become node properties.

---

## Risks identified

### Data quality

1. **Mixed types in code columns.** Even with `dtype=str`, Excel may have
   stored some codes as numbers internally, stripping leading zeros. Need to
   spot-check after Pass 1 — not just the first 2 rows but a stratified sample.

2. **Header PAP rows.** Rows where `PREXC_LEVEL` indicates a parent PAP
   (typically 1–4) have nulls for OPERUNIT, FUNDCD, UACS_OBJ_CD and zero
   AMT. The upstream converter emits these as zero-amount BudgetRecords.
   Decision: **keep them** (so the PAP hierarchy resolves cleanly in Neo4j);
   downstream consumers can filter on `amount > 0`.

3. **`DSC` column ambiguity.** Used both for PAP descriptions (at parent
   levels) and line-item descriptions (at detail levels). Will be passed
   through uniformly.

4. **Negative amounts.** Some NEP lines have negative `AMT` (reversions,
   continuing appropriations). Will pass through as-is.

5. **Region code format.** Need to verify NEP-FY2027 uses plain 2-digit
   zero-padded codes. Some legacy data uses `"14A"`/`"14B"` for former
   ARMM regions, which would break `zfill(2)`.

### Schema / modeling

6. **PREXC_LEVEL → digit mapping.** The mfo-pap converter enumerates 7 levels
   but the mapping from level number to "which PREXC digit is meaningful" is
   not strictly 1:1. Since sync.py doesn't consume PAP hierarchy entities,
   this risk is moot for the load path — but if we later want to use them,
   we'll need to validate.

7. **Operating Unit Class description.** NEP doesn't carry the class
   description (e.g., "Central Office"). We'll synthesize the class *code*
   from positions 5–6 of the 12-digit org UACS, and either:
   - Hardcode common class codes (01→Central Office, 02→Regional Office, etc.)
   - Leave `description` blank

8. **Funding source parent descriptions.** See "Critical" callout above.
   Resolved via hardcoded lookup.

### Pipeline / engineering

9. **Memory peak.** Streaming with `ijson` keeps RAM low even at 5M+ rows.
   Recommended over the upstream `json.load` approach.

10. **Determinism / ID stability.** IDs are `NEP-2027-0000000001` based on
    1-indexed row position. Re-running with a re-sorted Excel will shift IDs.
    Document this; consider adding source-file SHA-256 to metadata for
    provenance tracking.

11. **No schema validation.** Output JSON shape is implicit. A JSON Schema
    check at end of Pass 2 would catch regressions. (Nice-to-have, not
    blocking.)

12. **Encoding.** UTF-8 with `ensure_ascii=False` throughout. Windows
    terminal may mojibake display; files will be correct.

### Scope

13. **GAA reconciliation.** Path B reference data reflects NEP FY2027 only.
    New agencies or funding sources introduced only in the eventual GAA
    won't be in reference JSONs. Acceptable for NEP-only use; revisit if
    GAA comparison becomes a goal.

14. **Cross-year consistency.** To compare FY2027 against FY2026 (already in
    the open-budget-data repo), either regenerate FY2026 reference data with
    Path B for apples-to-apples, or merge FY2027 derived entities with FY2026
    upstream entities. Latter is what the upstream graph assumes.

---

## Recommended engineering safeguards

| Safeguard | Priority | Notes |
|---|---|---|
| 5k-row dry run before full execution | **High** | Validates column mapping, types, edge cases cheaply |
| Source-file SHA-256 in `budget-mapping.json` metadata | Medium | Provenance tracking |
| Stratified sample inspection after Pass 1 | **High** | Catches leading-zero stripping, weird region codes |
| `ijson` streaming in Pass 2 | Medium | Memory safety |
| JSON Schema validation of output | Low | Catches field regressions |
| Field-length validation on UACS codes | Medium | Catches malformed codes (e.g., 7-digit FUNDCD) |
| Statistics in `_metadata.json` for each dimension | Medium | Helps spot anomalies (e.g., 0 funding sources loaded) |

---

## Files to create / modify

### New (this project)

| Path | Purpose |
|---|---|
| `scripts/nep-gaa/converter_fy2027.py` | Pass 2: streaming converter + reference extractor |
| `scripts/nep-gaa/lookups/funding_source_components.py` | Hardcoded fund cluster / financing / authorization code→description |
| `scripts/nep-gaa/lookups/sector_outcomes.py` | Hardcoded sector outcomes (transcribed from mfo-pap converter) |
| `scripts/nep-gaa/validate_output.py` | Sanity-check output: counts, malformed codes, missing dimensions |

### Existing (already downloaded, used as-is)

| Path | Purpose |
|---|---|
| `scripts/nep-gaa-excel/converter_nep2025.py` | Pass 1: Excel → intermediate JSON |
| `scripts/nep-gaa/converter.py` | Upstream reference (not run; kept for comparison) |

### Untouched

| Path | Notes |
|---|---|
| `sync.py` | Downstream consumer; we'll conform to its contract |
| `validator.py` | Neo4j validator; not run unless loading data |

---

## Open questions for the user

These should be confirmed before coding begins:

1. **Fund cluster / financing / authorization descriptions:** OK to hardcode
   from DBM UACS documentation? (Stable across years, ~25 total entries.)
   Alternative: pull from FY2026 reference JSONs in the open-budget-data repo.

2. **Operating Unit Class descriptions:** Hardcode common ones
   (01→Central Office, etc.), or leave blank?

3. **Intermediate JSON disposal:** Delete `NEP-FY2027.json` (~1 GB) after
   Pass 2 completes, or keep it?

4. **Dry run first:** Do a 5k-row dry run before the full ~756k run?

5. **Output location:** Confirm `data/` under workspace root is the desired
   output (vs. cloning the open-budget-data repo and contributing there).

---

## Update after dry run: FUNDCD encoding investigation

**Initial concern (resolved):** The dry run surfaced that every FUNDCD in
NEP-FY2027 starts with `"10"` (532,312 of 756,629 rows). Since the official
UACS table only has fund cluster codes `01`–`07`, this looked like a data
quality issue.

**Resolution:** We downloaded `NEP-FY2026.xlsx` to compare and confirmed
this is the **standard DBM NEP encoding**, not an anomaly. Both FY2026 and
FY2027 NEP Excel exports use the same `10xxxxxx` prefix scheme (100% of
funding values in both files start with `"10"`). The same `10101101`,
`10401102`, `10102151`, `10102163`, etc. codes appear in both years.

**Why the discrepancy with upstream reference data:** The
`data/funding_source/funding_sources.json` in the open-budget-data repo
uses codes prefixed `01` (e.g. `01101101`), but the upstream
`data/budget/2026/items/nep_2026_batch_0001.json` (the actual budget
output) also uses `10`-prefixed codes (e.g. `10101101`). The upstream
pipeline has the same NEP-vs-reference encoding mismatch we have; the
BudgetRecord → FundingSource relationship joins would not resolve in
their loaded graph either without normalization.

**Approach taken:** The converter preserves the raw FUNDCD verbatim in
`funding_uacs_code` and `funding_sources.json` so our BudgetRecord →
FundingSource joins work self-consistently. The hardcoded
`fund_clusters.json` includes both `"10"` (mapped to "Regular Agency Fund
(NEP encoding)") and the official `"01"`–`"07"` codes, so sync.py's
description-string joins resolve for our dataset.

Caveat documented in `_metadata.json`: financing source code `"4"` (which
appears in NEP FUNDCD position 2 for retirement/SAGF/trust-type funds) has
no official UACS description; we mark it as `"(NEP export - sub-category 4)"`
rather than guess.

---

*Last updated: 2026-08-12*
