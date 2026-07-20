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
