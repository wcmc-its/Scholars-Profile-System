/**
 * `/edit/reports/7` — "Mentored publications". For every learner in a
 * (learner, mentor) pair — the AOC pairing sheet (which also carries the
 * MD-PhD program office's list), Jenzabar thesis advisors, ED postdoc
 * appointments, co-author inferences — every publication co-authored with
 * one of their mentors, with Journal Impact Factor and NIH iCite citations,
 * plus per-learner counts (`lib/edit/mentored-publications-report.ts`). The
 * Areas of Concentration (AOC) office's annual spreadsheet, on demand: the
 * summary table in-page and the full three-sheet workbook behind
 * "Download .xlsx" (`/api/edit/reports/mentored-publications`, same query
 * string). Every label speaks the office's language (`AOC`, never the
 * `md` bucket key; "likely", never "presumptive") — `lib/edit/mentorship-type.ts`
 * — and each type carries a hover (`HoverTooltip`, a client module, so it
 * is safe in this server page) plus a closed "Sources" disclosure under the
 * description that says what each source carries and lacks, and names the
 * one not yet loaded (the Faculty Review Tool's self-reported mentees).
 * `docs/mentored-publications-report.md` is the long form.
 *
 * Two in-page views (`view=summary|publications`, underline tabs the client
 * island owns — both views ride on the same loaded report, so a tab click
 * switches instantly and only rewrites the URL): Learners — the per-learner summary — and Publications — one row per
 * distinct paper, most recently added to PubMed first, as a Vancouver
 * citation with its PMID link, JIF, iCite count, the learner(s) and
 * mentor(s) on it. Both tables are ONE client island
 * (`components/edit/mentored-publications-table.tsx`): an in-memory facet
 * rail (year, author position, window, mentor) and sortable headers over
 * the rows this page loads in one shot; the download is server-filtered
 * only (types / years / set / tail), never by the rail.
 * "Type of mentorship" (`types=`, a checkbox group in the filter form) is
 * SERVER-side on purpose: the loader reads only the sources the selected
 * types need, so an AOC-office holder sees AOC-defined pairs and nothing
 * inferred (`lib/edit/mentorship-type.ts`; the choices offered and the
 * default are resolved against the caller's scopes — a roster type is
 * offered only when its scope is held, co-author inferences are never on by
 * default). Two publication sets (`pubs=mentored|all`, a select in the
 * filter form):
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
import * as React from "react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ConsoleShell } from "@/components/edit/console-shell";
import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
import { ReportAccessPanel, type ReportAccessPanelRow } from "@/components/edit/report-access-panel";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
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
  allowedMentorshipTypes,
  MENTORSHIP_TYPE_DESCRIPTION,
  MENTORSHIP_TYPE_KEYS,
  MENTORSHIP_TYPE_LABEL,
  resolveMentorshipTypes,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";
import {
  ALL_SCOPES,
  canManageReportAccess,
  getReportScopes,
  listReportAccess,
  MENTORED_PUBS_REPORT,
  MENTORED_PUBS_SCOPES,
} from "@/lib/edit/report-access";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Mentored publications — Scholars Profile Console",
  robots: { index: false, follow: false },
};

// Underline tabs, as `components/edit/matcha-tab.tsx` draws them.
function pageHref(params: MentoredPubsParams): string {
  return `/edit/reports/7?${mentoredPubsQueryString(params)}`;
}

function FilterForm({
  params,
  yearChoices,
  typeChoices,
}: {
  params: MentoredPubsParams;
  yearChoices: ReadonlyArray<number | null>;
  typeChoices: ReadonlyArray<MentorshipTypeKey>;
}) {
  const selected = new Set(params.years ?? []);
  const allYears = params.years !== null && params.years.length === 0;
  const selectedTypes = new Set(params.types ?? []);
  return (
    <AutoSubmitForm
      id="mentored-pubs-filters"
      action="/edit/reports/7"
      className="group border-apollo-border bg-apollo-surface mt-4 flex flex-wrap items-end gap-4 rounded-md border p-3 text-sm"
      data-testid="mentored-pubs-filters"
    >
      {/* The current view rides along as a hidden input the island owns
          (`form="mentored-pubs-filters"`), so a filter change keeps it. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-foreground font-medium">Type of mentorship</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {typeChoices.map((k) => (
            <label key={k} className="inline-flex items-center gap-1">
              <input type="checkbox" name="types" value={k} defaultChecked={selectedTypes.has(k)} />
              {/* The hover wraps the TEXT only — never the input, whose click
                  must stay a plain toggle. */}
              <HoverTooltip text={MENTORSHIP_TYPE_DESCRIPTION[k]} wide>
                <span>{MENTORSHIP_TYPE_LABEL[k]}</span>
              </HoverTooltip>
            </label>
          ))}
        </div>
      </fieldset>
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

/** The date facts a description does not already state, appended in the
 *  Sources disclosure (the hover text stays one sentence; MD-PhD and thesis
 *  say theirs inline, co-author pairs carry no years). */
const SOURCE_DATES: Partial<Record<MentorshipTypeKey, string>> = {
  aoc: "Carries the graduation year and, for recent classes, the entry year.",
  ecr: "Carries the graduation year.",
  postdoc: "Carries the appointment start and end dates.",
};

/** Closed by default: one entry per type in filter order, then the source
 *  not yet loaded. Plain `<details>` so there is nothing to hydrate. */
function SourcesDisclosure() {
  return (
    <details className="text-muted-foreground mt-2 text-sm" data-testid="mentored-pubs-sources">
      <summary className="cursor-pointer">Sources</summary>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {MENTORSHIP_TYPE_KEYS.map((k) => (
          <React.Fragment key={k}>
            <dt className="text-foreground font-medium">{MENTORSHIP_TYPE_LABEL[k]}</dt>
            <dd className="m-0">
              {MENTORSHIP_TYPE_DESCRIPTION[k]}
              {SOURCE_DATES[k] ? ` ${SOURCE_DATES[k]}` : null}
            </dd>
          </React.Fragment>
        ))}
        <dd className="col-span-2 m-0" data-testid="mentored-pubs-sources-frt">
          Not yet a source: the Faculty Review Tool&rsquo;s self-reported mentees &mdash; the
          mentoring extract from that system has not been provided.
        </dd>
      </dl>
    </details>
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
    : { years: null, types: null, tail: DEFAULT_TAIL, pubs: "mentored", view: "summary" };
  // Types outside the caller's scopes are silently dropped — never a wider set.
  const types = resolveMentorshipTypes(requested.types, scopes);
  const loaderScopes = [...scopes];

  const yearChoices = await loadMentoredGradYears(loaderScopes, types);
  // Years the chosen types have no class in are dropped (a type checkbox
  // auto-submits with the previous selection's years); nothing left → this
  // selection's default.
  const choiceSet = new Set(yearChoices);
  const kept = (requested.years ?? []).filter((y) => choiceSet.has(y));
  const years =
    requested.years === null || (requested.years.length > 0 && kept.length === 0)
      ? defaultMentoredPubsYears(yearChoices)
      : kept;
  const params: MentoredPubsParams = {
    years,
    types,
    tail: requested.tail,
    pubs: requested.pubs,
    view: requested.view,
  };

  const canManage = canManageReportAccess(session);
  const [report, pendingSlugRequests, pendingHonors, accessRows] = await Promise.all([
    loadMentoredPublicationsReport({
      scopes: loaderScopes,
      types,
      gradYears: years.length > 0 ? years : null,
      tail: params.tail,
      pubs: params.pubs,
    }),
    session.isSuperuser && isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
    canManage ? listReportAccess(MENTORED_PUBS_REPORT) : Promise.resolve([]),
  ]);

  const typeChoices = allowedMentorshipTypes(scopes);
  const scopeOptions: Array<readonly [string, string]> = [
    [ALL_SCOPES, "All programs"] as const,
    ...MENTORED_PUBS_SCOPES.map((s) => [s, PROGRAM_LABEL[s] ?? s] as const),
  ];
  const panelRows: ReportAccessPanelRow[] = accessRows.map((r) => ({
    ...r,
    grantedAt: r.grantedAt.toISOString(),
  }));

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
        with Journal Impact Factor and NIH iCite citations. Pairs come from the AOC pairing sheet, the
        MD-PhD program office, Jenzabar thesis-advisor records, ED postdoc appointments, and co-authorship
        inferences (off by default) &mdash; see Sources below. &ldquo;In window&rdquo; means entry year
        &le; publication year &le; graduation year + {params.tail}; an AOC learner with no entry year on
        the pairing sheet is assumed to have entered four years before graduating.
        {report.droppedUnresolved > 0 &&
          ` ${report.droppedUnresolved.toLocaleString()} co-publications not yet in the local corpus are not shown.`}
      </p>
      <SourcesDisclosure />
      <FilterForm params={params} yearChoices={yearChoices} typeChoices={typeChoices} />
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
      {allPubsMissing ? null : (
        <MentoredPublicationsTable
          view={params.view}
          viewHrefs={{
            summary: pageHref({ ...params, view: "summary" }),
            publications: pageHref({ ...params, view: "publications" }),
          }}
          downloadHref={`/api/edit/reports/mentored-publications?${qs}`}
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
