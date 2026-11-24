/**
 * `/edit/program-roster`: trainees in internal programs and their mentors, kept
 * by the programs' own staff. Nothing here reaches a public surface.
 *
 * Trainee records, some of minors. Audience: superusers and
 * `program_roster_editor` (`lib/edit/program-roster-access.ts`); anyone else,
 * or a dark deployment, gets a 404 before anything is read.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ProgramRoster } from "@/components/edit/program-roster";
import { db } from "@/lib/db";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { canEditProgramRoster, canViewProgramRoster } from "@/lib/edit/program-roster-access";
import { loadProgramRoster } from "@/lib/edit/program-roster.server";
import { resolveEditIdentity } from "@/lib/edit/request";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Program roster — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditProgramRosterPage() {
  const identity = await resolveEditIdentity();
  if (!identity) redirect("/api/auth/saml/login?return=/edit/program-roster");
  const { session, impersonatedCwid } = identity;
  if (!canViewProgramRoster(session)) notFound();

  const [{ programs, entries }, pendingSlugRequests, pendingHonors] = await Promise.all([
    loadProgramRoster(db.read),
    isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell
      active="program-roster"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
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
