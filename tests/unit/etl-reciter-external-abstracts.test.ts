/**
 * #3259 — external abstracts from reciterdb.reporting_external_abstracts, keyed by the
 * source-prefixed article_id, land on the synthetic pmid the rest of the ETL uses.
 * main() is guarded by !process.env.VITEST, so importing the module is side-effect free.
 */
import { describe, expect, it } from "vitest";

import { mergeExternalAbstracts } from "@/etl/reciter/index";

describe("mergeExternalAbstracts (#3259)", () => {
  it("maps article_id to its synthetic pmid and skips unknown ids and empty text", () => {
    const into = new Map<number, string>([[12345, "pubmed abstract"]]);
    const n = mergeExternalAbstracts(
      [
        { article_id: "OPENALEX:W4417001897", abstract: "Introduction: NPM1" },
        { article_id: "OPENALEX:W0000000001", abstract: "not in this run" },
        { article_id: "SCOPUS:86000793624", abstract: null },
      ],
      new Map([
        ["OPENALEX:W4417001897", -71],
        ["SCOPUS:86000793624", -5],
      ]),
      into,
    );
    expect(n).toBe(1);
    expect([...into]).toEqual([
      [12345, "pubmed abstract"],
      [-71, "Introduction: NPM1"],
    ]);
  });
});
