/**
 * `/edit/biosketch/worksheet?id=<generationId>` — the SciENcv worksheet for one saved biosketch
 * generation (#2652). Server Component: resolves the generation, authorizes on the row's OWN
 * `cwid` with the same predicate the generations GET and the generate route use
 * (`authorizeOverviewWrite`: self / superuser / granted proxy / unit admin), then loads the
 * scholar's edit context for the identity, education and appointment blocks plus the published,
 * profile-visible honors, and hands everything to the client worksheet.
 *
 * Flag-gated like the generations GET (`EDIT_BIOSKETCH_GENERATE` off ⇒ 404). Reads only —
 * nothing on the page writes. `force-dynamic` + `noindex`, mirroring the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SciencvWorksheet } from "@/components/edit/sciencv-worksheet";
import { loadEditContext } from "@/lib/api/edit-context";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import { getBiosketchGeneration } from "@/lib/edit/biosketch-provenance";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

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
    return (
      <div className="bg-apollo-page min-h-screen">
        <ConsoleTopBar variant="console" />
        <ForbiddenEditPage targetCwid={generation.cwid} />
      </div>
    );
  }

  const [ctx, honors] = await Promise.all([
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
  ]);
  if (!ctx) notFound();

  const isSelf = session.cwid === generation.cwid;
  const backHref = isSelf
    ? "/edit?attr=biosketch"
    : `/edit/scholar/${encodeURIComponent(generation.cwid)}?attr=biosketch`;

  // Only what the profile shows: a hidden row is one the scholar (or an admin) took off the
  // profile, and SciENcv shouldn't get it either. `locked` (a current chair) is shown.
  const educations = ctx.educations.filter((e) => e.state === "shown");
  const appointments = [...ctx.appointments]
    .filter((a) => a.state === "shown" || a.state === "locked")
    // Reverse chronological by start date — SciENcv's order — undated last.
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));

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
            startDate: a.startDate,
            endDate: a.endDate,
          }))}
          honors={honors}
          generation={{
            id: generation.id,
            mode: generation.mode,
            entries: generation.entries,
            products: generation.products,
            createdAt: generation.createdAt.toISOString(),
          }}
        />
      </main>
    </div>
  );
}
