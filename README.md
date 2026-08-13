# NEP Budget data & browser

Tools to turn Philippine **National Expenditure Program (NEP)** Excel workbooks
into structured JSON, plus a Vite + React browser for exploring FY budgets
(Place / NEP hierarchy views, line-item search, deep links).

This is a [BetterGovPH](https://github.com/bettergovph) project. Budget figures
and classifications originate from the Philippine government (see **Sources**);
this repository only transforms and visualizes them.

## Sources & attribution

| Source | What we use | Link |
|--------|-------------|------|
| **Department of Budget and Management (DBM)** — National Expenditure Program | Official NEP workbooks / publications for each fiscal year (e.g. `NEP-FY2026.xlsx`, `NEP-FY2027.xlsx`). Primary legal/fiscal source of proposed appropriations. | [DBM website](https://www.dbm.gov.ph/) · [NEP section / archives](https://www.dbm.gov.ph/index.php/program-expenditure-classification-prexc?catid=146&id=1204&view=article) · [NEP Volume I FY 2026](https://www.dbm.gov.ph/index.php?catid=400&id=3524%3Anational-expenditure-program-volume-i-fy-2026&view=article) |
| **DBM — Unified Accounts Code Structure (UACS)** | Org, funding, object, region, and related code semantics used when enriching rows and building reference tables. | Linked from DBM as [Unified Accounts Code Structure](https://www.dbm.gov.ph/) (UACS manuals / code lists) |
| **[bettergovph/open-budget-data](https://github.com/bettergovph/open-budget-data)** | Reference JSON layout and some stable UACS lookup conventions this pipeline aligns with. | [GitHub repository](https://github.com/bettergovph/open-budget-data) |

DBM’s site states that content is in the **public domain unless otherwise stated**.
Always prefer the official DBM release for authoritative figures; this project may
lag publications and can contain transform/display errors.

**Disclaimer:** Not an official government product. For research and civic
transparency only—not a substitute for the NEP, GAA, or DBM/BESF publications.

**AI-assisted analysis.** The figures, hierarchy, and structures on this site were
parsed, aggregated, and drafted by AI agents with human oversight. The dataset and
its interpretations may contain errors, mis-classifications, or stale figures —
always verify against the official documents and sources before citing. Report
errors or discrepancies via [GitHub Issues](https://github.com/csiiiv/NEP-BROWSER-2027/issues);
they may be patched in a later release.

Known source/transform quirks (kept for operators): [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md).

## Layout

```
NEP-FY20XX.xlsx          Source workbook(s) at repo root (gitignored)
browser/                 Vite + React budget browser (+ optional FastAPI)
scripts/
  nep-gaa-excel/         Stage 1: Excel → intermediate JSON
  nep-gaa/               Stage 2: intermediate JSON → data/
data/                    Output (gzipped budget batches + browser assets)
archive/                 Legacy scripts, docs, probes
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

### Vite + React (preferred)

```powershell
cd browser
npm install
npm run dev
# http://localhost:5173/#/2027/nep
```

Hash routes: `#/{year}/{view}`, `#/{year}/{view}/n/{nodeKey}` (deep-link a tree node), and `#/about`.

Features (high level):

- **NEP** and **Place** hierarchy views with sticky tree chrome (search / sort / collapse)
- Leaf line-item table with toggleable, reorderable columns
- Item search (current selection or entire year) with shard progress and hit **totals + amounts**
- Detail dialog with navigable hierarchy path for each row

UI stack: Vite + React + **shadcn/ui** (Tailwind). Dev/preview serve repo `data/` at `/data`.
Build with `npm run build` → `browser/dist/`. Prefer `npm run dev` while iterating so
UI changes appear without rebuilding preview.

**GitHub Actions:** pushes to `main` run CI (browser build) and deploy a static site
(browser `dist/` + `data/`) to GitHub Pages via `.github/workflows/`.

See `browser/README.md`. Legacy static UI: `browser/legacy-static/`.

### Optional FastAPI

```powershell
cd browser
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
- Budget rows may include `excel_row` (1-based Excel data-sheet row; header is row 1)
  for tracing back to `NEP-FY20XX.xlsx`.
- `OPERUNIT = "0000000"` is valid for NON-IU attached agencies.
- Git: commit gzipped batches + browser assets + references; ignore Excel,
  Stage‑1 intermediates, and plain `.json` item batches (see `.gitignore`).
