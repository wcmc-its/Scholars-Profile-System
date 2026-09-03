/**
 * The news queue loader's history tabs.
 *
 * The queue used to filter to `source: "NAME"` for EVERY status. VIVO-linked
 * mentions auto-publish and never sit pending, so that filter made them invisible
 * in Approved — a scholar with four published mentions on their profile appeared
 * nowhere in the queue at all. Two behaviours are pinned here:
 *
 *  1. NO SOURCE FILTER. History must show both sources; pending is name-only by
 *     construction, so dropping the filter costs it nothing.
 *  2. THE HISTORY SORT MUST NOT RANK BY LIKELIHOOD. A VIVO row has a null
 *     likelihood ⇒ rank 0 ⇒ it sinks below every NAME approval. Pending keeps the
 *     likelihood rank; history is most-recent-article-first.
 */
import { describe, expect, it } from "vitest";

import { NEWS_HISTORY_LIMIT, loadNewsQueue } from "@/lib/edit/news-queue";

type Row = {
  id: string;
  cwid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  detectedName: string | null;
  likelihood: string | null;
  matchBasis: string | null;
  contextSnippet: string | null;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function vivo(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    url: `https://news.weill.cornell.edu/${over.id}`,
    title: "A VIVO-linked article",
    publishedAt: new Date("2026-07-10T00:00:00Z"),
    detectedName: null,
    likelihood: null,
    matchBasis: null,
    contextSnippet: null,
    source: "VIVO",
    sourceRef: null,
    createdAt: new Date("2026-07-18T00:00:00Z"),
    updatedAt: new Date("2026-07-18T00:00:00Z"),
    ...over,
  };
}

function name(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    ...vivo(over),
    title: "A name-matched article",
    detectedName: "Fei Wang",
    likelihood: "HIGH",
    matchBasis: "TAG",
    source: "NAME",
    sourceRef: `https://news.weill.cornell.edu/${over.id}|fei wang`,
    ...over,
  };
}

/** Minimal stand-in for the Prisma surface the loader touches. `calls` records
 *  the `where` each findMany got, so a re-added source filter fails the test. */
function client(rows: Row[]) {
  const calls: Array<Record<string, unknown>> = [];
  const c = {
    newsMention: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push(args);
        return rows;
      },
    },
    scholar: {
      findMany: async () =>
        [...new Set(rows.map((r) => r.cwid))].map((cwid) => ({
          cwid,
          slug: `slug-${cwid}`,
          preferredName: `Scholar ${cwid}`,
          postnominal: null,
          fullName: `Scholar ${cwid}`,
          roleCategory: "full_time_faculty",
          primaryTitle: "Professor of Medicine",
          primaryDepartment: "Medicine",
        })),
    },
  };
  return { client: c as unknown as Parameters<typeof loadNewsQueue>[0], calls };
}

describe("loadNewsQueue — history shows every source", () => {
  it("queries without a source filter", async () => {
    const { client: c, calls } = client([vivo({ id: "v1", cwid: "aaa1001" })]);
    await loadNewsQueue(c, "published");
    expect(calls[0].where).toEqual({ status: "published" });
  });

  it("caps history and takes the most recent, but never caps pending", async () => {
    // news_mention is append-only, so an uncapped history load grows forever and
    // ships every row into the client payload. The cap must also order
    // newest-first at the DB, or it would keep the OLDEST rows.
    const { client: c, calls } = client([vivo({ id: "v1", cwid: "aaa1001" })]);

    await loadNewsQueue(c, "published");
    expect(calls[0].take).toBe(NEWS_HISTORY_LIMIT);
    expect(calls[0].orderBy).toEqual([{ publishedAt: "desc" }, { createdAt: "desc" }]);

    await loadNewsQueue(c, "pending");
    expect(calls[1].take).toBeUndefined();
  });

  it("returns VIVO rows alongside NAME approvals, each solo and uncontested", async () => {
    const { client: c } = client([
      vivo({ id: "v1", cwid: "aaa1001" }),
      name({ id: "n1", cwid: "bbb2002" }),
    ]);
    const groups = await loadNewsQueue(c, "published");

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.contested)).toBe(true);
    expect(groups.every((g) => g.rows.length === 1)).toBe(true);
    // The badge the UI keys on.
    expect(groups.flatMap((g) => g.rows.map((r) => r.source)).sort()).toEqual(["NAME", "VIVO"]);
    // A VIVO group is keyed by its own id — never lumped with the other NULL
    // sourceRefs, which would falsely mark unrelated mentions as competing.
    expect(groups.some((g) => g.key === "id:v1")).toBe(true);
  });

  it("does not bury a newer VIVO row under an older HIGH name-match", async () => {
    // The regression this whole change exists to prevent: rank by likelihood on a
    // history tab and every VIVO row (likelihood null ⇒ rank 0) sinks to the end.
    const { client: c } = client([
      name({ id: "n1", cwid: "bbb2002", publishedAt: new Date("2026-01-01T00:00:00Z") }),
      vivo({ id: "v1", cwid: "aaa1001", publishedAt: new Date("2026-07-10T00:00:00Z") }),
    ]);
    const groups = await loadNewsQueue(c, "published");

    expect(groups[0].rows[0].source).toBe("VIVO");
  });

  it("still ranks pending by likelihood, contested last", async () => {
    const { client: c } = client([
      name({ id: "m1", cwid: "bbb2002", likelihood: "MEDIUM" }),
      name({ id: "h1", cwid: "aaa1001", likelihood: "HIGH" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    expect(groups.map((g) => g.rows[0].likelihood)).toEqual(["HIGH", "MEDIUM"]);
  });
});

/**
 * #2578 — the queue must be able to tell a reviewer WHY a candidate scored what
 * it did. `likelihood` cannot carry that alone: it folds in contested-ness as
 * well as basis, so a MEDIUM means either "prose match" or "tagged, but two
 * scholars share the name". The basis is the half that distinguishes them.
 */
describe("loadNewsQueue — match basis (#2578)", () => {
  it("carries matchBasis through to the row the UI renders", async () => {
    const { client: c } = client([
      name({ id: "t1", cwid: "aaa1001", likelihood: "HIGH", matchBasis: "TAG" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].matchBasis).toBe("TAG");
  });

  it("ranks the new LOW tier below MEDIUM but above an unscored row", async () => {
    // LOW must not collapse into the 0 fallback: a scored LOW candidate is still
    // more actionable than a pre-#2578 row carrying no likelihood at all.
    const { client: c } = client([
      name({ id: "u1", cwid: "ddd4004", likelihood: null, matchBasis: null }),
      name({ id: "l1", cwid: "ccc3003", likelihood: "LOW", matchBasis: "TITLE" }),
      name({ id: "m1", cwid: "bbb2002", likelihood: "MEDIUM", matchBasis: "BODY" }),
      name({ id: "h1", cwid: "aaa1001", likelihood: "HIGH", matchBasis: "TAG" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    expect(groups.map((g) => g.rows[0].likelihood)).toEqual(["HIGH", "MEDIUM", "LOW", null]);
    expect(groups.map((g) => g.rows[0].matchBasis)).toEqual(["TAG", "BODY", "TITLE", null]);
  });

  it("still surfaces a contested group, whatever the basis, and sinks it last", async () => {
    // Two scholars, ONE detected name ⇒ one shared sourceRef ⇒ a single-select.
    // A TAG basis does not make it uncontested: the tag names *a* Fei Wang, not
    // which one. The UI keys "This is the one" / "None of these" off this flag.
    const ref = "https://news.weill.cornell.edu/x|fei wang";
    const { client: c } = client([
      name({ id: "c1", cwid: "aaa1001", likelihood: "MEDIUM", matchBasis: "TAG", sourceRef: ref }),
      name({ id: "c2", cwid: "bbb2002", likelihood: "MEDIUM", matchBasis: "TAG", sourceRef: ref }),
      name({ id: "s1", cwid: "ccc3003", likelihood: "LOW", matchBasis: "CAPTION" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    const contested = groups.find((g) => g.contested);
    expect(contested).toBeDefined();
    expect(contested!.rows).toHaveLength(2);
    expect(contested!.rows.map((r) => r.competingCwids.length)).toEqual([1, 1]);
    // Contested ranks 0 — it needs disambiguation before it needs ranking, so it
    // sits below even the solo LOW candidate. Shipped behaviour, pinned here.
    expect(groups[groups.length - 1].contested).toBe(true);
  });

  it("carries contextSnippet through to the row the UI renders", async () => {
    const { client: c } = client([
      name({
        id: "t1",
        cwid: "aaa1001",
        likelihood: "LOW",
        matchBasis: "TITLE",
        contextSnippet: "…and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended…",
      }),
    ]);
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].contextSnippet).toBe(
      "…and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended…",
    );
  });

  /**
   * #2578 follow-up — "sort by confidence then recency": within one tier, newer
   * publishedAt sorts first. This was already the loader's behaviour before the
   * scored BODY tier (LIKELIHOOD_RANK ranks the tier, the comparator breaks ties
   * by publishedAt descending) — see the docblock on LIKELIHOOD_RANK. Pinned
   * here explicitly because the scored tier is what the product owner's ask was
   * actually about, even though the sort mechanism itself needed no change.
   */
  it("sorts newer before older WITHIN a tier (recency), after confidence", async () => {
    const { client: c } = client([
      name({
        id: "old-high",
        cwid: "aaa1001",
        likelihood: "HIGH",
        publishedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      name({
        id: "new-high",
        cwid: "bbb2002",
        likelihood: "HIGH",
        publishedAt: new Date("2026-08-01T00:00:00Z"),
      }),
      name({
        id: "new-medium",
        cwid: "ccc3003",
        likelihood: "MEDIUM",
        publishedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    // Confidence still dominates: the newer MEDIUM sinks below BOTH HIGH rows
    // despite being the most recent article of the three...
    expect(groups.map((g) => g.rows[0].id)).toEqual(["new-high", "old-high", "new-medium"]);
    // ...and within the tied HIGH tier, the newer article sorts first.
    expect(groups[0].rows[0].id).toBe("new-high");
    expect(groups[1].rows[0].id).toBe("old-high");
  });
});
