# Edge cases & data quirks

Notes on source / transform quirks discovered while building and comparing
NEP FY datasets. **Pipeline code is left as-is** unless a fix is explicitly
decided later; this file records findings for YoY matching and validation.

## FY2026: swapped `UACS_OBJ_CD` / `UACS_EXP_CD` (subset of L7 rows)

**Status:** Source-data issue in the FY2026 NEP export (not a browser bug).  
**Scope:** About **39** PREXC level-7 rows in FY2026. FY2027 does not show this pattern in a full L7 scan.  
**Converter behavior:** Unchanged — Stage 2 still maps `object_uacs_code` from `UACS_OBJ_CD` only.

### Normal convention (most L7 rows, and FY2027)

| Column | Typical content |
|--------|-----------------|
| `UACS_OBJ_CD` | 10-digit object code (e.g. `5030102000`) |
| `UACS_EXP_CD` | Expense class digit (e.g. `3` = Financial Expenses) |
| `UACS_OBJ_DSC` / `UACS_EXP_DSC` | Match those codes |

### Swapped pattern (FY2026 outliers)

| Column | Content on affected rows |
|--------|---------------------------|
| `UACS_OBJ_CD` | Short class code (`1` / `2` / `3` / `6`) |
| `UACS_EXP_CD` | Real 10-digit object code |
| Descriptions | Also follow the swapped columns (`OBJ_DSC` = class name, `EXP_DSC` = object name) |

After conversion, the short class becomes a padded object code such as
`0000000003`.

### Example: Debt Service – Interest Payments

Same AA item (`FUNDCD` `10401110`, PAP text *For the Payment of Interest of
Foreign and Domestic Indebtedness*):

| Year | Raw `UACS_OBJ_CD` | Raw `UACS_EXP_CD` | Stored `object_uacs_code` |
|------|-------------------|------------------|---------------------------|
| 2026 | `3` | `5030102000` | `0000000003` |
| 2027 | `5030102000` | `3` | `5030102000` |

Amounts differ by year as expected (e.g. ₱950.0B thousands-units in 2026 vs
₱1,114.256B in 2027 in the processed AA assets); the **object code** mismatch
is the quirk.

### Other FY2026 funds seen with the same swap

Includes (non-exhaustive): tobacco/LGU share-style funds (`10101252`, …),
contingent/pension-style Special Purpose Funds, Net Lending (`10401280`), etc.
Full list is recoverable by scanning Stage-1 `NEP-FY2026.json` for L7 rows where
`len(UACS_EXP_CD) >= 10` and `len(UACS_OBJ_CD) <= 2`.

### Impact on YoY

Item YoY match keys include `object_uacs_code`. Affected FY2027 lines will not
match the FY2026 twin and surface as **NEW** even when funding + PAP text align.
Tree/AA rollups keyed only by funding rule (e.g. `10401110`) are unaffected at
the category level.

### Possible future fix (not applied)

In Stage 2, when `UACS_OBJ_CD` looks like an expense class and `UACS_EXP_CD` is a
10-digit object code, prefer `UACS_EXP_CD` (and matching descriptions) for
`object_uacs_code`. Would require regenerating FY2026 `data/` + browser assets.
