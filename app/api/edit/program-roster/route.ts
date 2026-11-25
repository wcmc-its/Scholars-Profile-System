/**
 * /api/edit/program-roster: every write to the internal program roster.
 *
 *   POST { action: "program_create", name, shortLabel, description? }
 *   POST { action: "program_update", id, name, shortLabel, description? }
 *   POST { action: "program_retire" | "program_reopen" | "program_delete", id }
 *   POST { action: "entry_create", programId, menteeCwid, year, mentorCwids, researchProgram? }
 *   POST { action: "entry_update", id, year, mentorCwids, researchProgram? }
 *   POST { action: "entry_delete", id }
 *   POST { action: "paste_check" | "paste_save", programId, text }
 *
 * Gate: `canEditProgramRoster`, checked before anything is read. 404, not 403,
 * so a caller without the role cannot tell the surface exists.
 *
 * Names are the directory's, never the caller's: a CWID the directory does not
 * have is refused, and if it cannot be reached nothing is saved. On update a
 * person already on the entry keeps the name stored with them, so an entry
 * stays editable after someone leaves the directory.
 *
 * Each write is one transaction with its audit row (CWIDs only, no names).
 * `paste_check` saves nothing. `paste_save` re-checks every line it is sent and
 * saves all of them or none, so a line that stopped matching is never saved.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow, type AuditAction, type AuditEntityType } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { directoryDisplayName } from "@/lib/edit/directory-names";
import { MAX_PASTE_ROWS, parseEntryInput, parseProgramInput, type EntryInput } from "@/lib/edit/program-roster";
import { canEditProgramRoster } from "@/lib/edit/program-roster-access";
import { checkPaste, cwidsToLookUp, parsePaste } from "@/lib/edit/program-roster-paste";
import { entryView, programView, type EntryRow } from "@/lib/edit/program-roster.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { fetchDirectoryPeopleByCwid, type DirectoryPerson } from "@/lib/sources/ldap";

const PATH = "/api/edit/program-roster";
/** A full paste is a few hundred statements; Prisma's default is 5s. */
const PASTE_TX = { maxWait: 5_000, timeout: 25_000 } as const;

/** A refusal raised inside a transaction, so the transaction rolls back. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field?: string,
  ) {
    super(code);
  }
}

const prismaCode = (err: unknown) => (err as { code?: string } | null)?.code;

const programValues = (p: { name: string; shortLabel: string; description: string | null; retiredAt: Date | null }) => ({
  name: p.name,
  shortLabel: p.shortLabel,
  description: p.description,
  retired: p.retiredAt !== null,
});
const entryValues = (e: EntryRow) => ({
  programId: e.programId,
  menteeCwid: e.menteeCwid,
  year: e.year,
  researchProgram: e.researchProgram,
  mentorCwids: e.mentors.map((m) => m.mentorCwid).sort(),
});

/** The name the people search shows ("Avery J. Quill"), so what is saved is what
 *  was picked; null when the directory has only the CWID. */
function storedName(p: DirectoryPerson): string | null {
  const name = p.name?.trim();
  return name && name.toLowerCase() !== p.cwid.toLowerCase() ? name : directoryDisplayName(p);
}

/** CWID → directory person. Throws when the directory cannot be reached. */
async function directoryPeople(cwids: string[]): Promise<Map<string, DirectoryPerson>> {
  return new Map((await fetchDirectoryPeopleByCwid(cwids)).map((p) => [p.cwid.toLowerCase(), p]));
}

/** CWID → directory name. Throws when the directory cannot be reached. */
async function directoryNames(cwids: string[]): Promise<Map<string, string>> {
  return namesOf(await directoryPeople(cwids));
}

function namesOf(people: ReadonlyMap<string, DirectoryPerson>): Map<string, string> {
  return new Map([...people].flatMap(([c, p]) => {
    const name = storedName(p);
    return name ? [[c, name] as const] : [];
  }));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (!canEditProgramRoster(session, impersonatedCwid)) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: "program-roster", path: PATH, reason: "not_roster_editor" });
    return editError(404, "not_found");
  }

  const audit = (
    tx: Parameters<typeof appendAuditRow>[0],
    targetEntityType: Extract<AuditEntityType, "roster_program" | "roster_entry">,
    targetEntityId: string,
    beforeValues: Record<string, unknown> | null,
    afterValues: Record<string, unknown> | null,
  ) =>
    appendAuditRow(tx, {
      actorCwid: realCwid,
      impersonatedCwid,
      targetEntityType,
      targetEntityId,
      action: `${targetEntityType}_change` satisfies AuditAction,
      fieldsChanged: null,
      beforeValues,
      afterValues,
      ts: new Date(),
      requestId,
    });

  type Tx = Parameters<Parameters<typeof db.write.$transaction>[0]>[0];

  const requireOpenProgram = async (tx: Pick<Tx, "rosterProgram">, programId: string) => {
    const program = await tx.rosterProgram.findUnique({ where: { id: programId } });
    if (!program) throw new Refused(404, "program_not_found", "programId");
    if (program.retiredAt) throw new Refused(409, "program_retired", "programId");
  };

  /** `names` must hold every CWID in `input`. */
  const createEntry = async (tx: Tx, programId: string, input: EntryInput, names: ReadonlyMap<string, string>) => {
    const row = await tx.rosterEntry.create({
      data: {
        programId,
        menteeCwid: input.menteeCwid,
        menteeName: names.get(input.menteeCwid)!,
        year: input.year,
        researchProgram: input.researchProgram,
        createdBy: realCwid,
        mentors: { create: input.mentorCwids.map((c) => ({ mentorCwid: c, mentorName: names.get(c)! })) },
      },
      ...withMentors,
    });
    await audit(tx, "roster_entry", row.id, null, entryValues(row));
    return row;
  };

  const action = body.action;
  const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64 ? body.id : null;
  const withMentors = { include: { mentors: true } } as const;

  try {
    if (action === "program_create" || action === "program_update") {
      const parsed = parseProgramInput(body);
      if (!parsed.ok) return editError(400, parsed.error, parsed.field);
      if (action === "program_update" && !id) return editError(400, "invalid_id", "id");
      const program = await db.write.$transaction(async (tx) => {
        const before = id && action === "program_update" ? await tx.rosterProgram.findUnique({ where: { id } }) : null;
        if (action === "program_update" && !before) throw new Refused(404, "program_not_found", "id");
        const row = before
          ? await tx.rosterProgram.update({ where: { id: before.id }, data: parsed.value })
          : await tx.rosterProgram.create({ data: { ...parsed.value, createdBy: realCwid } });
        await audit(tx, "roster_program", row.id, before && programValues(before), programValues(row));
        return row;
      });
      return editOk({ program: programView(program) });
    }

    if (action === "program_retire" || action === "program_reopen" || action === "program_delete") {
      if (!id) return editError(400, "invalid_id", "id");
      const program = await db.write.$transaction(async (tx) => {
        const before = await tx.rosterProgram.findUnique({ where: { id } });
        if (!before) throw new Refused(404, "program_not_found", "id");
        if (action === "program_delete") {
          // The FK is RESTRICT too (P2003 below), so a race cannot orphan an entry.
          if ((await tx.rosterEntry.count({ where: { programId: id } })) > 0) {
            throw new Refused(409, "program_not_empty", "id");
          }
          await tx.rosterProgram.delete({ where: { id } });
          await audit(tx, "roster_program", id, programValues(before), null);
          return null;
        }
        const row = await tx.rosterProgram.update({
          where: { id },
          data: { retiredAt: action === "program_retire" ? new Date() : null },
        });
        await audit(tx, "roster_program", id, programValues(before), programValues(row));
        return row;
      });
      return editOk(program ? { program: programView(program) } : { deletedId: id });
    }

    if (action === "entry_create") {
      if (typeof body.programId !== "string" || !body.programId || body.programId.length > 64) {
        return editError(400, "invalid_program", "programId");
      }
      const programId = body.programId;
      const parsed = parseEntryInput(body, new Date().getUTCFullYear());
      if (!parsed.ok) return editError(400, parsed.error, parsed.field);
      const { menteeCwid, mentorCwids } = parsed.value;
      const names = await directoryNames([menteeCwid, ...mentorCwids]);
      if (!names.has(menteeCwid)) return editError(400, "not_in_directory", "menteeCwid");
      if (mentorCwids.some((c) => !names.has(c))) return editError(400, "not_in_directory", "mentorCwids");
      const entry = await db.write.$transaction(async (tx) => {
        await requireOpenProgram(tx, programId);
        return createEntry(tx, programId, parsed.value, names);
      });
      return editOk({ entry: entryView(entry) });
    }

    if (action === "entry_update") {
      if (!id) return editError(400, "invalid_id", "id");
      const existing = await db.write.rosterEntry.findUnique({ where: { id }, ...withMentors });
      if (!existing) return editError(404, "entry_not_found", "id");
      const parsed = parseEntryInput({ ...body, menteeCwid: existing.menteeCwid }, new Date().getUTCFullYear());
      if (!parsed.ok) return editError(400, parsed.error, parsed.field);
      const { mentorCwids, year, researchProgram } = parsed.value;
      const names = new Map(existing.mentors.map((m) => [m.mentorCwid.toLowerCase(), m.mentorName]));
      const added = mentorCwids.filter((c) => !names.has(c));
      if (added.length > 0) {
        for (const [c, n] of await directoryNames(added)) names.set(c, n);
        if (added.some((c) => !names.has(c))) return editError(400, "not_in_directory", "mentorCwids");
      }
      const entry = await db.write.$transaction(async (tx) => {
        const before = await tx.rosterEntry.findUnique({ where: { id }, ...withMentors });
        if (!before) throw new Refused(404, "entry_not_found", "id");
        const row = await tx.rosterEntry.update({
          where: { id },
          data: {
            year,
            researchProgram,
            mentors: {
              deleteMany: {},
              create: mentorCwids.map((c) => ({ mentorCwid: c, mentorName: names.get(c)! })),
            },
          },
          ...withMentors,
        });
        await audit(tx, "roster_entry", id, entryValues(before), entryValues(row));
        return row;
      });
      return editOk({ entry: entryView(entry) });
    }

    if (action === "entry_delete") {
      if (!id) return editError(400, "invalid_id", "id");
      await db.write.$transaction(async (tx) => {
        const before = await tx.rosterEntry.findUnique({ where: { id }, ...withMentors });
        if (!before) throw new Refused(404, "entry_not_found", "id");
        await tx.rosterEntry.delete({ where: { id } });
        await audit(tx, "roster_entry", id, entryValues(before), null);
      });
      return editOk({ deletedId: id });
    }

    if (action === "paste_check" || action === "paste_save") {
      if (typeof body.programId !== "string" || !body.programId || body.programId.length > 64) {
        return editError(400, "invalid_program", "programId");
      }
      const programId = body.programId;
      const lines = parsePaste(typeof body.text === "string" ? body.text : "", new Date().getUTCFullYear());
      if (lines.length === 0) return editError(400, "empty_paste", "text");
      if (lines.length > MAX_PASTE_ROWS) return editError(400, "too_many_rows", "text");
      await requireOpenProgram(db.write, programId);

      const inputs = lines.flatMap((l) => (l.input ? [l.input] : []));
      const people = await directoryPeople([...new Set(lines.flatMap(cwidsToLookUp))]);
      const listed = await db.write.rosterEntry.findMany({
        where: { programId, menteeCwid: { in: inputs.map((e) => e.menteeCwid) } },
        select: { menteeCwid: true, year: true },
      });
      const rows = checkPaste(
        lines,
        people,
        storedName,
        new Set(listed.map((e) => `${e.menteeCwid.toLowerCase()}|${e.year}`)),
      );
      if (action === "paste_check") return editOk({ rows });
      if (rows.some((r) => r.held !== null)) return editError(409, "paste_changed", "text");

      const names = namesOf(people);
      const saved = await db.write.$transaction(async (tx) => {
        await requireOpenProgram(tx, programId);
        const out: EntryRow[] = [];
        for (const input of inputs) out.push(await createEntry(tx, programId, input, names));
        return out;
      }, PASTE_TX);
      return editOk({ entries: saved.map(entryView) });
    }

    return editError(400, "invalid_action", "action");
  } catch (err) {
    if (err instanceof Refused) return editError(err.status, err.code, err.field);
    if (prismaCode(err) === "P2002") {
      return editError(409, String(action).startsWith("program") ? "label_taken" : "already_listed");
    }
    // The program gained an entry, or went away, between the check and the write.
    if (prismaCode(err) === "P2003") {
      return editError(409, action === "program_delete" ? "program_not_empty" : "program_not_found");
    }
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
