/**
 * #1367 Gap 1 — `meshTaggedPubCount` + `clinicalOnTopicCounts` on the people doc.
 *
 * `meshTaggedPubCount` = the scholar's "eligible" pool: the count of visible pubs
 * carrying ANY MeSH descriptor at all (ungated by the min-evidence threshold —
 * unlike `publicationMeshUi`, this is a raw per-pub tally).
 *
 * `clinicalOnTopicCounts[specialty]` = for each visible pub, build its tree-number
 * ANCESTOR closure and test every curated specialty anchor against it — union-
 * first-then-count-once-per-pub-per-specialty, the same discipline `meshSubtreeCounts`
 * uses (see `search-index-mesh-subtree-counts.test.ts`, the sibling this file mirrors).
 *
 * Both are DISPLAY-ONLY for the clinical evidence line's "N of M eligible
 * publications" — neither is read by `selectEvidence`'s count-gated clinical-vs-
 * tagged precedence, which stays unchanged (covered by `result-evidence-select.test.ts`).
 */
import { describe, it, expect, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPeopleDoc,
  type MeshAncestorContext,
  type ScholarForIndex,
} from "@/lib/search-index-docs";
import { buildMeshAncestorIndex } from "@/lib/mesh-tree-ancestors";
import { anchorKey } from "@/lib/clinical-mesh-anchors";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

type MeshTerm = { ui: string | null; label: string };

function mockClient() {
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as Parameters<typeof buildPeopleDoc>[1];
}

function scholarWithClinicalPubs(
  popsSpecialties: string[],
  pubs: ReadonlyArray<ReadonlyArray<MeshTerm>>,
): ScholarForIndex {
  const s: Partial<ScholarForIndex> = {
    cwid: "clin1234",
    slug: "clin",
    preferredName: "Clin Scholar",
    fullName: "Clin Scholar",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Dept",
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: [],
    popsSpecialties,
    popsBoardCertifications: [],
    popsExpertise: [],
    authorships: pubs.map((terms, i) => ({
      pmid: String(i + 1),
      cwid: "clin1234",
      isConfirmed: true,
      isFirst: false,
      isLast: false,
      isPenultimate: false,
      position: 3,
      totalAuthors: 6,
      publication: {
        title: `p${i + 1}`,
        meshTerms: terms,
        abstract: null,
      },
    })) as unknown as ScholarForIndex["authorships"],
  };
  return s as ScholarForIndex;
}

// MeSH-shaped tree slice:
//   C14              Cardiovascular Diseases
//   C14.280          Heart Diseases            (Cardiology anchor D-code #1)
//   C14.280.400      Myocardial Infarction     (pub descriptor, under D-code #1)
//   C14.907          Vascular Diseases         (Cardiology anchor D-code #2, #2106/#2107)
//   C14.907.253      Coronary Artery Disease   (pub descriptor, under D-code #2)
//   H01.158          (an unrelated non-disease discipline tree — no anchor reaches it)
//
// `specialtyAnchorUis` maps a human specialty name to the descriptor UIs curated for
// it (mirrors `etl/clinical-mesh/specialty-anchors.csv` — a specialty MAY have more
// than one D-code, #2106/#2107).
function meshAncestors(specialtyAnchorUis: Record<string, string[]>): MeshAncestorContext {
  const rows = [
    { ui: "Dcv", treeNumbers: ["C14"] },
    { ui: "Dheart", treeNumbers: ["C14.280"] },
    { ui: "Dmi", treeNumbers: ["C14.280.400"] },
    { ui: "Dvasc", treeNumbers: ["C14.907"] },
    { ui: "Dcad", treeNumbers: ["C14.907.253"] },
    { ui: "Dunrelated", treeNumbers: ["H01.158"] },
  ];
  const treeNumbersByUi = new Map(rows.map((r) => [r.ui, r.treeNumbers]));
  const index = buildMeshAncestorIndex(rows);
  const specialtyAnchors = new Map(
    Object.entries(specialtyAnchorUis).map(([specialty, uis]) => [anchorKey(specialty), uis]),
  );
  return { index, treeNumbersByUi, specialtyAnchors };
}

describe("buildPeopleDoc — meshTaggedPubCount (#1367 Gap 1)", () => {
  it("(a) counts a pub once per any-MeSH-tag pub, ignoring an untagged pub", async () => {
    const ctx = meshAncestors({});
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(
        [],
        [
          [{ ui: "Dmi", label: "Myocardial Infarction" }], // tagged
          [], // no mesh at all
        ],
      ),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { meshTaggedPubCount?: number };

    expect(doc.meshTaggedPubCount).toBe(1);
  });

  it("(a) omitted entirely (zero) when the scholar has no MeSH-tagged pub", async () => {
    const ctx = meshAncestors({});
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs([], [[]]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("meshTaggedPubCount");
  });

  it("omitted entirely when no ancestor context is passed (byte-identical legacy doc)", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs([], [[{ ui: "Dmi", label: "Myocardial Infarction" }]]),
      mockClient(),
      NO_SUP,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("meshTaggedPubCount");
  });
});

describe("buildPeopleDoc — clinicalOnTopicCounts (#1367 Gap 1)", () => {
  it("(b) counts a pub ONCE for a specialty even when it matches via two different tree numbers reached by two different anchor D-codes (#2106/#2107)", async () => {
    const ctx = meshAncestors({ Cardiology: ["Dheart", "Dvasc"] }); // two D-codes -> C14.280 + C14.907
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(
        ["Cardiology"],
        [
          [
            { ui: "Dmi", label: "Myocardial Infarction" }, // under C14.280 (D-code #1's branch)
            { ui: "Dcad", label: "Coronary Artery Disease" }, // under C14.907 (D-code #2's branch)
          ],
        ],
      ),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { clinicalOnTopicCounts?: Record<string, number> };

    expect(doc.clinicalOnTopicCounts).toEqual({ Cardiology: 1 });
  });

  it("(c) a pub that matches ZERO clinical anchors does not appear in the map at all", async () => {
    const ctx = meshAncestors({ Cardiology: ["Dheart"] }); // C14.280 only
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(
        ["Cardiology"],
        [
          [{ ui: "Dmi", label: "Myocardial Infarction" }], // on-topic -> counted
          [{ ui: "Dunrelated", label: "Unrelated Discipline" }], // off-topic -> NOT counted
        ],
      ),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { clinicalOnTopicCounts?: Record<string, number> };

    expect(doc.clinicalOnTopicCounts).toEqual({ Cardiology: 1 });
  });

  it("(c) a specialty with no matching pub anywhere in the scholar's output is absent from the map (never a 0)", async () => {
    // Nephrology's own anchor tree (C14.907, borrowed from Dvasc for this fixture)
    // never intersects the scholar's one Cardiology-only pub.
    const ctx = meshAncestors({ Cardiology: ["Dheart"], Nephrology: ["Dvasc"] });
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(
        ["Cardiology", "Nephrology"],
        [[{ ui: "Dmi", label: "Myocardial Infarction" }]],
      ),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { clinicalOnTopicCounts?: Record<string, number> };

    expect(doc.clinicalOnTopicCounts).toEqual({ Cardiology: 1 });
    expect(doc.clinicalOnTopicCounts).not.toHaveProperty("Nephrology");
  });

  it("accumulates distinct-pub counts across pubs for the same specialty", async () => {
    const ctx = meshAncestors({ Cardiology: ["Dheart"] });
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(
        ["Cardiology"],
        [
          [{ ui: "Dmi", label: "Myocardial Infarction" }],
          [{ ui: "Dmi", label: "Myocardial Infarction" }],
        ],
      ),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { clinicalOnTopicCounts?: Record<string, number> };

    expect(doc.clinicalOnTopicCounts).toEqual({ Cardiology: 2 });
  });

  it("omitted entirely when no specialty has a curated MeSH anchor (clinicalAnchorResult.anchors is empty)", async () => {
    const ctx = meshAncestors({}); // no curated anchors at all
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(["Cardiology"], [[{ ui: "Dmi", label: "Myocardial Infarction" }]]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("clinicalOnTopicCounts");
  });

  it("omitted entirely when no ancestor context is passed", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithClinicalPubs(["Cardiology"], [[{ ui: "Dmi", label: "Myocardial Infarction" }]]),
      mockClient(),
      NO_SUP,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("clinicalOnTopicCounts");
  });
});
