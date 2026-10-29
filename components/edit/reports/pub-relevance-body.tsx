/**
 * Report 17 — Publication cancer relevance body. Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`); the page's unit gate admits the same actors as
 * the PATCH route's `canEditUnit`.
 *
 * One year of the center's research-member publications with the
 * `etl/center-pub-relevance` decision on each: the year select and the status
 * segments are URL params; the table (`pub-relevance-table.tsx`) owns the
 * confirm / flip / note writes. This is EVAL's "author review" step.
 */
import Link from "next/link";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { PubRelevanceTable } from "@/components/edit/reports/pub-relevance-table";
import { ReportCard } from "@/components/edit/reports/report-ui";
import { nci2aHref, nci2aUnitQuery } from "@/lib/edit/nci-2a-report";
import {
  filterPubRelevance,
  parsePubRelevanceParams,
  PUB_RELEVANCE_STATUS_LABEL,
  pubRelevanceYears,
  type PubRelevanceStatusFilter,
} from "@/lib/edit/pub-relevance-report";
import { loadPubRelevanceReport } from "@/lib/edit/pub-relevance-report.server";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const SEGMENTS: PubRelevanceStatusFilter[] = ["all", "ai", "rule", "confirmed", "not-scored"];

export async function renderPubRelevanceReport({
  code,
  kind,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const params = parsePubRelevanceParams(sp);
  const all = await loadPubRelevanceReport(code, params.year);
  const { rows, counts } = filterPubRelevance(all, params.status);
  const unitQuery = nci2aUnitQuery(code, kind);
  const statusHref = (s: PubRelevanceStatusFilter) =>
    nci2aHref(
      basePath,
      unitQuery,
      new URLSearchParams({
        year: String(params.year),
        ...(s === "all" ? {} : { status: s }),
      }).toString(),
    );

  return {
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
          <div className="border-apollo-border flex flex-wrap items-center gap-3 border-b px-5 py-4">
            <AutoSubmitForm
              action={basePath}
              className="group flex items-center gap-2"
              data-testid="pub-relevance-filters"
            >
              {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              {params.status !== "all" && (
                <input type="hidden" name="status" value={params.status} />
              )}
              <select
                name="year"
                defaultValue={String(params.year)}
                aria-label="Publication year"
                className="border-apollo-border-strong bg-apollo-surface h-[34px] rounded-md border px-2 text-sm"
              >
                {pubRelevanceYears().map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm group-data-[hydrated=true]:hidden"
              >
                Apply
              </button>
            </AutoSubmitForm>
            <nav
              aria-label="Review status"
              className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
              data-testid="pub-relevance-status-filter"
            >
              {SEGMENTS.map((s) => {
                const on = params.status === s;
                return (
                  <Link
                    key={s}
                    href={statusHref(s)}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap tabular-nums no-underline",
                      on
                        ? "bg-apollo-surface text-foreground font-semibold shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s === "all" ? "All" : PUB_RELEVANCE_STATUS_LABEL[s]}{" "}
                    {counts[s].toLocaleString()}
                  </Link>
                );
              })}
            </nav>
          </div>
          <PubRelevanceTable
            centerCode={code}
            rows={rows}
            resetKey={`${params.year}:${params.status}`}
          />
        </section>
        <ReportCard>
          <ul
            className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]"
            data-testid="pub-relevance-assumptions"
          >
            <li>
              Rows: publications from {params.year} with at least one confirmed author who is a
              research member of this center.
            </li>
            <li>
              MCC rule: a review, preprint, erratum, letter, comment, editorial or retraction (by
              PubMed publication type) is not cancer relevant. These are final and need no review.
            </li>
            <li>
              AI: Sonnet read the title, abstract and MeSH terms under MCC&apos;s rubric. Confirm
              it, or flip it and say why; either makes it Confirmed, and the relevance step never
              changes it again.
            </li>
            <li>Not scored: decided on the next run of the relevance step.</li>
          </ul>
        </ReportCard>
      </div>
    ),
  };
}
