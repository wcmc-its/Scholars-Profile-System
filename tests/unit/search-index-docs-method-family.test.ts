/**
 * Issue #824 §4c — `buildPeopleDoc` emits a public `methodFamily` rollup of the
 * scholar's overlay-VISIBLE method-family labels + their exemplar-tool display
 * names, but ONLY when a `FamilyOverlayGate` is passed (the ETL + the live
 * reconciler pass one, loaded with `forceSensitive: true`). A gate-less call —
 * every pre-#824 caller and test — never queries `scholarFamily` and never emits
 * the field, so the produced doc stays byte-identical.
 *
 * Invariants under test:
 *  - visible families contribute their label AND their exemplar-tool names,
 *    deduped, joined by " ".
 *  - a #800-suppressed (sc,label) family is excluded.
 *  - a #801-sensitive (sc,label) family is excluded (proves the public
 *    `forceSensitive` exclusion path AT THE DOC LEVEL).
 *  - omit-on-empty: no visible family → no `methodFamily` key.
 *  - no gate arg → no `methodFamily` key, and `scholarFamily.findMany` is NEVER
 *    called (the gate-less byte-identity guarantee).
 */
import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import { familyOverlayKey, type FamilyOverlayGate } from "@/lib/api/methods-overlay";
import { buildPeopleDoc, type ScholarForIndex } from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

type ClientArg = Parameters<typeof buildPeopleDoc>[1];
type FamilyRow = {
  supercategory: string;
  familyLabel: string;
  exemplarTools: unknown;
  exemplarContexts?: unknown;
};

// Mock client whose scholarFamily sidecar returns the given rows; every other
// sidecar (center / division / leadership / mostRecentPubDate) is empty so the
// doc shape stays minimal and only `methodFamily` is exercised.
function mockClient(familyRows: ReadonlyArray<FamilyRow>): ClientArg {
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    scholarFamily: { findMany: vi.fn().mockResolvedValue(familyRows) },
  } as unknown as ClientArg;
}

function makeScholar(overrides: Partial<ScholarForIndex> = {}): ScholarForIndex {
  return {
    cwid: "self",
    slug: "self",
    preferredName: "Self",
    fullName: "Self",
    postnominal: null,
    primaryTitle: null,
    primaryDepartment: null,
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: [],
    authorships: [],
    ...overrides,
  } as ScholarForIndex;
}

const CRISPR = { supercategory: "genomics_sequencing", familyLabel: "CRISPR gene editing" };
const SCRNA = { supercategory: "genomics_sequencing", familyLabel: "Single-cell RNA sequencing" };
const SUPPRESSED = { supercategory: "computational_statistical", familyLabel: "Descriptive statistics" };
const SENSITIVE = { supercategory: "animal_cell_models", familyLabel: "Genetically engineered mouse models" };

// A gate with the suppressed + sensitive keys populated (mirrors a
// `forceSensitive: true` load where both overlays are present).
const GATE: FamilyOverlayGate = {
  suppressed: new Set([familyOverlayKey(SUPPRESSED.supercategory, SUPPRESSED.familyLabel)]),
  sensitive: new Set([familyOverlayKey(SENSITIVE.supercategory, SENSITIVE.familyLabel)]),
};

const EMPTY_GATE: FamilyOverlayGate = { suppressed: new Set(), sensitive: new Set() };

async function methodFamilyFor(
  familyRows: ReadonlyArray<FamilyRow>,
  gate: FamilyOverlayGate,
): Promise<string | undefined> {
  const doc = (await buildPeopleDoc(
    makeScholar(),
    mockClient(familyRows),
    NO_SUP,
    gate,
  )) as { methodFamily?: string };
  return doc.methodFamily;
}

describe("buildPeopleDoc — methodFamily rollup (#824 §4c)", () => {
  it("emits visible family labels + exemplar-tool names, deduped, when gate + families present", async () => {
    const methodFamily = await methodFamilyFor(
      [
        { ...CRISPR, exemplarTools: ["Cas9", "ZFN"] },
        { ...SCRNA, exemplarTools: ["Seurat", "CellRanger"] },
      ],
      EMPTY_GATE,
    );
    // Insertion-ordered union of family labels + their exemplar-tool names,
    // joined by " ".
    expect(methodFamily).toBe(
      "CRISPR gene editing Cas9 ZFN Single-cell RNA sequencing Seurat CellRanger",
    );
    expect(methodFamily).toContain("CRISPR gene editing");
    expect(methodFamily).toContain("Cas9");
    expect(methodFamily).toContain("ZFN");
    expect(methodFamily).toContain("Single-cell RNA sequencing");
    expect(methodFamily).toContain("Seurat");
    expect(methodFamily).toContain("CellRanger");
  });

  it("dedupes a label / tool name shared across families", async () => {
    const methodFamily = await methodFamilyFor(
      [
        { ...CRISPR, exemplarTools: ["Cas9"] },
        // Second family repeats the Cas9 tool name and a duplicate label string.
        { supercategory: "genomics_sequencing", familyLabel: "CRISPR gene editing", exemplarTools: ["Cas9"] },
      ],
      EMPTY_GATE,
    );
    // "CRISPR gene editing" and "Cas9" each appear once (Set-deduped).
    const occurrences = (needle: string) =>
      (methodFamily ?? "").split(" ").filter((t) => t === needle).length;
    expect(occurrences("Cas9")).toBe(1);
    // "CRISPR", "gene", "editing" each appear once despite the repeated family.
    expect(occurrences("CRISPR")).toBe(1);
    expect(occurrences("editing")).toBe(1);
  });

  it("excludes a #800-suppressed (sc,label) family", async () => {
    const methodFamily = await methodFamilyFor(
      [
        { ...CRISPR, exemplarTools: ["Cas9"] },
        { ...SUPPRESSED, exemplarTools: ["mean", "median"] },
      ],
      GATE,
    );
    expect(methodFamily).toContain("CRISPR gene editing");
    // The suppressed family's label and tool names are gone.
    expect(methodFamily).not.toContain("Descriptive statistics");
    expect(methodFamily).not.toContain("median");
  });

  it("excludes a #801-sensitive (sc,label) family (forceSensitive doc-level path)", async () => {
    const methodFamily = await methodFamilyFor(
      [
        { ...CRISPR, exemplarTools: ["Cas9"] },
        { ...SENSITIVE, exemplarTools: ["Cre-lox"] },
      ],
      GATE,
    );
    expect(methodFamily).toContain("CRISPR gene editing");
    expect(methodFamily).not.toContain("Genetically engineered mouse models");
    expect(methodFamily).not.toContain("Cre-lox");
  });

  it("omits methodFamily when every family is gated out", async () => {
    const doc = (await buildPeopleDoc(
      makeScholar(),
      mockClient([
        { ...SUPPRESSED, exemplarTools: ["mean"] },
        { ...SENSITIVE, exemplarTools: ["Cre-lox"] },
      ]),
      NO_SUP,
      GATE,
    )) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("methodFamily");
  });

  it("omits methodFamily when the scholar has no families", async () => {
    const doc = (await buildPeopleDoc(
      makeScholar(),
      mockClient([]),
      NO_SUP,
      EMPTY_GATE,
    )) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("methodFamily");
  });

  it("guards non-array / empty exemplarTools (label still emitted, no crash)", async () => {
    const methodFamily = await methodFamilyFor(
      [
        // exemplarTools is null / not an array → skipped, label survives.
        { ...CRISPR, exemplarTools: null },
        // empty / whitespace tool entries are dropped.
        { ...SCRNA, exemplarTools: ["", "  ", "Seurat"] },
      ],
      EMPTY_GATE,
    );
    expect(methodFamily).toContain("CRISPR gene editing");
    expect(methodFamily).toContain("Seurat");
    const tokens = (methodFamily ?? "").split(" ");
    expect(tokens.includes("")).toBe(false);
  });

  it("no gate arg → no methodFamily key, and scholarFamily is NEVER queried (byte-identity)", async () => {
    const client = mockClient([{ ...CRISPR, exemplarTools: ["Cas9"] }]);
    const doc = (await buildPeopleDoc(
      makeScholar(),
      client,
      NO_SUP,
      // no 4th arg
    )) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("methodFamily");
    expect(
      (client as unknown as { scholarFamily: { findMany: ReturnType<typeof vi.fn> } })
        .scholarFamily.findMany,
    ).not.toHaveBeenCalled();
  });
});

// #1119 — the sibling methodContext field: the visible families' tool-USAGE
// snippets (values of the exemplar_contexts JSON map), deduped + joined. Same
// gate as methodFamily; omit-on-empty.
async function methodContextFor(
  familyRows: ReadonlyArray<FamilyRow>,
  gate: FamilyOverlayGate,
): Promise<string | undefined> {
  const doc = (await buildPeopleDoc(makeScholar(), mockClient(familyRows), NO_SUP, gate)) as {
    methodContext?: string;
  };
  return doc.methodContext;
}

describe("buildPeopleDoc — methodContext rollup (#1119)", () => {
  it("emits the visible families' usage snippets, deduped", async () => {
    const methodContext = await methodContextFor(
      [
        {
          ...CRISPR,
          exemplarTools: ["Cas9"],
          exemplarContexts: { Cas9: "introduced a double-strand break at the target locus" },
        },
        {
          ...SCRNA,
          exemplarTools: ["Seurat"],
          exemplarContexts: { Seurat: "clustered single cells into transcriptional subtypes" },
        },
      ],
      EMPTY_GATE,
    );
    expect(methodContext).toContain("introduced a double-strand break at the target locus");
    expect(methodContext).toContain("clustered single cells into transcriptional subtypes");
  });

  it("excludes a gated family's usage snippet (same overlay gate as methodFamily)", async () => {
    const methodContext = await methodContextFor(
      [
        {
          ...CRISPR,
          exemplarTools: ["Cas9"],
          exemplarContexts: { Cas9: "edited the safe-harbor locus in primary T cells" },
        },
        {
          ...SENSITIVE,
          exemplarTools: ["Cre-lox"],
          exemplarContexts: { "Cre-lox": "conditional knockout restricted to hepatocytes" },
        },
      ],
      GATE,
    );
    expect(methodContext).toContain("edited the safe-harbor locus");
    expect(methodContext).not.toContain("conditional knockout");
  });

  it("omits methodContext when no visible family carries a snippet", async () => {
    const doc = (await buildPeopleDoc(
      makeScholar(),
      // exemplarTools present, but no exemplarContexts → no snippet.
      mockClient([{ ...CRISPR, exemplarTools: ["Cas9"] }]),
      NO_SUP,
      EMPTY_GATE,
    )) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("methodContext");
    // ...while methodFamily is still emitted (the fields are independent).
    expect(doc).toHaveProperty("methodFamily");
  });
});
