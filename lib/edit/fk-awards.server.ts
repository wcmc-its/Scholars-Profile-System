/**
 * Report 21 loader: every F or K grant row, the center's research memberships
 * and programs, the four mentor tables for the award holders, and the names
 * of everyone involved, handed to `computeFkAwards`. The caller has passed
 * the unit gate. Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import {
  computeFkAwards,
  type FkAwards,
  type FkAwardsParams,
  type FkMentorLink,
} from "@/lib/edit/fk-awards";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function loadFkAwards(centerCode: string, params: FkAwardsParams): Promise<FkAwards> {
  const [grants, memberships, programs] = await Promise.all([
    db.read.grant.findMany({
      where: { OR: [{ mechanism: { startsWith: "F" } }, { mechanism: { startsWith: "K" } }] },
      select: {
        cwid: true,
        role: true,
        mechanism: true,
        awardNumber: true,
        externalId: true,
        title: true,
        startDate: true,
        endDate: true,
      },
    }),
    db.read.centerMembership.findMany({
      where: { centerCode, membershipType: "research" },
      select: { cwid: true, programCode: true, startDate: true, endDate: true },
    }),
    db.read.centerProgram.findMany({ where: { centerCode }, select: { code: true, label: true } }),
  ]);
  const holders = [...new Set(grants.map((g) => g.cwid))];
  const [phd, postdoc, aoc, frt] = await Promise.all([
    db.read.phdMentorRelationship.findMany({
      where: { menteeCwid: { in: holders } },
      select: { mentorCwid: true, menteeCwid: true },
    }),
    db.read.postdocMentorRelationship.findMany({
      where: { menteeCwid: { in: holders } },
      select: { mentorCwid: true, menteeCwid: true },
    }),
    db.read.aocMentee.findMany({
      where: { menteeCwid: { in: holders } },
      select: { mentorCwid: true, menteeCwid: true },
    }),
    db.read.frtMentee.findMany({
      where: { menteeCwid: { in: holders }, dismissedAt: null },
      select: { mentorCwid: true, menteeCwid: true },
    }),
  ]);
  const links: FkMentorLink[] = [
    ...phd.map((l) => ({ ...l, source: "PhD" as const })),
    ...postdoc.map((l) => ({ ...l, source: "postdoc" as const })),
    ...aoc.map((l) => ({ ...l, source: "AOC" as const })),
    ...frt.map((l) => ({
      mentorCwid: l.mentorCwid,
      menteeCwid: l.menteeCwid!,
      source: "FRT" as const,
    })),
  ];
  const people = await db.read.scholar.findMany({
    where: { cwid: { in: [...new Set([...holders, ...memberships.map((m) => m.cwid)])] } },
    select: { cwid: true, preferredName: true, roleCategory: true },
  });
  return computeFkAwards({
    grants: grants.map((g) => ({ ...g, startDate: day(g.startDate)!, endDate: day(g.endDate)! })),
    memberships: memberships.map((m) => ({
      ...m,
      startDate: day(m.startDate),
      endDate: day(m.endDate),
    })),
    links,
    people: people.map((s) => ({
      cwid: s.cwid,
      name: s.preferredName,
      roleCategory: s.roleCategory,
    })),
    programs,
    params,
  });
}
