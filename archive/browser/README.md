# NEP Budget Browser

A small local web app for browsing converted NEP budget data (FY2026 and FY2027).

## What it does

Serves a hierarchical tree view over the converted JSON:

```
Department
  └── Agency
       └── Operating Unit
            └── Program (PREXC level 3)
                 └── Line items (PREXC levels 4-7)
```

- **Year selector** — switch between FY2026 and FY2027.
- **Summary cards** — NEP grand total, automatic appropriations, and programmed appropriations (matches the NEP PDF table).
- **Appropriation filter** — show all items, automatic only, or programmed only.
- Click any tree node to drill down; the right panel shows leaf line items with pagination.
- Filter by amount (non-zero / zero / all) and free-text search on descriptions.
- Line items tagged as automatic appropriations show an **AA** badge.
- Click a row to see full detail (region, funding source, expense object, UACS codes).

## Setup

Requires converted data under `../data/budget/2026/` and/or `../data/budget/2027/`. If missing:

```powershell
cd c:\WORK\BetterGovPH\Budget-NEP
python scripts\nep-gaa-excel\converter_nep2025.py NEP-FY2026.xlsx scripts\nep-gaa\input
python scripts\nep-gaa\converter_fy2026.py
python scripts\nep-gaa-excel\converter_nep2025.py NEP-FY2027.xlsx scripts\nep-gaa\input
python scripts\nep-gaa\converter_fy2027.py
```

Then:

```powershell
cd c:\WORK\BetterGovPH\Budget-NEP\browser
pip install -r requirements.txt
python server.py
```

Open <http://localhost:8000>.

## Architecture

- **Backend** (`server.py`): FastAPI. Discovers available fiscal years, builds a separate tree index per year at startup, and exposes summary totals including automatic appropriations (same rules as `scripts/nep-gaa/automatic_appropriations.py`).
- **Frontend** (`index.html`): single HTML file, vanilla JS, no build step.

## Performance notes

- Startup takes ~60–90 seconds (indexes both years sequentially).
- After startup, memory is ~1–1.5 GB with both years loaded.
- Items queries scan all batches each time (~10–15 s per query). For faster search, SQLite with indexes is the obvious next step.

## API

| Endpoint | Description |
|---|---|
| `GET /` | The HTML page |
| `GET /api/years` | List available fiscal years |
| `GET /api/summary?year=2027` | Grand total, AA total, programmed total, AA share % |
| `GET /api/tree?year=2027` | Top-level (all departments) |
| `GET /api/tree/{kind}/{code}?year=2027` | One node + children. For `program`, add `&parent=<ou_uacs>`. |
| `GET /api/tree/{kind}/{code}/items?year=2027` | Leaf items. Params: `amount_filter`, `appropriation` (all/aa/programmed), `search`, `limit`, `offset`, `parent`. |
