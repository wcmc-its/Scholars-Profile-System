import { describe, it, expect } from "vitest";
import { pubSource } from "@/lib/publication-source";

describe("pubSource", () => {
  it("treats an all-digit pmid as PubMed with no source label", () => {
    expect(pubSource("39123456")).toEqual({ isPubmed: true, sourceLabel: null });
  });

  it("labels external source-prefixed article ids", () => {
    expect(pubSource("SCOPUS:105037533819")).toEqual({ isPubmed: false, sourceLabel: "Scopus" });
    expect(pubSource("OPENALEX:W2741809807")).toEqual({ isPubmed: false, sourceLabel: "OpenAlex" });
    expect(pubSource("WOS:000123456")).toEqual({ isPubmed: false, sourceLabel: "Web of Science" });
  });

  it("never treats a synthetic negative pmid or unknown prefix as PubMed", () => {
    // The rare >32-char external falls back to the synthetic negative pmid; it must
    // still read as external so no dead pubmed.ncbi/-3 link is built.
    expect(pubSource("-3")).toEqual({ isPubmed: false, sourceLabel: "External" });
    expect(pubSource("FOO:1")).toEqual({ isPubmed: false, sourceLabel: "External" });
  });

  it("handles null/undefined/empty", () => {
    expect(pubSource(null)).toEqual({ isPubmed: false, sourceLabel: null });
    expect(pubSource(undefined)).toEqual({ isPubmed: false, sourceLabel: null });
    expect(pubSource("")).toEqual({ isPubmed: false, sourceLabel: null });
  });
});
