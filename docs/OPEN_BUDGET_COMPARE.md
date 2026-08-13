# Comparison with bettergovph/open-budget-data

How this repo’s `data/` output relates to
[bettergovph/open-budget-data](https://github.com/bettergovph/open-budget-data).

**Last checked:** 2026-08-13 against open-budget-data `main` (FY2026 NEP
`budget-mapping` + reference JSON under `data/`). Full item batch byte-diff was
not run (~290 MB plain JSON on their side).

## Short answer

**FY2026 NEP line items are schema-compatible and match their published totals.**
Reference folders use the same *layout* as open-budget, but ours are largely
**NEP-derived subsets**, not a full multi-year UACS dump. Do not assume a
byte-for-byte drop-in for their Neo4j `sync.py` without adapting
`budget-mapping.json` and UACS catalog expectations.

## What each repo covers

| | This repo (Budget-NEP) | open-budget-data |
|--|------------------------|------------------|
| Budget years | NEP **2026**, **2027** | NEP **2020–2026** (+ GAA years) |
| Item files | `data/budget/{year}/items/nep_*_batch_*.json.gz` | Same naming, typically plain `.json` |
| Mapping | Compact `budget-mapping.json` (stats + PREXC analysis) | Larger file with embedded `unique_codes` lists |
| Org / funding / object / location / pap | Present | Present (+ richer location: provinces, cities, barangays) |
| Browser assets | `data/budget/{year}/browser/` | Not applicable |
| Extra here | `organization/divisions.json` | — |
| Extra there | `object_code/expense_categories.json`, multi-year UACS catalogs | — |

## FY2026 budget core (aligned)

From both `budget/2026/budget-mapping.json` metadata:

| Field | This repo | open-budget-data |
|-------|-----------|------------------|
| `budget_type` | NEP | NEP |
| `fiscal_year` | 2026 | 2026 |
| `total_records` | **771,594** | **771,594** |
| `total_amount` | **13,586,324,000** | **13,586,324,000** (thousands of pesos) |
| Batches | 8 × 100,000 | 8 × 100,000 (same filenames) |

Interpretation: both conversions are on the **same NEP-FY2026 record universe**
at the aggregate level. Amounts are in **thousands of pesos**; PREXC levels
overlap (see our `amount_analysis` / README notes).

We also record `source_file` / `source_sha256` on mapping; their older mapping
may omit those.

## Item schema (compatible)

Budget records are intended to match the shape expected by open-budget’s
pipeline (see converter headers referencing upstream `sync.py`):

**Typical fields:** `id`, `budget_type`, `fiscal_year`, `amount`, `description`,
`prexc_fpap_id`, and optionally `org_uacs_code`, `region_code`, `division_code`,
`division_name`, `ou_class_code`, `funding_uacs_code`, `object_uacs_code`.

**Also preserved here:** `prexc_level`, `sorder`, `excel_row` (traceability back
to the Excel / Stage‑1 JSON).

Compression differs (`.json.gz` vs plain JSON); content after gunzip is the
compatible unit.

## Reference dimensions (layout same, catalogs differ)

Compared locally against a mirror of their `data/` refs (not their full item
batches):

| File / dimension | Result |
|------------------|--------|
| `organization/departments.json` | Schema match; **100%** of our codes in theirs (they have a few extra) |
| `organization/agencies.json` | Schema ~match (+ their `tag`); **~95%** of our `uacs_code`s overlap; some renames (e.g. agency title changes) |
| `organization/operating_units.json` / `organizations.json` | Schema ~match; **~98%** of our OU codes overlap; they have a larger multi-year set |
| `organization/operating_unit_classes.json` | Codes largely overlap; **many description mismatches** (NEP-synthesized labels vs their UACS wording) |
| `location/regions.json` | Strong overlap; minor label differences (e.g. NIR naming) |
| `pap/sector_outcomes.json` | **Exact** code set match in the check |
| `funding_source/funding_sources.json` | **Same schema, different catalog:** theirs is a broad UACS table (often `01……` style); ours is NEP-derived (`10……` style funds as in the Excel). Prefer comparing to codes **actually used in budget rows** / mapping `unique_codes`, not the full UACS file |
| `object_code/sub_objects.json` | Same idea; theirs is a larger UACS library. Our 10-digit NEP objects align much better with their **FY2026 mapping `object_codes`** than with their full `sub_objects.json` dump |
| `object_code/objects.json` | High overlap on our 8-digit object keys vs their objects file; catalogs still differ in size |

**Practical rule:** treat **items + org hierarchy + regions** as the
open-budget-compatible core. Treat **funding_source/** and **object_code/**
reference JSONs as “aligned subset / parallel layout,” not identical UACS
mirrors.

### Mapping unique codes vs our refs (FY2026)

Against their `budget-mapping.unique_codes` (codes appearing in NEP rows):

- Funding: most of our funding UACS appear in their mapping set (~82 of 84 in
  one check).
- Object (sub-object 10-digit): strong overlap with their mapping
  `object_codes` (~131 of 136); their mapping also lists padded class codes
  such as `0000000001`…`0000000003` (see [EDGE_CASES.md](EDGE_CASES.md)).

## Sharing checklist (open-budget-style package)

Minimum useful share:

```
data/budget/2026/items/*.json.gz
data/budget/2027/items/*.json.gz
data/budget/2026/budget-mapping.json
data/budget/2027/budget-mapping.json
data/organization/
data/funding_source/
data/object_code/
data/location/
data/pap/
```

Optional for this browser only:

```
data/budget/{year}/browser/
```

Not required for JSON consumers (regenerate locally): Excel workbooks,
`scripts/nep-gaa/input/*.json`.

## Drop-in to open-budget `sync.py`?

| Layer | Expectation |
|-------|-------------|
| Item JSON records | Likely readable if gunzipped / path wiring updated |
| `budget-mapping.json` | **Different shape** — adapt or regenerate their style |
| Full UACS reference tables | **Not identical** — may need their catalogs or a merge |
| FY2027 | **Ours only** today |

## Re-running a comparison

A scratch mirror used for the 2026-08-13 check lived under `_compare/` (gitignored).
To refresh:

1. Download their `data/**` refs + `budget/2026/budget-mapping.json` from
   GitHub raw / sparse clone.
2. Compare metadata totals, schema keys, and code-set intersections as above.
3. Optional: stream their item batches vs our `.json.gz` for id/amount diffs
   (large download).

## Related docs

- [EDGE_CASES.md](EDGE_CASES.md) — FY2026 `UACS_OBJ_CD` / `UACS_EXP_CD` swap on a
  small L7 subset (affects object codes vs a “clean” UACS view).
- Root [README.md](../README.md) — pipeline stages and sources.
