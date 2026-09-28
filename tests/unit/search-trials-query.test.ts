import { describe, expect, it } from "vitest";
import { buildTrialsQuery } from "@/lib/api/search-trials";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const mesh = { descendantUis: ["D1", "D2"] } as MeshResolution;
const concept = { terms: { meshDescriptorUi: ["D1", "D2"], boost: 4 } };

describe("buildTrialsQuery", () => {
  it("empty query browses everything", () => {
    expect(buildTrialsQuery("  ", mesh, "expanded")).toEqual({ match_all: {} });
  });
  it("expanded = text OR concept", () => {
    const q = buildTrialsQuery("leukemia", mesh, "expanded") as { bool: { should: unknown[] } };
    expect(q.bool.should).toHaveLength(2);
    expect(q.bool.should[1]).toEqual(concept);
  });
  it("concept = concept only; exact and unresolved = text only", () => {
    expect(buildTrialsQuery("leukemia", mesh, "concept")).toEqual(concept);
    expect(buildTrialsQuery("leukemia", mesh, "exact")).toHaveProperty("multi_match");
    expect(buildTrialsQuery("leukemia", null, "expanded")).toHaveProperty("multi_match");
  });
});
