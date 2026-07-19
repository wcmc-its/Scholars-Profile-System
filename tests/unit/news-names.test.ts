/**
 * Deterministic scholar-name detection (etl/news/names.ts). No network, no DB.
 *
 * Covers the queue's inputs: a full name in prose becomes a HIGH candidate; a
 * full name shared by two scholars becomes a contested MEDIUM pair (same
 * groupKey); a lone surname is never proposed; a diacritic name folds; a
 * VIVO-linked scholar is excluded from the weaker prose pass.
 */
import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  detectMentions,
  foldToken,
  tokenize,
  type ScholarNameInput,
} from "@/etl/news/names";

const scholar = (over: Partial<ScholarNameInput> & { cwid: string; fullName: string }): ScholarNameInput => ({
  preferredName: over.fullName,
  primaryTitle: null,
  primaryDepartment: null,
  ...over,
});

describe("foldToken", () => {
  it("folds diacritics to base ASCII, lowercase", () => {
    expect(foldToken("José")).toBe("jose");
    expect(foldToken("Muñoz")).toBe("munoz");
    expect(foldToken("O'Brien")).toBe("obrien");
  });
});

describe("tokenize", () => {
  it("keeps accented words whole then folds them", () => {
    expect(tokenize("Dr. José García, PhD")).toEqual(["dr", "jose", "garcia", "phd"]);
  });
});

describe("detectMentions", () => {
  const index = buildNameIndex([
    scholar({ cwid: "xim2002", fullName: "Xiaojing Ma", primaryTitle: "Professor", primaryDepartment: "Microbiology" }),
    scholar({ cwid: "dco1", fullName: "David Cohen", primaryTitle: "Prof A", primaryDepartment: "Dept A" }),
    scholar({ cwid: "dco2", fullName: "David Cohen", primaryTitle: "Prof B", primaryDepartment: "Dept B" }),
  ]);

  it("emits HIGH for a unique full-name match", () => {
    const hits = detectMentions("Findings by Dr. Xiaojing Ma were published.", index);
    expect(hits).toEqual([
      { cwid: "xim2002", detectedName: "Xiaojing Ma", likelihood: "HIGH", groupKey: "xiaojing ma" },
    ]);
  });

  it("emits a contested MEDIUM pair when a full name resolves to two scholars", () => {
    const hits = detectMentions("Co-author David Cohen commented.", index);
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
    expect(hits.every((h) => h.likelihood === "MEDIUM")).toBe(true);
    // Same groupKey => the queue groups them as one single-select decision.
    expect(new Set(hits.map((h) => h.groupKey)).size).toBe(1);
  });

  it("never proposes a lone surname", () => {
    expect(detectMentions("Ma's lab reported results.", index)).toEqual([]);
    expect(detectMentions("The Cohen criterion was applied.", index)).toEqual([]);
  });

  it("excludes a VIVO-linked scholar from the prose pass", () => {
    const hits = detectMentions("Dr. Xiaojing Ma and David Cohen collaborated.", index, new Set(["xim2002"]));
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
  });
});
