import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPeopleDoc,
  buildPublicationDoc,
  type PublicationForIndex,
  type ScholarForIndex,
} from "@/lib/search-index-docs";

/**
 * Phase 4b C3 — publication-suppression integration in `buildPublicationDoc`.
 *
 * Asserts the suppression *delta* explicitly:
 *   - dark (whole-pub takedown OR derived-dark) → `null` (doc not emitted);
 *   - per-author hide → cwid absent from `wcmAuthors` / `wcmAuthorCwids`;
 *   - the derived-dark gate uses the CONFIRMED-WCM set, not the broader
 *     `wcmAuthorRows` chip membership (the §2.1 set-discrepancy code comment).
 *
 * The C2 no-suppression baseline (search-index-docs-golden.test.ts) is the
 * additivity check — those snapshots must NOT change as a result of C3.
 */

function makePub(
  pmid: string,
  authors: ReadonlyArray<{
    cwid: string;
    isConfirmed?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    position: number;
    totalAuthors: number;
  }>,
): PublicationForIndex {
  const p: Partial<PublicationForIndex> = {
    pmid,
    title: `Title ${pmid}`,
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
    authors: authors.map((a) => ({
      pmid,
      cwid: a.cwid,
      externalName: null,
      isConfirmed: a.isConfirmed ?? true,
      isFirst: a.isFirst ?? false,
      isLast: a.isLast ?? false,
      isPenultimate: false,
      position: a.position,
      totalAuthors: a.totalAuthors,
      scholar: {
        cwid: a.cwid,
        slug: a.cwid,
        preferredName: a.cwid,
        deletedAt: null,
        status: "active",
      },
    })) as unknown as PublicationForIndex["authors"],
    publicationTopics: [],
  };
  return p as PublicationForIndex;
}

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

describe("buildPublicationDoc — suppression integration (C3)", () => {
  it("emits an unchanged doc when no suppressions exist (the additivity baseline)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const doc = buildPublicationDoc(p, NO_SUP);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["ann", "bob"]);
  });

  it("returns null for an explicit whole-publication takedown (dark)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, isLast: true, position: 1, totalAuthors: 1 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["1"]),
      hiddenAuthorsByPmid: new Map(),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("returns null when every confirmed WCM author has a per-author hide (derived-dark)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann", "bob"])]]),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("drops a hidden cwid from wcmAuthors / wcmAuthorCwids when the pub stays displayed", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann"])]]),
    };
    const doc = buildPublicationDoc(p, sup);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["bob"]);
    const wcmAuthors = (doc as { wcmAuthors: Array<{ cwid: string }> }).wcmAuthors;
    expect(wcmAuthors.map((a) => a.cwid)).toEqual(["bob"]);
  });

  it("derived-dark uses the CONFIRMED WCM set, not the broader wcmAuthorRows membership", () => {
    // The §2.1 set-discrepancy code comment in buildPublicationDoc:
    // the derived-dark contract is `isConfirmed`-filtered; the chip contract
    // is not. An unconfirmed WCM author must NOT count against derived-dark.
    //
    // Setup: pmid has confirmed `ann` and unconfirmed `bob`. Ann hides.
    // Confirmed set = [ann]; ann hidden → derived-dark even though `bob` is
    // a "WCM author" in the broader chip sense.
    const p = makePub("1", [
      { cwid: "ann", isConfirmed: true, isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isConfirmed: false, isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann"])]]),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("an unrelated pmid's suppression does not affect this pub", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, isLast: true, position: 1, totalAuthors: 1 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["999"]),
      hiddenAuthorsByPmid: new Map([["999", new Set(["other"])]]),
    };
    const doc = buildPublicationDoc(p, sup);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["ann"]);
  });
});

describe("buildPeopleDoc — suppression integration (C4)", () => {
  function mockClient(rows: ReadonlyArray<{ pmid: string; date: Date | null }>) {
    return {
      centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
      divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
      publicationAuthor: {
        findMany: vi
          .fn()
          .mockResolvedValue(
            rows.map((r) => ({
              pmid: r.pmid,
              publication: { dateAddedToEntrez: r.date },
            })),
          ),
      },
      // Issue #532 — leadership sidecar queries; the suppression tests don't
      // care about the leadership signal, so both return empty.
      department: { findMany: vi.fn().mockResolvedValue([]) },
      division: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Parameters<typeof buildPeopleDoc>[1];
  }

  function scholarWithAuthorships(
    authorships: ReadonlyArray<{
      pmid: string;
      title: string;
      mesh?: string[];
      isFirst?: boolean;
    }>,
    overrides: Partial<ScholarForIndex> = {},
  ): ScholarForIndex {
    const base: Partial<ScholarForIndex> = {
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
      authorships: authorships.map((a, i) => ({
        pmid: a.pmid,
        cwid: "self",
        isConfirmed: true,
        isFirst: a.isFirst ?? i === 0,
        isLast: false,
        isPenultimate: false,
        position: i + 1,
        totalAuthors: 3,
        publication: {
          title: a.title,
          meshTerms: (a.mesh ?? []).map((label) => ({ ui: `D${label}`, label })),
          abstract: null,
        },
      })) as unknown as ScholarForIndex["authorships"],
      ...overrides,
    };
    return base as ScholarForIndex;
  }

  it("drops a self-hidden pmid from publicationTitles + publicationCount", async () => {
    const s = scholarWithAuthorships([
      { pmid: "1", title: "First paper" },
      { pmid: "2", title: "Hidden paper" },
      { pmid: "3", title: "Third paper" },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["2", new Set(["self"])]]),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([
        { pmid: "1", date: new Date("2024-01-01T00:00:00.000Z") },
        { pmid: "2", date: new Date("2024-06-01T00:00:00.000Z") },
        { pmid: "3", date: new Date("2023-01-01T00:00:00.000Z") },
      ]),
      sup,
    );
    expect((doc as { publicationCount: number }).publicationCount).toBe(2);
    const titles = (doc as { publicationTitles: string }).publicationTitles;
    expect(titles).not.toContain("Hidden paper");
    expect(titles).toContain("First paper");
    expect(titles).toContain("Third paper");
  });

  it("drops a dark pmid from the rollup", async () => {
    const s = scholarWithAuthorships([
      { pmid: "1", title: "First paper" },
      { pmid: "2", title: "Dark paper" },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["2"]),
      hiddenAuthorsByPmid: new Map(),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([
        { pmid: "1", date: null },
        { pmid: "2", date: null },
      ]),
      sup,
    );
    expect((doc as { publicationCount: number }).publicationCount).toBe(1);
    expect((doc as { publicationTitles: string }).publicationTitles).not.toContain(
      "Dark paper",
    );
  });

  it("filters hidden/dark pmids out of mostRecentPubDate", async () => {
    const s = scholarWithAuthorships([
      { pmid: "1", title: "Older" },
      { pmid: "2", title: "Newest but hidden" },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["2", new Set(["self"])]]),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([
        { pmid: "1", date: new Date("2023-01-01T00:00:00.000Z") },
        { pmid: "2", date: new Date("2024-06-01T00:00:00.000Z") }, // newer, hidden
      ]),
      sup,
    );
    const date = (doc as { mostRecentPubDate: Date | null }).mostRecentPubDate;
    expect(date?.toISOString()).toBe("2023-01-01T00:00:00.000Z");
  });

  it("isComplete uses the filtered count, not s.authorships.length", async () => {
    // 3 authorships, 1 self-hidden → kept = 2; isComplete must be false even
    // with overview + active grants (the >= 3 threshold).
    const s = scholarWithAuthorships(
      [
        { pmid: "1", title: "p1" },
        { pmid: "2", title: "p2" },
        { pmid: "3", title: "p3 hidden" },
      ],
      {
        overview: "<p>bio</p>",
        grants: [
          {
            cwid: "self",
            role: "PI",
            endDate: new Date("2099-12-31T00:00:00.000Z"),
            mechanism: "R01",
          },
        ] as unknown as ScholarForIndex["grants"],
      },
    );
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["3", new Set(["self"])]]),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([
        { pmid: "1", date: null },
        { pmid: "2", date: null },
        { pmid: "3", date: null },
      ]),
      sup,
    );
    expect((doc as { publicationCount: number }).publicationCount).toBe(2);
    expect((doc as { isComplete: boolean }).isComplete).toBe(false);
  });

  it("a hidden pmid's MeSH terms do not contribute to publicationMesh", async () => {
    const s = scholarWithAuthorships([
      { pmid: "1", title: "kept", mesh: ["KeptTerm"] },
      { pmid: "2", title: "hidden", mesh: ["HiddenTerm"] },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["2", new Set(["self"])]]),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([
        { pmid: "1", date: null },
        { pmid: "2", date: null },
      ]),
      sup,
    );
    const mesh = (doc as { publicationMesh: string }).publicationMesh;
    expect(mesh).not.toContain("HiddenTerm");
  });

  it("a suppression on a different cwid does not affect this scholar's rollup", async () => {
    const s = scholarWithAuthorships([{ pmid: "1", title: "Self's paper" }]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      // someone else hid the pub for themselves; it must still count for `self`.
      hiddenAuthorsByPmid: new Map([["1", new Set(["other"])]]),
    };
    const doc = await buildPeopleDoc(
      s,
      mockClient([{ pmid: "1", date: null }]),
      sup,
    );
    expect((doc as { publicationCount: number }).publicationCount).toBe(1);
    expect((doc as { publicationTitles: string }).publicationTitles).toContain(
      "Self's paper",
    );
  });
});
