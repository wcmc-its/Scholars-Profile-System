/**
 * Issue #837 — `buildPublicationDoc` emits a `wcmAuthorDepartments` keyword
 * array for the Publications-tab Department facet.
 *
 * Semantic invariants:
 *   - Union attribution: a paper carries every distinct department key its
 *     displayable WCM authors belong to (multiple co-authors in different
 *     departments → multiple keys).
 *   - Key shape mirrors `buildPeopleDoc`'s dept facet keys: the FK `deptCode`
 *     when present, else a `name:<deptName>` long-tail key for scholars
 *     without an FK code.
 *   - Omit-on-empty: pubs whose displayable WCM authors carry no department
 *     write nothing for the field (distinguishes "no signal" from "[]").
 *   - Suppression-safe: a hidden / soft-deleted author never contributes a
 *     department (the derivation runs over the rendered chip set, `wcmAuthorRows`).
 *
 * No DB, no OpenSearch — exercises the pure builder over hand-crafted Prisma
 * rows, the same harness style as the golden-doc test.
 */
import { describe, expect, it } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPublicationDoc,
  type PublicationForIndex,
} from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

/** Build one author row with the fields buildPublicationDoc reads. */
function author(opts: {
  cwid: string;
  position: number;
  totalAuthors: number;
  isFirst?: boolean;
  isLast?: boolean;
  isPenultimate?: boolean;
  deptCode?: string | null;
  deptName?: string | null;
  primaryDepartment?: string | null;
  deletedAt?: Date | null;
  status?: string;
}): PublicationForIndex["authors"][number] {
  return {
    pmid: "p1",
    cwid: opts.cwid,
    externalName: null,
    isConfirmed: true,
    isFirst: opts.isFirst ?? false,
    isLast: opts.isLast ?? false,
    isPenultimate: opts.isPenultimate ?? false,
    position: opts.position,
    totalAuthors: opts.totalAuthors,
    scholar: {
      cwid: opts.cwid,
      slug: `${opts.cwid}-slug`,
      preferredName: `Author ${opts.cwid}`,
      deletedAt: opts.deletedAt ?? null,
      status: opts.status ?? "active",
      roleCategory: "full_time_faculty",
      deptCode: opts.deptCode ?? null,
      primaryDepartment: opts.primaryDepartment ?? null,
      department: opts.deptName ? { name: opts.deptName } : null,
    },
  } as unknown as PublicationForIndex["authors"][number];
}

function pub(authors: PublicationForIndex["authors"]): PublicationForIndex {
  return {
    pmid: "p1",
    title: "A paper",
    journal: "A journal",
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
    authors,
    publicationTopics: [],
  } as unknown as PublicationForIndex;
}

describe("buildPublicationDoc — wcmAuthorDepartments (#837)", () => {
  it("emits the FK deptCode for each displayable WCM author (union, deduped)", () => {
    const doc = buildPublicationDoc(
      pub([
        author({ cwid: "a1", position: 1, totalAuthors: 3, isFirst: true, deptCode: "MED" }),
        author({ cwid: "a2", position: 2, totalAuthors: 3, deptCode: "PEDS" }),
        author({ cwid: "a3", position: 3, totalAuthors: 3, isLast: true, deptCode: "MED" }),
      ]),
      NO_SUP,
    );
    expect(doc).not.toBeNull();
    const depts = (doc as Record<string, unknown>).wcmAuthorDepartments as string[];
    // MED appears twice on the paper but is deduped to one key.
    expect(new Set(depts)).toEqual(new Set(["MED", "PEDS"]));
    expect(depts).toHaveLength(2);
  });

  it("falls back to a name:<dept> key when the scholar has no FK deptCode", () => {
    const doc = buildPublicationDoc(
      pub([
        author({
          cwid: "a1",
          position: 1,
          totalAuthors: 1,
          deptCode: null,
          deptName: "Anesthesiology",
        }),
      ]),
      NO_SUP,
    );
    const depts = (doc as Record<string, unknown>).wcmAuthorDepartments as string[];
    expect(depts).toEqual(["name:Anesthesiology"]);
  });

  it("uses primaryDepartment for the name: fallback when the FK relation is absent", () => {
    const doc = buildPublicationDoc(
      pub([
        author({
          cwid: "a1",
          position: 1,
          totalAuthors: 1,
          deptCode: null,
          deptName: null,
          primaryDepartment: "Radiology",
        }),
      ]),
      NO_SUP,
    );
    const depts = (doc as Record<string, unknown>).wcmAuthorDepartments as string[];
    expect(depts).toEqual(["name:Radiology"]);
  });

  it("omits the field entirely when no displayable WCM author has a department", () => {
    const doc = buildPublicationDoc(
      pub([
        author({
          cwid: "a1",
          position: 1,
          totalAuthors: 1,
          deptCode: null,
          deptName: null,
          primaryDepartment: null,
        }),
      ]),
      NO_SUP,
    );
    expect(doc).not.toBeNull();
    expect(doc as Record<string, unknown>).not.toHaveProperty("wcmAuthorDepartments");
  });

  it("excludes a soft-deleted (hidden) author's department from the union", () => {
    const doc = buildPublicationDoc(
      pub([
        author({ cwid: "a1", position: 1, totalAuthors: 2, isFirst: true, deptCode: "MED" }),
        // Soft-deleted trainee — not a rendered chip, so PEDS must not appear.
        author({
          cwid: "a2",
          position: 2,
          totalAuthors: 2,
          isLast: true,
          deptCode: "PEDS",
          deletedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ]),
      NO_SUP,
    );
    const depts = (doc as Record<string, unknown>).wcmAuthorDepartments as string[];
    expect(depts).toEqual(["MED"]);
  });

  it("excludes a per-author-hidden (suppressed) author's department", () => {
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["p1", new Set(["a2"])]]),
    };
    const doc = buildPublicationDoc(
      pub([
        author({ cwid: "a1", position: 1, totalAuthors: 2, isFirst: true, deptCode: "MED" }),
        author({ cwid: "a2", position: 2, totalAuthors: 2, isLast: true, deptCode: "PEDS" }),
      ]),
      sup,
    );
    const depts = (doc as Record<string, unknown>).wcmAuthorDepartments as string[];
    expect(depts).toEqual(["MED"]);
  });
});
