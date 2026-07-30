/**
 * The reported defect (2026-07-30) and the classes the prod/staging sweep found
 * alongside it. Inputs are assembled with `String.fromCharCode` — a literal
 * control character in a test file gets silently rewritten in transit, which is
 * how the first draft of the module under test corrupted itself.
 */
import { describe, expect, it } from "vitest";

import {
  hasEncodingDefect,
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
