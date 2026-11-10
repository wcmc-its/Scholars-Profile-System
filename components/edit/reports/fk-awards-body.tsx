/**
 * Report 21 — F and K awards body. Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`). NIH F and K awards held by the center's research
 * members and by trainees in their labs, with the awards whose holder has no
 * mentor record listed for review. The period, as-of date and lab-only switch
 * are URL params shared with the xlsx download; the classification is
 * `computeFkAwards` (`lib/edit/fk-awards.ts`).
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { DownloadAside, SELECT } from "@/components/edit/reports/core-report-ui";
import { ReportCard, ReportStats } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import {
  FK_CATEGORIES,
  fkAwardsQuery,
  fkAwardYears,
  fkPeriodLabel,
  parseFkAwardsParams,
  roleLabel,
  type FkAward,
} from "@/lib/edit/fk-awards";
import { loadFkAwards } from "@/lib/edit/fk-awards.server";
import { nci2aUnitQuery } from "@/lib/edit/nci-2a-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";
const TD = "px-3 py-2.5 align-top";

function Name({ cwid, name }: { cwid: string; name: string }) {
  return (
    <ScholarHoverCard cwid={cwid}>
      <span className="font-medium">{name}</span>
    </ScholarHoverCard>
  );
}

function Who({ a }: { a: FkAward }) {
  if (a.category === "member") return <span>{a.program ?? "No program"}</span>;
  if (a.mentors.length === 0) return <span className="text-muted-foreground">Unknown</span>;
  return (
    <ul className="space-y-1">
      {a.mentors.map((m) => (
        <li key={m.cwid}>
          <Name cwid={m.cwid} name={m.name} />
          <span className="text-muted-foreground">
            {" "}
            · {m.program ?? "No program"}
            {m.sources.length > 0 && ` · ${m.sources.join(", ")}`}
          </span>
        </li>
      ))}
      {a.careerMentorOnly && (
        <li className="text-muted-foreground text-[13px]">Faculty career mentor only</li>
      )}
    </ul>
  );
}

export async function renderFkAwardsReport({
  code,
  kind,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const params = parseFkAwardsParams(sp);
  const r = await loadFkAwards(code, params);
  const unitQuery = nci2aUnitQuery(code, kind);
  const years = fkAwardYears();
  const yearSelect = (name: "from" | "to", value: number) => (
    <select
      name={name}
      defaultValue={value}
      aria-label={name === "from" ? "From year" : "To year"}
      className={SELECT}
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
  );

  return {
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
          <div className="border-apollo-border flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
            <AutoSubmitForm
              action={basePath}
              className="group flex flex-wrap items-center gap-x-5 gap-y-3"
              data-testid="fk-awards-filters"
            >
              {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <span className="flex items-center gap-1.5 text-sm">
                Active in {yearSelect("from", params.from)} to {yearSelect("to", params.to)}
              </span>
              <label className="flex items-center gap-1.5 text-sm">
                Members as of
                <input
                  type="date"
                  name="asOf"
                  defaultValue={params.asOf}
                  className="border-apollo-border-strong bg-apollo-surface h-[34px] rounded-md border px-2 text-sm"
                />
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="labOnly" value="1" defaultChecked={params.labOnly} />
                Leave out faculty linked only by a career mentor
              </label>
              <button
                type="submit"
                className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm group-data-[hydrated=true]:hidden"
              >
                Apply
              </button>
            </AutoSubmitForm>
            <DownloadAside
              href={`/api/edit/center/${encodeURIComponent(code)}/fk-awards/xlsx?${fkAwardsQuery(params)}`}
              note="One row per award, as shown."
              testId="fk-awards"
            />
          </div>
          <div className="px-5 py-5">
            <ReportStats
              testId="fk-awards-stats"
              stats={FK_CATEGORIES.map((c) => ({
                value: `${r.counts[c.key].F} F · ${r.counts[c.key].K} K`,
                label: c.label,
              }))}
            />
          </div>
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[960px] border-collapse text-sm"
              data-testid="fk-awards-table"
            >
              <thead>
                <tr className="bg-apollo-surface-2 text-left">
                  <th className={cn(TH, "pl-5")}>Category</th>
                  <th className={TH}>Award holder</th>
                  <th className={TH}>Award</th>
                  <th className={TH}>Dates</th>
                  <th className={TH}>Member mentor or program</th>
                </tr>
              </thead>
              <tbody>
                {r.awards.map((a) => (
                  <tr
                    key={`${a.holderCwid}|${a.awardNumber}`}
                    className="border-apollo-border border-b"
                  >
                    <td className={cn(TD, "pl-5 whitespace-nowrap")}>
                      {FK_CATEGORIES.find((c) => c.key === a.category)!.label}
                    </td>
                    <td className={TD}>
                      <Name cwid={a.holderCwid} name={a.holderName} />
                      <div className="text-muted-foreground text-[13px]">
                        {roleLabel(a.holderRole)}
                      </div>
                    </td>
                    <td className={TD}>
                      <div className="font-medium tabular-nums">
                        {a.mechanism} · {a.awardNumber}
                      </div>
                      <div className="text-muted-foreground text-[13px]">{a.title}</div>
                    </td>
                    <td className={cn(TD, "whitespace-nowrap tabular-nums")}>
                      {a.start} to {a.end}
                    </td>
                    <td className={TD}>
                      <Who a={a} />
                    </td>
                  </tr>
                ))}
                {r.awards.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted-foreground px-5 py-6">
                      No F or K awards in {fkPeriodLabel(params)}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <ReportCard>
          <ul
            className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]"
            data-testid="fk-awards-assumptions"
          >
            <li>
              Awards: NIH F and K awards in InfoEd active at any point in {fkPeriodLabel(params)},
              held as PI, PI-Subaward or Co-PI. Yearly rows and renewals of one award count once.
              InfoEd has only WCM-administered awards, so awards administered at MSK or Rockefeller
              are not here.
            </li>
            <li>Members: research members on {params.asOf}, with their current program.</li>
            <li>
              Trainee of a member: a PhD, postdoc, AOC or FRT mentor record links the holder to a
              member. FRT mentors of faculty are career mentors and may not run the holder&apos;s
              lab; those awards are marked.
              {r.careerMentorOnlyHidden > 0 &&
                ` ${r.careerMentorOnlyHidden.toLocaleString()} such awards are left out by the filter.`}
            </li>
            <li>
              Member is Key Personnel: no mentor record, but a member is listed as Key Personnel on
              the award.
            </li>
            <li>
              No mentor record: the holder has no mentor in Scholars, so their lab is unknown.
              Review these by hand. {r.notCenter.toLocaleString()} awards whose holders are mentored
              only by non-members are left out.
            </li>
          </ul>
        </ReportCard>
      </div>
    ),
  };
}
