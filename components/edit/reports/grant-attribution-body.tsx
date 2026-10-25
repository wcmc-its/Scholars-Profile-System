/**
 * Report 14 — Grant attribution (#3071) body. Totals for the latest run, the
 * evidence the check used, run by run, a department roll-up (CSV), and the
 * awards by outcome with a plain GET filter. Mockup: the Grant Attribution
 * Showcase canvas, board 3. Loader: `lib/edit/grant-attribution-report.ts`.
 *
 * Person-gated like report 9, and only while the queue's flag is on (the data
 * comes from the same scoring run).
 */
import { notFound } from "next/navigation";

import { HowWeCheck, ReporterNameLine } from "@/components/edit/grant-attribution-shared";
import {
  DownloadCsvButton,
  RequeueButton,
} from "@/components/edit/reports/grant-attribution-results";
import { ReportCard } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { impersonationActive } from "@/lib/auth/effective-identity";
import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import {
  EVIDENCE_ROWS,
  isGrantAttributionQueueEnabled,
  isGrantAttributionQueueReadOnly,
} from "@/lib/edit/grant-attribution-queue";
import {
  GRANT_ATTRIBUTION_LIST_CAP,
  GRANT_ATTRIBUTION_OUTCOMES,
  OUTCOME_LABEL,
  loadGrantAttributionReport,
  parseGrantAttributionParams,
} from "@/lib/edit/grant-attribution-report";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";

const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] rounded-lg border px-2 text-[13px]";
const TH = "text-muted-foreground px-3 py-2 text-xs font-medium tracking-[0.05em] uppercase";
const fmt = (n: number) => n.toLocaleString("en-US");
const runDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });

export async function renderGrantAttributionReport({
  session,
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  if (!isGrantAttributionQueueEnabled()) notFound();
  const p = parseGrantAttributionParams(searchParams);
  const r = await loadGrantAttributionReport(db.read, p);
  const run = r.runs[0];
  const prev = r.runs[1];
  // Under View as the page is read-only, as the queue is (the route refuses too).
  const raw = await getSession();
  const canSend = !isGrantAttributionQueueReadOnly(
    session,
    raw ? impersonationActive(raw, nowSeconds()) : false,
  );
  const maxCue = Math.max(
    1,
    ...EVIDENCE_ROWS.map((e) => e.ids.reduce((n, id) => n + (run?.cues[id] ?? 0), 0)),
  );

  if (!run) {
    return {
      main: (
        <ReportCard className="mt-7">
          <p className="text-muted-foreground m-0 text-[14px]">
            No scoring run has been recorded yet. The weekly grants import writes one.
          </p>
        </ReportCard>
      ),
    };
  }

  const total = run.show + run.hide + run.queue;
  const kpis = [
    { label: "Awards checked", value: fmt(total), note: `across ${fmt(run.scholars)} scholars` },
    { label: "Shown", value: fmt(run.show), note: `${fmt(run.recovered)} recovered this run` },
    {
      label: "Hidden as someone else’s",
      value: fmt(run.hide),
      note: prev ? `${fmt(prev.hide)} the run before` : "",
    },
    {
      label: "Waiting for a curator",
      value: fmt(run.queue),
      note: prev ? `${fmt(prev.queue)} the run before` : "",
    },
    { label: "Curator decisions", value: fmt(r.curatorDecisions), note: "all time" },
  ];
  const qs = (o: Record<string, string | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ outcome: p.outcome, q: p.q || null, dept: p.dept, ...o }))
      if (v) u.set(k, v);
    return `${basePath}?${u.toString()}`;
  };

  return {
    subtitle: <>Latest run {runDay(run.ranAt)}.</>,
    main: (
      <div className="mt-7 flex flex-col gap-5" data-testid="grant-attribution-report">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          {kpis.map((k) => (
            <div
              key={k.label}
              className="bg-apollo-surface border-apollo-border flex flex-col gap-0.5 rounded-xl border px-4 py-3.5"
            >
              <span className="text-[13px] text-[#3a3532]">{k.label}</span>
              <span className="text-[26px] font-semibold tabular-nums">{k.value}</span>
              <span className="text-muted-foreground text-[12.5px]">{k.note}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-4">
          <ReportCard className="flex min-w-0 flex-[1_1_520px] flex-col gap-3 !p-5">
            <h2 className="m-0 text-base font-semibold">Evidence the check used</h2>
            <p className="text-muted-foreground m-0 text-[13px]">
              Awards on which each kind of evidence was found in the latest run. One award usually
              has several.
            </p>
            <div className="flex gap-4 text-[12.5px] text-[#3a3532]">
              <span className="flex items-center gap-1.5">
                <span className="bg-apollo-slate size-2.5 rounded-[2px]" aria-hidden="true" />
                Ties it to the scholar
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="bg-apollo-coral-foreground size-2.5 rounded-[2px]"
                  aria-hidden="true"
                />
                Points to someone else
              </span>
            </div>
            <dl className="m-0 flex flex-col gap-[7px]">
              {EVIDENCE_ROWS.map((e) => {
                const n = e.ids.reduce((s, id) => s + (run.cues[id] ?? 0), 0);
                return (
                  <div
                    key={e.label}
                    className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_56px] items-center gap-2.5 text-[13px]"
                  >
                    <dt className="text-[#3a3532]">{e.label}</dt>
                    <dd
                      className="bg-apollo-surface-2 m-0 h-2.5 overflow-hidden rounded-[3px]"
                      aria-hidden="true"
                    >
                      <div
                        className={
                          e.toward ? "bg-apollo-slate h-2.5" : "bg-apollo-coral-foreground h-2.5"
                        }
                        style={{ width: `${Math.max(n > 0 ? 0.5 : 0, (n / maxCue) * 100)}%` }}
                      />
                    </dd>
                    <dd className="m-0 text-right tabular-nums">{fmt(n)}</dd>
                  </div>
                );
              })}
            </dl>
          </ReportCard>

          <ReportCard className="flex min-w-0 flex-[1_1_360px] flex-col gap-3 !p-5">
            <h2 className="m-0 text-base font-semibold">Run by run</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px] tabular-nums">
                <thead>
                  <tr className="text-right">
                    <th className={`${TH} text-left`}>Run</th>
                    <th className={TH}>Shown</th>
                    <th className={TH}>Hidden</th>
                    <th className={TH}>Queue</th>
                    <th className={TH}>Recovered</th>
                  </tr>
                </thead>
                <tbody>
                  {r.runs.map((x) => (
                    <tr key={x.ranAt} className="border-apollo-border border-t text-right">
                      <td className="px-3 py-2 text-left">{runDay(x.ranAt)}</td>
                      <td className="px-3 py-2">{fmt(x.show)}</td>
                      <td className="px-3 py-2">{fmt(x.hide)}</td>
                      <td className="px-3 py-2">{fmt(x.queue)}</td>
                      <td className="px-3 py-2">{fmt(x.recovered)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details id="method" className="scroll-mt-4 text-[13px]">
              <summary className="text-apollo-slate cursor-pointer">How we check</summary>
              <div className="mt-2 flex flex-col gap-2">
                <HowWeCheck />
              </div>
            </details>
          </ReportCard>
        </div>

        <ReportCard className="flex flex-col gap-3 !p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="m-0 mr-auto text-base font-semibold">By department</h2>
            <DownloadCsvButton
              filename="grant-attribution-by-department.csv"
              rows={[
                ["Department", "Scholars", "Awards checked", "Shown", "Hidden", "In queue"],
                ...r.depts.map((d) => [d.name, d.scholars, d.awards, d.show, d.hide, d.queue]),
              ]}
            />
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13.5px] tabular-nums">
              <thead className="bg-apollo-surface-2 sticky top-0">
                <tr className="text-right">
                  <th className={`${TH} text-left`}>Department</th>
                  <th className={TH}>Scholars</th>
                  <th className={TH}>Awards checked</th>
                  <th className={TH}>Shown</th>
                  <th className={TH}>Hidden</th>
                  <th className={TH}>In queue</th>
                </tr>
              </thead>
              <tbody>
                {r.depts.map((d) => (
                  <tr key={d.name} className="border-apollo-border border-t text-right">
                    <td className="px-3 py-2 text-left">
                      <a href={qs({ dept: d.name })}>{d.name}</a>
                    </td>
                    <td className="px-3 py-2">{fmt(d.scholars)}</td>
                    <td className="px-3 py-2">{fmt(d.awards)}</td>
                    <td className="px-3 py-2">{fmt(d.show)}</td>
                    <td className="px-3 py-2">{fmt(d.hide)}</td>
                    <td className="px-3 py-2">{fmt(d.queue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ReportCard>

        <ReportCard className="flex flex-col gap-3 !p-5">
          <form method="get" action={basePath} className="flex flex-wrap items-center gap-2.5">
            <h2 className="m-0 mr-auto text-base font-semibold">Awards</h2>
            <label className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
              Outcome
              <select name="outcome" defaultValue={p.outcome} className={SELECT}>
                {GRANT_ATTRIBUTION_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
              Department
              <select name="dept" defaultValue={p.dept ?? ""} className={`${SELECT} max-w-[220px]`}>
                <option value="">All</option>
                {r.depts.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="search"
              name="q"
              defaultValue={p.q}
              placeholder="Scholar, award or PI…"
              aria-label="Search awards"
              className={`${SELECT} w-[220px] max-w-full px-2.5`}
            />
            <button type="submit" className={`${SELECT} px-3`}>
              Apply
            </button>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-[13.5px]">
              <thead className="bg-apollo-surface-2">
                <tr className="text-left">
                  <th className={TH}>Scholar</th>
                  <th className={TH}>Award</th>
                  <th className={TH}>Outcome</th>
                  <th className={TH}>Deciding evidence</th>
                  <th className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((w) => (
                  <tr
                    key={w.id}
                    className="border-apollo-border border-t align-top"
                    data-testid={`grant-attribution-report-row-${w.id}`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">
                          <ScholarHoverCard cwid={w.cwid}>
                            <span>{w.scholarName}</span>
                          </ScholarHoverCard>
                        </span>
                        <ReporterNameLine
                          reporterName={w.reporterName}
                          scholarNames={w.scholarNames}
                        />
                      </div>
                    </td>
                    <td className="max-w-[320px] px-3 py-2.5">
                      <div>{w.award.title ?? "Untitled award"}</div>
                      <div className="text-muted-foreground text-[12.5px]">
                        {[
                          w.award.awardNumber,
                          w.award.orgs.map((o) => o.name).join("; "),
                          w.award.startYear &&
                          w.award.endYear &&
                          w.award.startYear !== w.award.endYear
                            ? `${w.award.startYear}–${w.award.endYear}`
                            : w.award.startYear,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {OUTCOME_LABEL[w.band as "show" | "hide" | "queue"] ?? w.band}
                    </td>
                    <td className="max-w-[300px] px-3 py-2.5 text-[#3a3532]">{w.why}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {canSend && w.requeueable ? <RequeueButton id={w.id} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground m-0 text-[12.5px]">
            {r.matched === 0
              ? "No awards match."
              : r.matched > GRANT_ATTRIBUTION_LIST_CAP
                ? `Showing ${fmt(GRANT_ATTRIBUTION_LIST_CAP)} of ${fmt(r.matched)}. Narrow with a department or search.`
                : `${fmt(r.matched)} ${r.matched === 1 ? "award" : "awards"}.`}
          </p>
        </ReportCard>
      </div>
    ),
  };
}
