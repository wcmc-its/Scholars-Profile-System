/**
 * #1762 — the honors queue loader.
 *
 * Two behaviours carry real risk and are pinned here:
 *
 *  1. GROUPING BY ROSTER LINE. Rows sharing a `sourceRef` are competing claims on
 *     one award; at most one is true. If grouping breaks, the UI offers a plain
 *     approve on each and two people get credited with one fellowship — the
 *     mismatch the SPEC calls expensive.
 *  2. THE YEAR SIGNAL IS A NOTE, NEVER A FILTER. It annotates; it must never drop
 *     a row. A genuine emeritus hit in the 1980s band is plausible.
 */
import { describe, expect, it } from "vitest";

import { loadHonorQueue, yearPlausibilityNote } from "@/lib/edit/honor-queue";

type Row = {
  id: string;
  cwid: string;
  category: "PRIZE";
  name: string;
  organization: string;
  year: number | null;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
};

function honor(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    category: "PRIZE",
    name: "Sloan Research Fellowship",
    organization: "Sloan Foundation",
    year: 2014,
    source: "D3_RERUN_sloan",
    sourceRef: null,
    createdAt: new Date("2026-07-17T00:00:00Z"),
    ...over,
  };
}

/** Minimal stand-in for the Prisma surface the loader touches. */
function client(rows: Row[], scholars: Array<{ cwid: string; preferredName: string; primaryTitle?: string }>) {
  return {
    honor: { findMany: async () => rows },
    scholar: {
      findMany: async () =>
        scholars.map((s) => ({
          cwid: s.cwid,
          slug: `slug-${s.cwid}`,
          preferredName: s.preferredName,
          fullName: s.preferredName,
          primaryTitle: s.primaryTitle ?? "Professor of Medicine",
          primaryDepartment: "Medicine",
        })),
    },
  } as unknown as Parameters<typeof loadHonorQueue>[0];
}

describe("loadHonorQueue — grouping by roster line", () => {
  it("groups rows sharing a sourceRef and marks them contested", async () => {
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: "https://sloan.org/db#Smith|2014" }),
      honor({ id: "b", cwid: "bbb2002", sourceRef: "https://sloan.org/db#Smith|2014" }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "A Smith" },
        { cwid: "bbb2002", preferredName: "B Smith" },
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].contested).toBe(true);
    expect(groups[0].rows).toHaveLength(2);
    // Each candidate knows who it competes with — that's what lets the UI refuse
    // a plain approve.
    expect(groups[0].rows[0].competingCwids).toEqual(["bbb2002"]);
    expect(groups[0].rows[1].competingCwids).toEqual(["aaa1001"]);
  });

  it("does NOT lump distinct NULL-sourceRef rows into one contested group", async () => {
    // The trap: keying on `sourceRef` alone makes every NULL collide, marking
    // unrelated honors as competing and inviting a curator to reject real ones.
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: null }),
      honor({ id: "b", cwid: "bbb2002", sourceRef: null }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "A Smith" },
        { cwid: "bbb2002", preferredName: "B Smith" },
      ]),
    );

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.contested)).toBe(true);
    expect(groups.flatMap((g) => g.rows).every((r) => r.competingCwids.length === 0)).toBe(true);
  });

  it("treats the same scholar twice on one line as uncontested, not a rivalry", async () => {
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: "ref-1" }),
      honor({ id: "b", cwid: "aaa1001", sourceRef: "ref-1" }),
    ];
    const groups = await loadHonorQueue(client(rows, [{ cwid: "aaa1001", preferredName: "A Smith" }]));

    expect(groups).toHaveLength(1);
    expect(groups[0].contested).toBe(false);
  });

  it("orders contested groups first, then oldest", async () => {
    const rows = [
      honor({ id: "old", cwid: "aaa1001", sourceRef: null, createdAt: new Date("2020-01-01") }),
      honor({ id: "c1", cwid: "bbb2002", sourceRef: "ref-x", createdAt: new Date("2026-01-01") }),
      honor({ id: "c2", cwid: "ccc3003", sourceRef: "ref-x", createdAt: new Date("2026-01-01") }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "A" },
        { cwid: "bbb2002", preferredName: "B" },
        { cwid: "ccc3003", preferredName: "C" },
      ]),
    );

    expect(groups[0].contested).toBe(true);
    expect(groups[1].rows[0].id).toBe("old");
  });

  it("returns [] for an empty queue without querying scholars", async () => {
    let scholarCalls = 0;
    const c = {
      honor: { findMany: async () => [] },
      scholar: {
        findMany: async () => {
          scholarCalls++;
          return [];
        },
      },
    } as unknown as Parameters<typeof loadHonorQueue>[0];

    expect(await loadHonorQueue(c)).toEqual([]);
    expect(scholarCalls).toBe(0);
  });
});

describe("yearPlausibilityNote — a SIGNAL, never a filter", () => {
  it("flags an old award on a junior current title", () => {
    expect(yearPlausibilityNote({ year: 1985, title: "Clinical Instructor in Emergency Medicine" }))
      .toMatch(/check this is the same person/i);
  });

  it("stays silent on an old award held by a senior title (a real emeritus hit)", () => {
    expect(yearPlausibilityNote({ year: 1985, title: "Professor of Surgery" })).toBeNull();
  });

  it("stays silent on a recent award, junior title or not", () => {
    expect(yearPlausibilityNote({ year: 2020, title: "Assistant Professor of Medicine" })).toBeNull();
  });

  it("stays silent when the year is unknown rather than guessing", () => {
    expect(yearPlausibilityNote({ year: null, title: "Postdoctoral Associate" })).toBeNull();
  });

  it("stays silent when there is no title to judge", () => {
    expect(yearPlausibilityNote({ year: 1970, title: null })).toBeNull();
  });
});
