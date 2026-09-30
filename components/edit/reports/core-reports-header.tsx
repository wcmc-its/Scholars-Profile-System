/**
 * The shared header of a numbered report viewed for a core (`?kind=core`:
 * reports 3, 6, 11, 12, 13) — mockup `Core pub review/Core Reports.dc.html`.
 * "← Review queue" (`/edit/core/<id>/review`) with the "Viewing" picker at
 * the right; the "CORE FACILITY" eyebrow; "{core} reports" as the `<h1>`; and
 * a tab strip across the core's reports, the current one selected. It stands
 * in for the page's "← All reports" link, and the report's own name moves out
 * of the h1 (`ReportHeader`'s `underCoreHeader`), since the selected tab
 * already says it.
 *
 * Tabs carry only the core pair (`center`, `kind`): every other param is one
 * report's filter (`view`, `evid`, `basis`, …) and even the shared `from` /
 * `to` default differently per report (12 opens on the last nine years, 11 on
 * all years), so carrying them would open the next report on a window it
 * never chose. The picker is hidden when the viewer can report on one core.
 * On a phone the picker takes its own line and the tabs scroll sideways.
 *
 * All cores (`allCount` set, `coreId` = "all"; a superuser only, the page
 * decides): the "Core facilities · Roll-up" eyebrow, "All cores reports", a
 * lede saying a publication used by two cores counts once, and no "← Review
 * queue" (there is no all-cores queue). The page hands only reports 11–13 as
 * tabs.
 *
 * Server-safe and synchronous; the picker is the only client island.
 */
import Link from "next/link";

import type { CorePickerOption } from "@/components/edit/reports/core-picker";
import { CoreReportPicker } from "@/components/edit/reports/core-report-picker";
import { cn } from "@/lib/utils";

export type CoreReportTab = { n: string; name: string; slug: string };

export function CoreReportsHeader({
  coreId,
  coreName,
  options,
  tabs,
  current,
  allCount,
}: {
  coreId: string;
  coreName: string;
  /** The cores this viewer can report on, A–Z. */
  options: ReadonlyArray<CorePickerOption>;
  /** The core's reports, in report-number order. */
  tabs: ReadonlyArray<CoreReportTab>;
  /** The report on screen (`report_meta.report_key`). */
  current: string;
  /** Set for the all-cores roll-up: how many cores it covers. */
  allCount?: number;
}) {
  const all = allCount !== undefined;
  const here = tabs.find((t) => t.n === current);
  const scope = new URLSearchParams({ center: coreId, kind: "core" }).toString();
  return (
    <div className="mb-6" data-testid="core-reports-header">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-3",
          all ? "justify-end" : "justify-between",
        )}
      >
        {!all && (
          <Link
            href={`/edit/core/${encodeURIComponent(coreId)}/review`}
            className="text-apollo-slate text-sm hover:underline"
            data-testid="core-reports-queue-link"
          >
            &larr; Review queue
          </Link>
        )}
        {options.length > 1 && here && (
          <CoreReportPicker
            // Remount on a new core, so Back (a new `coreId`) resets the select.
            key={coreId}
            options={options}
            value={coreId}
            basePath={`/edit/reports/${here.slug}`}
          />
        )}
      </div>
      <div
        className="text-muted-foreground mt-4 text-xs tracking-[0.12em] uppercase"
        data-testid="core-reports-eyebrow"
      >
        {all ? "Core facilities · Roll-up" : "Core facility"}
      </div>
      <h1 className="mt-1.5 mb-0 text-[26px] font-bold tracking-[-0.01em] [overflow-wrap:anywhere]">
        {coreName} reports
      </h1>
      {all && (
        <p
          className="text-muted-foreground mt-2 max-w-[720px] text-[15px] leading-normal"
          data-testid="core-reports-lede"
        >
          The same reports rolled up across all {allCount} core facilities. A publication used by
          two cores counts once in totals.
        </p>
      )}
      <nav
        aria-label="Core reports"
        className="mt-5 overflow-x-auto"
        data-testid="core-reports-tabs"
      >
        <div className="border-apollo-border flex min-w-max gap-x-6 border-b">
          {tabs.map((t) => {
            const on = t.n === current;
            return (
              <Link
                key={t.n}
                href={`/edit/reports/${t.slug}?${scope}`}
                aria-current={on ? "page" : undefined}
                data-testid={`core-reports-tab-${t.n}`}
                className={cn(
                  "-mb-px shrink-0 border-b-2 py-2.5 text-[15px] whitespace-nowrap",
                  on
                    ? "border-apollo-maroon text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {t.name}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
