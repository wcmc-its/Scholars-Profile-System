import { describe, expect, it } from "vitest";
import {
  expandMechanism,
  getMechanism,
  listMechanisms,
} from "@/lib/mechanism-lookup";

describe("getMechanism", () => {
  it("resolves common NIH activity codes", () => {
    expect(getMechanism("R01")?.full).toBe("Research Project Grant (R01)");
    expect(getMechanism("K23")?.full).toBe(
      "Mentored Patient-Oriented Research Career Development Award (K23)",
    );
    expect(getMechanism("U01")?.full).toBe(
      "Research Project Cooperative Agreement (U01)",
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(getMechanism("r01")?.code).toBe("R01");
    expect(getMechanism(" R01 ")?.code).toBe("R01");
  });

  it("returns null for unknown codes and empty input", () => {
    expect(getMechanism("ZZZ99")).toBeNull();
    expect(getMechanism("")).toBeNull();
    expect(getMechanism(null)).toBeNull();
    expect(getMechanism(undefined)).toBeNull();
  });
});

describe("expandMechanism", () => {
  it("returns the full label when the code is known", () => {
    expect(expandMechanism("R21")).toBe(
      "Exploratory / Developmental Research Grant (R21)",
    );
  });

  it("returns null when the code is unknown", () => {
    expect(expandMechanism("XYZ")).toBeNull();
  });
});

describe("listMechanisms", () => {
  it("has unique codes across the canonical set", () => {
    const codes = listMechanisms().map((m) => m.code.toUpperCase());
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    expect(dupes).toEqual([]);
  });

  it("covers each major mechanism family at least once", () => {
    const codes = new Set(listMechanisms().map((m) => m.code));
    for (const required of ["R01", "K23", "F32", "T32", "U01", "P30", "S10"]) {
      expect(codes.has(required)).toBe(true);
    }
  });
});
