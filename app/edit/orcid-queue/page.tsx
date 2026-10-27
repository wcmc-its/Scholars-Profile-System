/**
 * `/edit/orcid-queue` — the ORCID librarian confirmation queue
 * (docs/orcid-librarian-queue-spec.md). People rarely confirm their own iD, so
 * librarians confirm candidate iDs on the evidence etl/orcid-evidence gathers
 * from each public ORCID record: a verified institutional email, an
 * institution in the record's affiliations, papers shared with the scholar's
 * publications, name agreement, and competing scholars or iDs.
 *
 * v3 (Roadmap/orcid-queue-v3-redesign-plan.md, PR A): master–detail. The
 * server loads every scholar in the queue as a list summary; the client
 * scores, searches, filters and sorts them, and fetches the selected
 * scholar's card from `GET /api/edit/orcid-queue/scholar`. The band tabs, the
 * sample gate and bulk confirm are gone.
 *
 * `type` / `unit` / `source` (the server half of the filter bar) narrow the
 * list. The filter-bar facets load beside the queue; when they fail the queue
 * still renders (the URL's filter still applies) and the bar offers the source
 * filter only.
 *
 * v2.1: each new work's Publication Manager link uses `PUBLICATION_MANAGER_URL`
 * (cdk/lib/app-stack.ts, per env; https only, else the SPS-wide default).
 *
 * Order of checks, every GET: session, then the flag (`ORCID_LIBRARIAN_QUEUE`
 * off ⇒ 404 for everyone), then `requireSuperuserGet` (librarians are
 * superusers; no new role). A View-as session reads the queue with every
 * control off: the routes refuse impersonated decisions. `force-dynamic` +
 * `noindex` like every `/edit` page.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { OrcidQueue } from "@/components/edit/orcid-queue";
import { getEffectiveEditSession, impersonationActive } from "@/lib/auth/effective-identity";
import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  isOrcidLibrarianQueueEnabled,
  parseOrcidQueueFilter,
  publicationManagerBaseUrl,
} from "@/lib/edit/orcid-queue";
import { loadOrcidQueue } from "@/lib/edit/orcid-queue.server";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ORCID queue — Scholars Console",
  robots: { index: false, follow: false },
};

const BASE_PATH = "/edit/orcid-queue";

export default async function OrcidQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=${BASE_PATH}`);
  }
  if (!isOrcidLibrarianQueueEnabled()) {
    notFound();
  }
  // Superuser re-check on every GET. Emits the `edit_authz_denied` line.
  if (requireSuperuserGet({ session, path: BASE_PATH, targetId: "orcid-queue" }) !== null) {
    return (
      <ConsoleShell
        active="orcid-queue"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const params = (await searchParams) ?? {};
  const filter = parseOrcidQueueFilter(params);
  const [data, rawSession, pendingSlugRequests, pendingHonors, facets] = await Promise.all([
    loadOrcidQueue(db.read, filter),
    getSession(),
    isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
    // Independent of the queue: a facet failure only narrows the filter bar.
    loadDataQualityFacets(db.read).catch((err: unknown) => {
      console.error(
        JSON.stringify({
          event: "orcid_queue_facets_failed",
          path: BASE_PATH,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }),
  ]);

  return (
    <ConsoleShell
      active="orcid-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div className="mb-[22px] flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.01em]">ORCID queue</h1>
        <p className="text-muted-foreground m-0 max-w-[80ch] text-[14.5px] leading-normal">
          ORCID iDs that may belong to a scholar, with the evidence from each public ORCID record. A
          confirmed iD goes on file and reaches WCM Identity overnight.
        </p>
      </div>
      <OrcidQueue
        data={data}
        facets={facets}
        basePath={BASE_PATH}
        readOnly={rawSession ? impersonationActive(rawSession, nowSeconds()) : false}
        pmBaseUrl={publicationManagerBaseUrl()}
      />
    </ConsoleShell>
  );
}
