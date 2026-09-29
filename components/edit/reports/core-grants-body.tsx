/**
 * Report 13 — "Grants citing the core" body (core-only; mockup `Core
 * Reports.dc.html`). A rail (status, funder, mechanism) in a GET
 * `AutoSubmitForm`; the headline with the non-NIH note under it and the
 * `.xlsx` button; Grants / By funder tabs.
 *
 * Loader, award collapsing, filters and workbook:
 * `lib/edit/core-grants-report.ts`; the download
 * (`/api/edit/reports/core-grants`) takes the same query string.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  ApplyFallback,
  BarList,
  CoreScopeInputs,
  CoreTabs,
  DownloadAside,
  RadioGroup,
} from "@/components/edit/reports/core-report-ui";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import {
  coreQueryString,
  loadCoreConfirmedPmids,
  toSearchParams,
} from "@/lib/edit/core-report-common";
import {
  coreGrantsQuery,
  filterAwards,
  formatPeriod,
  isCoreGrantsDefault,
  loadCoreGrantAwards,
  NON_NIH_NOTE,
  parseCoreGrantsParams,
  STATUS_LABEL,
  type CoreGrantsParams,
  type CoreGrantsResult,
  type GrantStatusFilter,
} from "@/lib/edit/core-grants-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

function summarize(xs: string[]): string {
  if (xs.length === 0) return "Any";
  return xs.length <= 2 ? xs.join(", ") : `${xs.length} selected`;
}

/** Exported for the render test. */
export function CoreGrantsView({
  coreId,
  basePath,
  params,
  result,
}: {
  coreId: string;
  basePath: string;
  params: CoreGrantsParams;
  result: CoreGrantsResult;
}) {
  const href = (view: CoreGrantsParams["view"]) =>
    `${basePath}?${coreQueryString(coreId, coreGrantsQuery(params, view))}`;
  const { awards, byFunder } = result;
  const max = Math.max(1, ...byFunder.map((f) => f.grants));
  return (
    <div data-testid="core-grants">
      <ReportStats
        stats={[
          {
            value: awards.length.toLocaleString(),
            label: awards.length === 1 ? "grant" : "grants",
          },
          { value: result.linkedPapers.toLocaleString(), label: "linked confirmed papers" },
        ]}
        aside={
          <DownloadAside
            href={`/api/edit/reports/core-grants?${coreQueryString(coreId, coreGrantsQuery(params))}`}
            note="Includes the Criteria, Grants and By funder sheets."
            testId="core-grants"
          />
        }
      />
      <p className="text-muted-foreground mt-3 text-[13px]" data-testid="core-grants-nih-note">
        {NON_NIH_NOTE}
      </p>
      <CoreTabs
        testId="core-grants-view"
        tabs={[
          {
            key: "grants",
            label: `Grants (${awards.length.toLocaleString()})`,
            href: href("grants"),
            current: params.view === "grants",
          },
          {
            key: "funders",
            label: "By funder",
            href: href("funders"),
            current: params.view === "funders",
          },
        ]}
      />
      {awards.length === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm" data-testid="core-grants-empty">
          No grants linked to this core&rsquo;s confirmed publications match these filters.
        </p>
      ) : params.view === "funders" ? (
        <BarList
          head="Funder"
          valueHead="Grants · papers"
          testId="core-grants-funders"
          bars={byFunder.map((f) => ({
            key: f.funder,
            label: f.funder,
            value: `${f.grants.toLocaleString()} · ${f.papers.toLocaleString()}`,
            fraction: f.grants / max,
          }))}
        />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table
            className="w-full min-w-[720px] border-collapse text-sm"
            data-testid="core-grants-table"
          >
            <thead>
              <tr className="border-apollo-border text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
                <th className="py-2 pr-3">Grant</th>
                <th className="py-2 pr-3">PI</th>
                <th className="py-2 pr-3">Funder</th>
                <th className="py-2 pr-3 text-right">Period</th>
                <th className="py-2 text-right">Papers</th>
              </tr>
            </thead>
            <tbody>
              {awards.map((a) => (
                <tr
                  key={a.key}
                  className="border-apollo-border border-b align-top"
                  data-testid="core-grants-row"
                >
                  <td className="py-2 pr-3">
                    <span className="font-semibold">{a.title}</span>
                    <span className="text-muted-foreground block text-xs">
                      {a.awardNumber ?? a.key}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <ScholarHoverCard cwid={a.piCwid}>
                      <span className="hover:underline">{a.piName}</span>
                    </ScholarHoverCard>
                  </td>
                  <td className="py-2 pr-3">
                    {a.funder}
                    {a.mechanism && (
                      <span className="text-muted-foreground block text-xs">{a.mechanism}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    {formatPeriod(a.start, a.end)}
                    <span className="text-muted-foreground block text-xs">
                      {a.active ? "Active" : "Ended"}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{a.papers.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div
        className="text-muted-foreground mt-6 flex max-w-[680px] flex-col gap-1.5 text-[13px]"
        role="note"
      >
        <p>
          One row per award: the entries for each person on an award and each renewal are combined.
          One paper can cite several grants, so paper counts add up to more than the core&rsquo;s
          confirmed total.
        </p>
        <p>Grants that fund a core user but no confirmed paper aren&rsquo;t listed.</p>
      </div>
    </div>
  );
}

export async function renderCoreGrantsReport({
  code,
  ctx,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const params = parseCoreGrantsParams(toSearchParams(searchParams));
  const asOf = new Date().toISOString().slice(0, 10);
  const pmids = await loadCoreConfirmedPmids(code);
  const { awards, pmidsByKey } = await loadCoreGrantAwards(pmids, asOf);
  const result = filterAwards(awards, params, pmidsByKey);
  const resetHref = isCoreGrantsDefault(params)
    ? null
    : `${basePath}?${coreQueryString(code, coreGrantsQuery({ ...parseCoreGrantsParams(new URLSearchParams()), view: params.view }))}`;
  const rail = (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to options count grants."
      testId="core-grants-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="core-grants-filters">
        <CoreScopeInputs coreId={code} view={params.view === "grants" ? undefined : params.view} />
        <RailSection label="Status" summary={STATUS_LABEL[params.status]} defaultOpen>
          <RadioGroup<GrantStatusFilter>
            name="status"
            value={params.status}
            options={(Object.keys(STATUS_LABEL) as GrantStatusFilter[]).map((s) => ({
              value: s,
              label: STATUS_LABEL[s],
            }))}
            counts={result.statusCounts}
          />
        </RailSection>
        <RailSection label="Funder" summary={summarize(params.funders)}>
          <RailChecklist
            name="funder"
            roomy
            options={result.funderOptions}
            selected={params.funders}
            countLabel="Grants"
          />
        </RailSection>
        <RailSection label="Mechanism" summary={summarize(params.mechs)}>
          <RailChecklist
            name="mech"
            roomy
            options={result.mechOptions}
            selected={params.mechs}
            collapseAfter={8}
            countLabel="Grants"
          />
        </RailSection>
        <ApplyFallback />
      </AutoSubmitForm>
    </ReportRail>
  );
  const active = (params.status !== "active" ? 1 : 0) + params.funders.length + params.mechs.length;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Grants that fund at least one confirmed publication of {ctx.unit.name}. A grant is linked
        when NIH RePORTER or ReCiter ties the paper to it.
      </p>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="lg:hidden">
            <FiltersSheet activeCount={active} testId="core-grants-filters-sheet-trigger">
              {rail}
            </FiltersSheet>
          </div>
          <ReportCard>
            <CoreGrantsView coreId={code} basePath={basePath} params={params} result={result} />
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
