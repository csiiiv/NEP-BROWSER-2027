import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import type { TreeNode } from "@/lib/data";
import { KIND_LABELS, formatAmountT, nodeKey } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PathChip {
  key: string;
  kind: string;
  label: string;
}

export interface TreeSuggest {
  key: string;
  label: string;
  kind: string;
  code: string;
  /** Ancestors only (excludes the matched node). */
  ancestors: PathChip[];
  crumbPath: string;
  amount_display_trillions: number;
  score: number;
}

interface IndexedNode {
  node: TreeNode;
  trail: PathChip[];
}

/** Walk the live forest so synthetic Total/Section parents are included in crumbs. */
function collectNodes(roots: TreeNode[]): IndexedNode[] {
  const out: IndexedNode[] = [];
  const walk = (n: TreeNode, parents: PathChip[]) => {
    const chip: PathChip = { key: nodeKey(n), kind: n.kind, label: n.label };
    const trail = [...parents, chip];
    out.push({ node: n, trail });
    for (const c of n.children || []) walk(c, trail);
  };
  for (const r of roots) walk(r, []);
  return out;
}

function scoreIndexed(entry: IndexedNode, q: string): number {
  const n = entry.node;
  const label = (n.label || "").toLowerCase();
  const code = (n.code || "").toLowerCase();
  const key = nodeKey(n).toLowerCase();
  const path = entry.trail.map((c) => c.label).join(" ").toLowerCase();
  if (!q) return 0;
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (code === q || code.startsWith(q)) return 70;
  if (label.includes(q)) return 50;
  if (code.includes(q) || key.includes(q)) return 40;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => label.includes(w))) return 45;
  if (words.length > 1 && words.every((w) => path.includes(w))) return 35;
  if (path.includes(q)) return 30;
  return 0;
}

export function suggestTreeNodes(
  forest: TreeNode[],
  query: string,
  limit = 12,
): TreeSuggest[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored: TreeSuggest[] = [];
  for (const entry of collectNodes(forest)) {
    const score = scoreIndexed(entry, q);
    if (score <= 0) continue;
    const ancestors = entry.trail.slice(0, -1);
    scored.push({
      key: nodeKey(entry.node),
      label: entry.node.label,
      kind: entry.node.kind,
      code: entry.node.code,
      ancestors,
      crumbPath: entry.trail.map((c) => c.label).join(" › "),
      amount_display_trillions: entry.node.amount_display_trillions,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || b.amount_display_trillions - a.amount_display_trillions);
  return scored.slice(0, limit);
}

export function TreeSearch({
  forest,
  onPick,
}: {
  forest: TreeNode[];
  onPick: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const suggestions = useMemo(() => suggestTreeNodes(forest, query), [forest, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        const menu = document.getElementById("tree-search-menu");
        if (menu?.contains(e.target as Node)) return;
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!open || !wrapRef.current) {
      setMenuBox(null);
      return;
    }
    const update = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      setMenuBox({
        top: r.bottom + 4,
        left: r.left,
        width: Math.max(r.width, Math.min(440, window.innerWidth - r.left - 12)),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, query, suggestions.length]);

  function pick(key: string) {
    onPick(key);
    setQuery("");
    setOpen(false);
  }

  const showMenu = open && query.trim().length >= 2 && menuBox;

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open || !suggestions.length) {
              if (e.key === "Escape") setOpen(false);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, suggestions.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = suggestions[active];
              if (hit) pick(hit.key);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Find dept, agency, program…"
          className="h-8 pl-8 text-xs"
          aria-autocomplete="list"
          aria-expanded={!!showMenu}
        />
      </div>
      {showMenu &&
        createPortal(
          <div
            id="tree-search-menu"
            style={{
              position: "fixed",
              top: menuBox.top,
              left: menuBox.left,
              width: menuBox.width,
            }}
            className="z-[80] max-h-80 overflow-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            {suggestions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matching nodes</div>
            ) : (
              <ul role="listbox" className="py-1">
                {suggestions.map((s, i) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className={cn(
                        "flex w-full flex-col items-stretch gap-1 px-2.5 py-2 text-left hover:bg-muted",
                        i === active && "bg-muted",
                      )}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(s.key)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("kind-chip shrink-0", `k-${s.kind}`)}>
                          {KIND_LABELS[s.kind] || s.kind}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={s.label}>
                          {s.label}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatAmountT(s.amount_display_trillions)}
                        </span>
                      </div>
                      {s.ancestors.length > 0 ? (
                        <div
                          className="flex flex-wrap items-center gap-1"
                          title={s.crumbPath}
                        >
                          {s.ancestors.map((a, idx) => (
                            <span key={a.key} className="inline-flex max-w-full items-center gap-1">
                              {idx > 0 && (
                                <span className="px-0.5 text-[10px] text-muted-foreground">›</span>
                              )}
                              <Badge
                                variant="outline"
                                className="h-auto max-w-full gap-1 rounded-full px-1.5 py-0.5 font-normal"
                              >
                                <span className={cn("kind-chip", `k-${a.kind}`)}>
                                  {KIND_LABELS[a.kind] || a.kind}
                                </span>
                                <span className="max-w-[140px] truncate text-[10px]">{a.label}</span>
                              </Badge>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
