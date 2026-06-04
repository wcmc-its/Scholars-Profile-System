/**
 * `lib/mentee-suppression.ts` — the pure helpers that drop a mentor's hidden
 * mentees from the public profile (#160 follow-up). This is the load-bearing
 * filter that `components/profile/profile-view.tsx` applies BEFORE computing the
 * mentee count / distribution; tested here in isolation so the server component
 * needn't be rendered.
 */
import { describe, expect, it } from "vitest";

import {
  filterHiddenMentees,
  hiddenMenteeCwids,
  type MenteeSuppressionRow,
} from "@/lib/mentee-suppression";

const MENTOR = "mentor01";

describe("hiddenMenteeCwids", () => {
  it("extracts menteeCwids from this mentor's `{mentorCwid}:{menteeCwid}` rows", () => {
    const rows: MenteeSuppressionRow[] = [
      { entityId: "mentor01:m1" },
      { entityId: "mentor01:m2" },
    ];
    expect([...hiddenMenteeCwids(MENTOR, rows)].sort()).toEqual(["m1", "m2"]);
  });

  it("ignores rows that belong to a DIFFERENT mentor (defensive prefix check)", () => {
    const rows: MenteeSuppressionRow[] = [
      { entityId: "mentor01:m1" },
      { entityId: "someoneelse:m1" }, // same menteeCwid, different mentor — must NOT match
    ];
    expect([...hiddenMenteeCwids(MENTOR, rows)]).toEqual(["m1"]);
  });

  it("ignores a malformed row with no mentee segment", () => {
    const rows: MenteeSuppressionRow[] = [{ entityId: "mentor01:" }];
    expect(hiddenMenteeCwids(MENTOR, rows).size).toBe(0);
  });

  it("returns an empty set when there are no rows", () => {
    expect(hiddenMenteeCwids(MENTOR, []).size).toBe(0);
  });
});

describe("filterHiddenMentees", () => {
  const mentees = [{ cwid: "m1" }, { cwid: "m2" }, { cwid: "m3" }];

  it("drops mentees whose cwid is in the hidden set", () => {
    const out = filterHiddenMentees(mentees, new Set(["m2"]));
    expect(out.map((m) => m.cwid)).toEqual(["m1", "m3"]);
  });

  it("returns the full list when nothing is hidden", () => {
    expect(filterHiddenMentees(mentees, new Set())).toHaveLength(3);
  });

  it("drops all when every mentee is hidden", () => {
    expect(filterHiddenMentees(mentees, new Set(["m1", "m2", "m3"]))).toHaveLength(0);
  });

  it("end-to-end: a mentor hide removes exactly that mentee before counting", () => {
    const rows: MenteeSuppressionRow[] = [{ entityId: "mentor01:m2" }];
    const visible = filterHiddenMentees(mentees, hiddenMenteeCwids(MENTOR, rows));
    expect(visible.map((m) => m.cwid)).toEqual(["m1", "m3"]);
  });
});
