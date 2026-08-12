# NEP Budget Browser

Vite + React + **shadcn/ui** (Tailwind) with hash routing
(`#/2027/nep`, `#/2026/place`, `#/…/n/{nodeKey}`, `#/about`).
Static assets under `../data` are served in dev/preview via a Vite plugin.

Budget figures come from the Philippine **Department of Budget and Management
(DBM)** National Expenditure Program and related **UACS** classifications.
See the root [`README.md`](../README.md#sources--attribution) and in-app
`#/about` for full source citations. This UI is a BetterGovPH civic tool—not an
official government product. Figures, hierarchy, and structures were parsed and
drafted with AI assistance under human oversight and may contain errors — verify
against official DBM sources before citing. Report errors or discrepancies via
[GitHub Issues](https://github.com/csiiiv/NEP-BROWSER-2027/issues); they may be
patched in a later release.

The previous plain HTML/JS UI lives in `legacy-static/`.

## Develop

```powershell
cd browser
npm install
npm run dev
# http://localhost:5173/#/2027/nep
```

Prefer `npm run dev` while iterating (HMR). `npm run preview` serves the last
`dist/` build only—rebuild after UI changes if you use preview.

## Build / preview

```powershell
cd browser
npm run build
npm run preview
# http://localhost:5173/#/2027/nep
```

Output: `browser/dist/` (relative `base: './'` for GitHub Pages).

## Optional FastAPI

```powershell
cd browser
python server.py
# http://localhost:8000
```
