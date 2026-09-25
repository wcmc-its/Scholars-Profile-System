/**
 * Report 2 — "NCI Table 2a" body (reports redesign, 2026-09-25; mockup
 * `NCI Table 2a Redesign.dc.html`). Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`); the page's unit gate (`loadReportsContext`)
 * admits the same actors as the API's `canEditUnit`.
 *
 * Top card: cycle-wide review progress, the banner, the headline numbers and
 * the CSV button. Results card: the status segments (All / Needs review /
 * Reviewed), the program and peer-reviewed selects and the search box — all
 * URL params, so the numbers, the table and the CSV follow the same filters —
 * then the chips and the table (`nci-2a-table.tsx`, the client half: paging,
 * inline percent edit, Accept).
 *
 * Filters sit inline, not in a rail (fewer than four facets, plan D4).
 * Loader: `lib/edit/nci-2a-report.server.ts`; filters, numbers, chips and the
 * CSV: `lib/edit/nci-2a-report.ts`.
 */
import Link from "next/link";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { Nci2aDownloadButton, Nci2aTable } from "@/components/edit/reports/nci-2a-table";
import { FilterChips, ReportCard, ReportStats } from "@/components/edit/reports/report-ui";
import { Progress } from "@/components/ui/progress";
import {
  filterNci2a,
  NCI2A_UNASSIGNED,
  nci2aCsvFilename,
  nci2aFiltered,
  nci2aHref,
  nci2aUnitQuery,
  nci2aChips,
  nci2aDownloadNote,
  nci2aQueryString,
  nci2aStatTiles,
  nci2aStats,
  parseNci2aParams,
  reviewProgress,
  sortQuery,
  type Nci2aParams,
  type Nci2aSortKey,
  type Nci2aStatusFilter,
} from "@/lib/edit/nci-2a-report";
import { loadNci2aReport } from "@/lib/edit/nci-2a-report.server";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";

export const NCI2A_BANNER =
  "Cancer-Relevant Percent marked AI-suggested is a Bedrock proposal per Meyer's cancer-relevance method, from the project title and funding source. Confirming or correcting it here is what makes it defensible in peer-review — review before this leaves the building.";

function toSearchParams(sp: UnitReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** Hidden inputs carrying the unit and the params a form doesn't own, defaults left out. */
function Carry({
  unitQuery,
  params,
  omit,
}: {
  unitQuery: string;
  params: Nci2aParams;
  omit: Array<keyof Nci2aParams>;
}) {
  const q = new URLSearchParams(nci2aQueryString(params));
  return (
    <>
      {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {[...q.entries()]
        .filter(([k]) => !omit.includes(k as keyof Nci2aParams))
        .map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
    </>
  );
}

function QueryAndAssumptions({ cycle }: { cycle: string }) {
  return (
    <section
      className="text-muted-foreground max-w-[760px] text-[13px]"
      data-testid="nci-2a-assumptions"
    >
      <h2 className="text-foreground text-sm font-semibold">Query &amp; Assumptions</h2>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        <li>
          Rows: every funded project in this center&apos;s latest OSRA import ({cycle}). Figures are
          annual direct costs.
        </li>
        <li>
          Cancer-relevant %: proposed by Bedrock from the project title and funding source, and
          marked AI-suggested until a reviewer accepts it (Confirmed) or saves a different value
          (Corrected, which names what the AI said). Review progress counts the projects that have
          an AI-suggested percentage. A project with no proposed percentage is Not inferred: it
          counts as Needs review and is left out of the Cancer-relevant dollar figure.
        </li>
        <li>
          Program: the PI&apos;s current program in the center roster; if the PI has none, the
          program recorded at import.
        </li>
        <li>
          Peer-reviewed: an NIH (including NCI) award, or a funder on NCI&apos;s list of
          peer-reviewing organizations.
        </li>
        <li>
          The CSV holds the rows these filters select (its name ends in -filtered when that is not
          the whole cycle), one line per program, with a Review Status column (Confirmed, Corrected
          or Needs review). It is award-level NCI submission data, so it is exempt from the
          50-person limit on scholar exports: it names PIs but has no CWID column.
        </li>
      </ul>
    </section>
  );
}

export async function renderNciTable2aReport({
  code,
  kind,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const params = parseNci2aParams(toSearchParams(searchParams));
  const data = await loadNci2aReport(code);
  const unitQuery = nci2aUnitQuery(code, kind);
  const href = (q: string) => nci2aHref(basePath, unitQuery, q);

  if (!data.cycle || data.awards.length === 0) {
    return {
      main: (
        <ReportCard className="mt-7">
          <p className="text-muted-foreground text-sm" data-testid="nci-2a-no-cycle">
            No import cycle found yet. Run the OSRA workbook import (
            <code>scripts/backfills/2026-08-08-cancer-center-nci-2a-import.ts</code>) to populate
            this report.
          </p>
        </ReportCard>
      ),
    };
  }

  const cycle = data.cycle;
  const { rows, counts } = filterNci2a(data.awards, params);
  const stats = nci2aStats(rows);
  const progress = reviewProgress(data.awards);
  const filtered = nci2aFiltered(params);
  const note = nci2aDownloadNote(cycle, stats, filtered);
  const chips = nci2aChips(params, data.programs);
  const narrowed = params.program !== "" || params.peer !== "" || params.q !== "";
  const sortHrefs = Object.fromEntries(
    (["pi", "dc", "pct", "rel"] as Nci2aSortKey[]).map((k) => [k, href(sortQuery(params, k))]),
  ) as Record<Nci2aSortKey, string>;
  const segments: Array<[Nci2aStatusFilter, string, number]> = [
    ["all", "All", counts.all],
    ["needs", "Needs review", counts.needs],
    ["done", "Reviewed", counts.done],
  ];
  const emptyMessage =
    params.status === "needs" && !narrowed
      ? "Nothing left to review. Every percentage is confirmed or corrected."
      : "No projects match these filters.";
  const programKnown =
    params.program === "" ||
    params.program === NCI2A_UNASSIGNED ||
    data.programs.some((p) => p.code === params.program);

  return {
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        <ReportCard className="grid gap-x-10 gap-y-7 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2.5" data-testid="nci-2a-progress">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[32px] leading-none font-bold tabular-nums">
                {progress.reviewed.toLocaleString()} of {progress.total.toLocaleString()}
              </span>
              <span className="text-muted-foreground text-[15px]">
                AI-suggested percentages reviewed
              </span>
            </div>
            <Progress value={progress.pct} aria-label="Review progress" />
            <p
              className="text-muted-foreground text-[13px] leading-normal"
              data-testid="nci-2a-banner"
            >
              {NCI2A_BANNER}
            </p>
            {progress.pending > 0 && (
              <div>
                <Link
                  href={href(
                    nci2aQueryString(parseNci2aParams(new URLSearchParams()), { status: "needs" }),
                  )}
                  className="border-apollo-border-strong hover:bg-apollo-surface-2 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium"
                  data-testid="nci-2a-review-link"
                >
                  Review {progress.pending.toLocaleString()}{" "}
                  {progress.pending === 1 ? "suggestion" : "suggestions"}
                </Link>
              </div>
            )}
          </div>
          <ReportStats
            stats={nci2aStatTiles(stats)}
            testId="nci-2a-stats"
            aside={
              <div className="flex flex-col items-start gap-2">
                <Nci2aDownloadButton filename={nci2aCsvFilename(cycle, filtered)} rows={rows} />
                <p
                  className={cn(
                    "text-[13px]",
                    note.pending ? "text-apollo-amber" : "text-muted-foreground",
                  )}
                  data-testid="nci-2a-download-note"
                >
                  {note.text}
                </p>
              </div>
            }
          />
        </ReportCard>

        <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
          <div className="border-apollo-border flex flex-col gap-3 border-b px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <nav
                aria-label="Review status"
                className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
                data-testid="nci-2a-status-filter"
              >
                {segments.map(([k, label, n]) => {
                  const on = params.status === k;
                  return (
                    <Link
                      key={k}
                      href={href(nci2aQueryString(params, { status: k }))}
                      aria-current={on ? "page" : undefined}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap tabular-nums no-underline",
                        on
                          ? "bg-apollo-surface text-foreground font-semibold shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label} {n.toLocaleString()}
                    </Link>
                  );
                })}
              </nav>
              <AutoSubmitForm
                action={basePath}
                className="group flex flex-wrap items-center gap-3"
                data-testid="nci-2a-filters"
              >
                <Carry unitQuery={unitQuery} params={params} omit={["program", "peer"]} />
                <select
                  name="program"
                  defaultValue={params.program}
                  aria-label="Program"
                  className={SELECT}
                >
                  <option value="">All programs</option>
                  {data.programs.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.code} — {p.label}
                    </option>
                  ))}
                  <option value={NCI2A_UNASSIGNED}>Unassigned</option>
                  {!programKnown && <option value={params.program}>{params.program}</option>}
                </select>
                <select
                  name="peer"
                  defaultValue={params.peer}
                  aria-label="Peer-reviewed"
                  className={SELECT}
                >
                  <option value="">Peer-reviewed or not</option>
                  <option value="yes">Peer-reviewed only</option>
                  <option value="no">Not peer-reviewed only</option>
                </select>
                <button
                  type="submit"
                  className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm group-data-[hydrated=true]:hidden"
                >
                  Apply
                </button>
              </AutoSubmitForm>
              {/* Its own form: typing must not submit per keystroke; Enter does. */}
              <form
                method="get"
                action={basePath}
                role="search"
                className="w-full sm:w-64"
                data-testid="nci-2a-search"
              >
                <Carry unitQuery={unitQuery} params={params} omit={["q"]} />
                <input
                  type="search"
                  name="q"
                  defaultValue={params.q}
                  placeholder="Search PI, funder or project"
                  aria-label="Search PI, CWID, funder, project number or title"
                  className="border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm"
                />
              </form>
            </div>
            <FilterChips
              chips={chips.map((c) => ({
                group: c.group,
                value: c.value,
                removeHref: href(c.removeQuery),
              }))}
              testId="nci-2a-chips"
            />
          </div>
          <Nci2aTable
            centerCode={code}
            rows={rows}
            resetKey={nci2aQueryString(params)}
            sort={params.sort}
            dir={params.dir}
            sortHrefs={sortHrefs}
            emptyMessage={emptyMessage}
          />
        </section>

        <p className="text-muted-foreground max-w-[760px] text-[13px]" role="note">
          Relevant DC = direct costs × cancer-relevant %. Program is set by each person&apos;s
          center membership and can&apos;t be changed here;{" "}
          <Link href={`/edit/center/${encodeURIComponent(code)}`}>
            edit it in the center roster
          </Link>
          . Press Enter or leave the field to save a percentage; Esc undoes. &ldquo;Accept … shown
          suggestions&rdquo; confirms the AI-suggested rows on screen, up to 50 at a time.
        </p>
        <QueryAndAssumptions cycle={cycle} />
      </div>
    ),
  };
}
