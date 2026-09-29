/**
 * Report 11 — "Core users" body (core-only; mockup `Core Reports.dc.html`).
 * A filter rail (person type + department through the reserved who-filter,
 * known client, minimum papers, publication years) in a GET `AutoSubmitForm`,
 * the headline with the `.xlsx` button — or, above `SCHOLAR_EXPORT_CAP`
 * people, the reason there is none — then People / Departments tabs.
 *
 * Parser, loader, builders and workbook: `lib/edit/core-users-report.ts`; the
 * download (`/api/edit/reports/core-users`) takes the same query string.
 * Unit-gated, core-only (`REPORT_NUMBERS_BY_KIND`); the frame is the dynamic
 * page's (`lib/edit/report-registry.ts`).
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
  YearWindow,
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
  yearOptions,
} from "@/lib/edit/core-report-common";
import {
  CLIENT_LABEL,
  coreUsersExportAllowed,
  coreUsersOverCapMessage,
  coreUsersQuery,
  isCoreUsersDefault,
  loadCoreUsersReport,
  MIN_PAPERS,
  MIN_PAPERS_LABEL,
  parseCoreUsersParams,
  yearWindowLabel,
  type ClientFilter,
  type CoreUsersParams,
  type CoreUsersResult,
} from "@/lib/edit/core-users-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { formatRoleCategory } from "@/lib/role-display";

function summarize(labels: string[]): string {
  if (labels.length === 0) return "Any";
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

/** The view: headline, tabs and table / bars. Exported for the render test. */
export function CoreUsersView({
  coreId,
  basePath,
  params,
  result,
  totalConfirmed,
}: {
  coreId: string;
  basePath: string;
  params: CoreUsersParams;
  result: CoreUsersResult;
  totalConfirmed: number;
}) {
  const href = (view: CoreUsersParams["view"]) =>
    `${basePath}?${coreQueryString(coreId, coreUsersQuery(params, view))}`;
  const { people, departments } = result;
  const allowed = coreUsersExportAllowed(people.length);
  const maxDept = Math.max(1, ...departments.map((d) => d.people));
  return (
    <div data-testid="core-users">
      <ReportStats
        stats={[
          { value: people.length.toLocaleString(), label: "people" },
          {
            value: departments.length.toLocaleString(),
            label: departments.length === 1 ? "department" : "departments",
          },
        ]}
        aside={
          <DownloadAside
            href={
              allowed && people.length > 0
                ? `/api/edit/reports/core-users?${coreQueryString(coreId, coreUsersQuery(params))}`
                : null
            }
            note={
              allowed
                ? "Includes the Criteria, People and Departments sheets."
                : coreUsersOverCapMessage(people.length)
            }
            refused={!allowed}
            testId="core-users"
          />
        }
      />
      <CoreTabs
        testId="core-users-view"
        tabs={[
          {
            key: "people",
            label: `People (${people.length.toLocaleString()})`,
            href: href("people"),
            current: params.view === "people",
          },
          {
            key: "departments",
            label: "Departments",
            href: href("departments"),
            current: params.view === "departments",
          },
        ]}
      />
      {totalConfirmed === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm" data-testid="core-users-empty">
          This core has no confirmed publications yet.
        </p>
      ) : people.length === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm" data-testid="core-users-empty">
          No one matches these filters.
        </p>
      ) : params.view === "departments" ? (
        <BarList
          head="Department"
          valueHead="People · papers"
          testId="core-users-departments"
          bars={departments.map((d) => ({
            key: d.department,
            label: d.department,
            value: `${d.people.toLocaleString()} · ${d.papers.toLocaleString()}`,
            fraction: d.people / maxDept,
          }))}
        />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table
            className="w-full min-w-[640px] border-collapse text-sm"
            data-testid="core-users-table"
          >
            <thead>
              <tr className="border-apollo-border text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3">Department</th>
                <th className="py-2 pr-3">Person type</th>
                <th className="py-2 pr-3 text-right">Papers</th>
                <th className="py-2 text-right">Active</th>
              </tr>
            </thead>
            <tbody>
              {people.map((u) => (
                <tr key={u.cwid} className="border-apollo-border border-b align-top">
                  <td className="py-2 pr-3">
                    <ScholarHoverCard cwid={u.cwid}>
                      <span className="font-semibold hover:underline">{u.name}</span>
                    </ScholarHoverCard>
                    {u.knownClient && (
                      <span
                        className="text-muted-foreground block text-xs"
                        data-testid="core-users-known-client"
                      >
                        Known client
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{u.department ?? "—"}</td>
                  <td className="py-2 pr-3">{formatRoleCategory(u.roleCategory) ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{u.papers.toLocaleString()}</td>
                  <td className="py-2 text-right tabular-nums">
                    {u.firstYear === null
                      ? "—"
                      : u.firstYear === u.lastYear
                        ? u.firstYear
                        : `${u.firstYear}–${u.lastYear}`}
                  </td>
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
          Paper counts are per person, so they add up to more than the core&rsquo;s total: one paper
          with three core users counts for each of them.
        </p>
        <p>
          Known clients come from the client roster on the review queue. Clients listed by name only
          can&rsquo;t be matched to papers.
        </p>
      </div>
    </div>
  );
}

export async function renderCoreUsersReport({
  code,
  ctx,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const params = parseCoreUsersParams(toSearchParams(searchParams));
  const pmids = await loadCoreConfirmedPmids(code);
  const result = await loadCoreUsersReport(code, pmids, params);
  const resetHref = isCoreUsersDefault(params)
    ? null
    : `${basePath}?${coreQueryString(code, coreUsersQuery({ ...parseCoreUsersParams(new URLSearchParams()), view: params.view }))}`;
  const typeOptions = [
    ...result.typeOptions,
    ...params.types
      .filter((t) => !result.typeOptions.some((o) => o.value === t))
      .map((t) => ({ value: t, label: formatRoleCategory(t) ?? t, count: 0 })),
  ];
  const deptOptions = [
    ...result.deptOptions,
    ...params.units
      .filter((u) => !result.deptOptions.some((o) => o.value === u))
      .map((u) => ({ value: u, label: u, count: 0 })),
  ];
  const labelOf = (opts: { value: string; label: string }[], v: string) =>
    opts.find((o) => o.value === v)?.label ?? v;
  const rail = (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to options count people."
      testId="core-users-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="core-users-filters">
        <CoreScopeInputs coreId={code} view={params.view === "people" ? undefined : params.view} />
        <RailSection
          label="Person type"
          summary={summarize(params.types.map((t) => labelOf(typeOptions, t)))}
        >
          <RailChecklist
            name="type"
            roomy
            options={typeOptions}
            selected={params.types}
            countLabel="People"
          />
        </RailSection>
        <RailSection
          label="Department"
          summary={summarize(params.units.map((u) => labelOf(deptOptions, u)))}
        >
          <RailChecklist
            name="unit"
            roomy
            options={deptOptions}
            selected={params.units}
            searchPlaceholder="Search departments…"
            collapseAfter={8}
            countLabel="People"
          />
        </RailSection>
        <RailSection label="Known client" summary={CLIENT_LABEL[params.client]}>
          <RadioGroup<ClientFilter>
            name="client"
            value={params.client}
            options={(Object.keys(CLIENT_LABEL) as ClientFilter[]).map((c) => ({
              value: c,
              label: CLIENT_LABEL[c],
            }))}
          />
        </RailSection>
        <RailSection label="Confirmed papers" summary={MIN_PAPERS_LABEL[params.minPapers]}>
          <RadioGroup
            name="minp"
            value={String(params.minPapers)}
            options={MIN_PAPERS.map((m) => ({ value: String(m), label: MIN_PAPERS_LABEL[m] }))}
          />
        </RailSection>
        <RailSection label="Publication years" summary={yearWindowLabel(params)}>
          <YearWindow from={params.from} to={params.to} years={yearOptions()} allowAny />
        </RailSection>
        <ApplyFallback />
      </AutoSubmitForm>
    </ReportRail>
  );
  const active =
    params.types.length +
    params.units.length +
    (params.client !== "any" ? 1 : 0) +
    (params.minPapers ? 1 : 0) +
    (params.from !== null || params.to !== null ? 1 : 0);

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Everyone who authored a confirmed publication with {ctx.unit.name}, with their department
        and person type. A person counts once however many papers they have.
      </p>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="lg:hidden">
            <FiltersSheet activeCount={active} testId="core-users-filters-sheet-trigger">
              {rail}
            </FiltersSheet>
          </div>
          <ReportCard>
            <CoreUsersView
              coreId={code}
              basePath={basePath}
              params={params}
              result={result}
              totalConfirmed={pmids.length}
            />
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
