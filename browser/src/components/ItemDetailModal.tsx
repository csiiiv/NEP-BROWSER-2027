import type { ReactNode } from "react";
import type { EnrichedRec } from "@/lib/data";
import type { Crumb } from "@/lib/path";
import { formatAmountP } from "@/lib/format";
import { BreadcrumbChips } from "@/components/BreadcrumbChips";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] break-words">
        {children}
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  if (children == null || children === "") return null;
  return (
    <code className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </code>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3">
      <h4 className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

export function ItemDetailModal({
  detail,
  pathLabel,
  trail,
  onNavigate,
  onClose,
}: {
  detail: EnrichedRec;
  pathLabel: string;
  trail: Crumb[];
  onNavigate: (key: string) => void;
  onClose: () => void;
}) {
  const amount = (detail.amount || 0) * 1000;
  const isZero = amount === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton>
        <DialogHeader className="gap-1 bg-chrome px-5 py-4 text-left text-chrome-foreground">
          <p className="text-[10px] font-bold tracking-[0.08em] text-chrome-muted uppercase">
            Line item
          </p>
          <DialogTitle className="text-base leading-snug text-white">
            {detail.object_name || detail.line_label || "—"}
          </DialogTitle>
          <DialogDescription
            className={cn(
              "pt-1 text-2xl font-bold tracking-tight tabular-nums text-white",
              isZero && "text-chrome-muted",
            )}
          >
            {formatAmountP(amount)}
            {detail.yoy_label && detail.yoy_label !== "—" && (
              <span
                className={cn(
                  "ml-3 text-base font-semibold tabular-nums",
                  detail.yoy_label === "NEW" && "text-chrome-muted",
                  detail.yoy_label.startsWith("+") && "text-emerald-300",
                  detail.yoy_label.startsWith("-") && "text-rose-300",
                )}
                title={
                  detail.yoy_label === "NEW"
                    ? "No matching FY2026 line (UACS key)"
                    : "Percent change vs FY2026"
                }
              >
                {detail.yoy_label}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[min(60vh,520px)] space-y-2.5 overflow-auto bg-muted/40 px-4 py-3">
          <Section title={pathLabel}>
            {trail.length ? (
              <BreadcrumbChips
                trail={trail}
                className="mt-0"
                clickableCurrent
                onNavigate={(key) => {
                  onNavigate(key);
                  onClose();
                }}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Path unavailable for this item.</p>
            )}
          </Section>

          <Section title="Expense">
            <div className="space-y-2.5">
              <Field label="Object code">
                <Code>{detail.object_uacs_code}</Code>
              </Field>
              <Field label="Funding source">
                <span>{detail.funding_name}</span>
                <Code>{detail.funding_uacs_code}</Code>
              </Field>
              <Field label="Program / PAP">{detail.program_description || "—"}</Field>
            </div>
          </Section>

          <Section title="Identifiers">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Record ID">
                <Code>{detail.id}</Code>
              </Field>
              <Field label="PREXC level">{detail.prexc_level ?? "—"}</Field>
              <Field label="PREXC FPAP ID">
                <Code>{String(detail.prexc_fpap_id || "")}</Code>
              </Field>
              <Field label="Excel row">
                {detail.excel_row ?? "—"}
                <span className="text-[11px] text-muted-foreground">header = row 1</span>
              </Field>
            </div>
          </Section>

          <Section title="Place">
            <div className="space-y-2.5">
              <Field label="Organization">
                <span>{detail.org_name || "—"}</span>
                <Code>{detail.org_uacs_code}</Code>
              </Field>
              <Field label="Division">
                <span>{detail.division_name || "—"}</span>
                <Code>{String(detail.division_code || "")}</Code>
              </Field>
              <Field label="Region">
                <span>{detail.region_name || "—"}</span>
                <Code>{detail.region_code}</Code>
              </Field>
            </div>
          </Section>
        </div>

        <Separator />
        <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-card sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            Press <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">Esc</kbd> to close
          </span>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
