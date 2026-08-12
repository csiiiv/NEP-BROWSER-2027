import { fetchGzJson } from "./cache";

export type ViewMode = "place" | "nep";
export type SearchScope = "selection" | "all";

export const AA_RULES: [string, string, string, string][] = [
  ["fundcd", "10401110", "debt_service", "Debt Service - Interest Payments"],
  ["fundcd", "10401258", "lgu_share", "National Tax Allotment (NTA)"],
  ["fundcd", "10401257", "lgu_share", "BARMM Annual Block Grant"],
  ["fundcd", "10401280", "net_lending", "Net Lending to GOCCs"],
  ["fundcd", "10401105", "tax_expenditure", "Tax Expenditure Fund"],
  ["fundcd_prefix", "10403", "sagf", "Special Accounts in the General Fund (SAGF)"],
  ["object_code", "5010301000", "statutory", "Retirement and Life Insurance Premiums (RLIP)"],
];

export const VIEW_PATHS: Record<ViewMode, string[]> = {
  place: ["Dept", "Agency", "Region", "Division", "OU", "Program"],
  nep: ["Dept", "Agency", "Program", "Region", "Division", "OU"],
};

export interface BudgetRec {
  id?: string;
  amount?: number;
  description?: string;
  prexc_fpap_id?: string;
  prexc_level?: number;
  org_uacs_code?: string;
  region_code?: string;
  division_code?: string;
  division_name?: string;
  funding_uacs_code?: string;
  object_uacs_code?: string;
  excel_row?: number;
  sorder?: string;
  [key: string]: unknown;
}

export interface EnrichedRec extends BudgetRec {
  amount_display_pesos: number;
  program_description: string;
  object_name: string;
  funding_name: string;
  org_name: string;
  region_name: string;
  line_label: string;
}

export interface TreeNode {
  key: string;
  kind: string;
  code: string;
  label: string;
  parent_key: string;
  item_count: number | null;
  total_amount: number;
  amount_display_trillions: number;
  shard: string | null;
  children: TreeNode[];
  child_count?: number;
}

interface RawTreeNode {
  kind: string;
  code: string;
  label: string;
  parent_key?: string;
  item_count?: number;
  total_amount?: number;
  shard?: string | null;
  children?: string[];
  child_keys?: string[];
}

interface Meta {
  fiscal_year: string;
  grand_total_thousands: number;
  aa_total_thousands: number;
  programmed_total_thousands: number;
  aa_items?: Record<
    string,
    { name?: string; item_count?: number; amount_thousands?: number; category?: string }
  >;
  shard_count?: number;
}

interface Manifest {
  all: string[];
  by_agency: Record<string, string[]>;
  dept_agencies: Record<string, string[]>;
}

export function whichAaRule(rec: BudgetRec): string | null {
  const fc = rec.funding_uacs_code || "";
  const obj = rec.object_uacs_code || "";
  for (const [matchType, key] of AA_RULES) {
    if (matchType === "fundcd" && fc === key) return key;
    if (matchType === "fundcd_prefix" && fc.startsWith(key)) return key;
    if (matchType === "object_code" && obj === key) return key;
  }
  return null;
}

function hydrateTree(raw: {
  view?: string;
  roots?: string[];
  nodes?: Record<string, RawTreeNode>;
}): { view: string; nodes: Map<string, TreeNode>; roots: TreeNode[] } {
  const nodes = new Map<string, TreeNode>();
  for (const [key, n] of Object.entries(raw.nodes || {})) {
    nodes.set(key, {
      key,
      kind: n.kind,
      code: n.code,
      label: n.label,
      parent_key: n.parent_key || "",
      item_count: n.item_count ?? 0,
      total_amount: n.total_amount || 0,
      amount_display_trillions: ((n.total_amount || 0) * 1000) / 1e12,
      shard: n.shard || null,
      children: [],
    });
  }
  for (const [key, n] of Object.entries(raw.nodes || {})) {
    const parent = nodes.get(key)!;
    const childKeys = n.child_keys || [];
    for (const ck of childKeys) {
      const child = nodes.get(ck);
      if (child) parent.children.push(child);
    }
    parent.children.sort((a, b) => b.total_amount - a.total_amount);
  }
  const roots = (raw.roots || [])
    .map((d) => nodes.get(`dept:${d}`))
    .filter((n): n is TreeNode => !!n)
    .sort((a, b) => b.total_amount - a.total_amount);
  return { view: raw.view || "place", nodes, roots };
}

export class YearData {
  year: string;
  repoBase: string;
  browserBase: string;
  meta: Meta | null = null;
  manifest: Manifest | null = null;
  trees: Record<ViewMode, ReturnType<typeof hydrateTree> | null> = {
    place: null,
    nep: null,
  };
  memShards = new Map<string, BudgetRec[]>();
  aaRows: BudgetRec[] | null = null;
  objects: Record<string, string> = {};
  funding: Record<string, string> = {};
  orgs: Record<string, string> = {};
  regions: Record<string, string> = {};

  constructor(year: string, repoBase: string) {
    this.year = year;
    this.repoBase = repoBase.replace(/\/$/, "");
    this.browserBase = `${this.repoBase}/data/budget/${year}/browser`;
  }

  async init() {
    this.meta = (await fetchGzJson(`${this.browserBase}/meta.json.gz`)) as Meta;
    this.manifest = (await fetchGzJson(`${this.browserBase}/manifest.json.gz`)) as Manifest;
    await this.loadRefs();
    return this.meta;
  }

  async loadRefs() {
    const base = this.repoBase;
    const urls = [
      `${base}/data/object_code/sub_objects.json`,
      `${base}/data/funding_source/funding_sources.json`,
      `${base}/data/organization/organizations.json`,
      `${base}/data/location/regions.json`,
    ];
    try {
      const [objs, funds, orgs, regions] = await Promise.all(
        urls.map((u) =>
          fetch(u, { cache: "no-cache" }).then((r) => {
            if (!r.ok) throw new Error(`${u} ${r.status}`);
            return r.json();
          }),
        ),
      );
      this.objects = Object.fromEntries(
        (objs || []).map((o: { uacs_code: string; description?: string }) => [
          String(o.uacs_code),
          o.description || "",
        ]),
      );
      this.funding = Object.fromEntries(
        (funds || []).map((f: { uacs_code: string; description?: string }) => [
          String(f.uacs_code),
          f.description || "",
        ]),
      );
      this.orgs = Object.fromEntries(
        (orgs || []).map((o: { uacs_code: string; description?: string }) => [
          String(o.uacs_code),
          o.description || "",
        ]),
      );
      this.regions = Object.fromEntries(
        (regions || []).map((r: { code: string; description?: string }) => [
          String(r.code),
          r.description || "",
        ]),
      );
    } catch (err) {
      console.error("[NEP] Failed to load reference labels", err);
    }
  }

  enrich(rec: BudgetRec): EnrichedRec {
    const obj = rec.object_uacs_code || "";
    const fund = rec.funding_uacs_code || "";
    const org = rec.org_uacs_code || "";
    const region = rec.region_code || "";
    const objectName = this.objects[obj] || "";
    return {
      ...rec,
      amount_display_pesos: (rec.amount || 0) * 1000,
      program_description: rec.description || "",
      object_name: objectName || (obj ? `Object ${obj}` : "—"),
      funding_name: this.funding[fund] || fund || "—",
      org_name: this.orgs[org] || "",
      region_name: this.regions[region] || region || "—",
      line_label: objectName || (obj ? `Object ${obj}` : rec.description || "—"),
    };
  }

  async loadTree(view: ViewMode) {
    if (!this.trees[view]) {
      const raw = await fetchGzJson(`${this.browserBase}/${view}_tree.json.gz`);
      this.trees[view] = hydrateTree(raw as Parameters<typeof hydrateTree>[0]);
    }
    return this.trees[view]!;
  }

  async loadShard(rel: string): Promise<BudgetRec[]> {
    if (this.memShards.has(rel)) return this.memShards.get(rel)!;
    const url =
      rel === "aa.json.gz"
        ? `${this.browserBase}/aa.json.gz`
        : `${this.browserBase}/shards/${rel}`;
    const rows = (await fetchGzJson(url)) as BudgetRec[];
    this.memShards.set(rel, rows);
    return rows;
  }

  shardPathsForDept(deptCode: string): string[] {
    const agencies = this.manifest?.dept_agencies?.[deptCode] || [];
    const paths: string[] = [];
    for (const a of agencies) {
      paths.push(...(this.manifest?.by_agency?.[a] || []));
    }
    return paths;
  }

  estimateShardDownloadMb(paths: string[]) {
    return Math.max(0.1, (paths.length * 8) / 1024);
  }

  estimateRamMb(rowCount: number) {
    return Math.round((rowCount * 0.8) / 1024);
  }

  programmedItemCount() {
    const place = this.trees.place;
    if (!place) return 0;
    return place.roots.reduce((s, d) => s + (d.item_count || 0), 0);
  }

  async loadAaRows() {
    if (!this.aaRows) this.aaRows = await this.loadShard("aa.json.gz");
    return this.aaRows;
  }

  async recordsForNode(view: ViewMode, node: TreeNode): Promise<BudgetRec[]> {
    if (node.kind === "aa_item" || (node.kind === "section" && node.code === "automatic")) {
      return this.loadAaRows();
    }
    if (node.kind === "section" && node.code === "programmed") {
      return this.loadMany(this.manifest?.all || []);
    }
    if (node.shard) return this.loadShard(node.shard);
    if (node.kind === "dept") return this.loadMany(this.shardPathsForDept(node.code));
    if (node.kind === "agency") {
      return this.loadMany(this.manifest?.by_agency?.[node.code] || []);
    }
    if (view === "nep" && node.kind === "program") {
      const agency = (node.parent_key || "").split(":")[1];
      return this.loadMany(this.manifest?.by_agency?.[agency] || []);
    }
    let cur: TreeNode | undefined = node;
    const tree = this.trees[view];
    while (cur) {
      if (cur.shard) return this.loadShard(cur.shard);
      cur = cur.parent_key && tree ? tree.nodes.get(cur.parent_key) : undefined;
    }
    return [];
  }

  async loadMany(paths: string[]) {
    const out: BudgetRec[] = [];
    for (const p of paths) out.push(...(await this.loadShard(p)));
    return out;
  }

  matchesNode(view: ViewMode, rec: BudgetRec, node: TreeNode): boolean {
    if (node.kind === "section" && node.code === "automatic") return whichAaRule(rec) != null;
    if (node.kind === "aa_item") return whichAaRule(rec) === node.code;
    if (rec.prexc_level !== 7 || whichAaRule(rec)) return false;
    const org = rec.org_uacs_code || "";
    const prexc = String(rec.prexc_fpap_id || "").padStart(15, "0");
    const region = rec.region_code || "_none";
    const division = rec.division_code || "_none";

    if (node.kind === "dept") return org.startsWith(node.code);
    if (node.kind === "agency") return org.startsWith(node.code);

    if (view === "nep") {
      if (node.kind === "program") {
        const agency = (node.parent_key || "").split(":")[1];
        return org.startsWith(agency || "") && prexc === node.code;
      }
      if (node.kind === "region") {
        const [agency, px, reg] = node.code.split("|");
        return org.startsWith(agency) && prexc === px && region === reg;
      }
      if (node.kind === "division") {
        const [agency, px, reg, div] = node.code.split("|");
        return org.startsWith(agency) && prexc === px && region === reg && division === div;
      }
      if (node.kind === "ou") {
        const parts = node.code.split("|");
        const [agency, px, reg, div, orgCode] = parts;
        return (
          org === orgCode &&
          prexc === px &&
          region === reg &&
          division === div &&
          org.startsWith(agency)
        );
      }
    } else {
      if (node.kind === "region") {
        const [agency, reg] = node.code.split("|");
        return org.startsWith(agency) && region === reg;
      }
      if (node.kind === "division") {
        const [agency, reg, div] = node.code.split("|");
        return org.startsWith(agency) && region === reg && division === div;
      }
      if (node.kind === "ou") return org === node.code;
      if (node.kind === "program") {
        const ou = (node.parent_key || "").split(":")[1];
        return org === ou && prexc === node.code;
      }
    }
    return false;
  }
}

export async function discoverYears(repoBase: string): Promise<string[]> {
  const years: string[] = [];
  for (const y of ["2027", "2026", "2025", "2024"]) {
    try {
      await fetchGzJson(`${repoBase}/data/budget/${y}/browser/meta.json.gz`);
      years.push(y);
    } catch {
      /* skip */
    }
  }
  return years;
}

export function isItemLeaf(view: ViewMode, node: TreeNode | null): boolean {
  if (!node) return false;
  if (node.kind === "aa_item") return true;
  if (view === "place") return node.kind === "program";
  if (view === "nep") return node.kind === "ou";
  return false;
}

export function isExpandable(node: TreeNode): boolean {
  const n = node.child_count ?? node.children?.length ?? 0;
  return n > 0 && node.kind !== "aa_item";
}
