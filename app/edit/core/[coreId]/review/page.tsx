/**
 * `/edit/core/[coreId]/review` — the core owner's pub review queue (cores
 * inference), split out of the core editor (cores-as-org-units P3/P4
 * restructure) into its own route, mirroring `/edit/center/[code]/history`: a
 * bespoke sub-page (its own `ConsoleTopBar`-based shell, NOT `EditShell`/
 * `AttributeRail`) reusing the SAME authz gate as the parent editor as its own
 * independent check — this route must be safely directly-linkable/bookmarkable
 * on its own, not dependent on the parent page having already run it.
 *
 * Lists the engine's candidate (publication, core) usages for one core, ranked
 * by likelihood, with inline evidence; the owner confirms/rejects each via
 * `POST /api/edit/core-claim`.
 *
 * Server Component. Authorization mirrors the core editor route:
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **Effective core role** (Superuser / comms_steward / owner / curator of
 *      this core, i.e. `UnitAdmin(entityType="core", entityId=coreId)`) →
 *      render (2026-08-26 policy widening decision #6 — a steward passes
 *      regardless of any personal `UnitAdmin` row).
 *   3. **No role + core exists** → one `edit_authz_denied` line + a visible 403;
 *      **core absent** → 404.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  loadCoreClientPaperCounts,
  loadCoreClients,
  type CoreClientLookup,
  type CoreClientPaperCountLookup,
} from "@/lib/api/core-clients";
import { loadCoreReviewQueue } from "@/lib/api/core-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Review core publications",
  robots: { index: false, follow: false },
};

export default async function EditCoreReviewPage({
  params,
}: {
  params: Promise<{ coreId: string }>;
}) {
  const { coreId } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/core/${encodeURIComponent(coreId)}/review`);
  }

  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    // Distinguish "no such core" (404) from "exists but you can't review it" (403).
    const exists = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: coreId,
      path: `/edit/core/${coreId}/review`,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return (
      <div className="bg-apollo-page min-h-screen">
        <ConsoleTopBar variant="console" />
        <ForbiddenEditPage variant="unit" targetEntity={coreId} />
      </div>
    );
  }

  const queue = await loadCoreReviewQueue(coreId, db.read);
  if (!queue) notFound();

  const clients = await loadCoreClients(coreId, db.read as unknown as CoreClientLookup);
  // What this core already holds from each person the queue may have to NAME, for
  // its evidence lines ("Samprit Banerjee, 18 papers, 11 recent"; "18 of their 29
  // publications"). Two populations, one query: the known-client roster, and every
  // WCM byline author across all three lists — the repeat-user line has to name
  // someone, and the only defensible name is the one whose confirmed count was
  // computed here rather than guessed beside the engine's anonymous scalar. The
  // loader de-dupes, and drops everyone this core holds nothing from, so what
  // reaches the client is only people with a confirmed paper here — 246 on
  // staging core 14, out of the 1,456 distinct byline authors (7,443 seats)
  // passed in.
  const paperCounts = await loadCoreClientPaperCounts(
    queue.confirmed,
    [
      ...clients.flatMap((c) => (c.cwid ? [c.cwid] : [])),
      ...[...queue.candidates, ...queue.confirmed, ...queue.rejected].flatMap((r) =>
        r.wcmAuthors.map((a) => a.cwid),
      ),
    ],
    db.read as unknown as CoreClientPaperCountLookup,
  );

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="edit-core-review-page">
      {/* This page has no `AdminSubnav` below it, so the top bar must supply the
          account menu / Back-to-Scholars / Sign-out itself (dwd2001 nav fix). */}
      <ConsoleTopBar variant="console" showAccountMenu />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        {/* Breadcrumb, not a bare back-link: this page is two levels down and
            directly linkable, so both ancestors have to be reachable from it. */}
        <nav aria-label="Breadcrumb" className="text-muted-foreground mb-3.5 flex gap-2 text-xs">
          <Link href="/edit/core" className="text-apollo-slate hover:underline">
            Cores
          </Link>
          <span aria-hidden className="opacity-50">
            /
          </span>
          <Link
            href={`/edit/core/${encodeURIComponent(coreId)}`}
            className="text-apollo-slate hover:underline"
          >
            {queue.core.name}
          </Link>
          <span aria-hidden className="opacity-50">
            /
          </span>
          <span>Review publications</span>
        </nav>

        <p className="text-apollo-maroon mb-1.5 text-[11px] font-medium tracking-[0.09em] uppercase">
          Core facility · review queue
        </p>
        {/* `page-title` (not `font-serif`) is the repo's page-subject hook — see
            the typography rule in app/globals.css. */}
        <h1 className="page-title mb-1.5 text-[29px] leading-tight font-semibold">
          {queue.core.name}
        </h1>
        <p className="text-muted-foreground mb-6 max-w-[56ch] text-[13px]">
          Confirm the publications that used this core and reject the false positives. Decisions
          show on public profiles and prime the next inference run.
        </p>
        <CoreClaimQueue
          core={queue.core}
          candidates={queue.candidates}
          confirmed={queue.confirmed}
          rejected={queue.rejected}
          clients={clients}
          paperCounts={paperCounts}
        />
      </main>
    </div>
  );
}
