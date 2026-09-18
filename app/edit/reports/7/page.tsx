/**
 * `/edit/reports/7` — "Mentored publications". For every MD-program learner
 * (`aoc_mentee`), every publication co-authored with one of their AOC mentors,
 * with Journal Impact Factor and NIH iCite citations, plus per-learner counts
 * (`lib/edit/mentored-publications-report.ts`). The Medical Education office's
 * annual spreadsheet, on demand: the summary table in-page and the full
 * three-sheet workbook behind "Download .xlsx"
 * (`/api/edit/reports/mentored-publications`, same query string).
 *
 * Two in-page views (`view=summary|publications`, underline tabs above the
 * table): Learners — the per-learner summary — and Publications — one row per
 * distinct paper, most recent first, as a Vancouver citation with its PMID
 * link, JIF, iCite count, the learner(s) and mentor(s) on it. Two publication
 * sets (`pubs=mentored|all`, a select in the filter form): the co-pubs with
 * an AOC mentor (default), or every publication of the learner from the
 * `aoc_mentee_publication` bridge, each flagged for a mentor co-author. Both
 * params ride every tab link and the download link; `view` is page-only.
 *
 * NOT unit-scoped like reports 1–6: access is a `report_access` row
 * (`lib/edit/report-access.ts`) — superuser / comms_steward always pass;
 * anyone else needs a row, and their rows' scope keys are the programs they
 * may see. Same session gate style as `/edit/data-sharing`: no session →
 * SSO login; an empty scope set → `notFound()` (the route reads as unbuilt
 * to someone it was never granted to). Filters are plain GET params
 * (`parseMentoredPubsParams`) — a server re-render per change, no client
 * state, like `/edit/data-sharing`'s filter bar; the form is the
 * `AutoSubmitForm` island so a change submits without an Apply click (the
 * button stays as the no-JS fallback). The "Viewers" panel
 * (`ReportAccessPanel`) is the other client island, rendered only for
 * `canManageReportAccess`.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ConsoleShell } from "@/components/edit/console-shell";
import { ReportAccessPanel, type ReportAccessPanelRow } from "@/components/edit/report-access-panel";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { citationIdentifier } from "@/lib/citation";
import { db } from "@/lib/db";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  mentoredPubsQueryString,
  parseMentoredPubsParams,
  type MentoredPubsParams,
} from "@/lib/edit/mentored-publications-params";
import {
  DEFAULT_TAIL,
  defaultMentoredPubsYears,
  HIGH_IMPACT_THRESHOLD,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
  MAX_TAIL,
  PROGRAM_LABEL,
  type MentoredPublicationsReport,
  type MentorRef,
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
const CWID_CLASS = "text-muted-foreground ml-2 font-mono text-xs";
// Underline tabs, as `components/edit/matcha-tab.tsx` draws them.
const TAB_ACTIVE = "border-apollo-maroon inline-block border-b-2 py-2 text-sm font-medium";
const TAB_IDLE = "text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-2 text-sm";

function pageHref(params: MentoredPubsParams): string {
  return `/edit/reports/7?${mentoredPubsQueryString(params)}`;
}

/** "Name  cwid" — the same treatment the learner column gives its cwid. */
function MentorCell({ mentors }: { mentors: ReadonlyArray<MentorRef> }) {
  if (mentors.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="m-0 list-none p-0">
      {mentors.map((m) => (
        <li key={m.cwid}>
          {m.name}
          <span className={CWID_CLASS}>{m.cwid}</span>
        </li>
      ))}
    </ul>
  );
}

function FilterForm({
  params,
  yearChoices,
  programChoices,
}: {
  params: MentoredPubsParams;
  yearChoices: ReadonlyArray<number | null>;
  programChoices: ReadonlyArray<readonly [string, string]>;
}) {
  const selected = new Set(params.years ?? []);
  const allYears = params.years !== null && params.years.length === 0;
  return (
    <AutoSubmitForm
      action="/edit/reports/7"
      className="group border-apollo-border bg-apollo-surface mt-4 flex flex-wrap items-end gap-4 rounded-md border p-3 text-xs"
      data-testid="mentored-pubs-filters"
    >
      {/* The view rides along so a filter change keeps it. */}
      {params.view !== "summary" && <input type="hidden" name="view" value={params.view} />}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground">Graduation year</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {yearChoices.map((y) => (
            <label key={y ?? "unknown"} className="inline-flex items-center gap-1">
              <input type="checkbox" name="years" value={y ?? "unknown"} defaultChecked={selected.has(y)} />
              {y ?? "Unknown grad year"}
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
        <span className="text-muted-foreground">Publications</span>
        <select
          name="pubs"
          defaultValue={params.pubs}
          className="border-apollo-border rounded border px-2 py-1"
          data-testid="mentored-pubs-set"
        >
          <option value="mentored">Co-authored with a mentor</option>
          <option value="all">All learner publications</option>
        </select>
      </label>
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
      {/* No-JS fallback; the island hides it once hydrated. */}
      <button
        type="submit"
        className="border-apollo-border hover:bg-apollo-surface-2 rounded border px-3 py-1.5 group-data-[hydrated=true]:hidden"
      >
        Apply
      </button>
    </AutoSubmitForm>
  );
}

/** The Learners | Publications view tabs — plain links that keep every other
 *  param. */
function ViewControls({ params }: { params: MentoredPubsParams }) {
  const tab = (view: MentoredPubsParams["view"], label: string) => (
    <Link
      href={pageHref({ ...params, view })}
      className={params.view === view ? TAB_ACTIVE : TAB_IDLE}
      aria-current={params.view === view ? "page" : undefined}
      data-testid={`mentored-pubs-view-${view}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="border-apollo-border mt-4 flex gap-4 border-b" aria-label="View">
      {tab("summary", "Learners")}
      {tab("publications", "Publications")}
    </nav>
  );
}

function SummaryTable({ report }: { report: MentoredPublicationsReport }) {
  const allMode = report.filters.pubs === "all";
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
            {allMode ? (
              <>
                <th className={`${TH_CLASS} text-right`}>All pubs (in window)</th>
                <th className={`${TH_CLASS} text-right`}>With a mentor (in window)</th>
                <th className={`${TH_CLASS} text-right`}>First author (in window)</th>
                <th className={`${TH_CLASS} text-right`}>
                  JIF &ge; {HIGH_IMPACT_THRESHOLD} (in window)
                </th>
                <th className={`${TH_CLASS} text-right`}>All-time total</th>
              </>
            ) : (
              <>
                <th className={`${TH_CLASS} text-right`}>In window</th>
                <th className={`${TH_CLASS} text-right`}>All years</th>
                <th className={`${TH_CLASS} text-right`}>JIF &ge; {HIGH_IMPACT_THRESHOLD}</th>
                <th className={`${TH_CLASS} text-right`}>First author</th>
              </>
            )}
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
                <span className={CWID_CLASS}>{r.cwid}</span>
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
              <td className={TD_CLASS}>
                <MentorCell mentors={r.mentors} />
              </td>
              {/* "—" = no window to count against (no grad or entry year). */}
              {allMode ? (
                <>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.withMentorInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.firstAuthorInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.highImpactInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsAllTime}</td>
                </>
              ) : (
                <>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.pubsAllTime}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.highImpactInWindow ?? "—"}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{r.firstAuthorInWindow ?? "—"}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One row per distinct publication, most recent first. */
function PublicationsTable({ report }: { report: MentoredPublicationsReport }) {
  const allMode = report.filters.pubs === "all";
  if (report.publications.length === 0) {
    return (
      <p className="text-muted-foreground mt-6" data-testid="mentored-pubs-empty">
        No publications match these filters.
      </p>
    );
  }
  return (
    <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
      <table
        className="w-full border-collapse text-left text-sm"
        data-testid="mentored-pubs-publications"
      >
        <thead>
          <tr>
            <th className={TH_CLASS}>Citation</th>
            <th className={`${TH_CLASS} text-right`}>JIF</th>
            <th className={`${TH_CLASS} text-right`}>Citations</th>
            <th className={TH_CLASS}>Learner(s)</th>
            <th className={TH_CLASS}>Mentor(s)</th>
          </tr>
        </thead>
        <tbody>
          {report.publications.map((p) => {
            const id = citationIdentifier(p.pmid);
            return (
              <tr key={p.pmid} data-testid={`mentored-pubs-pub-${p.pmid}`}>
                <td className={TD_CLASS}>
                  {p.citation}{" "}
                  <span className="whitespace-nowrap">
                    {id.label}:{" "}
                    {id.href ? (
                      <a
                        href={id.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-apollo-slate hover:underline"
                      >
                        {id.value}
                      </a>
                    ) : (
                      id.value
                    )}
                  </span>
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{p.jif ?? "—"}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{p.citations ?? "—"}</td>
                <td className={TD_CLASS}>
                  <ul className="m-0 list-none p-0">
                    {p.learners.map((l) => (
                      <li key={l.cwid} className="whitespace-nowrap">
                        {l.lastName ?? ""}
                        {l.lastName && l.firstName ? ", " : ""}
                        {l.firstName ?? ""}
                        <span className={CWID_CLASS}>{l.cwid}</span>
                        {l.firstAuthor && (
                          <span
                            className="text-muted-foreground ml-2 text-xs"
                            title="Learner is first author"
                          >
                            1st author
                          </span>
                        )}
                        <span
                          className="text-muted-foreground ml-2 text-xs"
                          title={
                            l.inWindow === null
                              ? "Program window unknown (no graduation or entry year on the roster)"
                              : "Publication year inside this learner's program window"
                          }
                        >
                          {l.inWindow === null
                            ? "In window: —"
                            : l.inWindow
                              ? "In window: Yes"
                              : "In window: No"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={TD_CLASS}>
                  {allMode && !p.withMentor ? (
                    <span className="text-muted-foreground">No mentor co-author</span>
                  ) : (
                    <MentorCell mentors={p.mentors} />
                  )}
                </td>
              </tr>
            );
          })}
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
    : { years: null, program: null, tail: DEFAULT_TAIL, pubs: "mentored", view: "summary" };
  // A `program` outside the caller's scopes is silently the "all" view of
  // what they DO hold — never a wider set.
  const program = requested.program !== null && scopeAdmits(scopes, requested.program) ? requested.program : null;
  const loaderScopes = program !== null ? [program] : [...scopes];

  const yearChoices = await loadMentoredGradYears(loaderScopes);
  // Years the chosen program has no class in are dropped (the Program
  // select auto-submits with the previous program's years); nothing left
  // → this program's default.
  const choiceSet = new Set(yearChoices);
  const kept = (requested.years ?? []).filter((y) => choiceSet.has(y));
  const years =
    requested.years === null || (requested.years.length > 0 && kept.length === 0)
      ? defaultMentoredPubsYears(yearChoices)
      : kept;
  const params: MentoredPubsParams = {
    years,
    program,
    tail: requested.tail,
    pubs: requested.pubs,
    view: requested.view,
  };

  const canManage = canManageReportAccess(session);
  const [report, pendingSlugRequests, pendingHonors, accessRows] = await Promise.all([
    loadMentoredPublicationsReport({
      scopes: loaderScopes,
      gradYears: years.length > 0 ? years : null,
      tail: params.tail,
      pubs: params.pubs,
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

  const totalInWindow = report.summary.reduce((n, r) => n + (r.pubsInWindow ?? 0), 0);
  const totalAllTime = report.summary.reduce((n, r) => n + r.pubsAllTime, 0);
  const allMode = params.pubs === "all";
  const allPubsMissing = allMode && report.allPubsLoaded === false;
  // The download never carries `view` (the workbook has no Publications view).
  const qs = mentoredPubsQueryString({ ...params, view: "summary" });

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
        {allMode
          ? "Every publication of each learner, with the ones co-authored with one of their AOC mentors flagged, "
          : "Every publication a learner co-authored with one of their AOC mentors, "}
        with Journal Impact Factor and NIH iCite citations. &ldquo;In window&rdquo; means entry year
        &le; publication year &le; graduation year + {params.tail}; a learner with no entry year on
        the roster is assumed to have entered four years before graduating.
      </p>
      <FilterForm params={params} yearChoices={yearChoices} programChoices={programChoices} />
      <ViewControls params={params} />
      {allPubsMissing && (
        <p
          className="border-apollo-border bg-apollo-surface-2 mt-4 rounded-md border px-3 py-2 text-sm"
          role="status"
          data-testid="mentored-pubs-all-missing"
        >
          All-publication data has not been loaded yet. The learner publication bridge (
          <code>etl:mentoring:import-learner-pubs</code>) has not run in this environment, so every
          count below would be zero. Switch &ldquo;Publications&rdquo; back to &ldquo;Co-authored
          with a mentor&rdquo; or run the import.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <p data-testid="mentored-pubs-total">
          <strong>{report.summary.length.toLocaleString()}</strong>{" "}
          {report.summary.length === 1 ? "learner" : "learners"} ·{" "}
          <strong>{totalInWindow.toLocaleString()}</strong> publications in window ·{" "}
          <strong>{totalAllTime.toLocaleString()}</strong> all years ·{" "}
          <strong>{report.publications.length.toLocaleString()}</strong> distinct{" "}
          {report.publications.length === 1 ? "publication" : "publications"}
        </p>
        <a
          href={`/api/edit/reports/mentored-publications?${qs}`}
          className="bg-apollo-maroon text-apollo-maroon-foreground hover:bg-apollo-maroon/90 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium"
          data-testid="mentored-pubs-download"
        >
          Download .xlsx
        </a>
      </div>
      {allPubsMissing ? null : params.view === "publications" ? (
        <PublicationsTable report={report} />
      ) : (
        <SummaryTable report={report} />
      )}
      {canManage && (
        <ReportAccessPanel reportKey={MENTORED_PUBS_REPORT} initialRows={panelRows} scopeOptions={scopeOptions} />
      )}
    </ConsoleShell>
  );
}
