/**
 * #1609 — the pure "Grants for me" feedback transform + vocabulary guards
 * (`lib/grant-recs/feedback.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  applyGrantRecFeedback,
  isFeedbackStatus,
  isNotRelevantReason,
  overfetchLimit,
  type GrantRecFeedbackStatus,
} from "@/lib/grant-recs/feedback";

const ids = (xs: Array<{ opportunityId: string }>) => xs.map((x) => x.opportunityId);
const list = (...xs: string[]) => xs.map((opportunityId) => ({ opportunityId }));
const fb = (entries: Array<[string, GrantRecFeedbackStatus]>) => new Map(entries);

describe("applyGrantRecFeedback", () => {
  it("is the identity with no feedback (server order kept)", () => {
    expect(ids(applyGrantRecFeedback(list("a", "b", "c"), new Map()))).toEqual(["a", "b", "c"]);
  });

  it("drops not-relevant items", () => {
    const out = applyGrantRecFeedback(list("a", "b", "c"), fb([["b", "not_relevant"]]));
    expect(ids(out)).toEqual(["a", "c"]);
  });

  it("pins saved items to the top, stable within each group", () => {
    const out = applyGrantRecFeedback(
      list("a", "b", "c", "d"),
      fb([
        ["d", "saved"],
        ["b", "saved"],
      ]),
    );
    expect(ids(out)).toEqual(["b", "d", "a", "c"]);
  });

  it("cuts to the limit AFTER dropping, so an over-fetched page stays full", () => {
    const out = applyGrantRecFeedback(
      list("a", "b", "c", "d"),
      fb([
        ["a", "not_relevant"],
        ["d", "saved"],
      ]),
      2,
    );
    expect(ids(out)).toEqual(["d", "b"]);
  });

  it("ignores feedback for ids not in the list", () => {
    expect(ids(applyGrantRecFeedback(list("a"), fb([["zzz", "saved"]])))).toEqual(["a"]);
  });
});

describe("overfetchLimit", () => {
  it("adds one per not-relevant entry, capped at the route max", () => {
    expect(overfetchLimit(25, new Map())).toBe(25);
    expect(
      overfetchLimit(
        25,
        fb([
          ["a", "not_relevant"],
          ["b", "saved"],
          ["c", "not_relevant"],
        ]),
      ),
    ).toBe(27);
    const many = new Map(
      Array.from({ length: 500 }, (_, i) => [`x${i}`, "not_relevant" as const]),
    );
    expect(overfetchLimit(25, many)).toBe(100);
  });
});

describe("vocabulary guards", () => {
  it("accepts only the known statuses and reasons", () => {
    expect(isFeedbackStatus("saved")).toBe(true);
    expect(isFeedbackStatus("not_relevant")).toBe(true);
    expect(isFeedbackStatus("dismissed")).toBe(false);
    expect(isFeedbackStatus(null)).toBe(false);
    expect(isNotRelevantReason("off_topic")).toBe(true);
    expect(isNotRelevantReason("wrong_stage")).toBe(true);
    expect(isNotRelevantReason("meh")).toBe(false);
  });
});
