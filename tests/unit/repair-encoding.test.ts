/**
 * The reported defect (2026-07-30) and the classes the prod/staging sweep found
 * alongside it. Inputs are assembled with `String.fromCharCode` — a literal
 * control character in a test file gets silently rewritten in transit, which is
 * how the first draft of the module under test corrupted itself.
 */
import { describe, expect, it } from "vitest";

import {
  hasDoubleEncoding,
  hasEncodingDefect,
  repairDoubleEncoding,
  repairEncoding,
  repairEncodingOrNull,
} from "@/lib/text/repair-encoding";

const cc = String.fromCharCode;

describe("repairEncoding", () => {
  it("recovers the reported right single quote (raz2002 / cboutin / mcr2004)", () => {
    expect(repairEncoding(`Dr. Zarnegar${cc(0x92)}s primary clinical interests`)).toBe(
      "Dr. Zarnegar’s primary clinical interests",
    );
  });

  it("recovers en dash, em dash, ellipsis and both double quotes", () => {
    expect(repairEncoding(`1968 ${cc(0x96)} present`)).toBe("1968 – present");
    expect(repairEncoding(`a${cc(0x97)}b`)).toBe("a—b");
    expect(repairEncoding(`etc${cc(0x85)}`)).toBe("etc…");
    expect(repairEncoding(`${cc(0x93)}quoted${cc(0x94)}`)).toBe("“quoted”");
  });

  it("drops the five cp1252 holes rather than emitting a box", () => {
    for (const cp of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
      expect(repairEncoding(`a${cc(cp)}b`)).toBe("ab");
    }
  });

  it("strips invisible junk: ZWSP, BOM, soft hyphen, word joiner, U+FFFD, NUL", () => {
    expect(repairEncoding(`${cc(0x200b)}Dr. Kaur`)).toBe("Dr. Kaur");
    expect(repairEncoding(`${cc(0xfeff)}DESCRIPTION`)).toBe("DESCRIPTION");
    expect(repairEncoding(`Anti${cc(0x00ad)}emesis`)).toBe("Antiemesis");
    expect(repairEncoding(`a${cc(0x2060)}b`)).toBe("ab");
    expect(repairEncoding(`IL-I ${cc(0xfffd)}Driven`)).toBe("IL-I Driven");
    expect(repairEncoding(`P${cc(0x00)}.001`)).toBe("P.001");
  });

  it("keeps tab, newline and carriage return", () => {
    expect(repairEncoding("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
  });

  it("keeps the joiners and bidi marks that carry meaning", () => {
    for (const cp of [0x200c, 0x200d, 0x200e, 0x200f]) {
      expect(repairEncoding(`a${cc(cp)}b`)).toBe(`a${cc(cp)}b`);
    }
  });

  it("leaves clean text — including real curly quotes and accents — byte-identical", () => {
    const clean = "Dr. Kaur’s work on “β-amyloid” — Université de Montréal, 1968–present.\n";
    expect(repairEncoding(clean)).toBe(clean);
    expect(hasEncodingDefect(clean)).toBe(false);
    expect(repairEncoding("")).toBe("");
  });

  it("is idempotent", () => {
    const dirty = `Dr. Reid${cc(0x92)}s${cc(0x200b)} ${cc(0xfffd)}work`;
    expect(repairEncoding(repairEncoding(dirty))).toBe(repairEncoding(dirty));
  });

  it("hasEncodingDefect has no sticky-lastIndex bug across calls", () => {
    const dirty = `a${cc(0x92)}b`;
    expect(hasEncodingDefect(dirty)).toBe(true);
    expect(hasEncodingDefect(dirty)).toBe(true);
    expect(hasEncodingDefect(dirty)).toBe(true);
  });

  it("passes null and undefined through", () => {
    expect(repairEncodingOrNull(null)).toBeNull();
    expect(repairEncodingOrNull(undefined)).toBeUndefined();
    expect(repairEncodingOrNull(`a${cc(0x92)}b`)).toBe("a’b");
  });
});

/** The three double-encoded shapes the 2026-07-30 prod sweep actually found. */
const CP1252_APOS = `${cc(0xe2)}${cc(0x20ac)}${cc(0x2122)}`; // U+2019, decoded as cp1252
const RAW_APOS = `${cc(0xe2)}${cc(0x80)}${cc(0x99)}`; // U+2019, nothing mapped yet
const LATIN1_IDIAERESIS = `${cc(0xc3)}${cc(0xaf)}`; // U+00EF, decoded as latin1
const LATIN1_REGISTERED = `${cc(0xc2)}${cc(0xae)}`; // U+00AE, decoded as latin1

describe("repairDoubleEncoding", () => {
  it("recovers the cp1252-flavoured form (publication.abstract, 12 prod rows)", () => {
    expect(repairDoubleEncoding(`Alzheimer${CP1252_APOS}s disease`)).toBe("Alzheimer’s disease");
    expect(repairDoubleEncoding(`some peoples${CP1252_APOS} immune`)).toBe("some peoples’ immune");
  });

  it("recovers the latin1-flavoured form (clinical_trial.title, 5 prod rows)", () => {
    expect(repairDoubleEncoding(`treatment-na${LATIN1_IDIAERESIS}ve`)).toBe("treatment-naïve");
    expect(repairDoubleEncoding(`BarreGEN${LATIN1_REGISTERED}`)).toBe("BarreGEN®");
  });

  it("recovers a sequence whose continuation is still a bare C1 (principal_sponsor, 3 rows)", () => {
    expect(repairDoubleEncoding(`Children${RAW_APOS}s Hospital`)).toBe("Children’s Hospital");
  });

  it("leaves legitimate accented text alone - the false positives that bit the sweep", () => {
    for (const s of ["Tomáš Hanke", "Líšková A", "Balážová P", "Velíšková J"]) {
      expect(repairDoubleEncoding(s)).toBe(s);
      expect(hasDoubleEncoding(s)).toBe(false);
    }
  });

  it("leaves plain ASCII and well-formed unicode untouched", () => {
    const clean = "Université de Montréal — β-amyloid “quoted” 100%";
    expect(repairDoubleEncoding(clean)).toBe(clean);
    expect(repairDoubleEncoding("")).toBe("");
  });

  it("is idempotent", () => {
    const once = repairDoubleEncoding(`Alzheimer${CP1252_APOS}s`);
    expect(repairDoubleEncoding(once)).toBe(once);
  });
});

describe("repairEncoding holds back double-encoded input", () => {
  it("does not map a C1 that follows a UTF-8 lead byte", () => {
    // The whole point: the cp1252 table would turn an invisible box into a
    // visible "Children<euro><tm>s". Better to leave it for the round-trip.
    const held = `Children${RAW_APOS}s Hospital`;
    expect(repairEncoding(held)).toBe(held);
  });

  it("still maps a bare C1 elsewhere in the same string", () => {
    expect(repairEncoding(`Zarnegar${cc(0x92)}s and Children${RAW_APOS}s`)).toBe(
      `Zarnegar’s and Children${RAW_APOS}s`,
    );
  });

  it("still strips invisibles from a held row", () => {
    expect(repairEncoding(`Children${RAW_APOS}s${cc(0x200b)} Hospital`)).toBe(
      `Children${RAW_APOS}s Hospital`,
    );
  });

  it("round-trips: hold, then repair properly", () => {
    const dirty = `Children${RAW_APOS}s${cc(0x200b)} Hospital`;
    expect(repairDoubleEncoding(repairEncoding(dirty))).toBe("Children’s Hospital");
  });
});
