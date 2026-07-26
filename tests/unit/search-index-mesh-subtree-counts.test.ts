/**
 * D-exact (search reason-from-doc, commit 2) — `meshSubtreeCounts` on the people
 * doc. For each non-suppressed pub, the scholar's descriptors are folded up to
 * their ANCESTOR concepts and UNIONED within the pub, so a pub tagged by two
 * descriptors in the same subtree counts ONCE for the shared ancestor (the
 * double-count trap). The query path then reads `meshSubtreeCounts[conceptUi]`
 * with an O(1) lookup instead of a publications-index agg.
 */
import { describe, it, expect, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPeopleDoc,
  loadMeshAncestorContext,
  type MeshAncestorContext,
  type ScholarForIndex,
} from "@/lib/search-index-docs";

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

function scholarWithPubs(
  pubs: ReadonlyArray<ReadonlyArray<MeshTerm>>,
): ScholarForIndex {
  const s: Partial<ScholarForIndex> = {
    cwid: "test1234",
    slug: "test",
    preferredName: "Test Scholar",
    fullName: "Test Scholar",
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
    authorships: pubs.map((terms, i) => ({
      pmid: String(i + 1),
      cwid: "test1234",
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
//   C04            Neoplasms              -> Dneo
//   C04.557        by Histologic Type     -> Dhist
//   C04.557.470    Glandular              -> Dgland
//   C04.557.470.200  Adenocarcinoma       -> Dadeno
//   C04.557.470.300  Cystadenocarcinoma   -> Dcyst
// loadMeshAncestorContext reads `mesh_descriptor.tree_numbers` via prisma; mock
// that one query so the test stays DB-free.
function meshAncestors(): Promise<MeshAncestorContext> {
  const rows = [
    { descriptorUi: "Dneo", treeNumbers: ["C04"] },
    { descriptorUi: "Dhist", treeNumbers: ["C04.557"] },
    { descriptorUi: "Dgland", treeNumbers: ["C04.557.470"] },
    { descriptorUi: "Dadeno", treeNumbers: ["C04.557.470.200"] },
    { descriptorUi: "Dcyst", treeNumbers: ["C04.557.470.300"] },
  ];
  const client = {
    meshDescriptor: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as Parameters<typeof loadMeshAncestorContext>[0];
  return loadMeshAncestorContext(client);
}

describe("buildPeopleDoc — meshSubtreeCounts (D-exact)", () => {
  it("counts a pub ONCE per ancestor concept even when two in-subtree descriptors fire", async () => {
    const ctx = await meshAncestors();
    // ONE pub tagged by Adenocarcinoma AND Cystadenocarcinoma — both descend from
    // Dgland / Dhist / Dneo. The shared ancestors must count 1, not 2.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [
          { ui: "Dadeno", label: "Adenocarcinoma" },
          { ui: "Dcyst", label: "Cystadenocarcinoma" },
        ],
      ]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { meshSubtreeCounts?: Record<string, number> };

    expect(doc.meshSubtreeCounts).toBeDefined();
    const counts = doc.meshSubtreeCounts!;
    // Shared ancestors — counted once (the dedupe crux):
    expect(counts.Dneo).toBe(1);
    expect(counts.Dhist).toBe(1);
    expect(counts.Dgland).toBe(1);
    // Each leaf concept itself — counted once (self-inclusive ancestor walk):
    expect(counts.Dadeno).toBe(1);
    expect(counts.Dcyst).toBe(1);
  });

  it("accumulates distinct-pub counts across pubs per concept", async () => {
    const ctx = await meshAncestors();
    // Pub 1: Adenocarcinoma. Pub 2: Cystadenocarcinoma. The shared ancestors are
    // tagged by 2 distinct pubs; each leaf by 1.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
        [{ ui: "Dcyst", label: "Cystadenocarcinoma" }],
      ]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as { meshSubtreeCounts?: Record<string, number> };

    const counts = doc.meshSubtreeCounts!;
    expect(counts.Dneo).toBe(2);
    expect(counts.Dhist).toBe(2);
    expect(counts.Dgland).toBe(2);
    expect(counts.Dadeno).toBe(1);
    expect(counts.Dcyst).toBe(1);
  });

  it("omits the field entirely when no ancestor context is passed (byte-identical legacy doc)", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithPubs([[{ ui: "Dadeno", label: "Adenocarcinoma" }]]),
      mockClient(),
      NO_SUP,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("meshSubtreeCounts");
  });

  it("omits the field when the scholar has no MeSH-tagged pub", async () => {
    const ctx = await meshAncestors();
    const doc = (await buildPeopleDoc(
      scholarWithPubs([[]]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("meshSubtreeCounts");
  });

  it("excludes an author-hidden pub from the counts", async () => {
    const ctx = await meshAncestors();
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["test1234"])]]),
    };
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dadeno", label: "Adenocarcinoma" }], // hidden
        [{ ui: "Dcyst", label: "Cystadenocarcinoma" }], // visible
      ]),
      mockClient(),
      sup,
      undefined,
      ctx,
    )) as { meshSubtreeCounts?: Record<string, number> };

    const counts = doc.meshSubtreeCounts!;
    // Only the visible pub contributes: shared ancestors = 1, Dadeno absent.
    expect(counts.Dneo).toBe(1);
    expect(counts.Dcyst).toBe(1);
    expect(counts.Dadeno).toBeUndefined();
  });
});

// #1959 — every pub built by `scholarWithPubs` is MIDDLE-author (isFirst/isLast
// false), so a descriptor on exactly one pub is dropped by the min-evidence gate
// (`distinctPubs < 2 && !hasFirstOrLast`). That is the cohort: the card counted the
// pub in the ungated `meshSubtreeCounts` while `alsoParent` denied the tag existed.
describe("buildPeopleDoc — publicationMeshUiBelowThreshold (#1959)", () => {
  type Doc = { publicationMeshUi?: string[]; publicationMeshUiBelowThreshold?: string[] };

  it("emits a dropped ANCESTOR of a surviving descriptor", async () => {
    const ctx = await meshAncestors();
    // Dadeno on 2 pubs -> survives. Dneo (its ancestor) on 1 middle-author pub -> dropped.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dneo", label: "Neoplasms" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
      ]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Doc;

    expect(doc.publicationMeshUi).toEqual(["Dadeno"]);
    expect(doc.publicationMeshUiBelowThreshold).toEqual(["Dneo"]);
    // The pub the old `alsoParent: false` denied is inside the ungated count.
    expect((doc as { meshSubtreeCounts: Record<string, number> }).meshSubtreeCounts.Dneo).toBe(3);
  });

  it("drops a below-gate descriptor that is NOT an ancestor of a surviving one", async () => {
    const ctx = await meshAncestors();
    // Dcyst is a SIBLING of Dadeno — nothing `alsoParent` can ever consult.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dcyst", label: "Cystadenocarcinoma" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
      ]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Doc;

    expect(doc.publicationMeshUi).toEqual(["Dadeno"]);
    expect(doc).not.toHaveProperty("publicationMeshUiBelowThreshold");
  });

  it("omits the field when nothing was dropped", async () => {
    const ctx = await meshAncestors();
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
      ]),
      mockClient(),
      NO_SUP,
      undefined,
      ctx,
    )) as Doc;

    expect(doc.publicationMeshUi).toEqual(["Dadeno"]);
    expect(doc).not.toHaveProperty("publicationMeshUiBelowThreshold");
  });

  it("omits the field entirely when no ancestor context is passed", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        [{ ui: "Dneo", label: "Neoplasms" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
        [{ ui: "Dadeno", label: "Adenocarcinoma" }],
      ]),
      mockClient(),
      NO_SUP,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("publicationMeshUiBelowThreshold");
  });
});
