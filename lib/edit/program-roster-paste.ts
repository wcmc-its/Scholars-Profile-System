/**
 * Pasting a cohort into the program roster: reading the lines, and checking
 * each against the directory. Pure; the route fetches. A line is ready only
 * when its CWIDs are all in the directory and its name is the directory's name
 * for that CWID, so a wrong CWID is held instead of filed under someone else.
 */
import {
  parseEntryInput,
  type EntryInput,
  type PasteRowView,
} from "@/lib/edit/program-roster";
import { frtNameKey } from "@/lib/frt/mentee-name";
import type { DirectoryPerson } from "@/lib/sources/ldap";

export type PasteLine = {
  raw: string;
  name: string;
  cwid: string;
  year: string;
  mentorCwids: string[];
  /** The checked input, or why it cannot be one. */
  input: EntryInput | null;
  problem: string | null;
};

const PROBLEM: Record<string, string> = {
  "invalid_cwid:menteeCwid": "The second column is not a CWID",
  "invalid_cwid:mentorCwids": "The fourth column should hold mentor CWIDs only",
  invalid_year: "The year is not valid",
  invalid_research_program: "The research program is too long",
  mentor_required: "No mentor CWID",
  too_many_mentors: "Too many mentors",
  mentor_is_mentee: "The person is listed as their own mentor",
};

/** name, CWID, year, mentor CWIDs, research program: tabs (Excel), else commas. */
export function parsePaste(text: string, thisYear: number): PasteLine[] {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
  return lines.flatMap((raw, i) => {
    const cells = raw.split(raw.includes("\t") ? "\t" : ",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    if (i === 0 && /\bcwid\b/i.test(cells[1] ?? "")) return []; // a header row
    const [name = "", cwid = "", year = "", mentorCell = "", researchProgram = "", ...extra] = cells;
    const mentorCwids = [...new Set(mentorCell.toLowerCase().split(/[;,\s]+/).filter(Boolean))];
    const line = { raw, name, cwid: cwid.toLowerCase(), year, mentorCwids };
    const parsed = parseEntryInput(
      { menteeCwid: cwid, year: /^\d{4}$/.test(year) ? Number(year) : null, researchProgram, mentorCwids },
      thisYear,
    );
    const problem = extra.some(Boolean)
      ? "Too many columns"
      : !name
        ? "No name"
        : parsed.ok
          ? null
          : (PROBLEM[`${parsed.error}:${parsed.field}`] ?? PROBLEM[parsed.error] ?? "This line could not be read");
    return [{ ...line, input: problem === null && parsed.ok ? parsed.value : null, problem }];
  });
}

/** "Last, First" as "First Last"; accents, case and punctuation folded. */
const fold = (name: string) => {
  const [last, first] = name.split(",");
  return (first?.trim() ? `${first} ${last}` : name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
};

/** Whether `pasted` names `p`: the same name, or the same first and last name
 *  (middle names aside). Nicknames do not count; the line is held. */
export function nameAgrees(pasted: string, p: DirectoryPerson): boolean {
  const key = frtNameKey(pasted);
  return [p.name, [p.firstName, p.lastName].filter(Boolean).join(" ")].some(
    (n) => fold(n) !== "" && (fold(n) === fold(pasted) || (key !== null && frtNameKey(n) === key)),
  );
}

/**
 * Every line, ready or held with its reason. `nameOf` is the name a save would
 * store (null when the directory has only the CWID). `listed` holds
 * `cwid|year` for entries already in the program.
 */
export function checkPaste(
  lines: readonly PasteLine[],
  people: ReadonlyMap<string, DirectoryPerson>,
  nameOf: (p: DirectoryPerson) => string | null,
  listed: ReadonlySet<string>,
): PasteRowView[] {
  const seen = new Set<string>();
  const nameFor = (cwid: string) => {
    const p = people.get(cwid);
    return p ? nameOf(p) : null;
  };
  const why = (l: PasteLine): string | null => {
    if (l.input === null) return l.problem;
    const person = people.get(l.input.menteeCwid);
    const name = nameFor(l.input.menteeCwid);
    if (!person || !name) return "This CWID is not in the directory";
    if (!nameAgrees(l.name, person)) return `The directory has ${name} for this CWID`;
    const unknown = l.input.mentorCwids.filter((c) => !nameFor(c));
    if (unknown.length > 0) return `Mentor CWID not in the directory: ${unknown.join(", ")}`;
    const key = `${l.input.menteeCwid}|${l.input.year}`;
    if (listed.has(key)) return "Already listed in this program for that year";
    if (seen.has(key)) return "On an earlier line for that year. Put every mentor on one line";
    seen.add(key);
    return null;
  };
  return lines.map((l) => {
    const held = why(l);
    return {
      raw: l.raw,
      // A held line shows what was pasted, so it can be found and fixed.
      person: { cwid: l.cwid, name: (held === null && nameFor(l.cwid)) || l.name },
      year: l.year,
      mentors: l.mentorCwids.map((c) => ({ cwid: c, name: nameFor(c) ?? c })),
      held,
    };
  });
}
