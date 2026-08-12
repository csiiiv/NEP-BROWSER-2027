import { fetchGzJson } from "./cache.js";

/** Same AA rules as the Python pipeline / FastAPI browser. */
export const AA_RULES = [
  ["fundcd", "10401110", "debt_service", "Debt Service - Interest Payments"],
  ["fundcd", "10401258", "lgu_share", "National Tax Allotment (NTA)"],
  ["fundcd", "10401257", "lgu_share", "BARMM Annual Block Grant"],
  ["fundcd", "10401280", "net_lending", "Net Lending to GOCCs"],
  ["fundcd", "10401105", "tax_expenditure", "Tax Expenditure Fund"],
  ["fundcd_prefix", "10403", "sagf", "Special Accounts in the General Fund (SAGF)"],
  ["object_code", "5010301000", "statutory", "Retirement and Life Insurance Premiums (RLIP)"],
];

export function whichAaRule(rec) {
  const fc = rec.funding_uacs_code || "";
  const obj = rec.object_uacs_code || "";
  for (const [matchType, key] of AA_RULES) {
    if (matchType === "fundcd" && fc === key) return key;
    if (matchType === "fundcd_prefix" && fc.startsWith(key)) return key;
    if (matchType === "object_code" && obj === key) return key;
  }
  return null;
}

function hydrateTree(raw) {
  const nodes = new Map();
  for (const [key, n] of Object.entries(raw.nodes || {})) {
    nodes.set(key, {
      key,
      kind: n.kind,
      code: n.code,
      label: n.label,
      parent_key: n.parent_key || "",
      item_count: n.item_count || 0,
      total_amount: n.total_amount || 0,
      amount_display_trillions: (n.total_amount || 0) * 1000 / 1e12,
      shard: n.shard || null,
      children: [],
      child_map: {},
    });
  }
  for (const [key, n] of Object.entries(raw.nodes || {})) {
    const parent = nodes.get(key);
    const mapKeys = n.children || [];
    const childKeys = n.child_keys || [];
    for (let i = 0; i < childKeys.length; i++) {
      const child = nodes.get(childKeys[i]);
      if (!child) continue;
      parent.children.push(child);
      parent.child_map[mapKeys[i] ?? child.code] = child;
    }
    // Sort children by amount desc (same as API)
    parent.children.sort((a, b) => b.total_amount - a.total_amount);
  }
  const roots = (raw.roots || [])
    .map((d) => nodes.get(`dept:${d}`))
    .filter(Boolean)
    .sort((a, b) => b.total_amount - a.total_amount);
  return { view: raw.view, nodes, roots };
}

export class YearData {
  constructor(year, repoBase) {
    this.year = year;
    this.repoBase = repoBase.replace(/\/$/, "");
    this.browserBase = `${this.repoBase}/data/budget/${year}/browser`;
    this.meta = null;
    this.manifest = null;
    this.trees = { place: null, nep: null };
    this.memShards = new Map();
    this.aaRows = null;
    this.yearIndex = null; // slim rows for whole-year search
    this.deptIndexes = new Map();
    this.objects = {};
    this.funding = {};
    this.orgs = {};
    this.regions = {};
  }

  async init() {
    this.meta = await fetchGzJson(`${this.browserBase}/meta.json.gz`);
    this.manifest = await fetchGzJson(`${this.browserBase}/manifest.json.gz`);
    await this.loadRefs();
    return this.meta;
  }

  async loadRefs() {
    const base = this.repoBase;
    const urls = {
      objects: `${base}/data/object_code/sub_objects.json`,
      funding: `${base}/data/funding_source/funding_sources.json`,
      orgs: `${base}/data/organization/organizations.json`,
      regions: `${base}/data/location/regions.json`,
    };
    try {
      const [objs, funds, orgs, regions] = await Promise.all(
        Object.values(urls).map((u) =>
          fetch(u, { cache: "no-cache" }).then((r) => {
            if (!r.ok) throw new Error(`${u} ${r.status}`);
            return r.json();
          }),
        ),
      );
      this.objects = Object.fromEntries(
        (objs || []).map((o) => [String(o.uacs_code), o.description || ""]),
      );
      this.funding = Object.fromEntries(
        (funds || []).map((f) => [String(f.uacs_code), f.description || ""]),
      );
      this.orgs = Object.fromEntries(
        (orgs || []).map((o) => [String(o.uacs_code), o.description || ""]),
      );
      this.regions = Object.fromEntries(
        (regions || []).map((r) => [String(r.code), r.description || ""]),
      );
      console.info(
        `[NEP] Loaded ${Object.keys(this.objects).length} expense objects, `
        + `${Object.keys(this.funding).length} funding sources`,
      );
    } catch (err) {
      console.error("[NEP] Failed to load reference labels", err);
      this.objects = {};
      this.funding = {};
      this.orgs = {};
      this.regions = {};
    }
  }

  enrich(rec) {
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
      line_label: objectName || (obj ? `Object ${obj}` : (rec.description || "—")),
    };
  }

  async loadTree(view) {
    if (!this.trees[view]) {
      const raw = await fetchGzJson(`${this.browserBase}/${view}_tree.json.gz`);
      this.trees[view] = hydrateTree(raw);
    }
    return this.trees[view];
  }

  async loadShard(rel) {
    if (this.memShards.has(rel)) return this.memShards.get(rel);
    const url = rel === "aa.json.gz"
      ? `${this.browserBase}/aa.json.gz`
      : `${this.browserBase}/shards/${rel}`;
    const rows = await fetchGzJson(url);
    this.memShards.set(rel, rows);
    return rows;
  }

  shardPathsForDept(deptCode) {
    const agencies = this.manifest.dept_agencies?.[deptCode] || [];
    const paths = [];
    for (const a of agencies) {
      paths.push(...(this.manifest.by_agency?.[a] || []));
    }
    return paths;
  }

  estimateShardDownloadMb(paths) {
    // Rough: ~8KB compressed average observed; prefer meta later
    return Math.max(0.1, (paths.length * 8) / 1024);
  }

  estimateRamMb(rowCount) {
    // Slim in-memory search docs ~0.4–1KB each; warn with upper band
    return Math.round((rowCount * 0.8) / 1024);
  }

  programmedItemCount() {
    const place = this.trees.place;
    if (!place) return this.meta?.place_nodes || 0;
    return place.roots.reduce((s, d) => s + (d.item_count || 0), 0);
  }

  async loadAaRows() {
    if (!this.aaRows) this.aaRows = await this.loadShard("aa.json.gz");
    return this.aaRows;
  }

  /** Records for a tree node (leaf or branch). Branch may pull many shards. */
  async recordsForNode(view, node) {
    if (node.kind === "aa_item" || (node.kind === "section" && node.code === "automatic")) {
      return this.loadAaRows();
    }
    if (node.kind === "section" && node.code === "programmed") {
      return this.loadAllProgrammed();
    }
    if (node.shard) {
      return this.loadShard(node.shard);
    }
    if (node.kind === "dept") {
      const paths = this.shardPathsForDept(node.code);
      return this.loadMany(paths);
    }
    if (node.kind === "agency") {
      return this.loadMany(this.manifest.by_agency?.[node.code] || []);
    }
    if (view === "nep" && node.kind === "program") {
      // parent agency from parent_key agency:XXXXX
      const agency = (node.parent_key || "").split(":")[1];
      return this.loadMany(this.manifest.by_agency?.[agency] || []);
    }
    // Walk for shard
    let cur = node;
    while (cur) {
      if (cur.shard) return this.loadShard(cur.shard);
      cur = cur.parent_key ? this.trees[view]?.nodes.get(cur.parent_key) : null;
    }
    return [];
  }

  async loadMany(paths) {
    const out = [];
    for (const p of paths) {
      out.push(...(await this.loadShard(p)));
    }
    return out;
  }

  async loadAllProgrammed() {
    return this.loadMany(this.manifest.all || []);
  }

  slimDoc(rec, view) {
    const org = rec.org_uacs_code || "";
    return {
      id: rec.id,
      description: rec.description || "",
      amount: rec.amount || 0,
      amount_display_pesos: (rec.amount || 0) * 1000,
      prexc_fpap_id: rec.prexc_fpap_id,
      prexc_level: rec.prexc_level,
      org_uacs_code: org,
      region_code: rec.region_code,
      division_code: rec.division_code,
      funding_uacs_code: rec.funding_uacs_code,
      object_uacs_code: rec.object_uacs_code,
      dept: org.slice(0, 2),
      agency: org.slice(0, 5),
      view,
    };
  }

  matchesNode(view, rec, node) {
    if (node.kind === "section" && node.code === "automatic") {
      return whichAaRule(rec) != null;
    }
    if (node.kind === "aa_item") {
      return whichAaRule(rec) === node.code;
    }
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
        const orgCode = parts[parts.length - 1];
        const agency = parts[0];
        const px = parts[1];
        const reg = parts[2];
        const div = parts[3];
        return org === orgCode && prexc === px && region === reg && division === div && org.startsWith(agency);
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

export async function discoverYears(repoBase) {
  const years = [];
  for (const y of ["2027", "2026", "2025", "2024"]) {
    try {
      await fetchGzJson(`${repoBase}/data/budget/${y}/browser/meta.json.gz`);
      years.push(y);
    } catch (_) {
      /* skip */
    }
  }
  return years;
}

export function isItemLeaf(view, node) {
  if (!node) return false;
  if (node.kind === "aa_item") return true;
  if (view === "place") return node.kind === "program";
  if (view === "nep") return node.kind === "ou";
  return false;
}
