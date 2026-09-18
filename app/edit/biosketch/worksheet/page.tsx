/**
 * `/edit/biosketch/worksheet?id=<generationId>` — the SciENcv worksheet for one saved biosketch
 * generation (#2652). Server Component: resolves the generation, authorizes on the row's OWN
 * `cwid` with the same predicate the generations GET and the generate route use
 * (`authorizeOverviewWrite`: self / superuser / granted proxy / unit admin), then loads the
 * scholar's edit context for the identity and education blocks, the scholar's WHOLE appointment
 * history (the edit context keeps active rows only), the published, profile-visible honors, and
 * the newest draft of the other narrative mode, and hands everything to the client worksheet.
 *
 * Flag-gated like the generations GET (`EDIT_BIOSKETCH_GENERATE` off ⇒ 404), and the #536
 * hidden-class guard runs after the context loads, as on the scholar editor. Reads only —
 * nothing on the page writes. `force-dynamic` + `noindex`, mirroring the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SciencvWorksheet } from "@/components/edit/sciencv-worksheet";
import { loadEditContext } from "@/lib/api/edit-context";
import { loadEntitySuppressions } from "@/lib/api/manual-layer";
import { looksLikeArtifactAppointment, shouldSuppressPreStart } from "@/lib/appointment-artifacts";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import { coerceEntries, getBiosketchGeneration } from "@/lib/edit/biosketch-provenance";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { isPubliclyDisplayed } from "@/lib/eligibility";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "SciENcv worksheet",
  robots: { index: false, follow: false },
};

const PATH = "/edit/biosketch/worksheet";

export default async function BiosketchWorksheetPage({
  searchParams,
}: {
  searchParams?: Promise<{ id?: string | string[] }>;
}) {
  if (!isBiosketchGenerateEnabled()) notFound();

  const raw = (await searchParams)?.id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id.length === 0 || id.length > 64) notFound();

  const identity = await resolveEditIdentity();
  if (!identity) {
    redirect(`/api/auth/saml/login?return=${encodeURIComponent(`${PATH}?id=${id}`)}`);
  }
  const { session, realCwid, impersonatedCwid } = identity;

  // The row is read BEFORE authorization because its `cwid` IS the authorization key (the
  // generations DELETE does the same). An unknown id 404s; a real id the caller may not touch
  // 403s below — the ids are opaque uuids that appear only in the owner's own history.
  const generation = await getBiosketchGeneration(id);
  if (!generation) notFound();

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: generation.cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: generation.cwid,
      path: PATH,
      reason: authz.reason,
    });
    // No `targetCwid` on the 403: unlike the scholar pages, the cwid is NOT in the URL the
    // caller typed — it came off the row — so echoing it (even as a data-attribute) would tell
    // a caller holding only the opaque id whose generation it is. The denial log above keeps it.
    return (
      <div className="bg-apollo-page min-h-screen">
        <ConsoleTopBar variant="console" />
        <ForbiddenEditPage />
      </div>
    );
  }

  const [ctx, honors, appointmentRows, otherDraft] = await Promise.all([
    loadEditContext(generation.cwid, db.read),
    // Published + profile-visible only: what the public profile shows is what the scholar has
    // chosen to stand behind, and a pending row hasn't been curated yet.
    db.read.honor.findMany({
      where: { cwid: generation.cwid, status: "published", showOnProfile: true },
      select: { name: true, organization: true, year: true },
      // Newest first; `year` NULLs sort last under `desc` on MySQL (the honor route relies on
      // the same). The picker's default is the first 15 in this order.
      orderBy: [{ year: "desc" }, { createdAt: "asc" }],
    }),
    // NOT `ctx.appointments`: the edit context keeps ACTIVE rows only (`endDate` null or in
    // the future), but SciENcv's Appointments and Positions block is the whole career, and the
    // expired rows DO exist (`ED-HISTORICAL`, #1323). Every row, filtered + ordered below.
    db.read.appointment.findMany({
      where: { cwid: generation.cwid },
      select: { externalId: true, title: true, organization: true, startDate: true, endDate: true },
    }),
    // A generation is ONE mode, so the newest draft of the OTHER mode fills the narrative block
    // this one can't — one worksheet instead of two. `null` leaves that block's note in place.
    db.read.biosketchGeneration.findFirst({
      where: {
        cwid: generation.cwid,
        mode: generation.mode === "personal_statement" ? "contributions" : "personal_statement",
      },
      orderBy: { createdAt: "desc" },
      select: { entries: true, createdAt: true },
    }),
  ]);
  if (!ctx) notFound();

  // #536 — a hidden identity class (doctoral student) has no public profile, so only a
  // superuser reaches any of its /edit surfaces; mirrors `/edit/scholar/[cwid]`. A
  // non-superuser — including the scholar themselves — 404s.
  if (!session.isSuperuser && !isPubliclyDisplayed(ctx.scholar.roleCategory)) notFound();

  const isSelf = session.cwid === generation.cwid;
  const backHref = isSelf
    ? "/edit?attr=biosketch"
    : `/edit/scholar/${encodeURIComponent(generation.cwid)}?attr=biosketch`;

  // Only what the profile shows: a hidden row is one the scholar (or an admin) took off the
  // profile, and SciENcv shouldn't get it either.
  const educations = ctx.educations.filter((e) => e.state === "shown");
  // The SAME #160 exclusion the public profile applies (`lib/api/profile.ts`), plus the WOOFA
  // effective-dating artifacts the profile's past-appointments list drops.
  const suppressedAppointmentIds = await loadEntitySuppressions(
    "appointment",
    appointmentRows.map((a) => a.externalId),
    db.read,
  );
  const appointments = appointmentRows
    .filter(
      (a) =>
        !suppressedAppointmentIds.has(a.externalId) &&
        !looksLikeArtifactAppointment(a.startDate, a.endDate) &&
        // Same placeholder drop the profile's past list applies — a "Pre-Start Academic"
        // row is an onboarding artifact, not a position anyone would paste into SciENcv.
        !shouldSuppressPreStart(a.title, appointmentRows.length),
    )
    // SciENcv's reverse-chronological order: current (no end date) first, then most recently
    // ended, then most recently started; an undated start sorts last within its group.
    .sort((a, b) => {
      const ae = a.endDate?.getTime() ?? Infinity;
      const be = b.endDate?.getTime() ?? Infinity;
      if (ae !== be) return be - ae;
      return (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0);
    });

  return (
    <div className="bg-apollo-page min-h-screen">
      <ConsoleTopBar variant="console" showAccountMenu />
      <main className="mx-auto w-full max-w-[var(--max-content)] px-6 py-10">
        <SciencvWorksheet
          cwid={generation.cwid}
          backHref={backHref}
          scholar={{
            preferredName: ctx.scholar.preferredName,
            fullName: ctx.scholar.fullName,
            orcid: ctx.scholar.orcid,
            primaryTitle: ctx.scholar.primaryTitle,
          }}
          educations={educations.map((e) => ({
            degree: e.degree,
            institution: e.institution,
            field: e.field,
            year: e.year,
          }))}
          appointments={appointments.map((a) => ({
            title: a.title,
            organization: a.organization,
            startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
            endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
          }))}
          honors={honors}
          generation={{
            id: generation.id,
            mode: generation.mode,
            entries: generation.entries,
            products: generation.products,
            createdAt: generation.createdAt.toISOString(),
          }}
          otherDraft={
            otherDraft
              ? {
                  entries: coerceEntries(otherDraft.entries),
                  createdAt: otherDraft.createdAt.toISOString(),
                }
              : null
          }
        />
      </main>
    </div>
  );
}
