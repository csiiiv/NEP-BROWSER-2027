import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { AppChrome } from "@/components/AppChrome";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

export default function About() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <AppChrome />
      <main className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,oklch(0.92_0.03_250),transparent_55%)] px-4 py-8">
        <Card className="mx-auto max-w-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">About this browser</CardTitle>
            <CardDescription>
              Explore the Philippine National Expenditure Program (NEP) from pre-built static
              assets: department/agency trees, automatic appropriations, and leaf-level expense
              lines (PREXC level 7). Built for{" "}
              <ExtLink href="https://github.com/bettergovph">BetterGovPH</ExtLink>
              . Source code:{" "}
              <ExtLink href="https://github.com/csiiiv/NEP-BROWSER-2027">
                github.com/csiiiv/NEP-BROWSER-2027
              </ExtLink>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 text-sm leading-relaxed">
            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Sources & attribution
              </h2>
              <p>
                Appropriation amounts and budget classifications come from official Philippine
                government publications. This app only reshapes and displays that data.
              </p>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>This repository</strong> —{" "}
                  <ExtLink href="https://github.com/csiiiv/NEP-BROWSER-2027">
                    csiiiv/NEP-BROWSER-2027
                  </ExtLink>{" "}
                  (pipeline, browser UI, and GitHub Pages deploy).
                </li>
                <li>
                  <strong>National Expenditure Program (NEP)</strong> — published by the{" "}
                  <ExtLink href="https://www.dbm.gov.ph/">
                    Department of Budget and Management (DBM)
                  </ExtLink>
                  . See the DBM{" "}
                  <ExtLink href="https://www.dbm.gov.ph/index.php/program-expenditure-classification-prexc?catid=146&id=1204&view=article">
                    NEP section / archives
                  </ExtLink>
                  {" "}
                  and, for example,{" "}
                  <ExtLink href="https://www.dbm.gov.ph/index.php?catid=400&id=3524%3Anational-expenditure-program-volume-i-fy-2026&view=article">
                    NEP Volume I FY 2026
                  </ExtLink>
                  . Workbooks such as <code className="rounded bg-muted px-1 py-0.5 text-xs">NEP-FY20XX.xlsx</code> are
                  converted into the assets this browser loads.
                </li>
                <li>
                  <strong>Unified Accounts Code Structure (UACS)</strong> — DBM coding for
                  organizations, funding sources, object codes, regions, and related labels used
                  when enriching line items. Documentation is linked from the{" "}
                  <ExtLink href="https://www.dbm.gov.ph/">DBM website</ExtLink> (UACS / PREXC materials).
                </li>
                <li>
                  <strong>Open budget JSON conventions</strong> — pipeline layout and some stable
                  reference lookups align with{" "}
                  <ExtLink href="https://github.com/bettergovph/open-budget-data">
                    bettergovph/open-budget-data
                  </ExtLink>
                  .
                </li>
              </ul>
              <p className="text-muted-foreground">
                DBM notes that site content is in the public domain unless otherwise stated. Prefer
                the official DBM release for authoritative figures. This browser is{" "}
                <strong>not</strong> an official government product and may lag publications or
                introduce transform/display errors.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">AI-assisted analysis.</strong> The figures,
                hierarchy, and structures on this site were parsed, aggregated, and drafted by AI
                agents with human oversight. The dataset and its interpretations may contain
                errors, mis-classifications, or stale figures — always verify against the official
                documents and sources before citing. Report errors or discrepancies via{" "}
                <ExtLink href="https://github.com/csiiiv/NEP-BROWSER-2027/issues">
                  GitHub Issues
                </ExtLink>
                ; they may be patched in a later release.
              </p>
            </section>

            <Separator />

            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Views
              </h2>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>NEP</strong> — Dept → Agency → Program → Region → Division → OU
                  (program-first)
                </li>
                <li>
                  <strong>Place</strong> — Dept → Agency → Region → Division → OU → Program
                  (geography-first)
                </li>
              </ul>
            </section>

            <Separator />

            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                How to use
              </h2>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  Expand the hierarchy; open a <strong>leaf</strong> (OU in NEP, Program in Place)
                  to load line items.
                </li>
                <li>
                  Selection is reflected in the URL as{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    #/&#123;year&#125;/&#123;view&#125;/n/&#123;nodeKey&#125;
                  </code>
                  .
                </li>
                <li>
                  Search scopes: <strong>Current selection</strong> (default) or{" "}
                  <strong>All</strong> (entire year—confirm before running). Progress shows shards
                  checked, hit count, and total amount.
                </li>
                <li>
                  Use <strong>Columns</strong> to show/hide and reorder table fields. Click a row
                  for detail; the path chips navigate the hierarchy.
                </li>
                <li>Amounts are shown in pesos (source values are thousands × 1,000).</li>
                <li>
                  For <strong>FY2027</strong>, hierarchy nodes and the item <strong>YoY</strong>{" "}
                  column compare to FY2026 when codes/keys match. Unmatched nodes or lines are
                  marked <strong>NEW</strong>.
                </li>
              </ul>
            </section>

            <Separator />

            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Data on disk
              </h2>
              <p>
                Runtime assets live under{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  data/budget/&#123;year&#125;/browser/
                </code>{" "}
                (gzipped trees, shards, AA, meta). Labels come from organization, funding, object,
                and location JSON. Gzip responses are cached in the browser Cache API.
              </p>
            </section>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2 sm:justify-between">
            <Link to="/2027/nep" className={cn(buttonVariants({ variant: "default" }))}>
              ← Back to browser
            </Link>
            <a
              href="https://github.com/csiiiv/NEP-BROWSER-2027"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              GitHub repository
            </a>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
