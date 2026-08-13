import type { BudgetRec, YearData } from "./data";

/** YoY is computed for FY2027 against FY2026 only. */
export const YOY_CURRENT_YEAR = "2027";
export const YOY_PRIOR_YEAR = "2026";

export function itemMatchKey(rec: BudgetRec): string {
  const org = String(rec.org_uacs_code || "");
  const prexc = String(rec.prexc_fpap_id || "").padStart(15, "0");
  const region = String(rec.region_code || "_none") || "_none";
  const division = String(rec.division_code || "_none") || "_none";
  const object = String(rec.object_uacs_code || "");
  const funding = String(rec.funding_uacs_code || "");
  return [org, prexc, region, division, object, funding].join("|");
}

export function yoyFromPrior(
  currThousands: number,
  priorThousands: number | undefined,
): { label: string; pct: number | null } {
  if (priorThousands === undefined) return { label: "NEW", pct: null };
  if (priorThousands === 0) return { label: "—", pct: null };
  const pct = ((currThousands - priorThousands) / priorThousands) * 100;
  const rounded = Math.round(pct * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return { label: `${sign}${rounded.toFixed(1)}%`, pct: rounded };
}

export function treeNodeYoyLabel(
  nodeKeyStr: string,
  currThousands: number,
  priorByNodeKey: Map<string, number> | null,
): string | null {
  if (!priorByNodeKey) return null;
  return yoyFromPrior(currThousands, priorByNodeKey.get(nodeKeyStr)).label;
}

export function buildPriorAmountIndex(rows: BudgetRec[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = itemMatchKey(r);
    map.set(k, (map.get(k) || 0) + (r.amount || 0));
  }
  return map;
}

/** Load prior-year shards and sum amounts by match key. Missing shards are skipped. */
export async function loadPriorAmountIndex(
  prior: YearData,
  paths: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const p of paths) {
    try {
      const rows = await prior.loadShard(p);
      for (const r of rows) {
        const k = itemMatchKey(r);
        map.set(k, (map.get(k) || 0) + (r.amount || 0));
      }
    } catch {
      /* shard absent in prior year */
    }
  }
  return map;
}

/** Prior tree rollups by node key, plus synthetic root/section/AA totals from meta. */
export async function loadPriorTreeAmountIndex(
  prior: YearData,
  view: "place" | "nep",
): Promise<Map<string, number>> {
  if (!prior.meta) await prior.init();
  const tree = await prior.loadTree(view);
  const map = new Map<string, number>();
  for (const [key, node] of tree.nodes) {
    map.set(key, node.total_amount);
  }
  const m = prior.meta!;
  map.set("root:total", m.grand_total_thousands);
  map.set("section:automatic", m.aa_total_thousands);
  map.set("section:programmed", m.programmed_total_thousands);
  for (const [code, info] of Object.entries(m.aa_items || {})) {
    if (info.amount_thousands != null) {
      map.set(`aa_item:${code}`, info.amount_thousands);
    }
  }
  return map;
}

export function attachYoy<T extends BudgetRec>(
  rows: T[],
  priorByKey: Map<string, number> | null,
): (T & { yoy_label: string; yoy_pct: number | null })[] {
  if (!priorByKey) {
    return rows.map((r) => ({ ...r, yoy_label: "—", yoy_pct: null }));
  }
  return rows.map((r) => {
    const { label, pct } = yoyFromPrior(r.amount || 0, priorByKey.get(itemMatchKey(r)));
    return { ...r, yoy_label: label, yoy_pct: pct };
  });
}
