/**
 * `/edit/research-security` — co-publications where a co-author lists an entity
 * on a research-security watch list (Roadmap
 * `research-security-dashboard-plan-2026-11-16.md`). Read-only; replaces the
 * one-off Section 1286 workbooks. The data is a nightly copy of reciterdb's
 * watch-list screen (`etl/research-security`).
 *
 * SENSITIVE, per-person screening results. Audience: superuser or
 * `research_security_viewer`, flag-gated (`EDIT_RESEARCH_SECURITY_DASHBOARD`);
 * anyone else, or a dark deployment, gets a 404. `force-dynamic` + `noindex`,
 * like the rest of `/edit/*`. Modelled on `/edit/data-sharing`.
 */
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import {
  ResearchSecurityDashboard,
  type ResearchSecurityViewRows,
} from "@/components/edit/research-security-dashboard";
import { Skeleton } from "@/components/ui/skeleton";
import {
  arrangeEntityRows,
  arrangeFundingRows,
  arrangePaperRows,
  arrangePersonRows,
  buildEntityProfile,
  buildEntityRows,
  buildFundingRows,
  buildPaperRows,
  buildPersonProfile,
  buildPersonRows,
  buildSummary,
  buildUnattributedRows,
  countUnattributedPapers,
  forConfirmedAuthors,
  groupUnattributedRows,
  loadCategories,
  loadEntities,
  loadMatchedStrings,
  loadResearchSecurityFacts,
  paginate,
  paperScope,
  searchUnattributedRows,
  sortUnattributedGroups,
  topAffiliations,
} from "@/lib/api/research-security-report";
import { loadInferredMethods } from "@/lib/api/research-security-methods";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  LIST_COUNTRY,
  PAGE_SIZE,
  parseResearchSecurityParams,
  withKnownCategory,
  withKnownEntity,
  type ResearchSecurityUiParams,
} from "@/lib/edit/research-security-dashboard";
import { buildResearchSecurityMethodsDoc } from "@/lib/edit/research-security-methods-doc";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

/** The entity card reads affiliation strings for at most this many papers. */
const ENTITY_STRINGS_PAPERS = 2000;

export const metadata = {
  title: "Research security — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditResearchSecurityPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/research-security");
  }

  // Flag + role gate, combined: a dark deployment and a viewer without the
  // role both 404. Nothing below this line runs for them.
  if (!(await canViewDashboard(session, "research-security"))) {
    notFound();
  }

  const ui = parseResearchSecurityParams((await searchParams) ?? {});

  const [pendingSlugRequests, pendingHonors] = await Promise.all([
    isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell
      active="research-security"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="text-[30px] leading-tight font-semibold tracking-[-.01em]">Research security</h1>
      <p className="text-muted-foreground mt-2.5 mb-6 max-w-[86ch] text-[14.5px] leading-normal">
        Co-publications where a co-author lists an entity on a research-security watch list, for
        Weill Cornell Medicine and Cornell University authors. Refreshed nightly from ReCiter.
      </p>
      <Suspense fallback={<ResearchSecurityBodySkeleton />}>
        <ResearchSecurityBody ui={ui} />
      </Suspense>
    </ConsoleShell>
  );
}

async function ResearchSecurityBody({ ui: requested }: { ui: ResearchSecurityUiParams }) {
  // The category is checked against the selected list BEFORE anything is
  // loaded, and the checked filters are the ones every link, the form and the
  // export are built from: a stale category is dropped, never applied unseen.
  const categories = await loadCategories(db.read, requested.filters);
  const known = withKnownCategory(requested.filters, categories);
  const entities = await loadEntities(db.read, known);
  const f = withKnownEntity(known, entities);
  const ui = { ...requested, filters: f };
  const facts = await loadResearchSecurityFacts(db.read, f);
  const entity = buildEntityRows(facts, f.campus);
  const person = buildPersonRows(facts, f.campus);
  const paper = buildPaperRows(facts, f.campus);
  const funding = buildFundingRows(facts, f.campus);
  const unattributed = buildUnattributedRows(facts, f.campus);

  // One person: the summary card, and links to the records the console and
  // the public site hold for them (a Cornell person may have neither).
  const profile = buildPersonProfile(facts, f.campus);
  const scholar = profile
    ? await db.read.scholar.findFirst({
        where: { cwid: profile.cwid, deletedAt: null },
        select: { cwid: true, slug: true, status: true },
      })
    : null;

  // One entity: the summary card. The affiliation text is read for its
  // confirmed papers only, newest first, and not at all in the country tier,
  // where free-text strings under one country do not repeat.
  const entityProfile = buildEntityProfile(facts, f.campus, f.entity);
  const entityAffiliations =
    entityProfile && f.list !== LIST_COUNTRY
      ? topAffiliations(
          await loadMatchedStrings(
            db.read,
            entityProfile.confirmedArticleIds.slice(0, ENTITY_STRINGS_PAPERS),
            f,
          ),
          entityProfile.entity,
        )
      : undefined;

  // What ReciterAI inferred the cards' confirmed papers used: the person's own
  // rows for the person card, every confirmed author's for the entity card.
  const [personMethods, entityMethods] = await Promise.all([
    profile
      ? loadInferredMethods(db.read, paperScope(facts, profile.confirmedArticleIds, profile.cwid))
      : null,
    entityProfile
      ? loadInferredMethods(db.read, paperScope(facts, entityProfile.confirmedArticleIds))
      : null,
  ]);

  // Search and sort belong to the selected view's table alone: the tiles and
  // the tab counts are never narrowed by them.
  let current: ResearchSecurityViewRows;
  let paged: { page: number; totalPages: number; total: number };
  let viewTotal: number;
  if (ui.view === "person") {
    const p = paginate(arrangePersonRows(person, ui), ui.page, PAGE_SIZE);
    current = { view: "person", rows: p.rows };
    paged = p;
    viewTotal = person.length;
  } else if (ui.view === "paper") {
    const p = paginate(arrangePaperRows(paper, ui), ui.page, PAGE_SIZE);
    // The affiliation text is read for this page's papers only.
    const matchedStrings = forConfirmedAuthors(
      await loadMatchedStrings(
        db.read,
        p.rows.map((r) => r.article.articleId),
        f,
      ),
      facts,
      f.campus,
    );
    current = { view: "paper", rows: p.rows, matchedStrings };
    paged = p;
    viewTotal = paper.length;
  } else if (ui.view === "funding") {
    const p = paginate(arrangeFundingRows(funding, ui), ui.page, PAGE_SIZE);
    current = { view: "funding", rows: p.rows };
    paged = p;
    viewTotal = funding.length;
  } else if (ui.view === "unattributed") {
    const found = searchUnattributedRows(unattributed, ui.q);
    if (f.person) {
      // One candidate: their rows, one per paper.
      const p = paginate(found, ui.page, PAGE_SIZE);
      current = { view: "unattributed", rows: p.rows };
      paged = p;
      viewTotal = unattributed.length;
    } else {
      const p = paginate(sortUnattributedGroups(groupUnattributedRows(found), ui), ui.page, PAGE_SIZE);
      current = { view: "unattributed", rows: [], groups: p.rows };
      paged = p;
      viewTotal = groupUnattributedRows(unattributed).length;
    }
  } else {
    const p = paginate(arrangeEntityRows(entity, ui), ui.page, PAGE_SIZE);
    current = { view: "entity", rows: p.rows };
    paged = p;
    viewTotal = entity.length;
  }

  return (
    <ResearchSecurityDashboard
      ui={ui}
      summary={buildSummary(facts, f)}
      tabCounts={{
        entity: entity.length,
        person: person.length,
        paper: paper.length,
        funding: funding.length,
        unattributed: countUnattributedPapers(unattributed),
      }}
      current={current}
      page={paged.page}
      totalPages={paged.totalPages}
      categories={categories}
      entities={entities}
      profile={profile}
      profileLinks={
        scholar
          ? {
              console: `/edit/scholar/${scholar.cwid}`,
              publicProfile: scholar.status === "active" ? `/${scholar.slug}` : undefined,
            }
          : undefined
      }
      entityProfile={entityProfile}
      entityAffiliations={entityAffiliations}
      personMethods={personMethods}
      entityMethods={entityMethods}
      viewShown={paged.total}
      viewTotal={viewTotal}
      dataAsOf={facts.dataAsOf}
      methods={buildResearchSecurityMethodsDoc()}
    />
  );
}

function ResearchSecurityBodySkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <div role="status" className="sr-only">
        Loading research security dashboard…
      </div>
      <Skeleton className="h-14 w-full rounded-[13px]" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-[13px]" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-[13px]" />
    </div>
  );
}
