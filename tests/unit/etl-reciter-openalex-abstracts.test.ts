import { describe, expect, it } from "vitest";

import { abstractsFromWorks } from "@/etl/reciter/openalex-abstracts";

describe("abstractsFromWorks (#3259)", () => {
  it("keys by bare W id, rebuilds word order, skips works with no abstract", () => {
    const out = abstractsFromWorks([
      { id: "https://openalex.org/W1", abstract_inverted_index: { world: [1], hello: [0] } },
      { id: "https://openalex.org/W2", abstract_inverted_index: null },
    ]);
    expect([...out]).toEqual([["W1", "hello world"]]);
  });
});
