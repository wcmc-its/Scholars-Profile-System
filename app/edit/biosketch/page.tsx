/**
 * `/edit/biosketch` — the SELF NIH-biosketch generator (#917 v5,
 * `docs/overview-generator-prompt-v5.md`). A scholar drafts the narrative prose
 * of their own NIH biosketch (Contributions to Science / Personal Statement)
 * from their indexed Scholars data. The output is a COPY/EXPORT
 * grant-application artifact — nothing is written to the public profile.
 *
 * Guard, mirroring the sibling `/edit/methods` posture:
 *   - `EDIT_BIOSKETCH_GENERATE` off ⇒ `notFound()` (404 — never reveal a dark
 *     surface; checked first so an unauthenticated hit never round-trips SAML).
 *   - no session                    ⇒ SAML login redirect.
 *   - the viewer's own scholar row missing / soft-deleted ⇒ `notFound()` (no
 *     profile to draft from).
 *
 * `force-dynamic` + `noindex`, like the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { BiosketchTool } from "@/components/edit/biosketch-tool";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Draft an NIH biosketch — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** The model the biosketch route will actually generate on — surfaced to the
 *  privileged cost line only. Resolution order matches `generateBiosketch`. */
const EFFECTIVE_MODEL =
  process.env.BIOSKETCH_GENERATE_MODEL ??
  process.env.OVERVIEW_GENERATE_MODEL ??
  "us.anthropic.claude-opus-4-8";

export default async function BiosketchSelfPage() {
  // (a) flag first — a dormant feature 404s before any work / SAML round-trip.
  if (!isBiosketchGenerateEnabled()) notFound();

  // (b) effective identity (honors a "View as" overlay), then SAML if absent.
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/biosketch");
  }

  // (c) the viewer's own scholar row must exist and not be soft-deleted — there
  // is no corpus to draft from otherwise. (Self authorization is implicit: the
  // route re-checks `authorizeOverviewWrite(entityId === self)` on generate.)
  const self = await db.read.scholar.findUnique({
    where: { cwid: session.cwid },
    select: { deletedAt: true },
  });
  if (!self || self.deletedAt !== null) notFound();

  // Cost line is privileged (superuser / comms-steward), mirroring the overview
  // generator's `canSelectPromptVersion`-gated cost; a faculty owner never sees it.
  const canSeeCost = session.isSuperuser || session.isCommsSteward;

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
          Generate the narrative prose of your NIH biosketch — up to five Contributions to Science,
          or a Personal Statement tailored to a proposed project — from your indexed publications,
          topics, methods, and grants. The draft is yours to copy into your grant application;
          nothing here is saved to your public profile. Review every entry for accuracy before you
          submit it.
        </p>
        <BiosketchTool entityId={session.cwid} canSeeCost={canSeeCost} model={EFFECTIVE_MODEL} />
      </main>
    </div>
  );
}
