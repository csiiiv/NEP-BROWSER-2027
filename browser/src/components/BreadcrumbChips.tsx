import type { Crumb } from "@/lib/path";
import { KIND_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  if (!trail.length) return null;
  return (
    <nav
      className={cn("mt-2 flex flex-wrap items-center gap-1", className)}
      aria-label="Selection path"
    >
      {trail.map((c, i) => {
        const last = i === trail.length - 1;
        const asButton = !last || clickableCurrent;
        const chip = (
          <>
            <span className={cn("kind-chip", `k-${c.kind}`)}>
              {KIND_LABELS[c.kind] || c.kind}
            </span>
            <span className="max-w-[220px] truncate">{c.label}</span>
          </>
        );
        return (
          <span key={c.key} className="inline-flex max-w-full items-center gap-1">
            {i > 0 && <span className="px-0.5 text-muted-foreground">›</span>}
            {asButton ? (
              <Button
                type="button"
                variant={last ? "secondary" : "outline"}
                size="sm"
                className={cn(
                  "h-auto gap-1.5 rounded-full px-2 py-1",
                  last ? "font-semibold" : "font-normal",
                )}
                title={c.key}
                aria-current={last ? "page" : undefined}
                onClick={() => onNavigate(c.key)}
              >
                {chip}
              </Button>
            ) : (
              <Badge
                variant="secondary"
                className="h-auto gap-1.5 rounded-full px-2 py-1 font-semibold"
                title={c.key}
                aria-current="page"
              >
                {chip}
              </Badge>
            )}
          </span>
        );
      })}
    </nav>
  );
}
