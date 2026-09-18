/**
 * `/edit/reports/7` — "Mentored publications". For every MD-program learner
 * (`aoc_mentee`), every publication co-authored with one of their AOC mentors,
 * with Journal Impact Factor and NIH iCite citations, plus per-learner counts
 * (`lib/edit/mentored-publications-report.ts`). The Medical Education office's
 * annual spreadsheet, on demand: the summary table in-page and the full
 * three-sheet workbook behind "Download .xlsx"
 * (`/api/edit/reports/mentored-publications`, same query string).
 *
 * NOT unit-scoped like reports 1–6: access is a `report_access` row
 * (`lib/edit/report-access.ts`) — superuser / comms_steward always pass;
 * anyone else needs a row, and their rows' scope keys are the programs they
 * may see. Same session gate style as `/edit/data-sharing`: no session →
 * SSO login; an empty scope set → `notFound()` (the route reads as unbuilt
 * to someone it was never granted to). Filters are plain GET params
 * (`parseMentoredPubsParams`) — a server re-render per change, no client
 * state, like `/edit/data-sharing`'s filter bar. The "Viewers" panel
 * (`ReportAccessPanel`) is the one client island, rendered only for
 * `canManageReportAccess`.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ReportAccessPanel, type ReportAccessPanelRow } from "@/components/edit/report-access-panel";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  mentoredPubsQueryString,
  parseMentoredPubsParams,
  type MentoredPubsParams,
} from "@/lib/edit/mentored-publications-params";
import {
  DEFAULT_TAIL,
  HIGH_IMPACT_THRESHOLD,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
  MAX_TAIL,
  PROGRAM_LABEL,
  type MentoredPublicationsReport,
} from "@/lib/edit/mentored-publications-report";
import {
  ALL_SCOPES,
  canManageReportAccess,
  getReportScopes,
  listReportAccess,
  MENTORED_PUBS_REPORT,
  MENTORED_PUBS_SCOPES,
  scopeAdmits,
} from "@/lib/edit/report-access";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Mentored publications — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const TH_CLASS = "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";
const TD_CLASS = "border-apollo-border border-t px-3 py-2 align-top";

function FilterForm({
  params,
  yearChoices,
  programChoices,
}: {
  params: MentoredPubsParams;
  yearChoices: ReadonlyArray<number>;
  programChoices: ReadonlyArray<readonly [string, string]>;
}) {
  const selected = new Set(params.years ?? []);
  const allYears = params.years !== null && params.years.length === 0;
  return (
    <form
      method="get"
      className="border-apollo-border bg-apollo-surface mt-4 flex flex-wrap items-end gap-4 rounded-md border p-3 text-xs"
      data-testid="mentored-pubs-filters"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground">Graduation year</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {yearChoices.map((y) => (
            <label key={y} className="inline-flex items-center gap-1">
              <input type="checkbox" name="years" value={y} defaultChecked={selected.has(y)} />
              {y}
            </label>
          ))}
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" name="years" value="all" defaultChecked={allYears} />
            All years
          </label>
        </div>
      </fieldset>
      {programChoices.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Program</span>
          <select
            name="program"
            defaultValue={params.program ?? "all"}
            className="border-apollo-border rounded border px-2 py-1"
          >
            <option value="all">All programs</option>
            {programChoices.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Years after graduation still counted</span>
        <select name="tail" defaultValue={String(params.tail)} className="border-apollo-border rounded border px-2 py-1">
          {Array.from({ length: MAX_TAIL + 1 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="border-apollo-border rounded border px-3 py-1.5 hover:bg-apollo-surface-2">
        Apply
      </button>
    </form>
  );
}

function SummaryTable({ report }: { report: MentoredPublicationsReport }) {
  if (report.summary.length === 0) {
    return (
      <p className="text-muted-foreground mt-6" data-testid="mentored-pubs-empty">
        No learners match these filters.
      </p>
    );
  }
  return (
    <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-left text-sm" data-testid="mentored-pubs-summary">
        <thead>
          <tr>
            <th className={TH_CLASS}>Grad year</th>
            <th className={TH_CLASS}>Learner</th>
            <th className={TH_CLASS}>Program</th>
            <th className={TH_CLASS}>Mentors</th>
            <th className={`${TH_CLASS} text-right`}>In window</th>
            <th className={`${TH_CLASS} text-right`}>All years</th>
            <th className={`${TH_CLASS} text-right`}>JIF &ge; {HIGH_IMPACT_THRESHOLD}</th>
            <th className={`${TH_CLASS} text-right`}>First author</th>
          </tr>
        </thead>
        <tbody>
          {report.summary.map((r) => (
            <tr key={r.cwid} data-testid={`mentored-pubs-learner-${r.cwid}`}>
              <td className={TD_CLASS}>{r.gradYear ?? "—"}</td>
              <td className={TD_CLASS}>
                {r.lastName ?? ""}
                {r.lastName && r.firstName ? ", " : ""}
                {r.firstName ?? ""}
                <span className="text-muted-foreground ml-2 font-mono text-xs">{r.cwid}</span>
                {r.entryYearSource === "fallback" && (
                  <span
                    className="text-muted-foreground ml-2 text-xs"
                    title="Entry year not on the roster; window assumes a 4-year track."
                  >
                    (entry est. {r.entryYear})
                  </span>
                )}
              </td>
              <td className={TD_CLASS}>{r.program}</td>
              <td className={TD_CLASS}>{r.mentors.join("; ")}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsInWindow}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsAllTime}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{r.highImpactInWindow}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{r.firstAuthorInWindow}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function EditReportsMentoredPublicationsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/7");
  }

  // Row-based gate: an empty scope set reads as an unbuilt route, the same
  // 404 `/edit/data-sharing` gives a non-viewer.
  const scopes = await getReportScopes(session, MENTORED_PUBS_REPORT);
  if (scopes.size === 0) {
    notFound();
  }

  // Malformed params fall back to the defaults (a page, unlike the download
  // route, has nothing useful to say with a 400).
  const parsed = parseMentoredPubsParams((await searchParams) ?? {});
  const requested: MentoredPubsParams = parsed.ok
    ? parsed.value
    : { years: null, program: null, tail: DEFAULT_TAIL };
  // A `program` outside the caller's scopes is silently the "all" view of
  // what they DO hold — never a wider set.
  const program = requested.program !== null && scopeAdmits(scopes, requested.program) ? requested.program : null;
  const loaderScopes = program !== null ? [program] : [...scopes];

  const yearChoices = await loadMentoredGradYears([...scopes]);
  const years = requested.years ?? yearChoices.slice(0, 2);
  const params: MentoredPubsParams = { years, program, tail: requested.tail };

  const canManage = canManageReportAccess(session);
  const [report, pendingSlugRequests, pendingHonors, accessRows] = await Promise.all([
    loadMentoredPublicationsReport({
      scopes: loaderScopes,
      gradYears: years.length > 0 ? years : null,
      tail: params.tail,
    }),
    session.isSuperuser && isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
    canManage ? listReportAccess(MENTORED_PUBS_REPORT) : Promise.resolve([]),
  ]);

  const programChoices: Array<readonly [string, string]> = MENTORED_PUBS_SCOPES.filter((s) =>
    scopeAdmits(scopes, s),
  ).map((s) => [s, PROGRAM_LABEL[s] ?? s] as const);
  const scopeOptions: Array<readonly [string, string]> = [
    [ALL_SCOPES, "All programs"] as const,
    ...MENTORED_PUBS_SCOPES.map((s) => [s, PROGRAM_LABEL[s] ?? s] as const),
  ];
  const panelRows: ReportAccessPanelRow[] = accessRows.map((r) => ({
    ...r,
    grantedAt: r.grantedAt.toISOString(),
  }));

  const totalInWindow = report.summary.reduce((n, r) => n + r.pubsInWindow, 0);
  const totalAllTime = report.summary.reduce((n, r) => n + r.pubsAllTime, 0);
  const qs = mentoredPubsQueryString(params);

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
    >
      <Link href="/edit/reports" className="text-apollo-slate mb-4 inline-block text-sm hover:underline">
        &larr; All reports
      </Link>
      <h1 className="mb-1 text-xl font-bold">Mentored publications</h1>
      <p className="text-muted-foreground text-sm">
        Every publication a learner co-authored with one of their AOC mentors, with Journal Impact
        Factor and NIH iCite citations. &ldquo;In window&rdquo; means entry year &le; publication year
        &le; graduation year + {params.tail}; a learner with no entry year on the roster is assumed to
        have entered four years before graduating.
      </p>
      <FilterForm params={params} yearChoices={yearChoices} programChoices={programChoices} />
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <p data-testid="mentored-pubs-total">
          <strong>{report.summary.length.toLocaleString()}</strong>{" "}
          {report.summary.length === 1 ? "learner" : "learners"} ·{" "}
          <strong>{totalInWindow.toLocaleString()}</strong> publications in window ·{" "}
          <strong>{totalAllTime.toLocaleString()}</strong> all years
        </p>
        <a
          href={`/api/edit/reports/mentored-publications?${qs}`}
          className="bg-apollo-maroon text-apollo-maroon-foreground hover:bg-apollo-maroon/90 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium"
          data-testid="mentored-pubs-download"
        >
          Download .xlsx
        </a>
      </div>
      <SummaryTable report={report} />
      {canManage && (
        <ReportAccessPanel reportKey={MENTORED_PUBS_REPORT} initialRows={panelRows} scopeOptions={scopeOptions} />
      )}
    </ConsoleShell>
  );
}
