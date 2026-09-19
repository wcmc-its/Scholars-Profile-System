/**
 * `lib/edit/mentorship-type.ts` — key / label per pair, the seven-key filter
 * vocabulary (`mentorshipTypeKey`), and the per-scope allowed / default /
 * resolved selections the page and route share. The labels are pinned in
 * the office's words: the key keeps the schema words (`md:roster:confirmed`
 * is a dedupe key), the label never does — no "presumptive" / "ambiguous" /
 * "roster" / "Jenzabar" / "ED" reaches a user.
 */
import { describe, expect, it } from "vitest";

import {
  allowedMentorshipTypes,
  defaultMentorshipTypes,
  MENTORSHIP_TYPE_DESCRIPTION,
  MENTORSHIP_TYPE_KEYS,
  MENTORSHIP_TYPE_LABEL,
  mentorshipKey,
  mentorshipLabel,
  mentorshipTypeKey,
  PROGRAM_LABEL,
  resolveMentorshipTypes,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";

const CASES: Array<[MentorshipType, string, string]> = [
  [{ program: "md", source: "roster", tier: "confirmed" }, "md:roster:confirmed", "AOC"],
  [
    { program: "mdphd", source: "roster", tier: "confirmed" },
    "mdphd:roster:confirmed",
    "MD-PhD (program office)",
  ],
  [{ program: "ecr", source: "roster", tier: "confirmed" }, "ecr:roster:confirmed", "ECR"],
  [
    { program: "phd", source: "jenzabar", tier: "confirmed" },
    "phd:jenzabar:confirmed",
    "PhD thesis advisor",
  ],
  [
    { program: "mdphd", source: "jenzabar", tier: "confirmed" },
    "mdphd:jenzabar:confirmed",
    "MD-PhD thesis advisor",
  ],
  [
    { program: "postdoc", source: "ed", tier: "confirmed" },
    "postdoc:ed:confirmed",
    "Postdoc supervisor",
  ],
  [
    { program: "volunteer", source: "coauthor", tier: "presumptive" },
    "volunteer:coauthor:presumptive",
    "Volunteer · likely mentee (from co-authorship)",
  ],
  [
    { program: "resident", source: "coauthor", tier: "ambiguous" },
    "resident:coauthor:ambiguous",
    "Resident · possible mentee (from co-authorship)",
  ],
];

const SCHEMA_WORDS = /presumptive|ambiguous|roster|Jenzabar|\bED\b/;

describe("mentorship type", () => {
  it.each(CASES)("%o → key %s, label %s", (t, key, label) => {
    expect(mentorshipKey(t)).toBe(key);
    expect(mentorshipLabel(t)).toBe(label);
    expect(label).not.toMatch(SCHEMA_WORDS);
  });

  it("an unmapped roster bucket and an unknown program fall back to the program word, never the table", () => {
    expect(mentorshipLabel({ program: "phd", source: "roster", tier: "confirmed" })).toBe("PhD");
    expect(mentorshipLabel({ program: "zzz", source: "roster", tier: "confirmed" })).toBe("zzz");
  });

  it("the md bucket reads AOC (the Program column, scope options and workbook), the key stays md", () => {
    expect(PROGRAM_LABEL.md).toBe("AOC");
    expect(Object.keys(PROGRAM_LABEL)).toContain("md");
  });

  it("no filter label or description leaks a schema word", () => {
    for (const k of MENTORSHIP_TYPE_KEYS) {
      expect(MENTORSHIP_TYPE_LABEL[k]).not.toMatch(SCHEMA_WORDS);
      expect(MENTORSHIP_TYPE_DESCRIPTION[k]).not.toMatch(/presumptive|ambiguous/);
    }
  });
});

describe("mentorshipTypeKey — every pair folds into one of the seven filter keys", () => {
  const KEYS: Array<[MentorshipType, string]> = [
    [{ program: "md", source: "roster", tier: "confirmed" }, "aoc"],
    [{ program: "mdphd", source: "roster", tier: "confirmed" }, "mdphd"],
    [{ program: "ecr", source: "roster", tier: "confirmed" }, "ecr"],
    [{ program: "phd", source: "jenzabar", tier: "confirmed" }, "thesis"],
    [{ program: "mdphd", source: "jenzabar", tier: "confirmed" }, "thesis"],
    [{ program: "postdoc", source: "ed", tier: "confirmed" }, "postdoc"],
    [{ program: "volunteer", source: "coauthor", tier: "presumptive" }, "likely"],
    [{ program: "alumni_md", source: "coauthor", tier: "ambiguous" }, "possible"],
  ];
  it.each(KEYS)("%o → %s", (t, key) => {
    expect(mentorshipTypeKey(t)).toBe(key);
  });

  it("every key has a label", () => {
    expect(MENTORSHIP_TYPE_KEYS).toEqual([
      "aoc",
      "mdphd",
      "ecr",
      "thesis",
      "postdoc",
      "likely",
      "possible",
    ]);
    for (const k of MENTORSHIP_TYPE_KEYS) {
      expect(MENTORSHIP_TYPE_LABEL[k]).toBeTruthy();
      expect(MENTORSHIP_TYPE_DESCRIPTION[k]).toMatch(/\.$/);
    }
  });
});

describe("allowed / default / resolved selections per scope", () => {
  it("'*' → every key allowed, every confirmed key default, co-author keys never default", () => {
    const all = new Set(["*"]);
    expect(allowedMentorshipTypes(all)).toEqual([...MENTORSHIP_TYPE_KEYS]);
    expect(defaultMentorshipTypes(all)).toEqual(["aoc", "mdphd", "ecr", "thesis", "postdoc"]);
  });

  it("an md holder: only AOC of the roster keys, plus the four non-roster keys; default = [aoc]", () => {
    const md = new Set(["md"]);
    expect(allowedMentorshipTypes(md)).toEqual(["aoc", "thesis", "postdoc", "likely", "possible"]);
    expect(defaultMentorshipTypes(md)).toEqual(["aoc"]);
  });

  it("md + ecr: both roster keys, in vocabulary order regardless of grant order", () => {
    expect(defaultMentorshipTypes(new Set(["ecr", "md"]))).toEqual(["aoc", "ecr"]);
    expect(allowedMentorshipTypes(new Set(["ecr", "md"]))).toEqual([
      "aoc",
      "ecr",
      "thesis",
      "postdoc",
      "likely",
      "possible",
    ]);
  });

  it("resolve: not given → default; given → allowed keys only; nothing allowed left → default", () => {
    const md = new Set(["md"]);
    expect(resolveMentorshipTypes(null, md)).toEqual(["aoc"]);
    expect(resolveMentorshipTypes(["likely", "possible"], md)).toEqual(["likely", "possible"]);
    // A roster key outside the holder's scopes is dropped, never widened.
    expect(resolveMentorshipTypes(["mdphd", "thesis"], md)).toEqual(["thesis"]);
    expect(resolveMentorshipTypes(["mdphd", "ecr"], md)).toEqual(["aoc"]);
    expect(resolveMentorshipTypes(["mdphd"], new Set(["*"]))).toEqual(["mdphd"]);
  });
});
