/**
 * Report 23 — Vice Chairs across departments. One table of every Vice Chair
 * role with an active holder, with the title as the department publishes it.
 * Plain GET `AutoSubmitForm` rail: search, area, department, site. Loader:
 * `lib/edit/unit-leadership-report.ts`. Superusers only; view-only, no download.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { db } from "@/lib/db";
import type { ReportRender, SuperuserReportProps } from "@/lib/edit/report-registry";
import { isUnitLeadershipEnabled } from "@/lib/edit/unit-leadership-flags";
import { loadViceChairReport, parseViceChairReportParams } from "@/lib/edit/unit-leadership-report";
import {
  LEADERSHIP_FUNCTIONS,
  LEADERSHIP_FUNCTION_LABELS,
  LEADERSHIP_SITES,
  LEADERSHIP_SITE_LABELS,
} from "@/lib/unit-leadership";

const FIELD =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm";
const FLAG =
  "bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2 py-0.5 text-[12px]";
const TH = "text-muted-foreground px-3 py-2 text-left text-[12px] font-semibold";
const TD = "px-3 py-2 align-top text-[13.5px]";

export async function renderViceChairsReport({
  searchParams,
  basePath,
}: SuperuserReportProps): Promise<ReportRender> {
  if (!isUnitLeadershipEnabled()) {
    return {
      main: (
        <ReportCard>
          <p className="text-muted-foreground m-0 text-[14px]">
            Vice Chair roles are not turned on in this environment yet.
          </p>
        </ReportCard>
      ),
    };
  }

  const p = parseViceChairReportParams(searchParams);
  const r = await loadViceChairReport(db.read, p);
  const filtered = p.q !== "" || p.area !== "all" || p.dept !== "all" || p.site !== "all";
  const areaSummary =
    p.area === "all" ? "Any area" : p.area === "general" ? "No area named" : LEADERSHIP_FUNCTION_LABELS[p.area];
  const deptSummary = r.departments.find((d) => d.code === p.dept)?.name ?? "All departments";
  const siteSummary =
    p.site === "all" ? "Any" : p.site === "any" ? "Any hospital site" : LEADERSHIP_SITE_LABELS[p.site];

  const rail = (
    <ReportRail resetHref={filtered ? basePath : null} help="Filters apply automatically." testId="vice-chair-rail">
      <AutoSubmitForm action={basePath} className="group" data-testid="vice-chair-filters">
        <RailSection label="Search" summary={p.q || "Anyone"} defaultOpen>
          <input
            type="search"
            name="q"
            defaultValue={p.q}
            placeholder="Name or title"
            aria-label="Search name or title"
            className={FIELD}
          />
        </RailSection>
        <RailSection label="Area" summary={areaSummary} defaultOpen>
          <select name="area" defaultValue={p.area} aria-label="Area" className={FIELD}>
            <option value="all">Any area</option>
            {LEADERSHIP_FUNCTIONS.map((f) => (
              <option key={f} value={f}>
                {LEADERSHIP_FUNCTION_LABELS[f]}
              </option>
            ))}
            <option value="general">No area named</option>
          </select>
        </RailSection>
        <RailSection label="Department" summary={deptSummary} defaultOpen>
          <select name="dept" defaultValue={p.dept} aria-label="Department" className={FIELD}>
            <option value="all">All departments</option>
            {r.departments.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name} ({d.count})
              </option>
            ))}
          </select>
        </RailSection>
        <RailSection label="Hospital site" summary={siteSummary}>
          <select name="site" defaultValue={p.site} aria-label="Hospital site" className={FIELD}>
            <option value="all">Any</option>
            <option value="any">Any hospital site</option>
            {LEADERSHIP_SITES.map((s) => (
              <option key={s} value={s}>
                {LEADERSHIP_SITE_LABELS[s]}
              </option>
            ))}
          </select>
        </RailSection>
      </AutoSubmitForm>
    </ReportRail>
  );

  return {
    subtitle: (
      <>Vice Chair roles in every department, with each title as the department publishes it.</>
    ),
    main: (
      <ReportLayout rail={rail}>
        <ReportCard>
          <ReportStats
            stats={[
              { value: r.total.toLocaleString("en-US"), label: "roles" },
              { value: r.people.toLocaleString("en-US"), label: "people" },
              { value: r.departments.length.toLocaleString("en-US"), label: "departments" },
              ...(filtered ? [{ value: r.rows.length.toLocaleString("en-US"), label: "match these filters" }] : []),
            ]}
          />
          <div className="mt-5 overflow-x-auto" data-testid="vice-chair-list">
            {r.rows.length === 0 ? (
              <p className="text-muted-foreground m-0 text-[14px]">
                {r.total === 0 ? "No Vice Chairs are listed yet." : "No roles match these filters."}
              </p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-apollo-border border-b">
                    <th scope="col" className={TH}>Name</th>
                    <th scope="col" className={TH}>Title</th>
                    <th scope="col" className={TH}>Department</th>
                    <th scope="col" className={TH}>Area</th>
                    <th scope="col" className={TH}>Hospital site</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row) => (
                    <tr key={row.id} className="border-apollo-border border-b" data-testid="vice-chair-row">
                      <td className={TD}>
                        <ScholarHoverCard cwid={row.cwid}>
                          <a href={`/edit/scholar/${row.cwid}`} className="font-semibold hover:underline">
                            {row.name}
                          </a>
                        </ScholarHoverCard>
                        {!row.fullTimeFaculty && (
                          <>
                            {" "}
                            <span className={FLAG}>Not full-time faculty</span>
                          </>
                        )}
                      </td>
                      <td className={TD}>{row.displayTitle}</td>
                      <td className={TD}>
                        <a href={`/edit/department/${row.departmentCode}`} className="hover:underline">
                          {row.departmentName}
                        </a>
                      </td>
                      <td className={`${TD} text-muted-foreground`}>
                        {row.functions
                          .map((f) =>
                            f === "clinical_area" && row.areaText ? row.areaText : LEADERSHIP_FUNCTION_LABELS[f],
                          )
                          .join(", ")}
                      </td>
                      <td className={`${TD} text-muted-foreground`}>
                        {row.site ? LEADERSHIP_SITE_LABELS[row.site] : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-muted-foreground mt-4 text-[12px]">
            Each department&apos;s owners and curators maintain these roles on the department&apos;s edit
            page. Areas are assigned there for this report and are not shown publicly. A role held by
            someone who has left WCM is not listed. Roles are not removed automatically when an
            appointment changes.
          </p>
        </ReportCard>
      </ReportLayout>
    ),
  };
}
