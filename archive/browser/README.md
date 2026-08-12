# Static NEP Budget Browser (GitHub Pages–ready)

No FastAPI required. The UI loads prebuilt gzipped assets from `data/budget/{year}/browser/`.

## Try locally

From the **repo root** (important — not from this folder):

```powershell
cd C:\WORK\BetterGovPH\Budget-NEP
python -m http.server 8080
```

Open http://localhost:8080/archive/browser/

## Behavior

- **Tree** from `place_tree.json.gz` / `nep_tree.json.gz` (cached in the browser)
- **Line items** only at leaves: Place `program`, NEP `ou`, AA items
- **Search scopes:** current leaf · department (needs a dept selected) · entire year (confirm + RAM warning)
- **Caching:** Cache API for `.json.gz` data; service worker for the shell

## GitHub Pages

Publish the repo (or `/docs` copy) so both `archive/browser/` and `data/budget/*/browser/` are reachable. Project sites need the repo base path (auto-detected when the app lives under `/…/archive/browser/`).

Optional FastAPI server (`server.py`) remains for API experiments; the default UI is static.
