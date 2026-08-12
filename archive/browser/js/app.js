import { detectBase, cacheStats, clearNepCache } from "./cache.js";
import {
  YearData,
  discoverYears,
  isItemLeaf,
  AA_RULES,
} from "./data.js";

const VIEW_PATHS = {
  place: ["Dept", "Agency", "Region", "Division", "OU", "Program"],
  nep: ["Dept", "Agency", "Program", "Region", "Division", "OU"],
};
const KIND_LABELS = {
  root: "Total",
  section: "Section",
  aa_item: "AA",
  dept: "Dept",
  agency: "Agency",
  region: "Region",
  division: "Div",
  ou: "OU",
  program: "Prog",
};

const state = {
  base: detectBase(),
  year: null,
  years: [],
  view: "place",
  store: null,
  selectedNode: null,
  breadcrumb: "",
  amountFilter: "nonzero",
  appropriation: "all",
  search: "",
  searchScope: "leaf", // leaf | dept | year
  itemsOffset: 0,
  itemsLimit: 100,
  itemsTotal: 0,
  expanded: new Set(),
  loaded: new Set(),
  itemsAbort: null,
};

function formatAmountP(pesos) {
  if (pesos == null || Number.isNaN(Number(pesos))) return "₱0.00";
  const n = Number(pesos);
  if (n === 0) return "₱0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}₱${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}₱${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}₱${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}₱${(abs / 1e3).toFixed(2)}K`;
  return `${sign}₱${abs.toFixed(2)}`;
}
function formatAmountT(t) {
  return formatAmountP((Number(t) || 0) * 1e12);
}
function formatNum(n) {
  return Number(n).toLocaleString();
}
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function nodeKey(node) {
  return node.key || `${node.kind}:${node.code}`;
}
function displayCode(node) {
  if (!node.code || node.kind === "root" || node.kind === "section") return null;
  const c = String(node.code);
  if (c.includes("|")) return c.split("|").pop();
  if (c.length > 14) return c.slice(0, 10) + "…";
  return c;
}
function isExpandable(node) {
  return (node.child_count > 0 || (node.children && node.children.length > 0))
    && node.kind !== "aa_item";
}
function childCount(node) {
  if (node.child_count != null) return node.child_count;
  return node.children ? node.children.length : 0;
}

function updateViewPath() {
  const steps = VIEW_PATHS[state.view];
  document.getElementById("view-path").innerHTML =
    `<strong>${state.view === "nep" ? "NEP" : "Place"} path</strong> `
    + steps.map((s) => `<span class="step">${s}</span>`).join('<span class="arrow">›</span>');
  document.getElementById("tree-view-label").textContent =
    state.view === "nep" ? "PDF-like program order · static" : "Geographic place order · static";
}

async function boot() {
  document.getElementById("cache-status").textContent = "Loading…";
  state.years = await discoverYears(state.base || "");
  if (!state.years.length) {
    document.getElementById("tree-root").innerHTML =
      `<div class="tree-empty">No browser assets found under <code>data/budget/*/browser</code>.
       Serve the repo root (not only archive/browser).</div>`;
    return;
  }
  state.year = state.years[0];
  const sel = document.getElementById("year-select");
  sel.innerHTML = "";
  state.years.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    sel.appendChild(opt);
  });
  sel.value = state.year;
  sel.addEventListener("change", async (e) => {
    state.year = e.target.value;
    await reloadYear();
  });

  document.querySelectorAll("#view-toggle button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.v === state.view) return;
      document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.v;
      updateViewPath();
      resetSelection();
      await loadRoot();
    });
  });

  document.getElementById("toggle-cards").addEventListener("click", () => {
    const cards = document.getElementById("cards");
    const open = cards.classList.toggle("open");
    document.getElementById("toggle-cards").textContent = open ? "Hide details" : "Show details";
  });

  document.getElementById("search-scope").addEventListener("change", (e) => {
    state.searchScope = e.target.value;
  });
  document.getElementById("clear-cache").addEventListener("click", async () => {
    await clearNepCache();
    state.store = null;
    await refreshCacheLabel();
    alert("Cache cleared. Reloading year…");
    await reloadYear();
  });

  document.getElementById("amount-filter").addEventListener("change", (e) => {
    state.amountFilter = e.target.value;
    state.itemsOffset = 0;
    if (state.selectedNode && isItemLeaf(state.view, state.selectedNode)) loadItems();
  });
  document.getElementById("search-btn").addEventListener("click", () => runSearch());
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  document.getElementById("reset-btn").addEventListener("click", () => {
    state.amountFilter = "nonzero";
    state.search = "";
    state.itemsOffset = 0;
    document.getElementById("amount-filter").value = "nonzero";
    document.getElementById("search-input").value = "";
    document.getElementById("search-scope").value = "leaf";
    state.searchScope = "leaf";
    if (state.selectedNode && isItemLeaf(state.view, state.selectedNode)) loadItems();
    else showBranchPanel(state.selectedNode);
  });

  updateViewPath();
  await reloadYear();
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (_) {
      /* optional */
    }
  }
}

async function refreshCacheLabel() {
  const s = await cacheStats();
  document.getElementById("cache-status").textContent =
    `Cache: ${s.entries} file(s) · static mode`;
}

async function reloadYear() {
  resetSelection();
  state.store = new YearData(state.year, state.base || "");
  await state.store.init();
  await state.store.loadTree(state.view);
  fillSummary();
  await loadRoot();
  await refreshCacheLabel();
}

function fillSummary() {
  const m = state.store.meta;
  const grand = formatAmountP(m.grand_total_thousands * 1000);
  const aa = formatAmountP(m.aa_total_thousands * 1000);
  const prog = formatAmountP(m.programmed_total_thousands * 1000);
  document.getElementById("inline-grand").textContent = grand;
  document.getElementById("inline-aa").textContent = aa;
  document.getElementById("inline-prog").textContent = prog;
  document.getElementById("card-grand").textContent = grand;
  document.getElementById("card-aa").textContent = aa;
  document.getElementById("card-prog").textContent = prog;
  const share = m.grand_total_thousands
    ? (m.aa_total_thousands / m.grand_total_thousands) * 100
    : 0;
  document.getElementById("card-grand-sub").textContent = `FY ${state.year} · static assets`;
  document.getElementById("card-aa-sub").textContent = `${share.toFixed(1)}% of NEP`;
  document.getElementById("card-prog-sub").textContent = `${(100 - share).toFixed(1)}% of NEP`;
}

function resetSelection() {
  state.expanded.clear();
  state.loaded.clear();
  state.selectedNode = null;
  document.getElementById("items-content").innerHTML =
    '<div class="tree-empty">Expand the tree, then open a leaf (Program / OU) for line items.</div>';
  document.getElementById("items-title").textContent = "Select a branch";
  document.getElementById("items-breadcrumb").textContent = "";
  document.getElementById("items-summary").textContent = "";
}

async function loadRoot() {
  const tree = await state.store.loadTree(state.view);
  const m = state.store.meta;
  const container = document.getElementById("tree-root");
  container.innerHTML = "";

  const rootNode = {
    key: "root:total",
    kind: "root",
    code: "total",
    label: `Total Appropriations (FY ${state.year})`,
    item_count: null,
    amount_display_trillions: m.grand_total_thousands * 1000 / 1e12,
    children: [],
    child_count: 2,
  };

  const aaChildren = AA_RULES.map(([,, category, name], i) => {
    const key = AA_RULES[i][1];
    const info = m.aa_items?.[key] || {};
    return {
      key: `aa_item:${key}`,
      kind: "aa_item",
      code: key,
      label: info.name || name,
      item_count: info.item_count || 0,
      total_amount: info.amount_thousands || 0,
      amount_display_trillions: (info.amount_thousands || 0) * 1000 / 1e12,
      children: [],
      child_count: 0,
      category,
    };
  }).sort((a, b) => b.total_amount - a.total_amount);

  const aaSection = {
    key: "section:automatic",
    kind: "section",
    code: "automatic",
    label: "Automatic Appropriations",
    item_count: aaChildren.reduce((s, c) => s + c.item_count, 0),
    total_amount: m.aa_total_thousands,
    amount_display_trillions: m.aa_total_thousands * 1000 / 1e12,
    children: aaChildren,
    child_count: aaChildren.length,
  };

  const progSection = {
    key: "section:programmed",
    kind: "section",
    code: "programmed",
    label: "Programmed Appropriations",
    item_count: tree.roots.reduce((s, d) => s + d.item_count, 0),
    total_amount: m.programmed_total_thousands,
    amount_display_trillions: m.programmed_total_thousands * 1000 / 1e12,
    children: tree.roots,
    child_count: tree.roots.length,
  };

  rootNode.children = [aaSection, progSection];

  const header = document.createElement("div");
  header.className = "tree-root-header";
  header.appendChild(renderTreeNode(rootNode, "", { isRootHeader: true }));
  container.appendChild(header);
  progSection.children; // ensure linked
  [aaSection, progSection].forEach((c) => {
    container.appendChild(renderTreeNode(c, rootNode.label));
  });
}

function renderTreeNode(node, parentBreadcrumb, opts = {}) {
  const breadcrumb = parentBreadcrumb
    ? `${parentBreadcrumb} › ${node.label}`
    : node.label;
  const wrapper = document.createElement("div");
  wrapper.className = "tree-node";
  wrapper.dataset.key = nodeKey(node);

  const row = document.createElement("div");
  const sectionClass = node.kind === "section" ? ` kind-section-${node.code}` : "";
  row.className = `tree-row kind-${node.kind}${sectionClass}`;

  const caret = document.createElement("span");
  caret.className = "caret";
  if (isExpandable(node)) {
    caret.textContent = "▶";
    if (state.expanded.has(nodeKey(node))) caret.classList.add("expanded");
  } else caret.classList.add("invisible");

  const chip = document.createElement("span");
  chip.className = `kind-chip k-${node.kind}`;
  chip.textContent = KIND_LABELS[node.kind] || node.kind;

  const short = displayCode(node);
  let codeEl = null;
  if (short) {
    codeEl = document.createElement("span");
    codeEl.className = "code";
    codeEl.textContent = short;
    codeEl.title = node.code;
  }

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.label;
  label.title = node.code ? `${node.label}\n${node.code}` : node.label;

  const stats = document.createElement("span");
  stats.className = "stats";
  const amountSpan = document.createElement("span");
  amountSpan.className = "amount";
  amountSpan.textContent = formatAmountT(node.amount_display_trillions);
  stats.appendChild(amountSpan);
  if (node.item_count != null) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = ` · ${formatNum(node.item_count)}`;
    stats.appendChild(count);
  }

  row.appendChild(caret);
  row.appendChild(chip);
  if (codeEl) row.appendChild(codeEl);
  row.appendChild(label);
  row.appendChild(stats);

  const children = document.createElement("div");
  children.className = "tree-children";
  if (state.expanded.has(nodeKey(node))) children.classList.add("open");

  row.addEventListener("click", async (e) => {
    e.stopPropagation();
    selectNode(node, breadcrumb);
    if (isExpandable(node)) await toggleExpand(node, children, caret, breadcrumb);
  });

  wrapper.appendChild(row);
  if (!opts.isRootHeader) {
    wrapper.appendChild(children);
    if (state.expanded.has(nodeKey(node)) && !state.loaded.has(nodeKey(node))) {
      toggleExpand(node, children, caret, breadcrumb);
    }
  }
  return wrapper;
}

async function toggleExpand(node, childrenEl, caretEl, breadcrumb) {
  const key = nodeKey(node);
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    state.loaded.delete(key);
    childrenEl.classList.remove("open");
    childrenEl.innerHTML = "";
    caretEl.classList.remove("expanded");
    return;
  }
  state.expanded.add(key);
  childrenEl.classList.add("open");
  caretEl.classList.add("expanded");
  if (state.loaded.has(key)) return;
  state.loaded.add(key);

  // Children already on node for static trees / synthetic sections
  let kids = node.children || [];
  if (!kids.length && node.kind === "dept") {
    const tree = await state.store.loadTree(state.view);
    const full = tree.nodes.get(node.key || `dept:${node.code}`);
    kids = full?.children || [];
    node.children = kids;
  }

  childrenEl.innerHTML = "";
  if (!kids.length) {
    const empty = document.createElement("div");
    empty.className = "tree-loading";
    empty.textContent = "No child branches";
    childrenEl.appendChild(empty);
    return;
  }
  kids.forEach((child) => {
    childrenEl.appendChild(renderTreeNode(child, breadcrumb));
  });
}

function selectNode(node, breadcrumb) {
  state.selectedNode = node;
  state.breadcrumb = breadcrumb;
  state.itemsOffset = 0;
  document.querySelectorAll(".tree-row.selected").forEach((el) => el.classList.remove("selected"));
  const wrapper = document.querySelector(`[data-key="${CSS.escape(nodeKey(node))}"]`);
  if (wrapper) wrapper.querySelector(".tree-row")?.classList.add("selected");

  document.getElementById("items-title").textContent = node.label;
  const kind = KIND_LABELS[node.kind] || node.kind;
  const codeBit = node.code && node.kind !== "root"
    ? `<code class="item-id" title="${escapeHtml(node.code)}">${escapeHtml(displayCode(node) || node.code)}</code> `
    : "";
  document.getElementById("items-breadcrumb").innerHTML =
    `${codeBit}<span class="kind-chip k-${node.kind}" style="display:inline-block;margin-right:6px">${kind}</span>${escapeHtml(breadcrumb || "")}`;

  if (isItemLeaf(state.view, node)) {
    loadItems();
  } else {
    showBranchPanel(node);
  }
}

function showBranchPanel(node) {
  if (!node) return;
  const summary = document.getElementById("items-summary");
  const content = document.getElementById("items-content");
  summary.innerHTML = node.item_count != null
    ? `<strong>${formatNum(node.item_count)}</strong> rolled-up items · ${formatAmountT(node.amount_display_trillions)}`
    : formatAmountT(node.amount_display_trillions);
  const leafName = state.view === "nep" ? "OU" : "Program";
  content.innerHTML = `
    <div class="load-prompt">
      <p>This is a <strong>branch</strong> total (all departments use the same rule).</p>
      <div class="hint">Line items live only on leaf nodes (<strong>${leafName}</strong> in ${state.view === "nep" ? "NEP" : "Place"} view, or an AA item). Expand the tree to a leaf to load rows from one shard. Use search with Department / Year scope for broader text search.</div>
    </div>`;
}

async function loadItems() {
  const node = state.selectedNode;
  if (!node || !isItemLeaf(state.view, node)) return;
  const summary = document.getElementById("items-summary");
  const content = document.getElementById("items-content");
  content.innerHTML = `<div class="loading-box"><div class="spinner"></div><div>Loading leaf shard…</div></div>`;
  summary.textContent = "Loading…";

  const started = Date.now();
  try {
    const rows = await state.store.recordsForNode(state.view, node);
    let matched = rows.filter((r) => state.store.matchesNode(state.view, r, node));
    matched = applyFilters(matched);
    state.itemsTotal = matched.length;
    const page = matched.slice(state.itemsOffset, state.itemsOffset + state.itemsLimit);
    const secs = ((Date.now() - started) / 1000).toFixed(2);
    summary.innerHTML = `<strong>${formatNum(matched.length)}</strong> matching · ${secs}s · leaf shard`;
    renderItemsTable(page);
  } catch (err) {
    content.innerHTML = `<div class="tree-empty">Error: ${escapeHtml(err.message)}</div>`;
    summary.textContent = "";
  }
}

function applyFilters(rows) {
  let out = rows;
  if (state.amountFilter === "nonzero") out = out.filter((r) => (r.amount || 0) !== 0);
  if (state.amountFilter === "zero") out = out.filter((r) => (r.amount || 0) === 0);
  if (state.search) {
    const q = state.search.toLowerCase();
    out = out.filter((r) => (r.description || "").toLowerCase().includes(q));
  }
  return out;
}

async function runSearch() {
  state.search = document.getElementById("search-input").value.trim();
  state.searchScope = document.getElementById("search-scope").value;
  state.itemsOffset = 0;

  if (!state.search) {
    if (state.selectedNode && isItemLeaf(state.view, state.selectedNode)) loadItems();
    return;
  }

  if (state.searchScope === "leaf") {
    if (!state.selectedNode || !isItemLeaf(state.view, state.selectedNode)) {
      alert("Leaf scope: select a Program (Place) or OU (NEP) leaf first.");
      return;
    }
    await loadItems();
    return;
  }

  if (state.searchScope === "dept") {
    const dept = findSelectedDept();
    if (!dept) {
      alert("Department scope: select a department (or a node under one) in the tree first.");
      return;
    }
    await searchInShards(
      state.store.shardPathsForDept(dept),
      `department ${dept}`,
      (r) => (r.org_uacs_code || "").startsWith(dept),
    );
    return;
  }

  // year scope
  const paths = state.store.manifest.all || [];
  const rowsEst = state.store.programmedItemCount() || 500000;
  const ram = state.store.estimateRamMb(rowsEst);
  const dl = state.store.estimateShardDownloadMb(paths);
  const ok = confirm(
    `Load all programmed shards for FY ${state.year} into this browser tab?\n\n`
    + `~${paths.length} files · ~${dl.toFixed(1)} MB download (cached after first time)\n`
    + `Rough RAM for search: ~${ram} MB (varies by browser)\n\n`
    + `Continue?`,
  );
  if (!ok) return;
  await searchInShards(paths, `FY ${state.year}`, () => true);
}

function findSelectedDept() {
  let n = state.selectedNode;
  if (!n) return null;
  if (n.kind === "dept") return n.code;
  if (n.kind === "agency") return n.code.slice(0, 2);
  if (n.org_uacs_code) return n.org_uacs_code.slice(0, 2);
  // Walk parent_key via tree
  const tree = state.store.trees[state.view];
  let cur = n;
  while (cur) {
    if (cur.kind === "dept") return cur.code;
    if (cur.kind === "agency") return cur.code.slice(0, 2);
    cur = cur.parent_key && tree ? tree.nodes.get(cur.parent_key) : null;
  }
  // From composite codes
  if (n.code && /^\d{2}/.test(n.code)) return n.code.slice(0, 2);
  return null;
}

async function searchInShards(paths, label, preFilter) {
  const summary = document.getElementById("items-summary");
  const content = document.getElementById("items-content");
  content.innerHTML = `<div class="loading-box"><div class="spinner"></div><div id="load-elapsed">Loading ${escapeHtml(label)}…</div></div>`;
  const started = Date.now();
  const q = state.search.toLowerCase();
  const matched = [];
  let loaded = 0;
  try {
    for (const p of paths) {
      const rows = await state.store.loadShard(p);
      loaded++;
      const el = document.getElementById("load-elapsed");
      if (el) {
        el.textContent = `Searching ${label}… ${loaded}/${paths.length} shards · ${matched.length} hits`;
      }
      for (const r of rows) {
        if (!preFilter(r)) continue;
        if (r.prexc_level !== 7) continue;
        if (state.amountFilter === "nonzero" && !(r.amount)) continue;
        if (state.amountFilter === "zero" && r.amount) continue;
        if (!(r.description || "").toLowerCase().includes(q)) continue;
        matched.push(r);
        if (matched.length >= 5000) break;
      }
      if (matched.length >= 5000) break;
    }
    state.itemsTotal = matched.length;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    summary.innerHTML =
      `<strong>${formatNum(matched.length)}</strong> hits in ${escapeHtml(label)}`
      + (matched.length >= 5000 ? " (capped at 5,000)" : "")
      + ` · ${secs}s`;
    renderItemsTable(matched.slice(0, state.itemsLimit));
  } catch (err) {
    content.innerHTML = `<div class="tree-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderItemsTable(items) {
  const content = document.getElementById("items-content");
  content.innerHTML = "";
  if (!items.length) {
    content.innerHTML = '<div class="tree-empty">No matching items.</div>';
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>
    <th>ID</th><th>Level</th><th>Description</th><th class="num">Amount</th>
    <th>Region</th><th>Org</th><th>Object</th>
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  items.forEach((item) => {
    const tr = document.createElement("tr");
    if ((item.amount || 0) === 0) tr.className = "zero-amount";
    tr.innerHTML = `
      <td><code class="item-id">${escapeHtml(item.id || "")}</code></td>
      <td class="num">${item.prexc_level ?? "—"}</td>
      <td class="description" title="${escapeHtml(item.description || "")}">${escapeHtml(item.description || "")}</td>
      <td class="num">${formatAmountP((item.amount || 0) * 1000)}</td>
      <td>${escapeHtml(item.region_code || "—")}</td>
      <td><code class="item-id">${escapeHtml(item.org_uacs_code || "")}</code></td>
      <td><code class="item-id">${escapeHtml(item.object_uacs_code || "")}</code></td>`;
    tbody.appendChild(tr);
  });
  content.appendChild(table);
}

boot();
