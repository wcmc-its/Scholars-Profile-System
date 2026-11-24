/** The program roster's reads and row shaping (server only). */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { RosterEntryView, RosterProgramView } from "@/lib/edit/program-roster";

type ProgramRow = {
  id: string;
  name: string;
  shortLabel: string;
  description: string | null;
  retiredAt: Date | null;
};
export type EntryRow = {
  id: string;
  programId: string;
  menteeCwid: string;
  menteeName: string;
  year: number;
  researchProgram: string | null;
  mentors: Array<{ mentorCwid: string; mentorName: string }>;
};

export const programView = (p: ProgramRow): RosterProgramView => ({
  id: p.id,
  name: p.name,
  shortLabel: p.shortLabel,
  description: p.description,
  retiredAt: p.retiredAt?.toISOString() ?? null,
});

export const entryView = (e: EntryRow): RosterEntryView => ({
  id: e.id,
  programId: e.programId,
  mentee: { cwid: e.menteeCwid, name: e.menteeName },
  year: e.year,
  researchProgram: e.researchProgram,
  mentors: e.mentors
    .map((m) => ({ cwid: m.mentorCwid, name: m.mentorName }))
    .sort((a, b) => a.name.localeCompare(b.name)),
});

/** Every program and entry. The caller has already passed `canViewProgramRoster`.
 *  ponytail: whole tables; a few hundred rows. Page it past a few thousand. */
export async function loadProgramRoster(
  client: Pick<PrismaClient, "rosterProgram" | "rosterEntry">,
): Promise<{ programs: RosterProgramView[]; entries: RosterEntryView[] }> {
  const [programs, entries] = await Promise.all([
    client.rosterProgram.findMany({ orderBy: { shortLabel: "asc" } }),
    client.rosterEntry.findMany({
      orderBy: [{ year: "desc" }, { menteeName: "asc" }],
      include: { mentors: true },
    }),
  ]);
  return { programs: programs.map(programView), entries: entries.map(entryView) };
}
