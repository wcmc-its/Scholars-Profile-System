/**
 * `lib/pub-key.ts` — the SPS `Publication.pmid` key for a ReCiterDB article,
 * shared by the mentee-suggestion builder and the mentoring bridge export.
 */
import { describe, expect, it } from "vitest";
import { pubKey } from "@/lib/pub-key";

describe("pubKey", () => {
  it("keys external rows on article_id and PubMed rows on the pmid, like etl/reciter/index.ts", () => {
    expect(pubKey(-4242, "SCOPUS:105037533819")).toBe("SCOPUS:105037533819");
    expect(pubKey(39887654, null)).toBe("39887654");
    expect(pubKey(-13, "X".repeat(33))).toBe("-13");
  });
});
