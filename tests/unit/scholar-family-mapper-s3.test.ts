/**
 * #799 — pure mapper for the A2 canonical taxonomy → scholar_family rows. Reads
 * the per-scholar faculty.families[] slice ({ family_id, label, supercategory,
 * pub_count, exemplar_tool_ids[] }), FK-scope + field guards, dedup-by-family_id,
 * ranking + top-N, open-set supercategory counter. Verifiable without S3 or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  buildScholarFamilyWritesFromS3,
  type FacultyFamilyEntry,
} from "@/etl/tools/scholar-family-mapper-s3";
import type { ToolsArtifactSlice } from "@/etl/tools/scholar-tool-mapper-s3";

/** Build a minimal artifact slice from a per-cwid families list. */
function artifact(faculty: Record<string, FacultyFamilyEntry[]>): ToolsArtifactSlice {
  return {
    tools: [],
    faculty: Object.fromEntries(
      Object.entries(faculty).map(([cwid, families]) => [cwid, { cwid, families }]),
    ),
  };
}

describe("buildScholarFamilyWritesFromS3 — canonical mapping", () => {
  it("emits one row per (cwid, family) with label, supercategory, pub_count, exemplars", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          {
            family_id: "fam_0042",
            label: "Confocal microscopy",
            supercategory: "imaging_microscopy",
            pub_count: 12,
            exemplar_tool_ids: ["tool_a", "tool_b"],
          },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toEqual([
      {
        cwid: "aog",
        familyId: "fam_0042",
        familyLabel: "Confocal microscopy",
        supercategory: "imaging_microscopy",
        pmidCount: 12,
        exemplarToolIds: ["tool_a", "tool_b"],
      },
    ]);
  });

  it("trims whitespace and drops non-string / empty exemplar ids", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          {
            family_id: "fam_1",
            label: "Mass-spec proteomics",
            supercategory: "omics_profiling",
            pub_count: 4,
            exemplar_tool_ids: [" tool_x ", "", 7, null, "tool_y"],
          },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarToolIds).toEqual(["tool_x", "tool_y"]);
  });

  it("defaults exemplar_tool_ids to [] when absent or not an array", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [{ family_id: "fam_1", label: "X", supercategory: "y", pub_count: 1 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarToolIds).toEqual([]);
  });
});

describe("buildScholarFamilyWritesFromS3 — guards", () => {
  it("skips scholars whose cwid is out of FK scope", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        stranger: [{ family_id: "fam_1", label: "X", supercategory: "y", pub_count: 3 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingCwid).toBe(1);
  });

  it("drops families missing family_id, label, or supercategory", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "", label: "No id", supercategory: "y", pub_count: 5 },
          { family_id: "fam_2", label: "", supercategory: "y", pub_count: 5 },
          { family_id: "fam_3", label: "No supercat", supercategory: "", pub_count: 5 },
          { family_id: "fam_4", label: null, supercategory: "y", pub_count: 5 }, // null label is legal upstream
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingFields).toBe(4);
  });

  it("drops families with a non-positive or non-numeric pub_count (nothing to show)", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_1", label: "Zero", supercategory: "y", pub_count: 0 },
          { family_id: "fam_2", label: "Missing", supercategory: "y" },
          { family_id: "fam_3", label: "NaN", supercategory: "y", pub_count: Number.NaN },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingFields).toBe(3);
  });
});

describe("buildScholarFamilyWritesFromS3 — ranking, cap, dedup", () => {
  it("keeps the top families per scholar by (pub_count desc, then family_id asc)", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_b", label: "B", supercategory: "s", pub_count: 2 },
          { family_id: "fam_a", label: "A", supercategory: "s", pub_count: 2 }, // tie → family_id asc wins
          { family_id: "fam_c", label: "C", supercategory: "s", pub_count: 9 },
        ],
      }),
      { ourCwidSet: new Set(["aog"]), topNPerScholar: 2 },
    );
    expect(writes.map((w) => w.familyLabel)).toEqual(["C", "A"]); // C leads on count; A beats B on family_id tiebreak
    expect(writes.map((w) => w.pmidCount)).toEqual([9, 2]);
  });

  it("dedupes a duplicate family_id within a scholar, keeping the max pub_count + its exemplars", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          {
            family_id: "fam_1",
            label: "Dup",
            supercategory: "s",
            pub_count: 3,
            exemplar_tool_ids: ["lo"],
          },
          {
            family_id: "fam_1",
            label: "Dup",
            supercategory: "s",
            pub_count: 8,
            exemplar_tool_ids: ["hi"],
          },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ familyId: "fam_1", pmidCount: 8, exemplarToolIds: ["hi"] });
  });
});

describe("buildScholarFamilyWritesFromS3 — open-set supercategory guard", () => {
  it("counts (but still writes) a supercategory outside the supplied known set", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_1", label: "Known", supercategory: "imaging_microscopy", pub_count: 2 },
          {
            family_id: "fam_2",
            label: "Drifted",
            supercategory: "brand_new_15th_supercat",
            pub_count: 2,
          },
        ],
      }),
      {
        ourCwidSet: new Set(["aog"]),
        knownSupercategories: new Set(["imaging_microscopy"]),
      },
    );
    expect(res.writes).toHaveLength(2); // open-set: the unknown one is NOT dropped
    expect(res.unknownSupercategory).toBe(1);
  });

  it("leaves unknownSupercategory at 0 when no known set is supplied", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [{ family_id: "fam_1", label: "X", supercategory: "anything", pub_count: 1 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.unknownSupercategory).toBe(0);
  });
});
