import { describe, it, expect } from "vitest";
import { getTopicPublications } from "@/lib/api/topics";

describe("getTopicPublications", () => {
  it.todo("sort=newest orders by year DESC then dateAddedToEntrez DESC");
  it.todo("sort=most_cited orders by citation_count DESC");
  it.todo("sort=by_impact uses recent_highlights curve and scholarCentric=false");
  it.todo("sort=curated returns same ordering as by_impact");
  it.todo("filter=research_articles_only excludes Letter, Editorial Article, Erratum");
  it.todo("filter=all includes all publication types");
  it.todo("subtopic param filters by primarySubtopicId");
  it.todo("returns null for unknown topic slug");
  it("export exists (RED: implementation pending Plan 05)", () => {
    expect(typeof getTopicPublications).toBe("function");
  });
});
