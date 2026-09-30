/**
 * UnitMembersSummary — the "Members" section of the single-scroll unit editor
 * (Edit Center / Edit Org Unit mockups, 2026-09-25): a title + one-line
 * explainer, the member count, and the ways into the full list — "Export CSV"
 * and, for a unit with a curated roster, "Manage members →" to the full-width
 * roster page (`?attr=roster`).
 *
 * Presentational and server-safe (no hooks); the caller supplies the count.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

export function UnitMembersSummary({
  description,
  count,
  countLabel,
  exportHref,
  manageHref,
  headingId = "members-heading",
}: {
  description: string;
  count: number;
  /** The word after the count ("faculty", "active"). */
  countLabel: string;
  exportHref?: string;
  manageHref?: string;
  headingId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4" data-testid="unit-members-summary">
      <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
        <h2 id={headingId} className="text-[17px] font-[600] tracking-[-0.015em]">
          Members
        </h2>
        <p className="text-muted-foreground text-[13px]">{description}</p>
      </div>
      <p className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums" data-testid="unit-members-count">
          {count.toLocaleString("en-US")}
        </span>
        <span className="text-muted-foreground text-[13px]">{countLabel}</span>
      </p>
      {(exportHref || manageHref) && (
        <div className="flex flex-wrap items-center gap-2">
          {exportHref && (
            <Button asChild variant="outline" size="sm">
              <a href={exportHref} data-testid="unit-members-export">
                Export CSV
              </a>
            </Button>
          )}
          {manageHref && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-apollo-slate text-apollo-slate"
            >
              <Link href={manageHref} data-testid="unit-members-manage">
                Manage members
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
