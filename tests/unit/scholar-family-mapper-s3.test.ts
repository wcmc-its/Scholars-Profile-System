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
import { buildToolContextIndex } from "@/etl/tools/tool-context";

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
        exemplarContexts: {}, // #1119 — no toolContext index supplied → {}
        pmids: [], // none in this fixture
        definition: null, // #879 — no familyDefById supplied → null
        definitionSource: null,
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

  it("collapses two family_ids sharing one (supercategory, label), keeping the max pub_count + counting it (#989)", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_old", label: "CRISPR screens", supercategory: "genomics", pub_count: 3 },
          { family_id: "fam_new", label: "CRISPR screens", supercategory: "genomics", pub_count: 9 },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    // One row for the stable (sc,label) identity — NOT two — so groupBy([sc,label])
    // `_count.cwid` counts this member once and the per-row chips can't duplicate.
    expect(res.writes).toHaveLength(1);
    expect(res.writes[0]).toMatchObject({
      familyId: "fam_new", // the stronger pub_count wins
      familyLabel: "CRISPR screens",
      supercategory: "genomics",
      pmidCount: 9,
    });
    expect(res.duplicateFamilyLabel).toBe(1);
  });

  it("does NOT collapse the same label under a different supercategory (distinct stable identities)", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_1", label: "Models", supercategory: "imaging", pub_count: 2 },
          { family_id: "fam_2", label: "Models", supercategory: "omics", pub_count: 2 },
        ],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toHaveLength(2);
    expect(res.duplicateFamilyLabel).toBe(0);
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

describe("buildScholarFamilyWritesFromS3 — #879 family definition join", () => {
  it("joins definition + definitionSource from familyDefById by family_id (+ counts join hits)", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({
        aog: [
          { family_id: "fam_1", label: "CRISPR screens", supercategory: "s", pub_count: 4 },
          { family_id: "fam_2", label: "Mass spec", supercategory: "s", pub_count: 2 },
        ],
      }),
      {
        ourCwidSet: new Set(["aog"]),
        familyDefById: new Map([
          // em-dash kept verbatim (house style — no transform)
          ["fam_1", { definition: "Pooled loss-of-function screens—including X.", definitionSource: "generated" }],
          // fam_2 intentionally absent → its row stays null
        ]),
      },
    );
    const byId = Object.fromEntries(res.writes.map((w) => [w.familyId, w]));
    expect(byId.fam_1.definition).toBe("Pooled loss-of-function screens—including X.");
    expect(byId.fam_1.definitionSource).toBe("generated");
    // A family with no entry in the index keeps null (benign, never dropped).
    expect(byId.fam_2.definition).toBeNull();
    expect(byId.fam_2.definitionSource).toBeNull();
    // Observability: exactly one row got a non-null definition from the join.
    expect(res.definitionJoinHits).toBe(1);
  });

  it("leaves both null when no familyDefById is supplied (pre-v3 artifact)", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact({ aog: [{ family_id: "fam_1", label: "X", supercategory: "s", pub_count: 1 }] }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].definition).toBeNull();
    expect(writes[0].definitionSource).toBeNull();
  });

  it("never drops a family for a missing definition (a join miss is benign)", () => {
    const res = buildScholarFamilyWritesFromS3(
      artifact({ aog: [{ family_id: "fam_1", label: "Keep me", supercategory: "s", pub_count: 7 }] }),
      { ourCwidSet: new Set(["aog"]), familyDefById: new Map() },
    );
    expect(res.writes).toHaveLength(1);
    expect(res.skippedMissingFields).toBe(0);
    expect(res.writes[0].definition).toBeNull();
  });
});

describe("buildScholarFamilyWritesFromS3 — #1119 exemplar contexts", () => {
  it("resolves a best snippet per exemplar tool, keyed by display name, scoped to family pmids", () => {
    const toolContext = buildToolContextIndex({
      tool_a: {
        "111": "CheXpert labels chest radiographs across 14 observations using an uncertainty-aware policy",
        "999": "an out-of-family paper that should be ignored by the pmid scope filter entirely",
      },
      tool_b: {
        "222": "MIMIC-CXR is a large public dataset of chest radiographs with free-text reports",
      },
    });
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact(
        {
          aog: [
            {
              family_id: "fam_0042",
              label: "Chest radiograph models",
              supercategory: "imaging_microscopy",
              pub_count: 2,
              exemplar_tool_ids: ["tool_a", "tool_b"],
              pmids: ["111", "222"], // family member pmids → scope
            },
          ],
        },
        [
          { canonical_tool_id: "tool_a", display_name: "CheXpert" },
          { canonical_tool_id: "tool_b", display_name: "MIMIC-CXR" },
        ],
      ),
      { ourCwidSet: new Set(["aog"]), toolContext },
    );
    expect(writes[0].exemplarContexts).toEqual({
      CheXpert: "CheXpert labels chest radiographs across 14 observations using an uncertainty-aware policy",
      "MIMIC-CXR": "MIMIC-CXR is a large public dataset of chest radiographs with free-text reports",
    });
    // pmid 999 (out of the family's pmids) was not chosen for CheXpert.
    expect(writes[0].exemplarContexts.CheXpert).not.toContain("out-of-family");
  });

  it("yields {} when no toolContext index is supplied", () => {
    const { writes } = buildScholarFamilyWritesFromS3(
      artifact(
        {
          aog: [
            {
              family_id: "fam_1",
              label: "F",
              supercategory: "s",
              pub_count: 1,
              exemplar_tool_ids: ["tool_a"],
              pmids: ["111"],
            },
          ],
        },
        [{ canonical_tool_id: "tool_a", display_name: "CheXpert" }],
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].exemplarContexts).toEqual({});
  });
});
