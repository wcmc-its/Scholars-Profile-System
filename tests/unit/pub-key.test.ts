/**
 * `lib/pub-key.ts` — the SPS `Publication.pmid` key for a ReCiterDB article,
 * shared by the mentee-suggestion builder and the mentoring bridge export.
 */
import { describe, expect, it } from "vitest";
import { externalKey, pubKey } from "@/lib/pub-key";

describe("pubKey", () => {
  it("keys external rows on article_id and PubMed rows on the pmid, like etl/reciter/index.ts", () => {
    expect(pubKey(-4242, "SCOPUS:105037533819")).toBe("SCOPUS:105037533819");
    expect(pubKey(39887654, null)).toBe("39887654");
    expect(pubKey(-13, "X".repeat(33))).toBe("-13");
  });

  it("PM #1060 — a CROSSREF id over 32 chars keys on a stable 32-char hash", () => {
    const id = "CROSSREF:10.1016/j.surg.2026.110815"; // 35 chars
    const key = externalKey(id);
    expect(key).toMatch(/^CROSSREF:[0-9a-f]{23}$/);
    expect(key).toHaveLength(32);
    expect(externalKey(id)).toBe(key); // stable across runs
    expect(externalKey("CROSSREF:10.1016/j.surg.2026.110816")).not.toBe(key);
    expect(externalKey("CROSSREF:10.1/x")).toBe("CROSSREF:10.1/x"); // fits: kept readable
    expect(pubKey(-7, id)).toBe(key);
  });
});
