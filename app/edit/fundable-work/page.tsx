/**
 * `/edit/fundable-work` — WCM conference abstracts and preprints by full-time
 * faculty (postdoc co-authors shown alongside), ranked by an at-ingest LLM read of their private-funding potential
 * (etl/fundable-work). For CTL: which new work to bring to industry and foundations.
 *
 * Audience: the Matcha audience (superuser, development role, observer).
 * `notFound()` while FUNDABLE_WORK is off. Read-only, so there is no API route:
 * this server component is the authorization boundary. It ships the top
 * `ROW_LIMIT` rows and `components/edit/fundable-work-browser` does the
 * filtering, faceting and sorting in the browser.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { FundableWorkBrowser, type FundableWorkRow } from "@/components/edit/fundable-work-browser";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { isFundableWorkEnabled, type FundableWorkFunder } from "@/lib/fundable-work";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Matcha for emergent research — Scholars Console",
  robots: { index: false, follow: false },
};

/** ponytail: the whole payload goes to the browser, abstracts included — a few
 *  hundred rows is ~1 MB over SSO. Raising this past ~1k means paginating. */
const ROW_LIMIT = 400;

export default async function FundableWorkPage() {
  if (!isFundableWorkEnabled()) notFound();
  const session = await getEffectiveEditSession();
  if (!session) redirect("/api/auth/saml/login?return=/edit/fundable-work");
  if (!(session.isSuperuser || session.isDeveloper || session.isObserver)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "fundable-work",
      path: "/edit/fundable-work",
      reason: "not_developer_get",
    });
    return (
      <ConsoleShell active="fundable-work" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const [works, pendingSlugRequests, pendingHonors] = await Promise.all([
    db.read.fundableWork.findMany({
      orderBy: [{ score: "desc" }, { publicationDate: "desc" }],
      take: ROW_LIMIT,
      include: {
        authors: {
          include: {
            scholar: {
              select: {
                preferredName: true,
                slug: true,
                primaryDepartment: true,
                roleCategory: true,
                hasHeadshot: true,
              },
            },
          },
        },
      },
    }),
    session.isSuperuser && isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : null,
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : null,
  ]);

  const rows: FundableWorkRow[] = works.map((w) => ({
    id: w.id,
    type: w.type,
    title: w.title,
    url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`,
    venue: w.venue,
    date: w.publicationDate.toISOString().slice(0, 10),
    score: w.score,
    stage: w.stage,
    modality: w.modality,
    rationale: w.rationale,
    pitch: w.pitch,
    abstract: w.abstract,
    funders: w.funders as FundableWorkFunder[],
    authors: w.authors.map((a) => ({
      cwid: a.cwid,
      name: a.scholar.preferredName,
      slug: a.scholar.slug,
      department: a.scholar.primaryDepartment,
      position: a.position,
      isPostdoc: a.scholar.roleCategory === "postdoc",
      hasHeadshot: a.scholar.hasHeadshot === true,
    })),
  }));

  return (
    <ConsoleShell
      active="fundable-work"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <FundableWorkBrowser rows={rows} truncated={works.length === ROW_LIMIT} />
    </ConsoleShell>
  );
}
