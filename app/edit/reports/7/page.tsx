/**
 * `/edit/reports/7` — "Mentored publications". For every learner in a
 * (learner, mentor) pair — the AOC roster, Jenzabar thesis advisors, ED
 * postdoc appointments, co-author suggestions — every publication
 * co-authored with one of their mentors, with Journal Impact Factor and NIH
 * iCite citations, plus per-learner counts
 * (`lib/edit/mentored-publications-report.ts`). The Medical Education office's
 * annual spreadsheet, on demand: the summary table in-page and the full
 * three-sheet workbook behind "Download .xlsx"
 * (`/api/edit/reports/mentored-publications`, same query string).
 *
 * Two in-page views (`view=summary|publications`, underline tabs above the
 * table): Learners — the per-learner summary — and Publications — one row per
 * distinct paper, most recently added to PubMed first, as a Vancouver
 * citation with its PMID link, JIF, iCite count, the learner(s) and
 * mentor(s) on it. Both tables are ONE client island
 * (`components/edit/mentored-publications-table.tsx`): an in-memory facet
 * rail (type of mentorship, year, author position, window, mentor) and
 * sortable headers over the rows this page loads in one shot; the download
 * is server-filtered only (program / years / set / tail), never by the rail.
 * Two publication sets (`pubs=mentored|all`, a select in the filter form):
 * the co-pubs with an AOC mentor (default), or every publication of the
 * learner from the `aoc_mentee_publication` bridge, each flagged for a mentor
 * co-author. Both params ride every tab link and the download link; `view`
 * is page-only.
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
import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
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
  defaultMentoredPubsYears,
  HIGH_IMPACT_THRESHOLD,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
  MAX_TAIL,
  PROGRAM_LABEL,
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

// Underline tabs, as `components/edit/matcha-tab.tsx` draws them.
const TAB_ACTIVE = "border-apollo-maroon inline-block border-b-2 py-2.5 text-base font-medium";
const TAB_IDLE = "text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-2.5 text-base";

function pageHref(params: MentoredPubsParams): string {
  return `/edit/reports/7?${mentoredPubsQueryString(params)}`;
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
      className="group border-apollo-border bg-apollo-surface mt-4 flex flex-wrap items-end gap-4 rounded-md border p-3 text-sm"
      data-testid="mentored-pubs-filters"
    >
      {/* The view rides along so a filter change keeps it. */}
      {params.view !== "summary" && <input type="hidden" name="view" value={params.view} />}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-foreground font-medium">Graduation year</legend>
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
          <span className="text-foreground font-medium">Program</span>
          <select
            name="program"
            defaultValue={params.program ?? "all"}
            className="border-foreground/40 rounded border px-2 py-1"
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
        <span className="text-foreground font-medium">Publications</span>
        <select
          name="pubs"
          defaultValue={params.pubs}
          className="border-foreground/40 rounded border px-2 py-1"
          data-testid="mentored-pubs-set"
        >
          <option value="mentored">Co-authored with a mentor</option>
          <option value="all">All learner publications</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-foreground font-medium">Years after graduation still counted</span>
        <select name="tail" defaultValue={String(params.tail)} className="border-foreground/40 rounded border px-2 py-1">
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
        className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 group-data-[hydrated=true]:hidden"
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
          ? "Every publication of each learner, with the ones co-authored with one of their mentors flagged, "
          : "Every publication a learner co-authored with one of their mentors, "}
        with Journal Impact Factor and NIH iCite citations. Pairs come from the AOC roster, Jenzabar
        thesis-advisor records, ED postdoc appointments, and co-authorship patterns (presumptive
        &mdash; unchecked by default). &ldquo;In window&rdquo; means entry year &le; publication year
        &le; graduation year + {params.tail}; an MD-program learner with no entry year on the roster
        is assumed to have entered four years before graduating.
        {report.droppedUnresolved > 0 &&
          ` ${report.droppedUnresolved.toLocaleString()} co-publications not yet in the local corpus are not shown.`}
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
      {allPubsMissing ? null : (
        <MentoredPublicationsTable
          view={params.view}
          summary={report.summary}
          publications={report.publications}
          pubsMode={params.pubs}
          highImpactThreshold={HIGH_IMPACT_THRESHOLD}
        />
      )}
      {canManage && (
        <ReportAccessPanel reportKey={MENTORED_PUBS_REPORT} initialRows={panelRows} scopeOptions={scopeOptions} />
      )}
    </ConsoleShell>
  );
}
