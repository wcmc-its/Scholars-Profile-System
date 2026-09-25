/**
 * Report 10 — "Display titles" body (Paul, 2026-09-25: the shared report
 * layout, no new artboard). Top to bottom: the "How titles are chosen" rubric
 * (`#rubric`, which the `/edit` title picker deep-links to), rendered FROM
 * `TITLE_RANK` / `TITLE_RANK_LABEL` so it cannot drift from the ladder; then
 * the filter rail (reason, rank band, pinned, winning rule, search) in a plain
 * GET `AutoSubmitForm`, the headline counts with the `.xlsx` button, and one
 * row per listed scholar.
 *
 * Who is listed, and why, is `lib/edit/title-dashboard.ts`; the download route
 * (`/api/edit/reports/display-titles`) takes the same query string through the
 * same `parseTitleDashboardParams`. The per-row "Change" disclosure REUSES
 * `TitleField` (its `/api/edit/field` write, its audit row) — this report adds
 * no write path. Only superuser / comms_steward get it: the person gate also
 * admits grantees, who may look but not set.
 */
import { Download } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  FilterChips,
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
  type FilterChip,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { TitleField } from "@/components/edit/title-field";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";
import {
  filterTitleDashboard,
  formatTitleRank,
  loadTitleDashboard,
  parseTitleDashboardParams,
  TITLE_BAND_LABEL,
  TITLE_BANDS,
  TITLE_REASON_LABEL,
  TITLE_REASONS,
  TITLE_RULES,
  titleDashboardQueryString,
  titleRowNotes,
  titleRuleLabel,
  winningRank,
  winningRule,
  type TitleDashboardParams,
  type TitleDashboardRow,
} from "@/lib/edit/title-dashboard";
import { TITLE_RANK, TITLE_RANK_LABEL } from "@/lib/scholar-title";

const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const TH = "text-muted-foreground px-3 py-2 text-left text-xs font-semibold tracking-[0.04em] uppercase";
const TD = "px-3 py-3 align-top";

/** The ladder, highest first; "Anything else" (unranked) sorts last on its own. */
export const RUBRIC_ROWS = (Object.keys(TITLE_RANK) as Array<keyof typeof TITLE_RANK>)
  .map((k) => ({ key: k, rank: TITLE_RANK[k], label: TITLE_RANK_LABEL[k] }))
  .sort((a, b) => a.rank - b.rank);

/** The tie-breaks and exceptions the ladder alone does not say (External
 *  Affairs, 2026-09-24/25). */
export const RUBRIC_RULES = [
  "Pins always win.",
  "Ties go to the working title, then the ED primary title.",
  "Emeritus titles hold no office.",
  "Every tracked center counts as institutional.",
  "Center associate directors and co-directors never title their holder.",
  "A director title naming its own department, or the department its holder chairs, ranks as Chair.",
  "A working title claims Chair only when a chair role backs it.",
  "Only academic departments have chairs: Graduate School and MD-PhD Program do not.",
] as const;

function toSearchParams(sp: PersonReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

function Rubric() {
  return (
    <ReportCard className="mt-7">
      <section id="rubric" aria-labelledby="rubric-heading" className="scroll-mt-4" data-testid="title-rubric">
        <h2 id="rubric-heading" className="text-base font-semibold">
          How titles are chosen
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Every title a scholar holds is ranked on this ladder; the highest-ranked one is displayed.
        </p>
        <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <table className="w-full text-sm" data-testid="title-rubric-ladder">
            <thead>
              <tr className="border-apollo-border border-b">
                <th scope="col" className={`${TH} w-16`}>
                  Rank
                </th>
                <th scope="col" className={TH}>
                  Title
                </th>
              </tr>
            </thead>
            <tbody>
              {RUBRIC_ROWS.map((r) => (
                <tr key={r.key} className="border-apollo-border border-b last:border-b-0">
                  <td className="px-3 py-1.5 tabular-nums">{formatTitleRank(r.rank)}</td>
                  <td className="px-3 py-1.5">{r.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <h3 className="text-sm font-semibold">Rules</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm" data-testid="title-rubric-rules">
              {RUBRIC_RULES.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-[13px]">Source: External Affairs, 2026-09-24/25.</p>
          </div>
        </div>
      </section>
    </ReportCard>
  );
}

/** A single-choice rail section: "Any" (value "") then each option. */
function RadioSection({
  label,
  name,
  value,
  options,
  testId,
}: {
  label: string;
  name: string;
  value: string | null;
  options: ReadonlyArray<readonly [string, string]>;
  testId: string;
}) {
  return (
    <RailSection label={label} summary={options.find(([v]) => v === value)?.[1] ?? "Any"} testId={testId}>
      <div className="flex flex-col gap-2">
        {[["", "Any"] as const, ...options].map(([v, l]) => (
          <label key={v} className={RADIO}>
            <input type="radio" name={name} value={v} defaultChecked={(value ?? "") === v} className={RADIO_INPUT} />
            {l}
          </label>
        ))}
      </div>
    </RailSection>
  );
}

const pinnedValue = (p: TitleDashboardParams) => (p.pinned === null ? null : p.pinned ? "yes" : "no");

function Rail({
  basePath,
  params,
  resetHref,
}: {
  basePath: string;
  params: TitleDashboardParams;
  resetHref: string | null;
}) {
  return (
    <ReportRail resetHref={resetHref} help="Filters apply automatically." testId="display-titles-rail">
      <AutoSubmitForm action={basePath} className="group" data-testid="display-titles-filters">
        <RailSection label="Search" summary={params.q || "Name, CWID or title"} defaultOpen testId="display-titles-q">
          <input
            type="search"
            name="q"
            defaultValue={params.q}
            aria-label="Search name, CWID or title"
            className="border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm"
          />
        </RailSection>
        <RadioSection
          label="Reason"
          name="reason"
          value={params.reason}
          options={TITLE_REASONS.map((r) => [r, TITLE_REASON_LABEL[r]] as const)}
          testId="display-titles-reason"
        />
        <RadioSection
          label="Rank band"
          name="band"
          value={params.band}
          options={TITLE_BANDS.map((b) => [b, TITLE_BAND_LABEL[b]] as const)}
          testId="display-titles-band"
        />
        <RadioSection
          label="Pinned"
          name="pinned"
          value={pinnedValue(params)}
          options={[
            ["yes", "Yes"],
            ["no", "No"],
          ]}
          testId="display-titles-pinned"
        />
        <RadioSection
          label="Winning rule"
          name="rule"
          value={params.rule}
          options={TITLE_RULES.map((r) => [r, titleRuleLabel(r)] as const)}
          testId="display-titles-rule"
        />
        {/* No-JS fallback; the island hides it once hydrated. */}
        <div className="px-[18px] pb-4 group-data-[hydrated=true]:hidden">
          <button
            type="submit"
            className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm"
          >
            Apply
          </button>
        </div>
      </AutoSubmitForm>
    </ReportRail>
  );
}

/** The active filters as chips, each removing itself. */
function chipsFor(p: TitleDashboardParams, basePath: string): FilterChip[] {
  const without = (patch: Partial<TitleDashboardParams>) => {
    const q = titleDashboardQueryString({ ...p, ...patch });
    return q ? `${basePath}?${q}` : basePath;
  };
  const out: FilterChip[] = [];
  if (p.q) out.push({ group: "Search", value: p.q, removeHref: without({ q: "" }) });
  if (p.reason) out.push({ group: "Reason", value: TITLE_REASON_LABEL[p.reason], removeHref: without({ reason: null }) });
  if (p.band) out.push({ group: "Rank band", value: TITLE_BAND_LABEL[p.band], removeHref: without({ band: null }) });
  if (p.pinned !== null) {
    out.push({ group: "Pinned", value: p.pinned ? "Yes" : "No", removeHref: without({ pinned: null }) });
  }
  if (p.rule) out.push({ group: "Winning rule", value: titleRuleLabel(p.rule), removeHref: without({ rule: null }) });
  return out;
}

function TitleRow({ r, canSet }: { r: TitleDashboardRow; canSet: boolean }) {
  const rule = winningRule(r);
  const notes = titleRowNotes(r);
  return (
    <tr className="border-apollo-border border-b last:border-b-0" data-testid={`title-row-${r.cwid}`}>
      <td className={TD}>
        <ScholarHoverCard cwid={r.cwid}>
          <span className="font-medium hover:underline">{r.name}</span>
        </ScholarHoverCard>
      </td>
      <td className={TD}>{r.displayed ?? "—"}</td>
      <td className={TD}>
        {rule ? titleRuleLabel(rule) : "—"}
        <div className="text-muted-foreground text-[13px] tabular-nums">rank {formatTitleRank(winningRank(r))}</div>
      </td>
      <td className={TD}>
        {r.runnerUp ? (
          <>
            {r.runnerUp.value}
            <div className="text-muted-foreground text-[13px] tabular-nums">
              {r.runnerUp.label} · rank {formatTitleRank(r.runnerUp.rank)}
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className={TD}>
        <ul className="flex flex-wrap gap-1">
          {r.reasons.map((x) => (
            <li
              key={x}
              className="bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2 py-px text-xs whitespace-nowrap"
            >
              {TITLE_REASON_LABEL[x]}
            </li>
          ))}
        </ul>
        {notes.length > 0 && <p className="text-muted-foreground mt-1.5 text-[13px]">{notes.join(" · ")}</p>}
      </td>
      {canSet && (
        <td className={`${TD} min-w-[88px]`}>
          <details className="group" data-testid={`title-change-${r.cwid}`}>
            <summary className="text-apollo-maroon cursor-pointer list-none text-sm hover:underline [&::-webkit-details-marker]:hidden">
              Change
            </summary>
            <div className="mt-2 w-[min(420px,80vw)]">
              <TitleField
                cwid={r.cwid}
                options={r.options}
                current={r.displayed}
                hasOverride={r.pin !== null}
                pending={null}
                canSet
              />
            </div>
          </details>
        </td>
      )}
    </tr>
  );
}

export async function renderDisplayTitlesReport({
  session,
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  const params = parseTitleDashboardParams(toSearchParams(searchParams));
  const all = await loadTitleDashboard(db.read);
  const rows = filterTitleDashboard(all, params);
  const canSet = session.isSuperuser || session.isCommsSteward;
  const query = titleDashboardQueryString(params);
  const chips = chipsFor(params, basePath);
  const rail = <Rail basePath={basePath} params={params} resetHref={query ? basePath : null} />;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        The scholars whose displayed title is worth a look: leadership titles and roles, pins, close contests,
        leadership titles that lost, and roles the title text disagrees with.
      </p>
    ),
    main: (
      <>
        <Rubric />
        <ReportLayout rail={rail}>
          <div className="flex min-w-0 flex-col gap-4">
            <div className="lg:hidden">
              <FiltersSheet activeCount={chips.length} testId="display-titles-filters-sheet-trigger">
                {rail}
              </FiltersSheet>
            </div>
            <ReportCard>
              <ReportStats
                stats={[
                  { value: all.length.toLocaleString(), label: "scholars listed" },
                  { value: rows.length.toLocaleString(), label: "after filters" },
                ]}
                aside={
                  <Button asChild variant="apollo">
                    <a
                      href={`/api/edit/reports/display-titles${query ? `?${query}` : ""}`}
                      data-testid="display-titles-download"
                    >
                      <Download className="size-4" aria-hidden />
                      Download .xlsx
                    </a>
                  </Button>
                }
              />
              <div className="mt-5">
                <FilterChips chips={chips} testId="display-titles-chips" />
              </div>
              {rows.length === 0 ? (
                <p className="text-muted-foreground mt-6 text-sm">No scholars match these filters.</p>
              ) : (
                <div className="mt-6 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm" data-testid="display-titles-table">
                    <thead>
                      <tr className="border-apollo-border border-b">
                        <th scope="col" className={TH}>
                          Scholar
                        </th>
                        <th scope="col" className={TH}>
                          Displayed title
                        </th>
                        <th scope="col" className={TH}>
                          Winning rule
                        </th>
                        <th scope="col" className={TH}>
                          Runner-up
                        </th>
                        <th scope="col" className={TH}>
                          Why listed
                        </th>
                        {canSet && (
                          <th scope="col" className={TH}>
                            <span className="sr-only">Pin</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <TitleRow key={r.cwid} r={r} canSet={canSet} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ReportCard>
          </div>
        </ReportLayout>
      </>
    ),
  };
}
