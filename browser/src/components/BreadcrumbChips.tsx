import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Crumb } from "@/lib/path";
import { KIND_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function CrumbChip({
  crumb,
  last,
  clickable,
  onNavigate,
}: {
  crumb: Crumb;
  last: boolean;
  clickable: boolean;
  onNavigate: (key: string) => void;
}) {
  const chip = (
    <>
      <span className={cn("kind-chip", `k-${crumb.kind}`)}>
        {KIND_LABELS[crumb.kind] || crumb.kind}
      </span>
      <span className="max-w-[220px] truncate">{crumb.label}</span>
    </>
  );
  if (clickable) {
    return (
      <Button
        type="button"
        variant={last ? "secondary" : "outline"}
        size="sm"
        className={cn(
          "h-auto gap-1.5 rounded-full px-2 py-1",
          last ? "font-semibold" : "font-normal",
        )}
        title={crumb.key}
        aria-current={last ? "page" : undefined}
        onClick={() => onNavigate(crumb.key)}
      >
        {chip}
      </Button>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="h-auto gap-1.5 rounded-full px-2 py-1 font-semibold"
      title={crumb.key}
      aria-current="page"
    >
      {chip}
    </Badge>
  );
}

export function BreadcrumbChips({
  trail,
  onNavigate,
  className,
  /** When true, the current (last) crumb is also a button — useful in item detail. */
  clickableCurrent = false,
}: {
  trail: Crumb[];
  onNavigate: (key: string) => void;
  className?: string;
  clickableCurrent?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  if (!trail.length) return null;

  const current = trail[trail.length - 1]!;

  return (
    <>
      {/* Desktop: full path */}
      <nav
        className={cn("mt-2 hidden flex-wrap items-center gap-1 md:flex", className)}
        aria-label="Selection path"
      >
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <span key={c.key} className="inline-flex max-w-full items-center gap-1">
              {i > 0 && <span className="px-0.5 text-muted-foreground">›</span>}
              <CrumbChip
                crumb={c}
                last={last}
                clickable={!last || clickableCurrent}
                onNavigate={onNavigate}
              />
            </span>
          );
        })}
      </nav>

      {/* Mobile: latest only + dropdown for full path */}
      <div className={cn("mt-2 md:hidden", className)}>
        <DropdownMenu open={mobileOpen} onOpenChange={setMobileOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto max-w-full gap-1.5 rounded-full px-2 py-1 font-normal"
              aria-label="Show full path"
            >
              <span className={cn("kind-chip", `k-${current.kind}`)}>
                {KIND_LABELS[current.kind] || current.kind}
              </span>
              <span className="min-w-0 truncate font-semibold">{current.label}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-[min(100vw-2rem,20rem)]">
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <DropdownMenuItem
                  key={c.key}
                  className={cn("gap-2", last && "font-semibold")}
                  onClick={() => {
                    if (!last || clickableCurrent) onNavigate(c.key);
                    setMobileOpen(false);
                  }}
                >
                  <span className={cn("kind-chip shrink-0", `k-${c.kind}`)}>
                    {KIND_LABELS[c.kind] || c.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {last && (
                    <span className="text-[10px] text-muted-foreground uppercase">Current</span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
