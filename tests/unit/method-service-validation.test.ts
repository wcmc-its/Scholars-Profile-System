/**
 * `lib/method-services/validation.ts`: the pure rules shared by
 * `/api/edit/method-service` and the editor section. Made-up values only.
 */
import { describe, expect, it } from "vitest";

import {
  SERVICE_PMIDS_MAX,
  defaultCountStaffPapers,
  isMethodServiceEntityType,
  parsePmidBlock,
  validatePmidList,
  validateServiceFamilies,
  validateServiceName,
  validateServiceUrl,
} from "@/lib/method-services/validation";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };

describe("isMethodServiceEntityType / defaultCountStaffPapers", () => {
  it("admits department and core only", () => {
    expect(isMethodServiceEntityType("department")).toBe(true);
    expect(isMethodServiceEntityType("core")).toBe(true);
    for (const v of ["division", "center", "institution", "scholar", "", null, 3]) {
      expect(isMethodServiceEntityType(v)).toBe(false);
    }
  });

  it("counts staff papers by default for a core, not for a department", () => {
    expect(defaultCountStaffPapers("core")).toBe(true);
    expect(defaultCountStaffPapers("department")).toBe(false);
  });
});

describe("validateServiceName", () => {
  it("trims and accepts 1 to 255 characters", () => {
    expect(validateServiceName("  Example service  ")).toEqual({ ok: true, value: "Example service" });
    expect(validateServiceName("x".repeat(255))).toMatchObject({ ok: true });
  });

  it("rejects empty, whitespace-only, over-long and non-string values", () => {
    expect(validateServiceName("")).toEqual({ ok: false, error: "name_required" });
    expect(validateServiceName("   ")).toEqual({ ok: false, error: "name_required" });
    expect(validateServiceName("x".repeat(256))).toEqual({ ok: false, error: "name_too_long" });
    expect(validateServiceName(undefined)).toEqual({ ok: false, error: "invalid_value" });
    expect(validateServiceName(42)).toEqual({ ok: false, error: "invalid_value" });
  });
});

describe("validateServiceUrl", () => {
  it("accepts an https URL, trimmed and otherwise verbatim", () => {
    expect(validateServiceUrl(" https://example.org/service?a=1 ")).toEqual({
      ok: true,
      value: "https://example.org/service?a=1",
    });
  });

  it("refuses an empty URL (a service must have one)", () => {
    expect(validateServiceUrl("")).toEqual({ ok: false, error: "url_required" });
    expect(validateServiceUrl("   ")).toEqual({ ok: false, error: "url_required" });
  });

  it("refuses http, other schemes, garbage, over-long and non-string values", () => {
    expect(validateServiceUrl("http://example.org")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateServiceUrl("javascript:alert(1)")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateServiceUrl("mailto:someone@example.org")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateServiceUrl("not a url")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateServiceUrl(`https://example.org/${"a".repeat(512)}`)).toEqual({
      ok: false,
      error: "url_too_long",
    });
    expect(validateServiceUrl(null)).toEqual({ ok: false, error: "invalid_value" });
  });
});

describe("validateServiceFamilies", () => {
  it("accepts 1 to 25 families, trimmed", () => {
    expect(
      validateServiceFamilies([{ supercategory: " evidence_synthesis ", familyLabel: " Example review methods " }]),
    ).toEqual({ ok: true, value: [FAM] });
    const many = Array.from({ length: 25 }, (_, i) => ({ supercategory: "s", familyLabel: `f${i}` }));
    expect(validateServiceFamilies(many)).toMatchObject({ ok: true });
  });

  it("de-duplicates on (supercategory, familyLabel), keeping the first", () => {
    const other = { supercategory: "other", familyLabel: FAM.familyLabel };
    expect(validateServiceFamilies([FAM, { ...FAM }, other, FAM])).toEqual({
      ok: true,
      value: [FAM, other],
    });
  });

  it("drops extra keys from each family", () => {
    expect(validateServiceFamilies([{ ...FAM, scholarCount: 9, familyId: "fam_1" }])).toEqual({
      ok: true,
      value: [FAM],
    });
  });

  it("requires at least one and at most 25", () => {
    expect(validateServiceFamilies([])).toEqual({ ok: false, error: "families_required" });
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ supercategory: "s", familyLabel: `f${i}` }));
    expect(validateServiceFamilies(tooMany)).toEqual({ ok: false, error: "too_many_families" });
    // 26 entries that collapse to one are fine: the cap is on distinct families.
    expect(validateServiceFamilies(Array.from({ length: 26 }, () => FAM))).toMatchObject({ ok: true });
  });

  it("rejects an empty supercategory or label, and a malformed entry", () => {
    for (const bad of [
      [{ supercategory: "", familyLabel: "x" }],
      [{ supercategory: "x", familyLabel: "  " }],
      [{ supercategory: "x" }],
      [{ supercategory: 1, familyLabel: "x" }],
      ["evidence_synthesis::x"],
      [null],
      "not an array",
      undefined,
    ]) {
      expect(validateServiceFamilies(bad)).toEqual({ ok: false, error: "invalid_value" });
    }
  });
});

describe("parsePmidBlock", () => {
  it("splits on newlines, commas, semicolons and whitespace", () => {
    expect(parsePmidBlock("111\n222, 333;444\t555  666\r\n777")).toEqual({
      pmids: ["111", "222", "333", "444", "555", "666", "777"],
      invalid: [],
    });
  });

  it("accepts 1 to 9 digits and nothing else", () => {
    expect(parsePmidBlock("1 123456789")).toEqual({ pmids: ["1", "123456789"], invalid: [] });
    expect(parsePmidBlock("1234567890 12a abc 12.5 -5")).toEqual({
      pmids: [],
      invalid: ["1234567890", "12a", "abc", "12.5", "-5"],
    });
  });

  it("reads a pasted PMID label", () => {
    expect(parsePmidBlock("PMID: 12345\npmid:67890, PMID 111; PMID222")).toEqual({
      pmids: ["12345", "67890", "111", "222"],
      invalid: [],
    });
  });

  it("reads a PubMed link, with or without scheme, slash or query", () => {
    expect(
      parsePmidBlock(
        [
          "https://pubmed.ncbi.nlm.nih.gov/12345/",
          "pubmed.ncbi.nlm.nih.gov/67890",
          "http://www.pubmed.ncbi.nlm.nih.gov/111?from=x",
        ].join("\n"),
      ),
    ).toEqual({ pmids: ["12345", "67890", "111"], invalid: [] });
  });

  it("reports a link that is not a PubMed article, and a bare label, as invalid", () => {
    const { pmids, invalid } = parsePmidBlock("https://example.org/12345 pubmed.ncbi.nlm.nih.gov/abc PMID:");
    expect(pmids).toEqual([]);
    expect(invalid).toEqual(["https://example.org/12345", "pubmed.ncbi.nlm.nih.gov/abc", "PMID:"]);
  });

  it("de-duplicates across forms, first-seen order, ignoring leading zeros", () => {
    expect(parsePmidBlock("222 111 PMID: 222 https://pubmed.ncbi.nlm.nih.gov/111/ 00111")).toEqual({
      pmids: ["222", "111"],
      invalid: [],
    });
  });

  it("treats a token of only zeros as invalid", () => {
    expect(parsePmidBlock("0 000")).toEqual({ pmids: [], invalid: ["0", "000"] });
  });

  it("returns nothing for an empty block and does not cap", () => {
    expect(parsePmidBlock("  \n ")).toEqual({ pmids: [], invalid: [] });
    const block = Array.from({ length: SERVICE_PMIDS_MAX + 5 }, (_, i) => String(i + 1)).join("\n");
    expect(parsePmidBlock(block).pmids).toHaveLength(SERVICE_PMIDS_MAX + 5);
  });
});

describe("validatePmidList", () => {
  it("accepts an empty list and a list of PMID strings, normalised", () => {
    expect(validatePmidList([])).toEqual({ ok: true, value: [] });
    expect(validatePmidList(["111", "PMID: 222", "111"])).toEqual({ ok: true, value: ["111", "222"] });
  });

  it("re-parses a whole block smuggled into one element", () => {
    expect(validatePmidList(["111, 222\n333"])).toEqual({ ok: true, value: ["111", "222", "333"] });
  });

  it("rejects a non-array, a non-string member and any token that is not a PMID", () => {
    expect(validatePmidList("111")).toEqual({ ok: false, error: "invalid_value" });
    expect(validatePmidList([111])).toEqual({ ok: false, error: "invalid_value" });
    expect(validatePmidList(["111", "abc"])).toEqual({ ok: false, error: "invalid_pmids" });
  });

  it("allows exactly 5000 and errors above it, never truncating", () => {
    const at = Array.from({ length: SERVICE_PMIDS_MAX }, (_, i) => String(i + 1));
    expect(validatePmidList(at)).toMatchObject({ ok: true });
    const over = validatePmidList([...at, String(SERVICE_PMIDS_MAX + 1)]);
    expect(over).toEqual({ ok: false, error: "too_many_pmids" });
    // 5001 entries that collapse to 5000 distinct PMIDs are fine.
    expect(validatePmidList([...at, "1"])).toMatchObject({ ok: true });
  });
});
