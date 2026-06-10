/**
 * #799 — pure mapper for the A2 canonical taxonomy → scholar_family rows. Reads
 * the per-scholar faculty.families[] slice ({ family_id, label, supercategory,
 * pub_count, exemplar_tool_ids[] }), resolves exemplar ids → tool display names
 * via tools[], FK-scope + field guards, dedup-by-family_id, ranking + top-N,
 * open-set supercategory counter. Verifiable without S3 or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  buildScholarFamilyWritesFromS3,
  type FacultyFamilyEntry,
} from "@/etl/tools/scholar-family-mapper-s3";
import type { ToolsArtifactSlice } from "@/etl/tools/scholar-tool-mapper-s3";

/** Build a minimal artifact slice from a per-cwid families list (+ optional tools[]). */
function artifact(
  faculty: Record<string, FacultyFamilyEntry[]>,
  tools: ToolsArtifactSlice["tools"] = [],
): ToolsArtifactSlice {
  return {
    tools,
    faculty: Object.fromEntries(
      Object.entries(faculty).map(([cwid, families]) => [cwid, { cwid, families }]),
    ),
  };
}

describe("buildScholarFamilyWritesFromS3 — canonical mapping", () => {
  it("emits one row per (cwid, family) with label, supercategory, pub_count, resolved exemplar names", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact(
        {
          aog: [
            {
              family_id: "fam_0042",
              label: "Chest radiograph models",
              supercategory: "imaging_microscopy",
              pub_count: 12,
              exemplar_tool_ids: ["tool_a", "tool_b"],
            },
          ],
        },
        [
          { canonical_tool_id: "tool_a", display_name: "CheXpert" },
          { canonical_tool_id: "tool_b", display_name: "MIMIC-CXR" },
        ],
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toEqual([
      {
        cwid: "aog",
        familyId: "fam_0042",
        familyLabel: "Chest radiograph models",
        supercategory: "imaging_microscopy",
        pmidCount: 12,
        exemplarTools: ["CheXpert", "MIMIC-CXR"], // resolved from canonical_tool_id, NOT the raw ids
        pmids: [], // none in this fixture
      },
    ]);
  });

  it("trims id whitespace, drops non-string/empty ids, and drops ids absent from tools[]", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact(
        {
          aog: [
            {
              family_id: "fam_1",
              label: "Mass-spec proteomics",
              supercategory: "omics_profiling",
              pub_count: 4,
              exemplar_tool_ids: [" tool_x ", "", 7, null, "tool_y", "ghost_id"],
            },
          ],
        },
        [
          { canonical_tool_id: "tool_x", display_name: "MaxQuant" },
          { canonical_tool_id: "tool_y", display_name: "Proteome Discoverer" },
        ],
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarTools).toEqual(["MaxQuant", "Proteome Discoverer"]); // ghost_id unresolvable → dropped
  });

  it("dedupes two ids that resolve to the same display name", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact(
        {
          aog: [
            {
              family_id: "fam_1",
              label: "X",
              supercategory: "y",
              pub_count: 1,
              exemplar_tool_ids: ["id1", "id2"],
            },
          ],
        },
        [
          { canonical_tool_id: "id1", display_name: "Same Tool" },
          { canonical_tool_id: "id2", display_name: "Same Tool" },
        ],
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarTools).toEqual(["Same Tool"]);
  });

  it("defaults exemplarTools to [] when absent or not an array", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [{ family_id: "fam_1", label: "X", supercategory: "y", pub_count: 1 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarTools).toEqual([]);
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
      artifact(
        {
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
        },
        [
          { canonical_tool_id: "lo", display_name: "Lo Tool" },
          { canonical_tool_id: "hi", display_name: "Hi Tool" },
        ],
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      familyId: "fam_1",
      pmidCount: 8,
      exemplarTools: ["Hi Tool"],
    });
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

describe("buildScholarFamilyWritesFromS3 — #819 pmids membership", () => {
  it("reads pmids as distinct digit strings, coercing numbers and dropping non-numeric/dupes", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          {
            family_id: "fam_1",
            label: "X",
            supercategory: "s",
            pub_count: 3,
            pmids: [38123456, "37999001", " 36000001 ", "37999001", "abc", null, 0],
          },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    // number→string, trimmed, deduped; "abc"/null/0 dropped → 3 distinct.
    expect(writes[0].pmids).toEqual(["38123456", "37999001", "36000001"]);
  });

  it("defaults pmids to [] when the field is absent (pre-#175 artifact)", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({ aog: [{ family_id: "fam_1", label: "X", supercategory: "s", pub_count: 2 }] }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].pmids).toEqual([]);
  });

  it("flags pmidCountMismatch only for populated rows whose distinct(pmids).length !== pub_count", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          // invariant holds → not a mismatch
          { family_id: "fam_ok", label: "OK", supercategory: "s", pub_count: 2, pmids: ["1", "2"] },
          // populated but len(1) !== pub_count(3) → mismatch
          { family_id: "fam_bad", label: "Bad", supercategory: "s", pub_count: 3, pmids: ["9"] },
          // empty pmids (pre-#175) → NOT counted as a mismatch
          { family_id: "fam_empty", label: "Empty", supercategory: "s", pub_count: 4 },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.pmidCountMismatch).toBe(1);
  });

  it("keeps the winning (max pub_count) entry's pmids when a family_id duplicates", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_1", label: "Dup", supercategory: "s", pub_count: 1, pmids: ["lo"] },
          {
            family_id: "fam_1",
            label: "Dup",
            supercategory: "s",
            pub_count: 5,
            pmids: ["11", "12", "13", "14", "15"],
          },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].pmidCount).toBe(5);
    expect(writes[0].pmids).toEqual(["11", "12", "13", "14", "15"]);
  });
});
