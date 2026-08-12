import { Link, NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export function AppChrome({
  year = "2027",
  view = "nep",
  children,
}: {
  year?: string;
  view?: string;
  children?: ReactNode;
}) {
  const location = useLocation();
  const browseTo = `/${year}/${view}`;
  const onAbout = location.pathname === "/about" || location.pathname.endsWith("/about");

  return (
    <header className="shrink-0 border-b border-border bg-card z-10">
      <div className="flex items-center justify-between gap-4 bg-chrome px-4 py-2.5 text-chrome-foreground">
        <div className="min-w-0 flex flex-col gap-0.5">
          <Link
            to={browseTo}
            className="truncate text-[15px] font-semibold tracking-tight text-white hover:underline hover:underline-offset-4"
          >
            NEP Budget Browser
          </Link>
          <span className="truncate text-[11px] text-chrome-muted">
            Philippine National Expenditure Program
          </span>
        </div>
        <nav className="flex shrink-0 gap-1" aria-label="Primary">
          <NavLink
            to={browseTo}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "text-chrome-muted hover:bg-white/10 hover:text-white",
              !onAbout && "bg-white/15 text-white",
            )}
          >
            Browse
          </NavLink>
          <NavLink
            to="/about"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "text-chrome-muted hover:bg-white/10 hover:text-white",
              onAbout && "bg-white/15 text-white",
            )}
          >
            About
          </NavLink>
        </nav>
      </div>
      {children}
    </header>
  );
}
