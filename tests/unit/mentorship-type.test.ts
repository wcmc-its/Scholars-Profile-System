/**
 * `lib/edit/mentorship-type.ts` — key / label / rail default per source.
 */
import { describe, expect, it } from "vitest";

import {
  mentorshipDefaultSelected,
  mentorshipKey,
  mentorshipLabel,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";

const CASES: Array<[MentorshipType, string, string, boolean]> = [
  [{ program: "md", source: "roster", tier: "confirmed" }, "md:roster:confirmed", "MD · roster", true],
  [{ program: "phd", source: "jenzabar", tier: "confirmed" }, "phd:jenzabar:confirmed", "PhD · Jenzabar", true],
  [{ program: "postdoc", source: "ed", tier: "confirmed" }, "postdoc:ed:confirmed", "Postdoc · ED", true],
  [
    { program: "volunteer", source: "coauthor", tier: "presumptive" },
    "volunteer:coauthor:presumptive",
    "Volunteer · co-author (presumptive)",
    false,
  ],
  [
    { program: "resident", source: "coauthor", tier: "ambiguous" },
    "resident:coauthor:ambiguous",
    "Resident · co-author (ambiguous)",
    false,
  ],
];

describe("mentorship type", () => {
  it.each(CASES)("%o → key %s, label %s, default %s", (t, key, label, selected) => {
    expect(mentorshipKey(t)).toBe(key);
    expect(mentorshipLabel(t)).toBe(label);
    expect(mentorshipDefaultSelected(t)).toBe(selected);
  });

  it("MD-PhD and an unknown program fall back sensibly", () => {
    expect(mentorshipLabel({ program: "mdphd", source: "jenzabar", tier: "confirmed" })).toBe("MD-PhD · Jenzabar");
    expect(mentorshipLabel({ program: "zzz", source: "roster", tier: "confirmed" })).toBe("zzz · roster");
  });
});
