/**
 * The internal program roster: shared types and input checks. Pure, so both
 * the client component and the route use it. Access: `program-roster-access.ts`.
 */
import { CWID_PATTERN } from "@/lib/cwid";

export type RosterPerson = { cwid: string; name: string };

export type RosterProgramView = {
  id: string;
  name: string;
  shortLabel: string;
  description: string | null;
  /** ISO date, or null while open. */
  retiredAt: string | null;
};

export type RosterEntryView = {
  id: string;
  programId: string;
  mentee: RosterPerson;
  year: number;
  researchProgram: string | null;
  mentors: RosterPerson[];
};

export type ProgramInput = { name: string; shortLabel: string; description: string | null };

export type EntryInput = {
  menteeCwid: string;
  year: number;
  researchProgram: string | null;
  mentorCwids: string[];
};

export const PROGRAM_NAME_MAX = 255;
export const SHORT_LABEL_MAX = 32;
export const DESCRIPTION_MAX = 1000;
export const RESEARCH_PROGRAM_MAX = 255;
export const MAX_MENTORS = 10;
const MIN_YEAR = 1990;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; field: string };
const bad = (error: string, field: string) => ({ ok: false as const, error, field });

/** Trimmed text, null when blank; undefined when it is not text or too long. */
function text(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length > max ? undefined : s || null;
}

export function parseProgramInput(body: Record<string, unknown>): Parsed<ProgramInput> {
  const name = text(body.name, PROGRAM_NAME_MAX);
  if (!name) return bad("invalid_name", "name");
  const shortLabel = text(body.shortLabel, SHORT_LABEL_MAX);
  if (!shortLabel) return bad("invalid_short_label", "shortLabel");
  const description = text(body.description, DESCRIPTION_MAX);
  if (description === undefined) return bad("invalid_description", "description");
  return { ok: true, value: { name, shortLabel, description } };
}

/** `thisYear` caps the year at next year, so a typo cannot land in 2206. */
export function parseEntryInput(body: Record<string, unknown>, thisYear: number): Parsed<EntryInput> {
  const cwid = (v: unknown) => {
    const s = typeof v === "string" ? v.trim().toLowerCase() : "";
    return CWID_PATTERN.test(s) ? s : null;
  };
  const menteeCwid = cwid(body.menteeCwid);
  if (!menteeCwid) return bad("invalid_cwid", "menteeCwid");
  const year = body.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year < MIN_YEAR || year > thisYear + 1) {
    return bad("invalid_year", "year");
  }
  const researchProgram = text(body.researchProgram, RESEARCH_PROGRAM_MAX);
  if (researchProgram === undefined) return bad("invalid_research_program", "researchProgram");
  const raw = Array.isArray(body.mentorCwids) ? body.mentorCwids.map(cwid) : [];
  if (raw.includes(null)) return bad("invalid_cwid", "mentorCwids");
  const mentorCwids = [...new Set(raw as string[])];
  if (mentorCwids.length === 0) return bad("mentor_required", "mentorCwids");
  if (mentorCwids.length > MAX_MENTORS) return bad("too_many_mentors", "mentorCwids");
  if (mentorCwids.includes(menteeCwid)) return bad("mentor_is_mentee", "mentorCwids");
  return { ok: true, value: { menteeCwid, year, researchProgram, mentorCwids } };
}
