/** Reading a pasted cohort, holding what does not match, and the mentor counts. */
import { describe, expect, it } from "vitest";

import { filterEntries, mentorCounts, milestoneOf, type RosterEntryView } from "@/lib/edit/program-roster";
import { checkPaste, nameAgrees, parsePaste } from "@/lib/edit/program-roster-paste";
import type { DirectoryPerson } from "@/lib/sources/ldap";

const person = (cwid: string, name: string, firstName: string | null = null, lastName: string | null = null): DirectoryPerson => ({
  cwid,
  name,
  firstName,
  lastName,
  title: null,
  dept: null,
  email: null,
});
const PEOPLE = new Map(
  [person("tra001", "Avery J. Quill", "Avery", "Quill"), person("men001", "Jordan Vale"), person("men002", "Emery Stone")].map(
    (p) => [p.cwid, p],
  ),
);
const nameOf = (p: DirectoryPerson) => (p.name === p.cwid ? null : p.name);
const held = (text: string, listed: string[] = []) =>
  checkPaste(parsePaste(text, 2026), PEOPLE, nameOf, new Set(listed)).map((r) => r.held);

describe("parsePaste", () => {
  it("reads Excel rows and comma rows, skips a header and blank lines", () => {
    const [a, b] = parsePaste(
      "Name\tCWID\tYear\tMentors\r\n\r\n\"Avery Quill\"\tTRA001\t2026\tmen001; MEN002 men001\tCancer  Biology\t\t\nAvery Quill, tra001, 2025, men001",
      2026,
    );
    expect(a.input).toEqual({ menteeCwid: "tra001", year: 2026, researchProgram: "Cancer Biology", mentorCwids: ["men001", "men002"] });
    expect(a.name).toBe("Avery Quill");
    expect(b.input).toMatchObject({ year: 2025, mentorCwids: ["men001"], researchProgram: null });
  });

  it.each([
    ["Avery Quill\t\t2026\tmen001", "The second column is not a CWID"],
    ["Avery Quill\ttra001\t26\tmen001", "The year is not valid"],
    ["Avery Quill\ttra001\t2206\tmen001", "The year is not valid"],
    ["Avery Quill\ttra001\t2026\t", "No mentor CWID"],
    ["Avery Quill\ttra001\t2026\t(men001)", "The fourth column should hold mentor CWIDs only"],
    ["Avery Quill\ttra001\t2026\ttra001", "The person is listed as their own mentor"],
    ["\ttra001\t2026\tmen001", "No name"],
    ["Avery Quill\ttra001\t2026\tmen001\tCB\textra", "Too many columns"],
    ["Avery Quill, tra001, 2026, men001, men002", expect.stringMatching(/^men002 is in the research program column/)],
    ["Avery Quill\ttra001\t2026\tmen001\tMEN002", expect.stringMatching(/^men002 is in the research program column/)],
    ["CWID: Avery\tCWID: tra001\t2026\tmen001", "The second column is not a CWID"],
    ["Quill, Avery, tra001, 2026, men001", "The year is not valid"],
  ])("holds %j", (text, why) => expect(held(text)).toEqual([why]));
});

describe("parsePaste quoting", () => {
  it("holds both halves of a cell with a line break", () => {
    expect(held('Avery Quill\ttra001\t2026\tmen001\t"Cancer\nBiology"')).toEqual([
      expect.stringMatching(/split across lines/),
      expect.stringMatching(/split across lines/),
    ]);
  });

  it("keeps a quoted comma inside its cell", () => {
    const [l] = parsePaste('Avery Quill,tra001,2026,men001,"Cancer, Stem Cell"', 2026);
    expect(l.input).toMatchObject({ mentorCwids: ["men001"], researchProgram: "Cancer, Stem Cell" });
  });

  it("a research program that is an ordinary word is not mistaken for a CWID", () => {
    expect(held("Avery Quill\ttra001\t2026\tmen001\timmunology")).toEqual([null]);
  });
});

describe("checkPaste", () => {
  it("is ready when every CWID is in the directory and the name agrees, and shows the directory's name", () => {
    const [r] = checkPaste(parsePaste("avery quill\ttra001\t2026\tmen001", 2026), PEOPLE, nameOf, new Set());
    expect(r).toMatchObject({ held: null, person: { cwid: "tra001", name: "Avery J. Quill" }, mentors: [{ name: "Jordan Vale" }] });
  });

  it("holds a wrong name, an unknown CWID, an unknown mentor, a repeat and one already listed", () => {
    expect(held("Casey Morrow\ttra001\t2026\tmen001")).toEqual(["The directory has Avery J. Quill for this CWID"]);
    expect(held("Dana Finch\tdaf999\t2026\tmen001")).toEqual(["This CWID is not in the directory"]);
    expect(held("Avery Quill\ttra001\t2026\tmen001;gho999")).toEqual(["Mentor CWID not in the directory: gho999"]);
    expect(held("Avery Quill\ttra001\t2026\tmen001", ["tra001|2026"])).toEqual(["Already listed in this program for that year"]);
    const line = "Avery Quill\ttra001\t2026\tmen001";
    expect(held(`${line}\n${line}\n${line.replace("2026", "2025")}`)).toEqual([null, expect.stringMatching(/earlier line/), null]);
  });

  it("a held line keeps the pasted name, so it can be found and fixed", () => {
    const [r] = checkPaste(parsePaste("Casey Morrow\ttra001\t2026\tmen001", 2026), PEOPLE, nameOf, new Set());
    expect(r.person.name).toBe("Casey Morrow");
  });
});

describe("nameAgrees", () => {
  it.each([
    ["Avery Quill", "Avery J. Quill", true],
    ["Quill, Avery", "Avery J. Quill", true],
    ["Dr. Avery Quill, PhD", "Avery Quill", true],
    ["José Núñez", "Jose Nunez", true],
    ["Sean O’Brien", "Sean O'Brien", true],
    ["Maria Garcia Lopez", "Maria Garcia-Lopez", true],
    ["Minh Do", "Minh Do", true], // "Do" is also a degree
    ["Avery Quill", "Avery Stone", false],
    ["Casey Morrow", "Cameron Morley", false],
    ["Bob Vale", "Robert Vale", false],
    ["A. Quill", "Avery Quill", false],
    ["A. Quill", "A. Jordan Quill", false],
    ["Minh Anh Do", "Minh Anh Pa", false],
    ["Kim Lee Do", "Kim Lee", false],
    ["Ji Hoon O", "Ji Hoon E", false],
    ["Mary Ann S.", "Mary Ann", false],
    ["Robert Vale Jr", "Robert Vale Sr", false],
    ["Quill, Avery", "Avery Quill, MD, PhD", true],
    ["Quill", "Avery Quill", false],
    ["", "Avery Quill", false],
  ])("%j against %j: %s", (pasted, name, want) => expect(nameAgrees(pasted, person("x", name))).toBe(want));

  it("accepts the legal name when the display name differs", () => {
    expect(nameAgrees("Robert Vale", person("x", "Bob Vale", "Robert", "Vale"))).toBe(true);
    expect(nameAgrees("", person("x", ""))).toBe(false);
  });
});

describe("mentor counts", () => {
  const entry = (id: string, cwid: string, year: number, mentors: string[]): RosterEntryView => ({
    id,
    programId: "p",
    mentee: { cwid, name: `Trainee ${cwid}` },
    year,
    researchProgram: null,
    mentors: mentors.map((m) => ({ cwid: m, name: `Mentor ${m} ${year}` })),
  });
  const ALL = [
    entry("1", "t1", 2024, ["m1"]),
    entry("2", "t1", 2025, ["m1"]), // the same trainee again
    entry("3", "t2", 2025, ["m1", "m2"]),
    entry("4", "t3", 2026, ["m2"]),
    entry("5", "t4", 2026, ["m2"]),
  ];
  const ANY = { year: null, query: "" };

  it("counts distinct trainees, once for each of their mentors, most first, under the newest saved name", () => {
    expect(mentorCounts(ALL, ANY)).toEqual([
      { mentor: { cwid: "m2", name: "Mentor m2 2026" }, trainees: 3, firstYear: 2025, lastYear: 2026 },
      { mentor: { cwid: "m1", name: "Mentor m1 2025" }, trainees: 2, firstYear: 2024, lastYear: 2025 },
    ]);
  });

  it("a year or search picks the mentors and never changes a count", () => {
    expect(mentorCounts(ALL, { year: 2026, query: "" }).map((m) => [m.mentor.cwid, m.trainees])).toEqual([["m2", 3]]);
    expect(mentorCounts(ALL, { year: null, query: "T1" }).map((m) => [m.mentor.cwid, m.trainees])).toEqual([["m1", 2]]);
    expect(mentorCounts(ALL, { year: 2026, query: "t1" })).toEqual([]);
  });

  it("a mentor whose saved name changed is never listed without an entry that is", () => {
    const renamed = [entry("a", "t1", 2024, ["m1"]), entry("b", "t2", 2026, ["m1"])];
    const f = { year: 2024, query: "m1 2026" }; // the newer saved name only
    expect(filterEntries(renamed, f)).toEqual([]);
    expect(mentorCounts(renamed, f)).toEqual([]);
  });

  it("milestones at 5, 10 and 15", () => {
    expect([0, 4, 5, 9, 10, 14, 15, 40].map(milestoneOf)).toEqual([null, null, 5, 5, 10, 10, 15, 15]);
  });
});
