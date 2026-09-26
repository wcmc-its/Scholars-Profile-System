/**
 * Count unification (Topic & Method refactor phase 4, unflagged).
 *
 * ONE definition shared by the rail row, the feed's "Publications N" heading
 * and the Load more denominator:
 *   - topics: DISTINCT pmids, every relevance tier, under the active type
 *     filter (default research articles only);
 *   - methods: DISTINCT research-article pmids after the overlay gate, the
 *     active-scholar filter and dark-pub removal (`getDistinctPmidCountForFamily`).
 *   - "All subareas" / "All families": the DISTINCT count, never the row sum.
 *
 * The loaders run against a small in-memory fake of the tables they read, and
 * the fake evaluates each query's actual predicates (the rail's groupBy `where`,
 * the feed's COUNT(DISTINCT) SQL), so dropping a predicate from either side
 * makes the numbers disagree here.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

type PtRow = {
  pmid: string;
  cwid: string;
  parentTopicId: string;
  primarySubtopicId: string | null;
  score: number;
  type: string | null;
};
type SfRow = {
  supercategory: string;
  familyLabel: string;
  familyId: string;
  cwid: string;
  pmids: string[];
  roleCategory: string | null;
};

const db = vi.hoisted(() => ({
  pt: [] as PtRow[],
  sf: [] as SfRow[],
  pubTypes: {} as Record<string, string | null>,
  dark: new Set<string>(),
}));

const excluded = new Set<string>(FEED_EXCLUDED_TYPES);
const isResearch = (t: string | null | undefined) => t != null && !excluded.has(t);

/** Evaluate `pmid: { in }` + `publicationType: { notIn }` over the pub fixture. */
function pubsWhere(where: Record<string, unknown>): string[] {
  const inList = ((where.pmid as { in?: string[] })?.in ?? Object.keys(db.pubTypes)) as string[];
  const notIn = (where.publicationType as { notIn?: string[] } | undefined)?.notIn;
  return [...new Set(inList)].filter(
    (p) =>
      p in db.pubTypes &&
      (!notIn || (db.pubTypes[p] != null && !notIn.includes(db.pubTypes[p] as string))),
  );
}

/** Interpret the feed's COUNT(DISTINCT pt.pmid) SQL against the fixture. */
function countDistinct(sql: Prisma.Sql): number {
  let topic: string | null = null;
  let sub: string | null = null;
  let gte: number | null = null;
  let lt: number | null = null;
  sql.strings.forEach((s, i) => {
    if (i >= sql.values.length) return;
    const v = sql.values[i];
    if (s.endsWith("pt.parent_topic_id = ")) topic = String(v);
    else if (s.endsWith("pt.primary_subtopic_id = ")) sub = String(v);
    else if (s.endsWith("pt.score >= ")) gte = Number(v);
    else if (s.endsWith("pt.score < ")) lt = Number(v);
  });
  const research = sql.sql.includes("publication_type NOT IN");
  const pmids = new Set(
    db.pt
      .filter(
        (r) =>
          r.parentTopicId === topic &&
          (sub === null || r.primarySubtopicId === sub) &&
          (gte === null || r.score >= gte) &&
          (lt === null || r.score < lt) &&
          (!research || isResearch(r.type)),
      )
      .map((r) => r.pmid),
  );
  return pmids.size;
}

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "cardio" ? { id: "cardio", label: "Cardio", displayThreshold: 0.5 } : null,
    },
    subtopic: {
      findMany: async () => [
        { id: "sub_a", label: "A", displayName: "Sub A", shortDescription: null, description: null },
        { id: "sub_b", label: "B", displayName: "Sub B", shortDescription: null, description: null },
      ],
    },
    publicationTopic: {
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        const notIn = (where.publication as { publicationType?: { notIn?: string[] } } | undefined)
          ?.publicationType?.notIn;
        const needSub = (where.primarySubtopicId as { not?: null } | undefined) !== undefined;
        const seen = new Map<string, { primarySubtopicId: string | null; pmid: string }>();
        for (const r of db.pt) {
          if (r.parentTopicId !== where.parentTopicId) continue;
          if (needSub && r.primarySubtopicId === null) continue;
          if (notIn && (r.type === null || notIn.includes(r.type))) continue;
          seen.set(`${r.primarySubtopicId}|${r.pmid}`, {
            primarySubtopicId: r.primarySubtopicId,
            pmid: r.pmid,
          });
        }
        return [...seen.values()];
      },
      findMany: async () => [],
    },
    scholarFamily: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) =>
        db.sf
          .filter(
            (r) =>
              r.supercategory === where.supercategory &&
              (where.familyLabel === undefined ||
                (typeof where.familyLabel === "string"
                  ? r.familyLabel === where.familyLabel
                  : (where.familyLabel as { in: string[] }).in.includes(r.familyLabel))),
          )
          .map((r) => ({
            ...r,
            pmidCount: r.pmids.length,
            exemplarTools: [],
            scholar: { roleCategory: r.roleCategory },
            ...(select.definition ? { definition: null, definitionSource: null } : {}),
          })),
    },
    publication: {
      findMany: async ({ where, select, skip, take }: { where: Record<string, unknown>; select: Record<string, unknown>; skip?: number; take?: number }) => {
        if (Array.isArray(where.NOT)) return [];
        const pmids = pubsWhere(where).sort();
        const rows = pmids.map((pmid) => ({
          pmid,
          title: `Paper ${pmid}`,
          journal: null,
          year: 2020,
          publicationType: db.pubTypes[pmid],
          citationCount: null,
          pubmedUrl: null,
          doi: null,
          pmcid: null,
          impactScore: null,
          dateAddedToEntrez: null,
        }));
        void select;
        return rows.slice(skip ?? 0, take !== undefined ? (skip ?? 0) + take : undefined);
      },
      count: async ({ where }: { where: Record<string, unknown> }) => pubsWhere(where).length,
    },
    publicationAuthor: { findMany: async () => [] },
    suppression: { findMany: async () => [] },
    familySuppressionOverlay: { findMany: async () => [] },
    familySensitivityOverlay: { findMany: async () => [] },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => [
      { c: BigInt(countDistinct(Prisma.sql(strings, ...(values as Prisma.Sql[])))) },
    ],
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEnabled: () => true,
  isMethodsLensSensitiveGateOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsLensEntityLayerOn: () => false,
  isMethodsLensToolContextOn: () => false,
  isMethodsFamilyRosterFallbackOn: () => false,
}));

vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: async () => ({}),
  resolveDarkPmids: async (pmids: string[]) => new Set(pmids.filter((p) => db.dark.has(p))),
  loadHiddenAuthorshipCounts: async () => new Map(),
}));

import { getSubtopicRail, getTopicPublications } from "@/lib/api/topics";
import {
  getSupercategoryRollup,
  getFamilyPublications,
  getDistinctPmidCountForFamily,
  getSupercategoryAllWork,
  pickFamilyLabel,
} from "@/lib/api/methods";

const JA = "Academic Article";

describe("topic: rail row == feed heading == Load more denominator", () => {
  beforeEach(() => {
    db.pt = [
      // p1: strongly, two WCM co-authors (one pmid, two rows).
      { pmid: "p1", cwid: "aaa1001", parentTopicId: "cardio", primarySubtopicId: "sub_a", score: 0.9, type: JA },
      { pmid: "p1", cwid: "bbb1002", parentTopicId: "cardio", primarySubtopicId: "sub_a", score: 0.9, type: JA },
      // p2: also tier.
      { pmid: "p2", cwid: "aaa1001", parentTopicId: "cardio", primarySubtopicId: "sub_a", score: 0.4, type: JA },
      // p3: a Letter — out of the default type filter.
      { pmid: "p3", cwid: "aaa1001", parentTopicId: "cardio", primarySubtopicId: "sub_b", score: 0.8, type: "Letter" },
      { pmid: "p4", cwid: "ccc1003", parentTopicId: "cardio", primarySubtopicId: "sub_b", score: 0.7, type: JA },
      // p5: no primary subtopic — in the topic total, in no rail row.
      { pmid: "p5", cwid: "ccc1003", parentTopicId: "cardio", primarySubtopicId: null, score: 0.6, type: JA },
      // p6: an Editorial Article in the also tier.
      { pmid: "p6", cwid: "ccc1003", parentTopicId: "cardio", primarySubtopicId: "sub_a", score: 0.45, type: "Editorial Article" },
      // another topic's row never leaks in.
      { pmid: "p7", cwid: "ccc1003", parentTopicId: "neuro", primarySubtopicId: "sub_a", score: 0.9, type: JA },
    ];
  });

  it("rail counts are distinct research-article pmids across every tier", async () => {
    const rail = (await getSubtopicRail("cardio"))!;
    expect(Object.fromEntries(rail.subtopics.map((s) => [s.id, s.pubCount]))).toEqual({
      sub_a: 2, // p1 (once, not per co-author), p2 (also tier); not p6 (editorial)
      sub_b: 1, // p4; not p3 (letter)
    });
    // All subareas: distinct, incl. the no-subtopic p5 — not the row sum (3).
    expect(rail.totalPubCount).toBe(4);
  });

  it("each rail row equals the feed heading for that subarea, and All equals the unfiltered heading", async () => {
    const rail = (await getSubtopicRail("cardio"))!;
    for (const s of rail.subtopics) {
      const feed = (await getTopicPublications("cardio", { sort: "newest", subtopic: s.id, tier: "strongly" }))!;
      const heading = feed.tierTotals.strongly + feed.tierTotals.also;
      expect(heading, s.id).toBe(s.pubCount);
      // Show = All relevant: the Load more denominator is the untiered total.
      const all = (await getTopicPublications("cardio", { sort: "newest", subtopic: s.id }))!;
      expect(all.total, s.id).toBe(s.pubCount);
    }
    const feed = (await getTopicPublications("cardio", { sort: "newest", tier: "strongly" }))!;
    expect(feed.tierTotals.strongly + feed.tierTotals.also).toBe(rail.totalPubCount);
    // Show = Strongly relevant: the denominator is the strongly count.
    expect(feed.total).toBe(feed.tierTotals.strongly);
    expect(feed.total).toBe(3); // p1, p4, p5
  });

  it("the type toggle moves the feed off the rail's default-filter count, as designed", async () => {
    const feed = (await getTopicPublications("cardio", { sort: "newest", filter: "all" }))!;
    expect(feed.total).toBe(6); // p1..p6
  });
});

describe("methods: family rail row == family feed heading == distinct count; All families distinct", () => {
  const SC = "reagents";
  beforeEach(() => {
    db.sf = [
      { supercategory: SC, familyLabel: "CRISPR", familyId: "fam_0001", cwid: "aaa1001", pmids: ["m1", "m2"], roleCategory: "full_time_faculty" },
      { supercategory: SC, familyLabel: "CRISPR", familyId: "fam_0001", cwid: "bbb1002", pmids: ["m2", "m3"], roleCategory: null },
      { supercategory: SC, familyLabel: "Antibodies", familyId: "fam_0002", cwid: "ccc1003", pmids: ["m3", "m4", "m5"], roleCategory: "full_time_faculty" },
    ];
    db.pubTypes = { m1: JA, m2: JA, m3: JA, m4: "Letter", m5: JA };
    db.dark = new Set(["m5"]);
  });

  it("agree for every family, and All families is the distinct union", async () => {
    const { families, allPubCount } = await getSupercategoryRollup(SC);
    for (const f of families) {
      const feed = (await getFamilyPublications(SC, f.familyLabel, { sort: "newest" }))!;
      const distinct = await getDistinctPmidCountForFamily(SC, f.familyLabel);
      expect(f.pubCount, f.familyLabel).toBe(feed.total);
      expect(feed.total, f.familyLabel).toBe(distinct);
      expect(feed.total, f.familyLabel).toBe(feed.totalResearchOnly);
    }
    expect(Object.fromEntries(families.map((f) => [f.familyLabel, f.pubCount]))).toEqual({
      CRISPR: 3, // m1, m2, m3
      Antibodies: 1, // m3; m4 letter, m5 dark
    });
    // m3 sits in both families: the row sum (4) double-counts it.
    expect(allPubCount).toBe(3);
    const allWork = await getSupercategoryAllWork(SC);
    expect(allWork.researchCount).toBe(allPubCount);
  });

  it("a hidden-role member counts nowhere, so All families is never below a family", async () => {
    db.sf.push(
      { supercategory: SC, familyLabel: "Antibodies", familyId: "fam_0002", cwid: "ddd1004", pmids: ["m6", "m7"], roleCategory: "doctoral_student" },
      { supercategory: SC, familyLabel: "Antibodies", familyId: "fam_0002", cwid: "eee1005", pmids: ["m7"], roleCategory: "affiliate_alumni" },
    );
    db.pubTypes = { ...db.pubTypes, m6: JA, m7: JA };
    const { families, allPubCount } = await getSupercategoryRollup(SC);
    const byLabel = Object.fromEntries(families.map((f) => [f.familyLabel, f.pubCount]));
    expect(byLabel).toEqual({ CRISPR: 3, Antibodies: 1 });
    const feed = (await getFamilyPublications(SC, "Antibodies", { sort: "newest" }))!;
    expect(feed.total).toBe(1);
    expect(feed.hits.map((h) => h.pmid)).toEqual(["m3"]);
    expect(await getDistinctPmidCountForFamily(SC, "Antibodies")).toBe(1);
    const allWork = await getSupercategoryAllWork(SC);
    expect(allWork.researchCount).toBe(allPubCount);
    for (const f of families) expect(allPubCount).toBeGreaterThanOrEqual(f.pubCount ?? 0);
    // The category feed's rows are exactly the union of the family feeds' rows.
    const unionRows = new Set<string>();
    for (const f of families) {
      const ff = (await getFamilyPublications(SC, f.familyLabel, { sort: "newest" }))!;
      for (const h of ff.hits) unionRows.add(h.pmid);
    }
    expect(new Set(allWork.entries.filter((e) => e.research).map((e) => e.pmid))).toEqual(unionRows);
  });
});

describe("pickFamilyLabel (per-row family on the category-wide feed)", () => {
  it("picks the pub's family with the most pubs in the category", () => {
    const counts = new Map([
      ["Antibodies", 12],
      ["CRISPR", 40],
      ["Flow", 7],
    ]);
    expect(pickFamilyLabel(["Flow", "CRISPR", "Antibodies"], counts)).toBe("CRISPR");
  });
  it("breaks a tie by label A→Z, whatever the input order", () => {
    const counts = new Map([
      ["Beta", 5],
      ["Alpha", 5],
    ]);
    expect(pickFamilyLabel(["Beta", "Alpha"], counts)).toBe("Alpha");
    expect(pickFamilyLabel(["Alpha", "Beta"], counts)).toBe("Alpha");
  });
  it("a single family is its own label; none is null", () => {
    expect(pickFamilyLabel(["Solo"], new Map())).toBe("Solo");
    expect(pickFamilyLabel([], new Map())).toBeNull();
  });
});
