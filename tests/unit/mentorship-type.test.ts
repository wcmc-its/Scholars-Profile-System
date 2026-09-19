/**
 * `lib/edit/mentorship-type.ts` — key / label per pair, the seven-key filter
 * vocabulary (`mentorshipTypeKey`), and the per-scope allowed / default /
 * resolved selections the page and route share.
 */
import { describe, expect, it } from "vitest";

import {
  allowedMentorshipTypes,
  defaultMentorshipTypes,
  MENTORSHIP_TYPE_KEYS,
  MENTORSHIP_TYPE_LABEL,
  mentorshipKey,
  mentorshipLabel,
  mentorshipTypeKey,
  resolveMentorshipTypes,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";

const CASES: Array<[MentorshipType, string, string]> = [
  [{ program: "md", source: "roster", tier: "confirmed" }, "md:roster:confirmed", "MD · roster"],
  [
    { program: "phd", source: "jenzabar", tier: "confirmed" },
    "phd:jenzabar:confirmed",
    "PhD · Jenzabar",
  ],
  [{ program: "postdoc", source: "ed", tier: "confirmed" }, "postdoc:ed:confirmed", "Postdoc · ED"],
  [
    { program: "volunteer", source: "coauthor", tier: "presumptive" },
    "volunteer:coauthor:presumptive",
    "Volunteer · co-author (presumptive)",
  ],
  [
    { program: "resident", source: "coauthor", tier: "ambiguous" },
    "resident:coauthor:ambiguous",
    "Resident · co-author (ambiguous)",
  ],
];

describe("mentorship type", () => {
  it.each(CASES)("%o → key %s, label %s", (t, key, label) => {
    expect(mentorshipKey(t)).toBe(key);
    expect(mentorshipLabel(t)).toBe(label);
  });

  it("MD-PhD and an unknown program fall back sensibly", () => {
    expect(mentorshipLabel({ program: "mdphd", source: "jenzabar", tier: "confirmed" })).toBe("MD-PhD · Jenzabar");
    expect(mentorshipLabel({ program: "zzz", source: "roster", tier: "confirmed" })).toBe("zzz · roster");
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
    for (const k of MENTORSHIP_TYPE_KEYS) expect(MENTORSHIP_TYPE_LABEL[k]).toBeTruthy();
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
