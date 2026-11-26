/**
 * `/edit/center/meyer_cancer_center/program-roster`: trainees in the cancer
 * center's internal programs and their mentors, kept by the programs' own
 * staff. Nothing here reaches a public surface. No console tab: linked from the
 * center's editor page. Any other center code is a 404, and the center's own
 * Owners and Curators get nothing from the path: access is the role below.
 *
 * Trainee records, some of minors. Audience: superusers and
 * `program_roster_editor` (`lib/edit/program-roster-access.ts`); anyone else,
 * or a dark deployment, gets a 404 before anything is read.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ProgramRoster } from "@/components/edit/program-roster";
import { db } from "@/lib/db";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  canEditProgramRoster,
  canViewProgramRoster,
  PROGRAM_ROSTER_CENTER,
  PROGRAM_ROSTER_PATH,
} from "@/lib/edit/program-roster-access";
import { loadProgramRoster } from "@/lib/edit/program-roster.server";
import { resolveEditIdentity } from "@/lib/edit/request";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Program roster — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditProgramRosterPage({ params }: { params: Promise<{ code: string }> }) {
  if ((await params).code !== PROGRAM_ROSTER_CENTER) notFound();
  const identity = await resolveEditIdentity();
  if (!identity) redirect(`/api/auth/saml/login?return=${PROGRAM_ROSTER_PATH}`);
  const { session, impersonatedCwid } = identity;
  if (!canViewProgramRoster(session)) notFound();

  const [{ programs, entries }, center, pendingSlugRequests, pendingHonors] = await Promise.all([
    loadProgramRoster(db.read),
    // The way back, only for someone the center's page will open for.
    session.isSuperuser ||
    (await db.read.unitAdmin.findFirst({
      where: { cwid: session.cwid, entityType: "center", entityId: PROGRAM_ROSTER_CENTER },
      select: { cwid: true },
    }))
      ? db.read.center.findUnique({ where: { code: PROGRAM_ROSTER_CENTER }, select: { name: true } })
      : Promise.resolve(null),
    isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell
      active="self"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      {center && (
        <Link
          href={`/edit/center/${PROGRAM_ROSTER_CENTER}`}
          className="text-apollo-slate mb-2 inline-block text-[13px] hover:underline"
        >
          &larr; {center.name}
        </Link>
      )}
      <h1 className="text-[30px] leading-tight font-semibold tracking-[-.01em]">Program roster</h1>
      <p className="text-muted-foreground mt-2.5 mb-6 max-w-[86ch] text-[14.5px] leading-normal">
        Trainees and mentors in internal programs. Nothing here appears on a public profile.
      </p>
      <ProgramRoster
        programs={programs}
        entries={entries}
        canEdit={canEditProgramRoster(session, impersonatedCwid)}
      />
    </ConsoleShell>
  );
}
