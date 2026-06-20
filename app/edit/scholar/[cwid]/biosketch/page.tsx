/**
 * `/edit/scholar/[cwid]/biosketch` — the DELEGATED NIH-biosketch generator
 * (#917 v5). A superuser / granted proxy / org-unit curator drafts the
 * narrative prose of ANOTHER scholar's NIH biosketch from that scholar's
 * indexed data. The output is the same COPY/EXPORT artifact as the self surface
 * — nothing is written to the target's profile.
 *
 * Authorization mirrors `POST /api/edit/biosketch/generate` BYTE-FOR-BYTE: the
 * SHARED `authorizeOverviewWrite` predicate (self OR superuser OR granted proxy
 * OR org-unit owner/curator), keyed on `realCwid`, gated to non-impersonating
 * for the delegated legs. The identity (`session` / `realCwid` /
 * `impersonatedCwid`) is resolved by the SAME `resolveEditIdentity` the write
 * route's preamble uses, so the page gate and the API gate cannot drift.
 *
 * A failed authorization is `notFound()` (404) — the surface must be
 * indistinguishable from a missing one for an unauthorized viewer; it never 403s
 * and never reveals the target exists.
 *
 * `force-dynamic` + `noindex`, like the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { BiosketchTool } from "@/components/edit/biosketch-tool";
import { db } from "@/lib/db";
import { resolveEditIdentity } from "@/lib/edit/request";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Draft an NIH biosketch — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** Same model resolution order as `generateBiosketch` / the self page. */
const EFFECTIVE_MODEL =
  process.env.BIOSKETCH_GENERATE_MODEL ??
  process.env.OVERVIEW_GENERATE_MODEL ??
  "us.anthropic.claude-opus-4-8";

export default async function BiosketchDelegatedPage({
  params,
}: {
  params: Promise<{ cwid: string }>;
}) {
  const { cwid } = await params;

  // (a) flag first — a dark surface 404s before any work / SAML round-trip.
  if (!isBiosketchGenerateEnabled()) notFound();

  // (b) the dual edit identity — the EXACT same resolution the write route's
  // preamble (`readEditRequest`) uses, so the page authorizes identically.
  // `null` ⇒ unauthenticated ⇒ SAML login (the bare route, returning here).
  const identity = await resolveEditIdentity();
  if (!identity) {
    redirect(`/api/auth/saml/login?return=/edit/scholar/${cwid}/biosketch`);
  }
  const { session, realCwid, impersonatedCwid } = identity;

  // (c) authorization — the SHARED bio-write predicate, called exactly as the
  // route calls it (same casts of `db.read`). A deny is a 404, never a 403: the
  // surface must not betray the target's existence.
  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) notFound();

  // The target scholar row must exist + not be soft-deleted — no corpus to draft
  // from otherwise. (A superuser-authorized but missing target → 404, same as
  // the route's `scholar_not_found` after authz.)
  const target = await db.read.scholar.findUnique({
    where: { cwid },
    select: { deletedAt: true },
  });
  if (!target || target.deletedAt !== null) notFound();

  // Cost line privileged to superuser / comms-steward / org-unit-admin (a unit
  // admin acts in an operational capacity, so the per-draft cost is shown to
  // them too). A bare granted proxy does not see it.
  const canSeeCost =
    session.isSuperuser || session.isCommsSteward || authz.viaUnitAdminUnit !== null;

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="biosketch-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
        </div>
      </header>

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Draft an NIH biosketch</h1>
        <p className="text-muted-foreground mb-6 max-w-3xl text-sm">
          Generate the narrative prose of this scholar&rsquo;s NIH biosketch — up to five
          Contributions to Science, or a Personal Statement tailored to a proposed project — from
          their indexed publications, topics, methods, and grants. The draft is a copy/export
          artifact for their grant application; nothing here is saved to their public profile.
          Review every entry for accuracy before it is submitted.
        </p>
        <BiosketchTool entityId={cwid} canSeeCost={canSeeCost} model={EFFECTIVE_MODEL} />
      </main>
    </div>
  );
}
