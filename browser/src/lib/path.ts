import type { BudgetRec, TreeNode, ViewMode, YearData } from "./data";
import { whichAaRule } from "./data";
import { nodeKey } from "./format";

export interface Crumb {
  key: string;
  label: string;
  kind: string;
  node: TreeNode;
}

/** Tree leaf key that owns this line item in the given view. */
export function leafKeyForRec(view: ViewMode, rec: BudgetRec): string | null {
  const aa = whichAaRule(rec);
  if (aa) return `aa_item:${aa}`;
  if (rec.prexc_level !== 7) return null;

  const org = rec.org_uacs_code || "";
  if (org.length < 5) return null;
  const agency = org.slice(0, 5);
  const prexc = String(rec.prexc_fpap_id || "").padStart(15, "0");
  const region = rec.region_code || "_none";
  const division = rec.division_code || "_none";

  if (view === "nep") {
    return `ou:${agency}|${prexc}|${region}|${division}|${org}`;
  }
  return `program:${org}:${prexc}`;
}

/** Hierarchy crumbs for a line item (not the current selection). */
export function buildItemCrumbTrail(
  rec: BudgetRec,
  root: TreeNode,
  sections: TreeNode[],
  store: YearData,
  view: ViewMode,
): Crumb[] {
  const key = leafKeyForRec(view, rec);
  if (!key) return [];
  const node = findNodeByKey(root, sections, store, view, key);
  if (!node) return [];
  return buildCrumbTrail(node, root, sections, store, view);
}

/** Path segment for a node key (safe in hash routes). */
export function encodeNodeParam(key: string): string {
  return encodeURIComponent(key);
}

export function nodePath(year: string, view: ViewMode, key?: string | null): string {
  if (!key) return `/${year}/${view}`;
  return `/${year}/${view}/n/${encodeNodeParam(key)}`;
}

export function findNodeByKey(
  root: TreeNode,
  sections: TreeNode[],
  store: YearData,
  view: ViewMode,
  key: string,
): TreeNode | null {
  if (nodeKey(root) === key) return root;

  for (const section of sections) {
    if (nodeKey(section) === key) return section;
    for (const child of section.children || []) {
      if (nodeKey(child) === key) return child;
    }
  }

  const fromMap = store.trees[view]?.nodes.get(key);
  if (fromMap) return fromMap;

  const programmed = sections.find((s) => s.code === "programmed");
  if (programmed) {
    const walked = walkChildren(programmed, key);
    if (walked) return walked;
  }
  return null;
}

function walkChildren(node: TreeNode, key: string): TreeNode | null {
  for (const child of node.children || []) {
    if (nodeKey(child) === key) return child;
    const hit = walkChildren(child, key);
    if (hit) return hit;
  }
  return null;
}

export function buildCrumbTrail(
  node: TreeNode,
  root: TreeNode,
  sections: TreeNode[],
  store: YearData,
  view: ViewMode,
): Crumb[] {
  const sectionByKey = new Map(sections.map((s) => [nodeKey(s), s]));
  const tree = store.trees[view];
  const chain: TreeNode[] = [];
  let cur: TreeNode | null = node;

  while (cur) {
    chain.unshift(cur);
    const pk: string = cur.parent_key;
    if (!pk) break;
    if (pk === nodeKey(root) || pk === "root:total") {
      cur = root;
      continue;
    }
    if (sectionByKey.has(pk)) {
      cur = sectionByKey.get(pk)!;
      continue;
    }
    cur = tree?.nodes.get(pk) ?? null;
  }

  if (!chain.length || nodeKey(chain[0]) !== nodeKey(root)) {
    chain.unshift(root);
  }

  return chain.map((n) => ({
    key: nodeKey(n),
    label: n.label,
    kind: n.kind,
    node: n,
  }));
}

export function ancestorKeys(trail: Crumb[]): string[] {
  return trail.slice(0, -1).map((c) => c.key);
}
