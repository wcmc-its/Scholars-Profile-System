import { describe, expect, it, vi } from "vitest";
import {
  buildScholarFamilyWritesFromS3,
  type ScholarFamilyWrite,
} from "@/etl/tools/scholar-family-mapper-s3";
import {
  applySystematicReviewRule,
  findSystematicReviewFamily,
  isSystematicReviewRuleOn,
  normalizeFamilyLabel,
  runSystematicReviewRule,
  SR_RULE_FLAG,
  toolsRunSignature,
  type FamilyIdentity,
} from "@/etl/tools/systematic-review-rule";

const SC = "computational_statistical";
const LABEL = "Systematic review and meta-analysis";

const FAMILY: FamilyIdentity = {
  familyId: "fam_sr",
  familyLabel: LABEL,
  supercategory: SC,
  definition: "Pools the results of published studies.",
  definitionSource: "generated",
};

function row(over: Partial<ScholarFamilyWrite> & { cwid: string }): ScholarFamilyWrite {
  return {
    familyId: "fam_other",
    familyLabel: "Other family",
    supercategory: "imaging",
    pmidCount: 1,
    exemplarTools: ["Tool A"],
    exemplarContexts: { "Tool A": "used Tool A" },
    exemplarContextPmids: { "Tool A": "900" },
    pmids: ["900"],
    definition: "Other definition.",
    definitionSource: "generated",
    ...over,
  };
}

function apply(over: Partial<Parameters<typeof applySystematicReviewRule>[0]>) {
  return applySystematicReviewRule({
    writes: [],
    flaggedPmids: [],
    authorships: [],
    fullTimeFacultyCwids: new Set(["fac1"]),
    activeCwids: new Set(["fac1", "post1", "stu1"]),
    family: FAMILY,
    topN: 50,
    ...over,
  });
}

describe("findSystematicReviewFamily", () => {
  it("normalises case, hyphens, underscores and whitespace", () => {
    expect(normalizeFamilyLabel("  Systematic-Review_and   META-analysis ")).toBe(
      "systematic review and meta analysis",
    );
    for (const label of [
      "Systematic review and meta-analysis",
      "SYSTEMATIC REVIEW AND META-ANALYSIS",
      "systematic_review and  meta-analysis",
      "  Systematic Review And Meta-Analysis  ",
    ]) {
      const found = findSystematicReviewFamily([
        { family_id: "fam_x", label: "Meta-regression", supercategory: SC },
        { family_id: " fam_sr ", label, supercategory: ` ${SC} ` },
      ]);
      expect(found?.identity.familyId).toBe("fam_sr");
      // The row carries the registry's own label (trimmed), not the normalised form.
      expect(found?.identity.familyLabel).toBe(label.trim());
      expect(found?.identity.supercategory).toBe(SC);
      expect(found?.matches).toBe(1);
    }
  });

  it("matches the label spelled without the hyphen", () => {
    // Hyphen and space are the same after normalising, on both sides.
    expect(
      findSystematicReviewFamily([
        { family_id: "fam_sr", label: "Systematic review and meta analysis", supercategory: SC },
      ])?.identity.familyId,
    ).toBe("fam_sr");
  });

  it("does not match the label under another supercategory", () => {
    expect(
      findSystematicReviewFamily([
        { family_id: "fam_sr", label: LABEL, supercategory: "clinical_research" },
      ]),
    ).toBeNull();
  });

  it("returns null when the family is missing or the registry is not an array", () => {
    expect(findSystematicReviewFamily([{ family_id: "f", label: "Other", supercategory: SC }])).toBeNull();
    expect(findSystematicReviewFamily(undefined)).toBeNull();
    expect(findSystematicReviewFamily([null, {}, { family_id: "", label: LABEL, supercategory: SC }])).toBeNull();
  });

  it("joins the definition by family_id", () => {
    const found = findSystematicReviewFamily(
      [{ family_id: "fam_sr", label: LABEL, supercategory: SC }],
      { familyDefById: new Map([["fam_sr", { definition: "D", definitionSource: "generated" }]]) },
    );
    expect(found?.identity).toEqual({
      familyId: "fam_sr",
      familyLabel: LABEL,
      supercategory: SC,
      definition: "D",
      definitionSource: "generated",
    });
    expect(
      findSystematicReviewFamily([{ family_id: "fam_sr", label: LABEL, supercategory: SC }])?.identity
        .definition,
    ).toBeNull();
  });

  it("prefers the id existing writes use when the registry duplicates the family", () => {
    const found = findSystematicReviewFamily(
      [
        { family_id: "fam_a", label: LABEL, supercategory: SC },
        { family_id: "fam_b", label: LABEL, supercategory: SC },
      ],
      { writes: [row({ cwid: "fac1", familyId: "fam_b", familyLabel: LABEL, supercategory: SC })] },
    );
    expect(found?.identity.familyId).toBe("fam_b");
    expect(found?.matches).toBe(2);
  });
});

describe("applySystematicReviewRule", () => {
  it("is a no-op for an empty flagged set", () => {
    const writes = [row({ cwid: "fac1" })];
    const out = apply({ writes, authorships: [{ pmid: "1", cwid: "fac1" }] });
    expect(out.writes).toBe(writes);
    expect(out.counters).toMatchObject({ flaggedPmids: 0, qualifyingPmids: 0, rowsCreated: 0 });
  });

  it("excludes a paper with no full-time-faculty author entirely", () => {
    const writes = [row({ cwid: "post1" })];
    const out = apply({
      writes,
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "post1" },
        { pmid: "10", cwid: "stu1" },
      ],
    });
    expect(out.writes).toBe(writes);
    expect(out.counters).toMatchObject({
      flaggedPmids: 1,
      qualifyingPmids: 0,
      scholarsCredited: 0,
      rowsCreated: 0,
    });
  });

  it("does not let an inactive faculty author qualify a paper", () => {
    const out = apply({
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "gone" },
        { pmid: "10", cwid: "post1" },
      ],
      fullTimeFacultyCwids: new Set(["gone"]),
    });
    expect(out.writes).toEqual([]);
    expect(out.counters.qualifyingPmids).toBe(0);
  });

  it("credits a non-faculty co-author when a faculty co-author exists", () => {
    const out = apply({
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "fac1" },
        { pmid: "10", cwid: "post1" },
      ],
    });
    expect(out.writes.map((w) => w.cwid).sort()).toEqual(["fac1", "post1"]);
    expect(out.writes.every((w) => w.familyId === "fam_sr" && w.pmidCount === 1)).toBe(true);
    expect(out.counters).toMatchObject({ qualifyingPmids: 1, scholarsCredited: 2, rowsCreated: 2, pmidsAdded: 2 });
  });

  it("does not credit an inactive scholar or an unmatched author", () => {
    const out = apply({
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "fac1" },
        { pmid: "10", cwid: "gone" },
        { pmid: "10", cwid: null },
      ],
    });
    expect(out.writes.map((w) => w.cwid)).toEqual(["fac1"]);
    expect(out.counters.scholarsCredited).toBe(1);
  });

  it("ignores authorships of pmids that are not flagged", () => {
    const out = apply({
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "fac1" },
        { pmid: "11", cwid: "fac1" },
      ],
    });
    expect(out.writes[0].pmids).toEqual(["10"]);
  });

  it("extends an existing row: sorted distinct union, count, other fields untouched", () => {
    const existing = row({
      cwid: "fac1",
      familyId: "fam_sr",
      familyLabel: LABEL,
      supercategory: SC,
      pmidCount: 2,
      pmids: ["300", "20"],
      definition: "From the artifact.",
    });
    const other = row({ cwid: "fac1", pmidCount: 9 });
    const writes = [other, existing];
    const out = apply({
      writes,
      flaggedPmids: ["100", "20", "5", "1000"],
      authorships: ["100", "20", "5", "1000"].map((pmid) => ({ pmid, cwid: "fac1" })),
    });
    const merged = out.writes.find((w) => w.familyId === "fam_sr")!;
    expect(merged.pmids).toEqual(["5", "20", "100", "300", "1000"]);
    expect(merged.pmidCount).toBe(5);
    expect({ ...merged, pmids: existing.pmids, pmidCount: existing.pmidCount }).toEqual(existing);
    // Input is not mutated, and the untouched sibling row is the same object.
    expect(existing.pmids).toEqual(["300", "20"]);
    expect(writes).toEqual([other, existing]);
    expect(out.writes).toContain(other);
    expect(out.counters).toMatchObject({ rowsExtended: 1, rowsCreated: 0, pmidsAdded: 3, rowsDroppedByCap: 0 });
  });

  it("extends the row found by stable label when its family_id differs from the registry", () => {
    const existing = row({ cwid: "fac1", familyId: "fam_old", familyLabel: LABEL, supercategory: SC, pmids: ["1"] });
    const out = apply({ writes: [existing], flaggedPmids: ["2"], authorships: [{ pmid: "2", cwid: "fac1" }] });
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0]).toMatchObject({ familyId: "fam_old", pmids: ["1", "2"], pmidCount: 2 });
  });

  it("leaves a row alone when it already holds every pmid", () => {
    const existing = row({ cwid: "fac1", familyId: "fam_sr", familyLabel: LABEL, supercategory: SC, pmids: ["2", "1"], pmidCount: 2 });
    const writes = [existing];
    const out = apply({ writes, flaggedPmids: ["1"], authorships: [{ pmid: "1", cwid: "fac1" }] });
    expect(out.writes).toBe(writes);
    expect(out.counters).toMatchObject({ rowsUnchanged: 1, rowsExtended: 0, pmidsAdded: 0 });
  });

  it("creates a row in exactly the shape the mapper emits for a family with no exemplars", () => {
    const mapped = buildScholarFamilyWritesFromS3(
      {
        tools: [],
        faculty: {
          fac1: {
            families: [
              { family_id: "fam_sr", label: LABEL, supercategory: SC, pub_count: 2, exemplar_tool_ids: [], pmids: ["7", "8"] },
            ],
          },
        },
      } as never,
      {
        ourCwidSet: new Set(["fac1"]),
        familyDefById: new Map([
          ["fam_sr", { definition: FAMILY.definition, definitionSource: FAMILY.definitionSource }],
        ]),
      },
    ).writes[0];

    const out = apply({
      flaggedPmids: ["8", "7"],
      authorships: [
        { pmid: "8", cwid: "fac1" },
        { pmid: "7", cwid: "fac1" },
        { pmid: "7", cwid: "fac1" },
      ],
    });
    expect(out.writes).toEqual([mapped]);
    expect(out.counters).toMatchObject({ rowsCreated: 1, pmidsAdded: 2 });
  });

  it("re-applies the per-scholar cap and counts the rows it drops", () => {
    const writes = [
      row({ cwid: "fac1", familyId: "fam_a", pmidCount: 5 }),
      row({ cwid: "fac1", familyId: "fam_b", pmidCount: 2 }),
      row({ cwid: "post1", familyId: "fam_a", pmidCount: 4 }),
      row({ cwid: "post1", familyId: "fam_b", pmidCount: 3 }),
      row({ cwid: "stu1", familyId: "fam_a", pmidCount: 1 }),
      row({ cwid: "stu1", familyId: "fam_b", pmidCount: 1 }),
    ];
    const out = apply({
      writes,
      topN: 2,
      flaggedPmids: ["1", "2", "3"],
      authorships: [
        // fac1 gets a 3-paper row: it outranks fam_b, which the cap drops.
        { pmid: "1", cwid: "fac1" },
        { pmid: "2", cwid: "fac1" },
        { pmid: "3", cwid: "fac1" },
        // post1 gets a 1-paper row: the new row itself is the one dropped.
        { pmid: "1", cwid: "post1" },
      ],
    });
    expect(out.writes.filter((w) => w.cwid === "fac1").map((w) => [w.familyId, w.pmidCount])).toEqual([
      ["fam_a", 5],
      ["fam_sr", 3],
    ]);
    expect(out.writes.filter((w) => w.cwid === "post1").map((w) => w.familyId)).toEqual(["fam_a", "fam_b"]);
    // A scholar the rule did not touch keeps the very same rows.
    expect(out.writes.filter((w) => w.cwid === "stu1")).toEqual([writes[4], writes[5]]);
    expect(out.counters).toMatchObject({ rowsCreated: 2, rowsDroppedByCap: 2 });
    for (const cwid of ["fac1", "post1", "stu1"]) {
      expect(out.writes.filter((w) => w.cwid === cwid).length).toBeLessThanOrEqual(2);
    }
  });

  it("breaks rank ties on family_id, as the mapper does", () => {
    const writes = [row({ cwid: "fac1", familyId: "fam_z", pmidCount: 1 })];
    const out = apply({ writes, topN: 1, flaggedPmids: ["1"], authorships: [{ pmid: "1", cwid: "fac1" }] });
    expect(out.writes.map((w) => w.familyId)).toEqual(["fam_sr"]);
  });

  it("counts existing rows whose label is spelled differently from the registry", () => {
    const existing = row({ cwid: "fac1", familyId: "fam_sr", familyLabel: "Systematic Review and Meta-Analysis", supercategory: SC });
    const out = apply({ writes: [existing], flaggedPmids: ["1"], authorships: [{ pmid: "1", cwid: "fac1" }] });
    expect(out.counters.labelDriftRows).toBe(1);
  });
});

describe("applySystematicReviewRule with publication suppressions", () => {
  const flaggedPmids = ["10", "11"];
  const authorships = [
    { pmid: "10", cwid: "fac1" },
    { pmid: "10", cwid: "post1" },
    { pmid: "11", cwid: "fac1" },
    { pmid: "11", cwid: "post1" },
  ];

  it("credits no one for a taken-down paper", () => {
    const out = apply({
      flaggedPmids,
      authorships,
      suppression: { darkPmids: new Set(["10"]), hiddenAuthorsByPmid: new Map() },
    });
    expect(out.counters).toMatchObject({ qualifyingPmids: 1, suppressedAuthorships: 2 });
    expect(out.writes.map((w) => [w.cwid, w.pmids])).toEqual([
      ["fac1", ["11"]],
      ["post1", ["11"]],
    ]);
  });

  it("does not credit a scholar who hid their authorship, but still credits co-authors", () => {
    const out = apply({
      flaggedPmids,
      authorships,
      suppression: {
        darkPmids: new Set(),
        hiddenAuthorsByPmid: new Map([["10", new Set(["post1"])]]),
      },
    });
    expect(out.counters).toMatchObject({ qualifyingPmids: 2, suppressedAuthorships: 1 });
    expect(out.writes.map((w) => [w.cwid, w.pmids, w.pmidCount])).toEqual([
      ["fac1", ["10", "11"], 2],
      ["post1", ["11"], 1],
    ]);
  });

  it("creates no row from a scholar's only qualifying paper when they hid it", () => {
    const out = apply({
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "fac1" },
        { pmid: "10", cwid: "post1" },
      ],
      suppression: {
        darkPmids: new Set(),
        hiddenAuthorsByPmid: new Map([["10", new Set(["post1"])]]),
      },
    });
    expect(out.counters.rowsCreated).toBe(1);
    expect(out.writes.map((w) => w.cwid)).toEqual(["fac1"]);
  });

  it("a hidden faculty authorship does not qualify the paper for anyone", () => {
    const writes = [row({ cwid: "post1" })];
    const out = apply({
      writes,
      flaggedPmids: ["10"],
      authorships: [
        { pmid: "10", cwid: "fac1" },
        { pmid: "10", cwid: "post1" },
      ],
      suppression: {
        darkPmids: new Set(),
        hiddenAuthorsByPmid: new Map([["10", new Set(["fac1"])]]),
      },
    });
    expect(out.counters).toMatchObject({ qualifyingPmids: 0, suppressedAuthorships: 1 });
    expect(out.writes).toBe(writes);
  });
});

describe("toolsRunSignature", () => {
  const base = "a".repeat(64);

  it("flag off: is the artifact signature itself", () => {
    for (const env of [{}, { [SR_RULE_FLAG]: "off" }, { [SR_RULE_FLAG]: "true" }]) {
      expect(toolsRunSignature(base, env)).toBe(base);
    }
  });

  it("flag on: a different, stable 64-char hex value, so a flip either way mismatches", () => {
    const on = toolsRunSignature(base, { [SR_RULE_FLAG]: "on" });
    expect(on).toMatch(/^[0-9a-f]{64}$/);
    expect(on).not.toBe(base);
    expect(toolsRunSignature(base, { [SR_RULE_FLAG]: "on" })).toBe(on);
    expect(toolsRunSignature("b".repeat(64), { [SR_RULE_FLAG]: "on" })).not.toBe(on);
  });
});

describe("runSystematicReviewRule", () => {
  const registry = [{ family_id: "fam_sr", label: LABEL, supercategory: SC }];
  function loaders() {
    return {
      loadFlaggedPmids: vi.fn(async () => ["10"]),
      loadFullTimeFacultyCwids: vi.fn(async () => new Set(["fac1"])),
      loadConfirmedAuthorships: vi.fn(async () => [{ pmid: "10", cwid: "fac1" }]),
    };
  }

  it("reads the flag as exactly 'on'", () => {
    expect(isSystematicReviewRuleOn({ [SR_RULE_FLAG]: "on" })).toBe(true);
    for (const v of [undefined, "", "off", "ON", "true", "1", " on"]) {
      expect(isSystematicReviewRuleOn({ [SR_RULE_FLAG]: v })).toBe(false);
    }
  });

  it("flag off: returns the same writes, reads nothing, and never looks for the family", async () => {
    const writes = [row({ cwid: "fac1" })];
    const snapshot = structuredClone(writes);
    for (const env of [{}, { [SR_RULE_FLAG]: "off" }, { [SR_RULE_FLAG]: "true" }]) {
      const l = loaders();
      const out = await runSystematicReviewRule({
        env,
        writes,
        registry: [], // would throw if the flag were on
        activeCwids: new Set(["fac1"]),
        topN: 50,
        ...l,
      });
      expect(out.status).toBe("off");
      expect(out.writes).toBe(writes);
      expect(l.loadFlaggedPmids).not.toHaveBeenCalled();
      expect(l.loadFullTimeFacultyCwids).not.toHaveBeenCalled();
      expect(l.loadConfirmedAuthorships).not.toHaveBeenCalled();
    }
    expect(writes).toEqual(snapshot);
  });

  it("flag on, family missing: throws naming the flag and the label, before any read", async () => {
    const l = loaders();
    await expect(
      runSystematicReviewRule({
        env: { [SR_RULE_FLAG]: "on" },
        writes: [],
        registry: [{ family_id: "fam_sr", label: LABEL, supercategory: "elsewhere" }],
        activeCwids: new Set(["fac1"]),
        topN: 50,
        ...l,
      }),
    ).rejects.toThrow(/METHOD_FAMILY_SR_RULE.*systematic review and meta-analysis.*computational_statistical/);
    expect(l.loadFlaggedPmids).not.toHaveBeenCalled();
  });

  it("flag on, nothing flagged yet: skips without throwing or loading authorships", async () => {
    const writes = [row({ cwid: "fac1" })];
    const l = { ...loaders(), loadFlaggedPmids: vi.fn(async () => [] as string[]) };
    const out = await runSystematicReviewRule({
      env: { [SR_RULE_FLAG]: "on" },
      writes,
      registry,
      activeCwids: new Set(["fac1"]),
      topN: 50,
      ...l,
    });
    expect(out.status).toBe("skipped_empty");
    expect(out.writes).toBe(writes);
    expect(l.loadConfirmedAuthorships).not.toHaveBeenCalled();
  });

  it("flag on: asks for authorships of the flagged pmids only and merges", async () => {
    const l = loaders();
    const out = await runSystematicReviewRule({
      env: { [SR_RULE_FLAG]: "on" },
      writes: [row({ cwid: "fac1" })],
      registry,
      familyDefById: new Map([["fam_sr", { definition: "D", definitionSource: "generated" }]]),
      activeCwids: new Set(["fac1"]),
      topN: 50,
      ...l,
    });
    expect(l.loadConfirmedAuthorships).toHaveBeenCalledWith(["10"]);
    expect(out.status).toBe("applied");
    if (out.status !== "applied") return;
    expect(out.registryMatches).toBe(1);
    expect(out.counters).toMatchObject({ qualifyingPmids: 1, scholarsCredited: 1, rowsCreated: 1 });
    expect(out.writes).toHaveLength(2);
    expect(out.writes[1]).toMatchObject({ cwid: "fac1", familyId: "fam_sr", definition: "D", pmids: ["10"] });
  });

  it("flag on: passes publication suppressions through to the merge", async () => {
    const writes = [row({ cwid: "fac1" })];
    const out = await runSystematicReviewRule({
      env: { [SR_RULE_FLAG]: "on" },
      writes,
      registry,
      activeCwids: new Set(["fac1"]),
      topN: 50,
      suppression: { darkPmids: new Set(["10"]), hiddenAuthorsByPmid: new Map() },
      ...loaders(),
    });
    expect(out.status).toBe("applied");
    if (out.status !== "applied") return;
    expect(out.counters).toMatchObject({ qualifyingPmids: 0, suppressedAuthorships: 1 });
    expect(out.writes).toBe(writes);
  });
});
