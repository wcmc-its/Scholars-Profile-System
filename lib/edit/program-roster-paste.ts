/**
 * Pasting a cohort into the program roster: reading the lines, and checking
 * each against the directory. Pure; the route fetches. A line is ready only
 * when its CWIDs are all in the directory and its name is the directory's name
 * for that CWID, so a wrong CWID is held instead of filed under someone else.
 */
import { isCwid } from "@/lib/cwid";
import { parseEntryInput, type EntryInput, type PasteRowView } from "@/lib/edit/program-roster";
import type { DirectoryPerson } from "@/lib/sources/ldap";

export type PasteLine = {
  raw: string;
  name: string;
  cwid: string;
  year: string;
  mentorCwids: string[];
  researchProgram: string;
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

const cwidList = (cell: string) => [...new Set(cell.toLowerCase().split(/[;,\s]+/).filter(Boolean))];
/** Commas outside quotes. */
const COMMA = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;

/** name, CWID, year, mentor CWIDs, research program: tabs (Excel), else commas. */
export function parsePaste(text: string, thisYear: number): PasteLine[] {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
  return lines.flatMap((raw, i) => {
    const cells = raw.split(raw.includes("\t") ? "\t" : COMMA).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    // A header row: a label where the CWID goes, and no data beside it.
    if (i === 0 && /\bcwid\b/i.test(cells[1] ?? "") && !/\d/.test(`${cells[1]}${cells[2] ?? ""}`)) return [];
    const [name = "", cwid = "", year = "", mentorCell = "", researchProgram = "", ...extra] = cells;
    const mentorCwids = cwidList(mentorCell);
    const line = { raw, name, cwid: cwid.toLowerCase(), year, mentorCwids, researchProgram };
    const parsed = parseEntryInput(
      { menteeCwid: cwid, year: /^\d{4}$/.test(year) ? Number(year) : null, researchProgram, mentorCwids },
      thisYear,
    );
    // An odd quote is half of a cell with a line break in it; the rest is on the next line.
    const problem = (raw.split('"').length - 1) % 2 === 1
      ? "A cell is split across lines. Put it on one line, without quotes"
      : extra.some(Boolean)
      ? "Too many columns"
      : !name
        ? "No name"
        : parsed.ok
          ? null
          : (PROBLEM[`${parsed.error}:${parsed.field}`] ?? PROBLEM[parsed.error] ?? "This line could not be read");
    return [{ ...line, input: problem === null && parsed.ok ? parsed.value : null, problem }];
  });
}

/** Every CWID-like word in the line, the research program's included: a second
 *  mentor pasted one column over must not be saved as a research program. */
export const cwidsToLookUp = (l: PasteLine): string[] =>
  l.input ? [l.input.menteeCwid, ...l.input.mentorCwids, ...strayCwids(l)] : [];
const strayCwids = (l: PasteLine) => cwidList(l.researchProgram).filter(isCwid);

const HONORIFIC = /^(dr|prof|mr|mrs|ms|mx)$/;
const DEGREE = /^(md|phd|mph|msc|mba|ms|rn|pharmd|dds|dvm)$/;

/** A name's words: accents, case, punctuation, honorifics and degrees folded,
 *  "Last, First" flipped. Never drops a word that could be a surname. */
function words(name: string): string[] {
  const [first = [], second = []] = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(",")
    .map((part) => part.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean))
    .filter((part) => part.length > 0 && !part.every((w) => DEGREE.test(w)));
  const out = [...second, ...first];
  if (out.length > 2 && HONORIFIC.test(out[0])) out.shift();
  while (out.length > 2 && DEGREE.test(out[out.length - 1])) out.pop();
  return out;
}

/** Whether `pasted` names `p`: the same name, or the same first and last words
 *  (middle names aside). Nicknames, bare initials and "Jr" against "Sr" do not
 *  agree; the line is held. */
export function nameAgrees(pasted: string, p: DirectoryPerson): boolean {
  const a = words(pasted);
  if (a.length === 0) return false;
  return [p.name, [p.firstName, p.lastName].filter(Boolean).join(" ")].some((n) => {
    const b = words(n);
    if (a.join(" ") === b.join(" ")) return true;
    return a.length > 1 && b.length > 1 && a[0].length > 1 && a[0] === b[0] && a.at(-1) === b.at(-1);
  });
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
    const stray = strayCwids(l).filter((c) => people.has(c));
    if (stray.length > 0) return `${stray.join(", ")} is in the research program column. Put every mentor in the fourth column, separated by ;`;
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
      researchProgram: l.researchProgram,
      mentors: l.mentorCwids.map((c) => ({ cwid: c, name: nameFor(c) ?? c })),
      held,
    };
  });
}
