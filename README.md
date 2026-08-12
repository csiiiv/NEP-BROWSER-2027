# NEP Excel → Structured JSON

Two-stage pipeline for Philippine NEP (National Expenditure Program) workbooks,
plus optional browser assets for fast exploration.

## Layout

```
NEP-FY20XX.xlsx          Source workbook(s) at repo root (gitignored)
scripts/
  nep-gaa-excel/         Stage 1: Excel → intermediate JSON
  nep-gaa/               Stage 2: intermediate JSON → data/
data/                    Output (gzipped budget batches + reference JSONs)
archive/browser/         FastAPI budget browser
```

## Stage 1 — Excel to intermediate JSON

```powershell
pip install -r requirements.txt
python scripts/nep-gaa-excel/converter_nep2025.py NEP-FY2026.xlsx scripts/nep-gaa/input
python scripts/nep-gaa-excel/converter_nep2025.py NEP-FY2027.xlsx scripts/nep-gaa/input
```

Produces `scripts/nep-gaa/input/NEP-FY20XX.json` (~1 GB per year, gitignored).

## Stage 2 — Intermediate JSON to structured output

```powershell
python scripts/nep-gaa/converter_fy2026.py
python scripts/nep-gaa/converter_fy2027.py
```

Writes:

- `data/budget/{year}/items/nep_{year}_batch_*.json.gz` (~100k records/batch, gzipped)
- `data/budget/{year}/budget-mapping.json`
- `data/organization/`, `data/funding_source/`, `data/object_code/`, `data/location/`, `data/pap/`

If you still have plain `.json` batches from an older run:

```powershell
python scripts/nep-gaa/recompress_batches.py
```

## Browser assets (recommended)

Pre-builds Place/NEP trees and **agency×region item shards** so the browser
does not scan the full dataset on every request:

```powershell
python scripts/nep-gaa/build_browser_assets.py
```

Writes `data/budget/{year}/browser/`:

| File | Role |
|------|------|
| `place_tree.json.gz` / `nep_tree.json.gz` | Tree rollups |
| `shards/{agency}/{region}.json.gz` | Programmed L7 lines for that slice |
| `aa.json.gz` | Automatic appropriation rows |
| `meta.json.gz` / `manifest.json.gz` | Totals + shard index |

## Browser

```powershell
cd archive\browser
python server.py
# http://localhost:8000
```

Views: **Place** (Dept → Agency → Region → Division → OU → Program) and
**NEP** (Dept → Agency → Program → Region → Division → OU).

## Validation

```powershell
python scripts/nep-gaa/validate_output.py --data data
```

## Notes

- Amounts in source are **thousands of pesos**; multiply by 1,000 for pesos.
- Use `prexc_level == 7` for line-item sums; parent PREXC levels overlap.
- `OPERUNIT = "0000000"` is valid for NON-IU attached agencies.
- Git: commit gzipped batches + browser assets + references; ignore Excel,
  Stage‑1 intermediates, and plain `.json` item batches (see `.gitignore`).
