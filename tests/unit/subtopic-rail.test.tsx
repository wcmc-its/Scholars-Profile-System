import { describe, it, expect } from "vitest";
import { SubtopicRail } from "@/components/topic/subtopic-rail";

describe("SubtopicRail", () => {
  it.todo("renders subtopics sorted by pubCount DESC");
  it.todo("renders 'Less common' divider between subtopics with pubCount > 10 and pubCount <= 10");
  it.todo("applies opacity-60 to subtopics with pubCount <= 10");
  it.todo("filter input filters items client-side across both sections");
  it.todo("clicking active subtopic deselects it");
  it.todo("filter clear X button has aria-label='Clear filter'");
  it("component exports (RED: implementation pending Plan 07)", () => {
    expect(typeof SubtopicRail).toBe("function");
  });
});
