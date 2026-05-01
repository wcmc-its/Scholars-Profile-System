import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CuratedTag } from "@/components/topic/curated-tag";

describe("CuratedTag", () => {
  it.todo("renders with publication_centric tooltip wording");
  it.todo("renders with scholar_centric tooltip wording");
  it.todo("renders Info icon with aria-label='Learn more about Curated ranking'");
  it("component exports (RED: implementation pending Plan 07)", () => {
    expect(typeof CuratedTag).toBe("function");
  });
});
