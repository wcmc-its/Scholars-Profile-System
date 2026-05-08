import { describe, expect, it } from "vitest";
import { isNihAwardNumber, parseNihAward } from "@/lib/award-number";

describe("parseNihAward", () => {
  it("parses a standard R01 with whitespace separator", () => {
    expect(parseNihAward("R01 CA245678")).toEqual({
      mechanism: "R01",
      nihIc: "NCI",
      serial: "245678",
    });
  });

  it("parses a K23 award", () => {
    expect(parseNihAward("K23 HL157640")).toEqual({
      mechanism: "K23",
      nihIc: "NHLBI",
      serial: "157640",
    });
  });

  it("parses a U01 cooperative agreement", () => {
    expect(parseNihAward("U01 AI234567")).toEqual({
      mechanism: "U01",
      nihIc: "NIAID",
      serial: "234567",
    });
  });

  it("parses 3-character activity codes (UG3, U2C, UH3)", () => {
    expect(parseNihAward("UG3 AG098024").mechanism).toBe("UG3");
    expect(parseNihAward("U2C MD016124").mechanism).toBe("U2C");
    expect(parseNihAward("UH3 NS103997").mechanism).toBe("UH3");
  });

  it("parses S10 instrumentation awards", () => {
    expect(parseNihAward("S10 OD030447")).toEqual({
      mechanism: "S10",
      nihIc: "OD",
      serial: "030447",
    });
  });

  it("tolerates leading support flag and amendment suffix", () => {
    expect(parseNihAward("1R01CA245678-01A1")).toEqual({
      mechanism: "R01",
      nihIc: "NCI",
      serial: "245678",
    });
  });

  it("tolerates 7-digit serials", () => {
    expect(parseNihAward("R01 CA1234567").serial).toBe("1234567");
  });

  it("returns nulls for non-NIH formats", () => {
    expect(parseNihAward("OCRA-2024-091")).toEqual({
      mechanism: null,
      nihIc: null,
      serial: null,
    });
    expect(parseNihAward("AZ-OVA-8472").mechanism).toBeNull();
    expect(parseNihAward("RSG-21-001").mechanism).toBeNull();
  });

  it("returns nulls for empty / null / undefined input", () => {
    expect(parseNihAward(null).mechanism).toBeNull();
    expect(parseNihAward(undefined).mechanism).toBeNull();
    expect(parseNihAward("").mechanism).toBeNull();
  });

  it("returns null nihIc when the IC prefix isn't in the canonical list", () => {
    // ZZ isn't a real IC prefix — mechanism still parses, IC is null.
    expect(parseNihAward("R01 ZZ123456")).toEqual({
      mechanism: "R01",
      nihIc: null,
      serial: "123456",
    });
  });
});

describe("isNihAwardNumber", () => {
  it("returns true for parseable NIH award numbers", () => {
    expect(isNihAwardNumber("R01 CA245678")).toBe(true);
    expect(isNihAwardNumber("1K99HG011773-01")).toBe(true);
  });

  it("returns false for non-NIH award numbers", () => {
    expect(isNihAwardNumber("OCRA-2024-091")).toBe(false);
    expect(isNihAwardNumber("IIS-2123456")).toBe(false);
    expect(isNihAwardNumber(null)).toBe(false);
  });
});
