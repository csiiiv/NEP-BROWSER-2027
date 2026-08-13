import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp, Columns3, Download, GripVertical, MoreHorizontal, Square } from "lucide-react";
import { AppChrome } from "@/components/AppChrome";
import { BreadcrumbChips } from "@/components/BreadcrumbChips";
import { ItemDetailModal } from "@/components/ItemDetailModal";
import { TreeSearch } from "@/components/TreeSearch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { cacheStats, clearNepCache, detectBase } from "@/lib/cache";
import {
  AA_RULES,
  VIEW_PATHS,
  YearData,
  discoverYears,
  isExpandable,
  isItemLeaf,
  whichAaRule,
  type EnrichedRec,
  type SearchScope,
  type TreeNode,
  type ViewMode,
  type BudgetRec,
} from "@/lib/data";
import {
  KIND_LABELS,
  displayCode,
  formatAmountP,
  formatAmountT,
  formatNum,
  nodeKey,
} from "@/lib/format";
import {
  ancestorKeys,
  buildCrumbTrail,
  buildItemCrumbTrail,
  findNodeByKey,
  nodePath,
  type Crumb,
} from "@/lib/path";
import {
  YOY_CURRENT_YEAR,
  YOY_PRIOR_YEAR,
  attachYoy,
  loadPriorAmountIndex,
  loadPriorTreeAmountIndex,
  treeNodeYoyLabel,
} from "@/lib/yoy";

const DEFAULT_EXPANDED = ["section:automatic", "section:programmed"] as const;
const ITEMS_CAP = 5000;
const ITEM_COLS_STORAGE_KEY = "nep-item-cols-v4";

type TreeSort = "amount" | "name" | "yoy";
type ItemColId =
  | "object"
  | "amount"
  | "yoy"
  | "funding"
  | "prog"
  | "region"
  | "div"
  | "ou"
  | "object_code"
  | "id";
type ItemSortKey = ItemColId;
type SortDir = "asc" | "desc";

interface SearchProgress {
  label: string;
  loaded: number;
  total: number;
  hits: number;
  amountThousands: number;
}

/** Order here is the default left-to-right column arrangement. */
const ITEM_COLUMNS: {
  id: ItemColId;
  label: string;
  header: string;
  defaultOn: boolean;
}[] = [
  { id: "object", label: "Expense object", header: "Expense object", defaultOn: true },
  { id: "amount", label: "Amount", header: "Amount", defaultOn: true },
  { id: "yoy", label: "YoY vs FY2026", header: "YoY", defaultOn: true },
  { id: "prog", label: "Program / PAP", header: "PROG", defaultOn: true },
  { id: "region", label: "Region", header: "REGION", defaultOn: true },
  { id: "div", label: "Division", header: "DIV", defaultOn: true },
  { id: "ou", label: "Operating unit", header: "OU", defaultOn: true },
  { id: "funding", label: "Funding", header: "Funding", defaultOn: true },
  { id: "object_code", label: "Object code", header: "Object code", defaultOn: true },
  { id: "id", label: "Record ID", header: "ID", defaultOn: true },
];

const ITEM_COL_BY_ID = Object.fromEntries(ITEM_COLUMNS.map((c) => [c.id, c])) as Record<
  ItemColId,
  (typeof ITEM_COLUMNS)[number]
>;

interface ColPrefs {
  order: ItemColId[];
  visible: ItemColId[];
}

function defaultColOrder(): ItemColId[] {
  return ITEM_COLUMNS.map((c) => c.id);
}

function defaultVisibleCols(): Set<ItemColId> {
  return new Set(ITEM_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id));
}

function defaultColPrefs(): ColPrefs {
  return {
    order: defaultColOrder(),
    visible: [...defaultVisibleCols()],
  };
}

function normalizeColOrder(order: ItemColId[]): ItemColId[] {
  const valid = new Set(defaultColOrder());
  const seen = new Set<ItemColId>();
  const next: ItemColId[] = [];
  for (const id of order) {
    if (valid.has(id) && !seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  for (const id of defaultColOrder()) {
    if (!seen.has(id)) next.push(id);
  }
  return next;
}

function loadColPrefs(): ColPrefs {
  try {
    const raw = localStorage.getItem(ITEM_COLS_STORAGE_KEY);
    if (!raw) return defaultColPrefs();
    const parsed = JSON.parse(raw) as unknown;
    const valid = new Set(defaultColOrder());

    // Legacy format: visible id array only
    if (Array.isArray(parsed)) {
      const visible = parsed.filter(
        (id): id is ItemColId => typeof id === "string" && valid.has(id as ItemColId),
      );
      return {
        order: defaultColOrder(),
        visible: visible.length ? visible : defaultColPrefs().visible,
      };
    }

    if (parsed && typeof parsed === "object") {
      const obj = parsed as { order?: unknown; visible?: unknown };
      const order = normalizeColOrder(
        Array.isArray(obj.order)
          ? obj.order.filter(
              (id): id is ItemColId => typeof id === "string" && valid.has(id as ItemColId),
            )
          : defaultColOrder(),
      );
      const visible = Array.isArray(obj.visible)
        ? obj.visible.filter(
            (id): id is ItemColId => typeof id === "string" && valid.has(id as ItemColId),
          )
        : defaultColPrefs().visible;
      return {
        order,
        visible: visible.length ? visible : defaultColPrefs().visible,
      };
    }
  } catch {
    /* ignore */
  }
  return defaultColPrefs();
}

function saveColPrefs(order: ItemColId[], visible: Set<ItemColId> | ItemColId[]) {
  try {
    const vis = visible instanceof Set ? [...visible] : visible;
    localStorage.setItem(
      ITEM_COLS_STORAGE_KEY,
      JSON.stringify({ order, visible: vis }),
    );
  } catch {
    /* ignore */
  }
}

function columnWidthPx(id: ItemColId): number {
  switch (id) {
    case "amount":
      return 112;
    case "yoy":
      return 72;
    case "region":
      return 120;
    case "div":
      return 120;
    case "object_code":
      return 128;
    case "id":
      return 148;
    case "funding":
      return 200;
    case "object":
    case "prog":
    case "ou":
    default:
      return 280;
  }
}

function cellText(item: EnrichedRec, col: ItemColId): string {
  switch (col) {
    case "object":
      return item.line_label || "";
    case "amount":
      return formatAmountP((item.amount || 0) * 1000);
    case "yoy":
      return item.yoy_label || "—";
    case "funding":
      return item.funding_name || "";
    case "prog":
      return item.program_description || "";
    case "region":
      return item.region_name || item.region_code || "";
    case "div": {
      const code = String(item.division_code || "");
      if (!code || code === "_none") return item.division_name || "—";
      return item.division_name || code;
    }
    case "ou":
      return item.org_name || item.org_uacs_code || "";
    case "object_code":
      return String(item.object_uacs_code || "");
    case "id":
      return String(item.id || "");
  }
}

function sortValue(item: EnrichedRec, key: ItemSortKey): string | number {
  if (key === "amount") return item.amount || 0;
  if (key === "yoy") {
    if (item.yoy_pct != null) return item.yoy_pct;
    if (item.yoy_label === "NEW") return Number.POSITIVE_INFINITY;
    return Number.NEGATIVE_INFINITY;
  }
  return cellText(item, key);
}

function sumAmountsThousands(rows: { amount?: number }[]): number {
  let sum = 0;
  for (const r of rows) sum += r.amount || 0;
  return sum;
}

function formatHitsSummary(count: number, amountThousands: number, noun = "hits"): string {
  return `${formatNum(count)} ${noun} · ${formatAmountP(amountThousands * 1000)}`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportItemsCsv(
  rows: EnrichedRec[],
  columns: { id: ItemColId; header: string }[],
  filename: string,
) {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          if (c.id === "amount") return String((row.amount || 0) * 1000);
          return csvEscape(cellText(row, c.id));
        })
        .join(","),
    );
  }
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const selectClass = cn(
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm shadow-xs",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none",
);

function treeYoySortKey(
  node: TreeNode,
  priorTreeAmounts: Map<string, number> | null,
): number {
  if (!priorTreeAmounts) return node.total_amount;
  const prior = priorTreeAmounts.get(node.key);
  if (prior === undefined || prior === 0) return Number.NEGATIVE_INFINITY;
  return ((node.total_amount - prior) / prior) * 100;
}

function sortTreeChildren(
  children: TreeNode[],
  sort: TreeSort,
  priorTreeAmounts: Map<string, number> | null = null,
): TreeNode[] {
  const arr = [...children];
  if (sort === "name") {
    arr.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  } else if (sort === "yoy") {
    arr.sort(
      (a, b) =>
        treeYoySortKey(b, priorTreeAmounts) - treeYoySortKey(a, priorTreeAmounts)
        || b.total_amount - a.total_amount,
    );
  } else {
    arr.sort((a, b) => b.total_amount - a.total_amount);
  }
  return arr;
}

function sortItems(rows: EnrichedRec[], key: ItemSortKey, dir: SortDir): EnrichedRec[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let cmp = 0;
    if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }
    return cmp * mul;
  });
}

export default function Explorer() {
  const { year: yearParam, view: viewParam, nodeKey: nodeKeyParam } = useParams();
  const navigate = useNavigate();
  const base = useMemo(() => detectBase(), []);
  const nodeId = nodeKeyParam ?? null;

  const [years, setYears] = useState<string[]>([]);
  const [store, setStore] = useState<YearData | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [cacheLabel, setCacheLabel] = useState("");
  const [showHeaderExtra, setShowHeaderExtra] = useState(false);
  const [showCards, setShowCards] = useState(false);
  const [mobilePane, setMobilePane] = useState<"tree" | "items">("tree");

  const year = yearParam || years[0] || "2027";
  const view: ViewMode = viewParam === "place" ? "place" : "nep";

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED),
  );
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([]);
  const [rootNode, setRootNode] = useState<TreeNode | null>(null);

  const [amountFilter, setAmountFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("selection");
  const [items, setItems] = useState<EnrichedRec[]>([]);
  const [itemsSummary, setItemsSummary] = useState("");
  const [itemsMode, setItemsMode] = useState<"empty" | "branch" | "loading" | "table">("empty");
  const [detail, setDetail] = useState<EnrichedRec | null>(null);
  const [treeSort, setTreeSort] = useState<TreeSort>("amount");
  const [itemSortKey, setItemSortKey] = useState<ItemSortKey>("amount");
  const [itemSortDir, setItemSortDir] = useState<SortDir>("desc");
  const [visibleCols, setVisibleCols] = useState<Set<ItemColId>>(() => {
    return new Set(loadColPrefs().visible);
  });
  const [colOrder, setColOrder] = useState<ItemColId[]>(() => loadColPrefs().order);
  const [colsOpen, setColsOpen] = useState(false);
  const [dragColId, setDragColId] = useState<ItemColId | null>(null);
  const [dragOverColId, setDragOverColId] = useState<ItemColId | null>(null);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [priorTreeAmounts, setPriorTreeAmounts] = useState<Map<string, number> | null>(null);
  const [panelHint, setPanelHint] = useState(
    "Expand the tree, then open a leaf (Program / OU) for line items.",
  );

  useEffect(() => {
    if (year !== YOY_CURRENT_YEAR && treeSort === "yoy") {
      setTreeSort("amount");
    }
  }, [year, treeSort]);

  const appliedNodeRef = useRef<string | null>(null);
  const itemsJobRef = useRef(0);
  const priorStoreRef = useRef<YearData | null>(null);
  const amountFilterRef = useRef(amountFilter);
  const searchRef = useRef(search);
  amountFilterRef.current = amountFilter;
  searchRef.current = search;

  function beginItemsJob() {
    itemsJobRef.current += 1;
    return itemsJobRef.current;
  }

  function isCurrentItemsJob(job: number) {
    return itemsJobRef.current === job;
  }

  function cancelSearch() {
    beginItemsJob();
    setSearchProgress(null);
    if (items.length) {
      setItemsMode("table");
    } else {
      setItemsMode("empty");
      setItemsSummary("");
      setPanelHint("Search cancelled.");
    }
  }

  async function priorAmountIndexFor(
    s: YearData,
    paths: string[],
  ): Promise<Map<string, number> | null> {
    if (s.year !== YOY_CURRENT_YEAR) return null;
    if (!priorStoreRef.current || priorStoreRef.current.repoBase !== s.repoBase) {
      priorStoreRef.current = new YearData(YOY_PRIOR_YEAR, s.repoBase);
    }
    return loadPriorAmountIndex(priorStoreRef.current, paths);
  }

  const refreshCache = useCallback(async (s: YearData | null) => {
    const st = await cacheStats();
    const nObj = Object.keys(s?.objects || {}).length;
    setCacheLabel(`Cache: ${st.entries} file(s) · ${nObj} object labels`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ys = await discoverYears(base);
        if (cancelled) return;
        if (!ys.length) {
          setBootError("No browser assets under /data/budget/*/browser.");
          return;
        }
        setYears((prev) => (prev.length === ys.length && prev.every((y, i) => y === ys[i]) ? prev : ys));
        const y = yearParam && ys.includes(yearParam) ? yearParam : ys[0];
        const v = viewParam === "place" || viewParam === "nep" ? viewParam : "nep";
        if (y !== yearParam || v !== viewParam) {
          // Preserve current node deep-link when correcting year/view only.
          navigate(nodePath(y, v, nodeKeyParam ?? null), { replace: true });
        }
      } catch (e) {
        if (!cancelled) setBootError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally omit nodeKey — tree navigation must not re-bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, navigate, yearParam, viewParam]);

  useEffect(() => {
    if (!years.length) return;
    let cancelled = false;
    (async () => {
      setItemsMode("loading");
      setSearchProgress(null);
      setSelected(null);
      setTrail([]);
      setExpanded(new Set(DEFAULT_EXPANDED));
      setDetail(null);
      setPriorTreeAmounts(null);
      appliedNodeRef.current = null;
      beginItemsJob(); // cancel any in-flight search / leaf load
      try {
        const s = new YearData(year, base);
        await s.init();
        await s.loadTree(view);
        if (cancelled) return;
        setStore(s);
        await buildRoot(s, view, year);
        await refreshCache(s);
        if (year === YOY_CURRENT_YEAR) {
          if (!priorStoreRef.current || priorStoreRef.current.repoBase !== base) {
            priorStoreRef.current = new YearData(YOY_PRIOR_YEAR, base);
          }
          try {
            const priorMap = await loadPriorTreeAmountIndex(priorStoreRef.current, view);
            if (!cancelled) setPriorTreeAmounts(priorMap);
          } catch (err) {
            console.warn("[NEP] Prior-year tree YoY unavailable", err);
            if (!cancelled) setPriorTreeAmounts(null);
          }
        }
        if (!nodeKeyParam) {
          setItemsMode("empty");
          setPanelHint("Expand the tree, then open a leaf (Program / OU) for line items.");
          setItems([]);
          setItemsSummary("");
        }
      } catch (e) {
        if (!cancelled) setBootError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, view, years, base]);

  async function buildRoot(s: YearData, v: ViewMode, y: string) {
    const tree = await s.loadTree(v);
    const m = s.meta!;
    const aaChildren: TreeNode[] = AA_RULES.map(([, key, , name]) => {
      const info = m.aa_items?.[key] || {};
      return {
        key: `aa_item:${key}`,
        kind: "aa_item",
        code: key,
        label: info.name || name,
        parent_key: "section:automatic",
        item_count: info.item_count || 0,
        total_amount: info.amount_thousands || 0,
        amount_display_trillions: ((info.amount_thousands || 0) * 1000) / 1e12,
        shard: null,
        children: [],
        child_count: 0,
      };
    }).sort((a, b) => b.total_amount - a.total_amount);

    const aaSection: TreeNode = {
      key: "section:automatic",
      kind: "section",
      code: "automatic",
      label: "Automatic Appropriations",
      parent_key: "root:total",
      item_count: aaChildren.reduce((sum, c) => sum + (c.item_count || 0), 0),
      total_amount: m.aa_total_thousands,
      amount_display_trillions: (m.aa_total_thousands * 1000) / 1e12,
      shard: null,
      children: aaChildren,
      child_count: aaChildren.length,
    };
    const progSection: TreeNode = {
      key: "section:programmed",
      kind: "section",
      code: "programmed",
      label: "Programmed Appropriations",
      parent_key: "root:total",
      item_count: tree.roots.reduce((sum, d) => sum + (d.item_count || 0), 0),
      total_amount: m.programmed_total_thousands,
      amount_display_trillions: (m.programmed_total_thousands * 1000) / 1e12,
      shard: null,
      children: tree.roots,
      child_count: tree.roots.length,
    };
    // Tree assets leave dept.parent_key empty; attach under Programmed for crumb climbs.
    for (const d of tree.roots) {
      if (!d.parent_key) d.parent_key = "section:programmed";
    }
    setRootNode({
      key: "root:total",
      kind: "root",
      code: "total",
      label: `Total Appropriations (FY ${y})`,
      parent_key: "",
      item_count: null,
      total_amount: m.grand_total_thousands,
      amount_display_trillions: (m.grand_total_thousands * 1000) / 1e12,
      shard: null,
      children: [aaSection, progSection],
      child_count: 2,
    });
    setRootChildren([aaSection, progSection]);
  }

  async function loadLeafItemsFor(s: YearData, v: ViewMode, node: TreeNode) {
    const job = beginItemsJob();
    setItemsMode("loading");
    setSearchProgress(null);
    const started = Date.now();
    try {
      const paths = shardPathsForNode(s, v, node);
      const [rows, priorByKey] = await Promise.all([
        s.recordsForNode(v, node),
        priorAmountIndexFor(s, paths),
      ]);
      if (!isCurrentItemsJob(job)) return;
      let matched = rows
        .filter((r) => s.matchesNode(v, r, node))
        .map((r) => s.enrich(r));
      matched = applyFilters(matched, amountFilterRef.current, searchRef.current);
      matched = attachYoy(matched, priorByKey);
      if (!isCurrentItemsJob(job)) return;
      const capped = matched.length > ITEMS_CAP;
      const rowsOut = capped ? matched.slice(0, ITEMS_CAP) : matched;
      setItems(rowsOut);
      setItemsSummary(
        `${formatHitsSummary(matched.length, sumAmountsThousands(matched), "matching")}`
          + (capped ? ` (showing first ${formatNum(ITEMS_CAP)})` : "")
          + ` · ${((Date.now() - started) / 1000).toFixed(2)}s · leaf shard`,
      );
      setItemsMode("table");
    } catch (e) {
      if (!isCurrentItemsJob(job)) return;
      setItemsMode("empty");
      setPanelHint(`Error: ${e}`);
    }
  }

  const applyNodeSelection = useCallback(
    async (node: TreeNode, crumbs: Crumb[], s: YearData, v: ViewMode) => {
      setSelected(node);
      setTrail(crumbs);
      setDetail(null);
      setMobilePane("items");
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const k of ancestorKeys(crumbs)) next.add(k);
        return next;
      });
      if (isItemLeaf(v, node)) {
        await loadLeafItemsFor(s, v, node);
      } else {
        beginItemsJob(); // drop any in-flight search results
        setItemsMode("branch");
        setItems([]);
        setItemsSummary(
          node.item_count != null
            ? `${formatNum(node.item_count)} rolled-up items · ${formatAmountT(node.amount_display_trillions)}`
            : formatAmountT(node.amount_display_trillions),
        );
        const leafName = v === "nep" ? "OU" : "Program";
        setPanelHint(
          `Branch total only. Line items are on leaf nodes (${leafName}). Use Search with scope “Current selection” or “All”.`,
        );
      }
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-key="${CSS.escape(nodeKey(node))}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    },
    [],
  );

  useEffect(() => {
    if (!store || !rootNode || !rootChildren.length) return;
    let cancelled = false;

    (async () => {
      if (!nodeId) {
        if (appliedNodeRef.current !== null) {
          appliedNodeRef.current = null;
          beginItemsJob();
          setSelected(null);
          setTrail([]);
          setDetail(null);
          setItemsMode("empty");
          setItems([]);
          setItemsSummary("");
          setPanelHint("Expand the tree, then open a leaf (Program / OU) for line items.");
        }
        return;
      }
      if (appliedNodeRef.current === nodeId) return;
      const node = findNodeByKey(rootNode, rootChildren, store, view, nodeId);
      if (!node) {
        appliedNodeRef.current = nodeId;
        setSelected(null);
        setTrail([]);
        setItemsMode("empty");
        setPanelHint(`Node not found for this view: ${nodeId}`);
        return;
      }
      const crumbs = buildCrumbTrail(node, rootNode, rootChildren, store, view);
      appliedNodeRef.current = nodeId;
      if (!cancelled) await applyNodeSelection(node, crumbs, store, view);
    })();

    return () => {
      cancelled = true;
    };
  }, [store, rootNode, rootChildren, nodeId, view, applyNodeSelection]);

  function setYear(y: string) {
    navigate(nodePath(y, view));
  }
  function setView(v: ViewMode) {
    navigate(nodePath(year, v));
  }

  function goToNode(key: string) {
    navigate(nodePath(year, view, key));
  }

  function onSelect(node: TreeNode) {
    goToNode(nodeKey(node));
  }

  async function loadLeafItems(node: TreeNode) {
    if (!store) return;
    await loadLeafItemsFor(store, view, node);
  }

  function applyFilters(rows: EnrichedRec[], amt: string, qRaw: string) {
    let out = rows;
    if (amt === "nonzero") out = out.filter((r) => (r.amount || 0) !== 0);
    if (amt === "zero") out = out.filter((r) => (r.amount || 0) === 0);
    if (qRaw.trim()) {
      const q = qRaw.trim().toLowerCase();
      out = out.filter((r) =>
        [r.object_name, r.funding_name, r.program_description, r.object_uacs_code]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    return out;
  }

  async function runSearch() {
    if (!store) return;
    const q = search.trim();

    if (searchScope === "selection") {
      if (!selected) {
        alert("Select a node in the hierarchy first.");
        return;
      }
      if (!q) {
        if (isItemLeaf(view, selected)) await loadLeafItems(selected);
        return;
      }
      await searchWithinNode(selected, q);
      return;
    }

    // Scope: All (entire year)
    if (!q) {
      alert("Enter a search term to search the entire year.");
      return;
    }
    const paths = store.manifest?.all || [];
    const rowsEst = store.programmedItemCount() || 500000;
    const ok = confirm(
      `Search all programmed shards for FY ${year}?\n\n`
        + `~${paths.length} files · ~${store.estimateShardDownloadMb(paths).toFixed(1)} MB download\n`
        + `Rough RAM: ~${store.estimateRamMb(rowsEst)} MB\n\nContinue?`,
    );
    if (!ok) return;
    await searchShards(paths, q, `FY ${year}`, (r) => r.prexc_level === 7 && !whichAaRule(r));
  }

  async function searchWithinNode(node: TreeNode, q: string) {
    if (!store) return;
    const paths = shardPathsForNode(store, view, node);
    if (!paths.length) {
      setItemsMode("empty");
      setPanelHint("No shards found for this selection.");
      return;
    }
    const broad =
      node.kind === "root"
      || (node.kind === "section" && node.code === "programmed")
      || (node.item_count != null && node.item_count > 50000)
      || paths.length > 40;
    if (broad) {
      const ok = confirm(
        `Search within “${node.label}”?\n\n`
          + `~${paths.length} shard file(s)`
          + (node.item_count != null ? ` · ~${formatNum(node.item_count)} items` : "")
          + `\n\nContinue?`,
      );
      if (!ok) return;
    }
    await searchShards(paths, q, node.label, (r) => store.matchesNode(view, r, node));
  }

  async function searchShards(
    paths: string[],
    q: string,
    label: string,
    preFilter: (r: BudgetRec) => boolean,
  ) {
    if (!store) return;
    const job = beginItemsJob();
    setItemsMode("loading");
    setDetail(null);
    setSearchProgress({ label, loaded: 0, total: paths.length, hits: 0, amountThousands: 0 });
    setPanelHint(`Searching ${label}…`);
    const started = Date.now();
    const qLower = q.toLowerCase();
    const matched: EnrichedRec[] = [];
    const amt = amountFilterRef.current;
    try {
      const priorByKey = await priorAmountIndexFor(store, paths);
      if (!isCurrentItemsJob(job)) return;
      let loaded = 0;
      for (const p of paths) {
        if (!isCurrentItemsJob(job)) return;
        const rows = await store.loadShard(p);
        if (!isCurrentItemsJob(job)) return;
        loaded++;
        for (const r of rows) {
          if (!preFilter(r)) continue;
          if (amt === "nonzero" && !r.amount) continue;
          if (amt === "zero" && r.amount) continue;
          const enriched = store.enrich(r);
          const hay = [enriched.object_name, enriched.funding_name, enriched.program_description, enriched.object_uacs_code]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(qLower)) continue;
          matched.push(enriched);
          if (matched.length >= ITEMS_CAP) break;
        }
        const amountThousands = sumAmountsThousands(matched);
        setSearchProgress({
          label,
          loaded,
          total: paths.length,
          hits: matched.length,
          amountThousands,
        });
        setPanelHint(
          `Searching ${label}… ${loaded}/${paths.length} shards · ${formatHitsSummary(matched.length, amountThousands)}`,
        );
        if (matched.length >= ITEMS_CAP) break;
      }
      if (!isCurrentItemsJob(job)) return;
      const withYoy = attachYoy(matched, priorByKey);
      const amountThousands = sumAmountsThousands(withYoy);
      setItems(withYoy);
      setItemsSummary(
        `${formatHitsSummary(withYoy.length, amountThousands)} in ${label}`
          + (withYoy.length >= ITEMS_CAP ? ` (capped at ${formatNum(ITEMS_CAP)})` : "")
          + ` · ${((Date.now() - started) / 1000).toFixed(1)}s · ${loaded}/${paths.length} shards`,
      );
      setItemsMode("table");
    } catch (e) {
      if (!isCurrentItemsJob(job)) return;
      setItemsMode("empty");
      setPanelHint(`Error: ${e}`);
    } finally {
      if (isCurrentItemsJob(job)) setSearchProgress(null);
    }
  }

  const sortedItems = useMemo(
    () => sortItems(items, itemSortKey, itemSortDir),
    [items, itemSortKey, itemSortDir],
  );

  const itemsTotalThousands = useMemo(
    () => sumAmountsThousands(sortedItems),
    [sortedItems],
  );

  const activeColumns = useMemo(
    () =>
      colOrder
        .filter((id) => visibleCols.has(id))
        .filter((id) => id !== "yoy" || year === YOY_CURRENT_YEAR)
        .map((id) => ITEM_COL_BY_ID[id])
        .filter(Boolean),
    [colOrder, visibleCols, year],
  );

  const tableWidthPx = useMemo(
    () => activeColumns.reduce((sum, col) => sum + columnWidthPx(col.id), 0),
    [activeColumns],
  );

  const orderedColumns = useMemo(
    () =>
      colOrder
        .filter((id) => id !== "yoy" || year === YOY_CURRENT_YEAR)
        .map((id) => ITEM_COL_BY_ID[id])
        .filter(Boolean),
    [colOrder, year],
  );

  const detailTrail = useMemo(() => {
    if (!detail || !store || !rootNode) return trail;
    const itemTrail = buildItemCrumbTrail(detail, rootNode, rootChildren, store, view);
    return itemTrail.length ? itemTrail : trail;
  }, [detail, store, rootNode, rootChildren, view, trail]);

  const treeForest = useMemo(() => {
    if (!rootNode) return [];
    return [{ ...rootNode, children: rootChildren.length ? rootChildren : rootNode.children }];
  }, [rootNode, rootChildren]);

  function toggleItemSort(key: ItemSortKey) {
    if (itemSortKey === key) {
      setItemSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setItemSortKey(key);
      setItemSortDir(key === "amount" ? "desc" : "asc");
    }
  }

  function toggleColumn(id: ItemColId, on: boolean) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else {
        if (next.size <= 1) return prev;
        next.delete(id);
      }
      saveColPrefs(colOrder, next);
      return next;
    });
  }

  function moveColumn(fromId: ItemColId, toId: ItemColId) {
    if (fromId === toId) return;
    setColOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(fromId);
      const to = next.indexOf(toId);
      if (from < 0 || to < 0) return prev;
      next.splice(from, 1);
      next.splice(to, 0, fromId);
      saveColPrefs(next, visibleCols);
      return next;
    });
  }

  function nudgeColumn(id: ItemColId, dir: -1 | 1) {
    setColOrder((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      saveColPrefs(next, visibleCols);
      return next;
    });
  }

  function resetColumns() {
    const prefs = defaultColPrefs();
    setColOrder(prefs.order);
    setVisibleCols(new Set(prefs.visible));
    saveColPrefs(prefs.order, prefs.visible);
  }

  if (bootError) {
    return <div className="tree-empty">{bootError}</div>;
  }
  if (!store || !rootNode) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
        Loading NEP assets…
      </div>
    );
  }

  const m = store.meta!;
  const share = m.grand_total_thousands
    ? (m.aa_total_thousands / m.grand_total_thousands) * 100
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <AppChrome year={year} view={view}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <select
            className={cn(selectClass, "h-7 text-xs")}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            aria-label="Fiscal year"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={view}
            onValueChange={(v) => {
              if (v === "place" || v === "nep") setView(v);
            }}
            aria-label="Hierarchy view"
          >
            <ToggleGroupItem value="place" className="h-7 px-2.5 text-xs">Place</ToggleGroupItem>
            <ToggleGroupItem value="nep" className="h-7 px-2.5 text-xs">NEP</ToggleGroupItem>
          </ToggleGroup>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {view === "nep" ? "Program-first" : "Geography-first"}
          </span>
          <span className="text-xs text-muted-foreground">
            Total{" "}
            <b className="font-semibold text-foreground tabular-nums">
              {formatAmountP(m.grand_total_thousands * 1000)}
            </b>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowHeaderExtra((x) => !x)}
          >
            {showHeaderExtra ? "Less" : "Details"}
          </Button>
          <span className="ml-auto hidden text-[10px] text-muted-foreground lg:inline">
            DBM NEP · not official · AI-assisted — verify before citing
          </span>
        </div>

        {showHeaderExtra && (
          <div className="space-y-2 border-t border-border px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Automatic{" "}
                <b className="font-semibold text-aa tabular-nums">
                  {formatAmountP(m.aa_total_thousands * 1000)}
                </b>
                <span className="text-muted-foreground/80"> · {share.toFixed(1)}%</span>
              </span>
              <span>
                Programmed{" "}
                <b className="font-semibold text-prog tabular-nums">
                  {formatAmountP(m.programmed_total_thousands * 1000)}
                </b>
                <span className="text-muted-foreground/80"> · {(100 - share).toFixed(1)}%</span>
              </span>
              <div className="hidden flex-wrap items-center gap-1 sm:flex" aria-label={`${view} hierarchy`}>
                {VIEW_PATHS[view].map((s, i) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    {i > 0 && <span>›</span>}
                    <Badge variant="secondary" className="rounded-md font-medium">
                      {s}
                    </Badge>
                  </span>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => setShowCards((x) => !x)}
              >
                {showCards ? "Hide cards" : "Cards"}
              </Button>
            </div>
            {showCards && (
              <div className="grid gap-2 sm:grid-cols-3">
                <Card size="sm">
                  <CardHeader className="gap-1">
                    <CardDescription className="text-[10px] tracking-wide uppercase">
                      NEP Grand Total
                    </CardDescription>
                    <CardTitle className="text-lg tabular-nums">
                      {formatAmountP(m.grand_total_thousands * 1000)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-[10px] text-muted-foreground">
                    FY {year} · static assets
                  </CardContent>
                </Card>
                <Card size="sm" className="border-aa/30 bg-aa/5">
                  <CardHeader className="gap-1">
                    <CardDescription className="text-[10px] tracking-wide uppercase">
                      Automatic Appropriations
                    </CardDescription>
                    <CardTitle className="text-lg text-aa tabular-nums">
                      {formatAmountP(m.aa_total_thousands * 1000)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-[10px] text-muted-foreground">
                    {share.toFixed(1)}% of NEP
                  </CardContent>
                </Card>
                <Card size="sm" className="border-prog/30 bg-prog/5">
                  <CardHeader className="gap-1">
                    <CardDescription className="text-[10px] tracking-wide uppercase">
                      Programmed Appropriations
                    </CardDescription>
                    <CardTitle className="text-lg text-prog tabular-nums">
                      {formatAmountP(m.programmed_total_thousands * 1000)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-[10px] text-muted-foreground">
                    {(100 - share).toFixed(1)}% of NEP
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </AppChrome>

      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 md:hidden">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={mobilePane}
          onValueChange={(v) => {
            if (v === "tree" || v === "items") setMobilePane(v);
          }}
          className="w-full"
          aria-label="Mobile panel"
        >
          <ToggleGroupItem value="tree" className="h-8 flex-1 text-xs">
            Hierarchy
          </ToggleGroupItem>
          <ToggleGroupItem value="items" className="h-8 flex-1 text-xs">
            Items
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className={cn("tree-panel", mobilePane !== "tree" && "max-md:hidden")}>
          <div className="tree-panel-chrome">
            <div className="tree-panel-head !items-center gap-2">
              <h2 className="shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Hierarchy
              </h2>
              <TreeSearch forest={treeForest} onPick={goToNode} />
            </div>
            <div className="tree-panel-tools">
              <Label className="text-[11px] text-muted-foreground">Sort</Label>
              <select
                className={cn(selectClass, "h-7 text-xs")}
                value={treeSort}
                onChange={(e) => setTreeSort(e.target.value as TreeSort)}
                aria-label="Tree sort"
              >
                <option value="amount">By amount</option>
                <option value="name">By name</option>
                {year === YOY_CURRENT_YEAR && (
                  <option value="yoy">By YoY change</option>
                )}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setExpanded(new Set(DEFAULT_EXPANDED))}
              >
                Collapse all
              </Button>
            </div>
          </div>
          <div className="tree-scroll">
            <div className="pb-1.5">
              <TreeRow
                node={rootNode}
                selectedKey={selected ? nodeKey(selected) : null}
                expanded={expanded}
                setExpanded={setExpanded}
                onSelect={onSelect}
                showChildren={false}
                treeSort={treeSort}
                priorTreeAmounts={priorTreeAmounts}
              />
            </div>
            {sortTreeChildren(rootChildren, treeSort, priorTreeAmounts).map((c) => (
              <TreeRow
                key={nodeKey(c)}
                node={c}
                selectedKey={selected ? nodeKey(selected) : null}
                expanded={expanded}
                setExpanded={setExpanded}
                onSelect={onSelect}
                showChildren
                treeSort={treeSort}
                priorTreeAmounts={priorTreeAmounts}
              />
            ))}
          </div>
        </div>

        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden bg-background p-3.5",
            mobilePane !== "items" && "max-md:hidden",
          )}
        >
          <div className="mb-2.5 shrink-0 space-y-2 border-b border-border pb-2">
            <div>
              <h2 className="text-sm font-semibold">{selected?.label || "Select a branch"}</h2>
              <BreadcrumbChips trail={trail} onNavigate={goToNode} />
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Amount</Label>
                <select
                  className={selectClass}
                  value={amountFilter}
                  onChange={(e) => setAmountFilter(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="nonzero">Non-zero</option>
                  <option value="zero">Zero only</option>
                </select>
              </div>
              <div className="flex min-w-[180px] flex-1 items-center gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Search</Label>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                  placeholder="salaries, electricity, RLIP… (Enter)"
                  className="h-8"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Scope</Label>
                <select
                  className={selectClass}
                  value={searchScope}
                  onChange={(e) => setSearchScope(e.target.value as SearchScope)}
                >
                  <option value="selection">Current selection</option>
                  <option value="all">All</option>
                </select>
              </div>
              <Button type="button" size="sm" onClick={runSearch}>
                Search
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setColsOpen(true)}
              >
                <Columns3 className="size-3.5" aria-hidden />
                Columns
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!sortedItems.length}
                onClick={() =>
                  exportItemsCsv(
                    sortedItems,
                    activeColumns,
                    `nep-${year}-${view}-items.csv`,
                  )
                }
              >
                <Download className="size-3.5" aria-hidden />
                CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setAmountFilter("all");
                  setSearch("");
                  setSearchScope("selection");
                  if (selected && isItemLeaf(view, selected)) loadLeafItems(selected);
                }}
              >
                Reset
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" aria-label="More actions">
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem
                    onClick={async () => {
                      await clearNepCache();
                      window.location.reload();
                    }}
                  >
                    Clear cache & reload
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled className="text-muted-foreground">
                    {cacheLabel || "Cache: —"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {(itemsMode === "table" || itemsMode === "loading" || itemsMode === "branch") && (
            <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 tabular-nums text-muted-foreground">
                {itemsMode === "loading" && searchProgress
                  ? `${searchProgress.loaded}/${searchProgress.total} shards · ${formatHitsSummary(searchProgress.hits, searchProgress.amountThousands)}`
                  : itemsMode === "table"
                    ? (itemsSummary || formatHitsSummary(sortedItems.length, itemsTotalThousands, "rows"))
                    : itemsSummary}
              </span>
              {itemsMode === "loading" && searchProgress && (
                <Button type="button" variant="destructive" size="sm" className="h-7" onClick={cancelSearch}>
                  <Square className="size-3 fill-current" aria-hidden />
                  Stop
                </Button>
              )}
              {itemsMode === "table" && sortedItems.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() =>
                    exportItemsCsv(
                      sortedItems,
                      activeColumns,
                      `nep-${year}-${view}-items.csv`,
                    )
                  }
                >
                  <Download className="size-3.5" aria-hidden />
                  Export CSV
                </Button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            {itemsMode === "loading" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10">
                <div className="w-full max-w-md space-y-3">
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span className="min-w-0 leading-snug">
                      {searchProgress
                        ? `Searching ${searchProgress.label}…`
                        : panelHint || "Loading…"}
                    </span>
                    {searchProgress && searchProgress.total > 0 && (
                      <span className="shrink-0 text-right tabular-nums">
                        {searchProgress.loaded}/{searchProgress.total} shards
                        <span className="block text-muted-foreground/80 sm:inline">
                          {" "}· {formatHitsSummary(searchProgress.hits, searchProgress.amountThousands)}
                        </span>
                      </span>
                    )}
                  </div>
                  {searchProgress && searchProgress.total > 0 ? (
                    <Progress
                      value={Math.min(
                        100,
                        (searchProgress.loaded / searchProgress.total) * 100,
                      )}
                      className="h-2"
                    />
                  ) : (
                    <div className="flex justify-center">
                      <div className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
                    </div>
                  )}
                  {searchProgress && searchProgress.total > 0 && (
                    <div className="flex items-center justify-center gap-3">
                      <p className="text-[11px] tabular-nums text-muted-foreground">
                        {Math.round((searchProgress.loaded / searchProgress.total) * 100)}%
                      </p>
                      <Button type="button" variant="outline" size="sm" className="h-7" onClick={cancelSearch}>
                        Stop search
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {itemsMode === "empty" && <div className="tree-empty">{panelHint}</div>}
            {itemsMode === "branch" && (
              <Card className="max-w-md">
                <CardHeader>
                  <CardTitle className="text-sm">Branch total</CardTitle>
                  <CardDescription>{panelHint}</CardDescription>
                </CardHeader>
              </Card>
            )}
            {itemsMode === "table" && (
              <div className="h-full min-h-0 overflow-auto rounded-lg border border-border bg-card">
                <table
                  className="caption-bottom border-collapse text-sm"
                  style={{ tableLayout: "fixed", width: tableWidthPx }}
                >
                  <colgroup>
                    {activeColumns.map((col) => (
                      <col key={col.id} style={{ width: columnWidthPx(col.id) }} />
                    ))}
                  </colgroup>
                  <TableHeader className="sticky top-0 z-10 border-b bg-card shadow-[0_1px_0_0_var(--border)] [&_th]:bg-card">
                    <TableRow className="hover:bg-transparent">
                      {activeColumns.map((col) => (
                        <SortableHead
                          key={col.id}
                          label={col.header}
                          title={
                            col.id === "yoy"
                              ? "Percent change vs FY2026 (UACS match). NEW if unmatched."
                              : undefined
                          }
                          align={col.id === "amount" || col.id === "yoy" ? "right" : undefined}
                          active={itemSortKey === col.id}
                          dir={itemSortDir}
                          onClick={() => toggleItemSort(col.id)}
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedItems.map((item) => (
                      <TableRow
                        key={item.id}
                        className={cn(
                          "cursor-pointer",
                          (item.amount || 0) === 0 && "text-muted-foreground",
                          detail?.id === item.id && "bg-primary/10",
                        )}
                        onClick={() => setDetail(item)}
                      >
                        {activeColumns.map((col) => {
                          const text = cellText(item, col.id) || "—";
                          const isAmount = col.id === "amount";
                          const isYoy = col.id === "yoy";
                          const isCode = col.id === "object_code" || col.id === "id";
                          const isMultiline =
                            col.id === "object"
                            || col.id === "prog"
                            || col.id === "ou"
                            || col.id === "funding"
                            || col.id === "region"
                            || col.id === "div";
                          return (
                            <TableCell
                              key={col.id}
                              className={cn(
                                "align-top",
                                isAmount && "text-right tabular-nums whitespace-nowrap",
                                isYoy && "text-right tabular-nums whitespace-nowrap text-[12px]",
                                isYoy && text === "NEW" && "font-medium text-foreground",
                                isYoy && text.startsWith("+") && "text-emerald-700 dark:text-emerald-400",
                                isYoy && text.startsWith("-") && "text-rose-700 dark:text-rose-400",
                                isCode && "font-mono text-[11px] whitespace-nowrap text-muted-foreground",
                              )}
                              title={
                                isYoy
                                  ? text === "NEW"
                                    ? "No matching FY2026 line (UACS key)"
                                    : "vs FY2026"
                                  : text
                              }
                            >
                              {isMultiline ? (
                                <div className="line-clamp-2 w-full break-words whitespace-normal leading-snug [overflow-wrap:anywhere]">
                                  {text}
                                </div>
                              ) : (
                                text
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>

      <Dialog open={colsOpen} onOpenChange={setColsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Table columns</DialogTitle>
            <DialogDescription>
              Toggle columns and drag the handle (or use arrows) to set left-to-right order.
              At least one column must stay on.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1 py-1">
            {orderedColumns.map((col, index) => {
              const checked = visibleCols.has(col.id);
              const id = `col-${col.id}`;
              const dragging = dragColId === col.id;
              const over = dragOverColId === col.id && dragColId !== col.id;
              return (
                <div
                  key={col.id}
                  className={cn(
                    "flex items-center gap-1 rounded-lg px-1 py-1 transition-colors",
                    over && "bg-primary/10 ring-1 ring-primary/30",
                    dragging && "opacity-50",
                    !dragging && !over && "hover:bg-muted/60",
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverColId !== col.id) setDragOverColId(col.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverColId === col.id) setDragOverColId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = (e.dataTransfer.getData("text/col-id") || dragColId) as ItemColId | null;
                    if (from) moveColumn(from, col.id);
                    setDragColId(null);
                    setDragOverColId(null);
                  }}
                >
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
                    draggable
                    title="Drag to reorder"
                    aria-label={`Drag to reorder ${col.header}`}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/col-id", col.id);
                      setDragColId(col.id);
                    }}
                    onDragEnd={() => {
                      setDragColId(null);
                      setDragOverColId(null);
                    }}
                  >
                    <GripVertical className="size-4" aria-hidden />
                  </button>
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1.5 pr-1"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={checked && visibleCols.size <= 1}
                      onCheckedChange={(v) => toggleColumn(col.id, v === true)}
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{col.header}</span>
                      {col.header !== col.label && (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {col.label}
                        </span>
                      )}
                    </span>
                  </label>
                  <div className="flex shrink-0 flex-col">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-6"
                      disabled={index === 0}
                      aria-label={`Move ${col.header} up`}
                      onClick={() => nudgeColumn(col.id, -1)}
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-6"
                      disabled={index === orderedColumns.length - 1}
                      aria-label={`Move ${col.header} down`}
                      onClick={() => nudgeColumn(col.id, 1)}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={resetColumns}>
              Reset defaults
            </Button>
            <Button type="button" size="sm" onClick={() => setColsOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {detail && (
        <ItemDetailModal
          detail={detail}
          pathLabel={view === "nep" ? "NEP path" : "Place path"}
          trail={detailTrail}
          onNavigate={goToNode}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function SortableHead({
  label,
  title,
  active,
  dir,
  onClick,
  align,
  className,
}: {
  label: string;
  title?: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "right";
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={cn(align === "right" ? "text-right" : undefined, className)}>
      <button
        type="button"
        title={title}
        className={cn(
          "inline-flex items-center gap-1 font-medium hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={onClick}
      >
        {label}
        <Icon className="size-3.5 opacity-70" aria-hidden />
      </button>
    </TableHead>
  );
}

function shardPathsForNode(store: YearData, view: ViewMode, node: TreeNode): string[] {
  if (node.kind === "aa_item" || (node.kind === "section" && node.code === "automatic")) {
    return ["aa.json.gz"];
  }
  if (node.kind === "section" && node.code === "programmed") {
    return store.manifest?.all || [];
  }
  if (node.kind === "root") {
    return ["aa.json.gz", ...(store.manifest?.all || [])];
  }
  if (node.shard) return [node.shard];
  if (node.kind === "dept") return store.shardPathsForDept(node.code);
  if (node.kind === "agency") return store.manifest?.by_agency?.[node.code] || [];
  if (view === "nep" && node.kind === "program") {
    const agency = (node.parent_key || "").split(":")[1];
    return store.manifest?.by_agency?.[agency] || [];
  }
  let cur: TreeNode | undefined = node;
  const tree = store.trees[view];
  while (cur) {
    if (cur.shard) return [cur.shard];
    cur = cur.parent_key && tree ? tree.nodes.get(cur.parent_key) : undefined;
  }
  return [];
}

function TreeRow({
  node,
  selectedKey,
  expanded,
  setExpanded,
  onSelect,
  showChildren,
  treeSort,
  priorTreeAmounts,
}: {
  node: TreeNode;
  selectedKey: string | null;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  onSelect: (n: TreeNode) => void;
  showChildren: boolean;
  treeSort: TreeSort;
  priorTreeAmounts: Map<string, number> | null;
}) {
  const key = nodeKey(node);
  const open = expanded.has(key);
  const expandable = isExpandable(node);
  const short = displayCode(node);
  const sectionClass = node.kind === "section" ? ` kind-section-${node.code}` : "";
  const children = useMemo(
    () => sortTreeChildren(node.children || [], treeSort, priorTreeAmounts),
    [node.children, treeSort, priorTreeAmounts],
  );
  const yoyLabel = treeNodeYoyLabel(key, node.total_amount, priorTreeAmounts);

  return (
    <div className="tree-node" data-key={key}>
      <div
        className={`tree-row kind-${node.kind}${sectionClass}${selectedKey === key ? " selected" : ""}`}
        onClick={() => {
          onSelect(node);
          if (expandable && !open) {
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(key);
              return next;
            });
          }
        }}
      >
        <span
          className={`caret${expandable ? (open ? " expanded" : "") : " invisible"}`}
          onClick={(e) => {
            if (!expandable) return;
            e.stopPropagation();
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }}
        >
          {expandable ? "▶" : ""}
        </span>
        <span className={`kind-chip k-${node.kind}`}>{KIND_LABELS[node.kind] || node.kind}</span>
        {short && <span className="code" title={node.code}>{short}</span>}
        <span className="label" title={node.code ? `${node.label}\n${node.code}` : node.label}>
          {node.label}
        </span>
        <span className="stats">
          <span className="amount">{formatAmountT(node.amount_display_trillions)}</span>
          {yoyLabel && (
            <span
              className={cn(
                "ml-1.5 text-[10px] font-medium tabular-nums",
                yoyLabel === "NEW" && "text-foreground/80",
                yoyLabel === "—" && "text-muted-foreground",
                yoyLabel.startsWith("+") && "text-emerald-700 dark:text-emerald-400",
                yoyLabel.startsWith("-") && "text-rose-700 dark:text-rose-400",
              )}
              title={
                yoyLabel === "NEW"
                  ? "No matching FY2026 node"
                  : yoyLabel === "—"
                    ? "Prior amount was zero"
                    : "vs FY2026"
              }
            >
              {yoyLabel}
            </span>
          )}
          {node.item_count != null && (
            <span className="count"> · {formatNum(node.item_count)}</span>
          )}
        </span>
      </div>
      {showChildren && expandable && (
        <div className={`tree-children${open ? " open" : ""}`}>
          {open &&
            children.map((child) => (
              <TreeRow
                key={nodeKey(child)}
                node={child}
                selectedKey={selectedKey}
                expanded={expanded}
                setExpanded={setExpanded}
                onSelect={onSelect}
                showChildren
                treeSort={treeSort}
                priorTreeAmounts={priorTreeAmounts}
              />
            ))}
        </div>
      )}
    </div>
  );
}
