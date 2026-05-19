import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPeopleDoc,
  buildPublicationDoc,
  type PublicationForIndex,
  type ScholarForIndex,
} from "@/lib/search-index-docs";

// Empty suppression set — the C2 baseline assumption is "no suppressions";
// the C3-updated builder signature requires it explicitly. With empty sup
// the suppression logic is a no-op, so the C2 snapshots must NOT change.
const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

/**
 * C2 doc-diff harness — golden snapshots for the OpenSearch document shapes
 * (Phase 4b plan §5.1).
 *
 * Hand-crafted Prisma-row fixtures exercise each branch of `buildPublicationDoc`
 * and `buildPeopleDoc` — omit-on-empty fields, the `wcmAuthorPositions` union,
 * the `wcmAuthorRows` active-scholar filter, the `isComplete` gate, the
 * deptCode + center fold, etc. The committed snapshots are the permanent
 * regression guard for every future builder refactor — including the C3 / C4
 * suppression-filter additions, which must NOT change the no-suppression
 * baseline these snapshots capture.
 *
 * These tests have no DB and no OpenSearch dependency. The mocked Prisma
 * client supplies the per-scholar `mostRecentPubDate` query result.
 */

// Mock client whose mostRecentPubDate query returns the given dates.
function mockPeopleClient(
  pubDates: ReadonlyArray<Date | null>,
): Parameters<typeof buildPeopleDoc>[2] {
  return {
    publicationAuthor: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          pubDates.map((d) => ({ publication: { dateAddedToEntrez: d } })),
        ),
    },
  } as unknown as Parameters<typeof buildPeopleDoc>[2];
}

// Fixed endDate well in the future — keeps `hasActiveGrants` /
// `activePiGrantCount` stable across snapshot runs without pinning a date.
const FAR_FUTURE = new Date("2099-12-31T00:00:00.000Z");

describe("buildPublicationDoc — golden snapshots", () => {
  it("captures a fully-populated publication (every optional field set)", () => {
    const p: Partial<PublicationForIndex> = {
      pmid: "12345",
      title: "Cardiac repair after myocardial infarction",
      journal: "Journal of Cardiology",
      year: 2024,
      publicationType: "Journal Article",
      citationCount: 17,
      dateAddedToEntrez: new Date("2024-06-15T00:00:00.000Z"),
      doi: "10.1234/jcard.2024.001",
      pmcid: "PMC12345678",
      pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345/",
      abstract: "We study cardiac repair following acute MI.",
      impactScore: {
        toNumber: () => 0.87,
      } as unknown as PublicationForIndex["impactScore"],
      impactJustification: "First-author paper in a Q1 cardiology journal.",
      meshTerms: [
        { ui: "D006333", label: "Heart" },
        { ui: "D009203", label: "Myocardial Infarction" },
      ] as unknown as PublicationForIndex["meshTerms"],
      authors: [
        {
          pmid: "12345",
          cwid: "ann1234",
          externalName: null,
          isConfirmed: true,
          isFirst: true,
          isLast: false,
          isPenultimate: false,
          position: 1,
          totalAuthors: 3,
          scholar: {
            cwid: "ann1234",
            slug: "ann-pi",
            preferredName: "Ann Researcher",
            deletedAt: null,
            status: "active",
          },
        },
        {
          pmid: "12345",
          cwid: null,
          externalName: "External Coauthor",
          isConfirmed: false,
          isFirst: false,
          isLast: false,
          isPenultimate: true,
          position: 2,
          totalAuthors: 3,
          scholar: null,
        },
        {
          pmid: "12345",
          cwid: "bob5678",
          externalName: null,
          isConfirmed: true,
          isFirst: false,
          isLast: true,
          isPenultimate: false,
          position: 3,
          totalAuthors: 3,
          scholar: {
            cwid: "bob5678",
            slug: "bob-senior",
            preferredName: "Bob Senior",
            deletedAt: null,
            status: "active",
          },
        },
      ] as unknown as PublicationForIndex["authors"],
      publicationTopics: [
        { parentTopicId: "topic-heart" },
        { parentTopicId: "topic-mi" },
      ],
    };
    expect(buildPublicationDoc(p as PublicationForIndex, NO_SUP)).toMatchSnapshot();
  });

  it("captures the omit-on-empty branches (no topics, null impact, blank mesh)", () => {
    const p: Partial<PublicationForIndex> = {
      pmid: "99999",
      title: "Editorial",
      journal: "Some Journal",
      year: 2020,
      publicationType: "Editorial",
      citationCount: 0,
      dateAddedToEntrez: null,
      doi: null,
      pmcid: null,
      pubmedUrl: null,
      abstract: null,
      impactScore: null,
      impactJustification: null,
      meshTerms: [] as unknown as PublicationForIndex["meshTerms"],
      authors: [
        {
          pmid: "99999",
          cwid: "ann1234",
          externalName: null,
          isConfirmed: true,
          isFirst: true,
          isLast: true,
          isPenultimate: false,
          position: 1,
          totalAuthors: 1,
          scholar: {
            cwid: "ann1234",
            slug: "ann-pi",
            preferredName: "Ann Researcher",
            deletedAt: null,
            status: "active",
          },
        },
      ] as unknown as PublicationForIndex["authors"],
      publicationTopics: [],
    };
    expect(buildPublicationDoc(p as PublicationForIndex, NO_SUP)).toMatchSnapshot();
  });

  it("filters wcmAuthors to ACTIVE non-deleted scholars (deleted coauthor dropped)", () => {
    const p: Partial<PublicationForIndex> = {
      pmid: "44444",
      title: "Paper with a deleted coauthor",
      journal: "J",
      year: 2024,
      publicationType: "Journal Article",
      citationCount: 0,
      dateAddedToEntrez: null,
      doi: null,
      pmcid: null,
      pubmedUrl: null,
      abstract: null,
      impactScore: null,
      impactJustification: null,
      meshTerms: [] as unknown as PublicationForIndex["meshTerms"],
      authors: [
        {
          pmid: "44444",
          cwid: "ann1234",
          externalName: null,
          isConfirmed: true,
          isFirst: true,
          isLast: false,
          isPenultimate: false,
          position: 1,
          totalAuthors: 2,
          scholar: {
            cwid: "ann1234",
            slug: "ann",
            preferredName: "Ann",
            deletedAt: null,
            status: "active",
          },
        },
        {
          pmid: "44444",
          cwid: "deleted",
          externalName: null,
          isConfirmed: true,
          isFirst: false,
          isLast: true,
          isPenultimate: false,
          position: 2,
          totalAuthors: 2,
          scholar: {
            cwid: "deleted",
            slug: "deleted",
            preferredName: "Deleted Coauthor",
            deletedAt: new Date("2023-01-01T00:00:00.000Z"),
            status: "active",
          },
        },
      ] as unknown as PublicationForIndex["authors"],
      publicationTopics: [],
    };
    const doc = buildPublicationDoc(p as PublicationForIndex, NO_SUP);
    expect(doc).toMatchSnapshot();
    // Spot-assertion outside the snapshot — the deleted coauthor is filtered.
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["ann1234"]);
  });
});

describe("buildPeopleDoc — golden snapshots", () => {
  it("captures a fully-populated scholar (active PI, dept + division + center)", async () => {
    const s: Partial<ScholarForIndex> = {
      cwid: "ann1234",
      slug: "ann-researcher",
      preferredName: "Ann M. Researcher",
      fullName: "Ann Marie Researcher",
      postnominal: "MD",
      primaryTitle: "Associate Professor",
      primaryDepartment: "Department of Medicine",
      overview: "<p>Bio.</p>",
      roleCategory: "faculty",
      deptCode: "MED",
      divCode: "CARD",
      department: { name: "Medicine" },
      division: { name: "Cardiology" },
      topicAssignments: [
        { cwid: "ann1234", topic: "cardiology", score: 0.8 },
      ] as unknown as ScholarForIndex["topicAssignments"],
      grants: [
        {
          cwid: "ann1234",
          role: "PI",
          endDate: FAR_FUTURE,
          mechanism: "R01",
        },
      ] as unknown as ScholarForIndex["grants"],
      authorships: [
        {
          pmid: "1",
          cwid: "ann1234",
          isConfirmed: true,
          isFirst: true,
          isLast: false,
          isPenultimate: false,
          position: 1,
          totalAuthors: 3,
          publication: {
            title: "First paper",
            meshTerms: [{ ui: "D001", label: "Term Alpha" }],
            abstract: "Abstract one.",
          },
        },
        {
          pmid: "2",
          cwid: "ann1234",
          isConfirmed: true,
          isFirst: false,
          isLast: true,
          isPenultimate: false,
          position: 2,
          totalAuthors: 2,
          publication: {
            title: "Second paper",
            meshTerms: [{ ui: "D001", label: "Term Alpha" }],
            abstract: "Abstract two.",
          },
        },
        {
          pmid: "3",
          cwid: "ann1234",
          isConfirmed: true,
          isFirst: false,
          isLast: false,
          isPenultimate: false,
          position: 3,
          totalAuthors: 5,
          publication: {
            title: "Third paper",
            meshTerms: [{ ui: "D001", label: "Term Alpha" }],
            abstract: null,
          },
        },
      ] as unknown as ScholarForIndex["authorships"],
    };
    const doc = await buildPeopleDoc(
      s as ScholarForIndex,
      ["ASCVD-CENTER"],
      mockPeopleClient([
        new Date("2024-06-01T00:00:00.000Z"),
        new Date("2023-01-01T00:00:00.000Z"),
        null,
      ]),
      NO_SUP,
    );
    expect(doc).toMatchSnapshot();
  });

  it("captures a sparse scholar (isComplete=false, no center, no division, no postnominal)", async () => {
    const s: Partial<ScholarForIndex> = {
      cwid: "junior42",
      slug: "junior-faculty",
      preferredName: "Junior Faculty",
      fullName: "Junior Faculty",
      postnominal: null,
      primaryTitle: "Assistant Professor",
      primaryDepartment: "Department of Misc",
      overview: null,
      roleCategory: "faculty",
      deptCode: null,
      divCode: null,
      department: null,
      division: null,
      topicAssignments: [],
      grants: [],
      authorships: [
        {
          pmid: "10",
          cwid: "junior42",
          isConfirmed: true,
          isFirst: true,
          isLast: false,
          isPenultimate: false,
          position: 1,
          totalAuthors: 4,
          publication: {
            title: "Lone paper",
            meshTerms: [],
            abstract: null,
          },
        },
      ] as unknown as ScholarForIndex["authorships"],
    };
    const doc = await buildPeopleDoc(
      s as ScholarForIndex,
      [],
      mockPeopleClient([null]),
      NO_SUP,
    );
    expect(doc).toMatchSnapshot();
  });
});
