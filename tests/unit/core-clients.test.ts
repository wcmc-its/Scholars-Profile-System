/**
 * "Known clients" data layer (lib/api/core-clients) — ReciterAI #383 / SPS
 * #2607, CWID-only pass. `parseCwidBlock` is pure; `loadCoreClients` is
 * exercised against a fake, injectable Prisma-shaped client (no DB).
 */
import { describe, expect, it } from "vitest";

import {
  loadCoreClientPaperCounts,
  loadCoreClients,
  parseCwidBlock,
  type CoreClientLookup,
  type CoreClientPaperCountLookup,
} from "@/lib/api/core-clients";

describe("parseCwidBlock", () => {
  it("splits on whitespace, commas, semicolons, and newlines", () => {
    const { cwids, invalid } = parseCwidBlock("djb2001, jx2001;ab1234\nrev01   cc2002");
    expect(cwids).toEqual(["djb2001", "jx2001", "ab1234", "rev01", "cc2002"]);
    expect(invalid).toEqual([]);
  });

  it("lowercases and trims each token", () => {
    const { cwids } = parseCwidBlock("  DJB2001  , Jx2001");
    expect(cwids).toEqual(["djb2001", "jx2001"]);
  });

  it("de-dupes repeated CWIDs (case-insensitively)", () => {
    const { cwids } = parseCwidBlock("djb2001 DJB2001 djb2001");
    expect(cwids).toEqual(["djb2001"]);
  });

  it("reports a malformed token as invalid without dropping the valid ones", () => {
    const { cwids, invalid } = parseCwidBlock("djb2001, not-a-cwid, 12345, jx2001");
    expect(cwids).toEqual(["djb2001", "jx2001"]);
    expect(invalid).toEqual(["not-a-cwid", "12345"]);
  });

  it("accepts 2-5 letters + 1-6 digits, rejects outside that shape", () => {
    const { cwids, invalid } = parseCwidBlock("ab1 abcde123456 abcdef1 a1234567");
    expect(cwids).toEqual(["ab1", "abcde123456"]);
    expect(invalid).toEqual(["abcdef1", "a1234567"]);
  });

  it("returns empty arrays for blank input", () => {
    expect(parseCwidBlock("   \n  ")).toEqual({ cwids: [], invalid: [] });
  });
});

describe("loadCoreClients", () => {
  function fakeDb(
    clientRows: Array<{
      id?: string;
      cwid: string | null;
      displayName?: string | null;
      affiliation?: string | null;
      addedAt: Date;
      addedBy: string;
    }>,
    scholarRows: Array<{
      cwid: string;
      preferredName: string;
      slug: string;
      primaryDepartment?: string | null;
    }>,
  ): CoreClientLookup {
    return {
      coreClient: {
        findMany: async ({ where }) => {
          expect(where.removedAt).toBeNull();
          return clientRows.map((r, i) => ({
            id: r.id ?? `row-${i}`,
            cwid: r.cwid,
            displayName: r.displayName ?? null,
            affiliation: r.affiliation ?? null,
            addedAt: r.addedAt,
            addedBy: r.addedBy,
          }));
        },
      },
      scholar: {
        findMany: async ({ where }) => {
          const wanted = new Set(where.cwid.in.map((c) => c.toLowerCase()));
          return scholarRows
            .filter((s) => wanted.has(s.cwid.toLowerCase()))
            .map((s) => ({ ...s, primaryDepartment: s.primaryDepartment ?? null }));
        },
      },
    };
  }

  it("returns an empty list when the core has no active clients", async () => {
    const db = fakeDb([], []);
    expect(await loadCoreClients("2", db)).toEqual([]);
  });

  it("resolves a Scholar name/slug case-insensitively against the stored (lowercased) cwid", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    const db = fakeDb(
      [{ cwid: "djb2001", addedAt, addedBy: "rev01" }],
      [{ cwid: "DJB2001", preferredName: "Doug Ballon", slug: "doug-ballon" }],
    );
    const rows = await loadCoreClients("2", db);
    expect(rows).toEqual([
      {
        id: "row-0",
        cwid: "djb2001",
        name: "Doug Ballon",
        slug: "doug-ballon",
        affiliation: null,
        addedAt,
        addedBy: "rev01",
        addedByName: null,
      },
    ]);
  });

  it("resolves name: null / slug: null for a CWID with no Scholar row — never rejected", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    const db = fakeDb([{ cwid: "xy9999", addedAt, addedBy: "rev01" }], []);
    const rows = await loadCoreClients("2", db);
    expect(rows).toEqual([
      {
        id: "row-0",
        cwid: "xy9999",
        name: null,
        slug: null,
        affiliation: null,
        addedAt,
        addedBy: "rev01",
        addedByName: null,
      },
    ]);
  });

  it("names a NAME-ONLY row from its own displayName and never looks it up", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    let scholarCalls = 0;
    let queried: string[] = [];
    const db = fakeDb(
      [{ cwid: null, displayName: "Ada Lovelace", affiliation: "Analytical Engines", addedAt, addedBy: "rev01" }],
      [],
    );
    const spied: CoreClientLookup = {
      ...db,
      scholar: {
        findMany: async (args) => {
          scholarCalls += 1;
          queried = args.where.cwid.in;
          return db.scholar.findMany(args);
        },
      },
    };
    const rows = await loadCoreClients("2", spied);
    expect(rows).toEqual([
      {
        id: "row-0",
        cwid: null,
        name: "Ada Lovelace",
        slug: null,
        affiliation: "Analytical Engines",
        addedAt,
        addedBy: "rev01",
        addedByName: null,
      },
    ]);
    // The lookup still runs — it has the ADDING actor to resolve — but the row's
    // own (null) cwid must never reach the `in` list. A null in there matches
    // nothing useful and, in the Prisma/MySQL shape, widens rather than narrows.
    expect(scholarCalls).toBe(1);
    expect(queried).toEqual(["rev01"]);
    expect(queried).not.toContain(null);
  });

  it("prefers the Scholar department over a stored affiliation on a CWID row", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    const db = fakeDb(
      [{ cwid: "djb2001", affiliation: "typed by hand", addedAt, addedBy: "rev01" }],
      [
        {
          cwid: "djb2001",
          preferredName: "Doug Ballon",
          slug: "doug-ballon",
          primaryDepartment: "Radiology",
        },
      ],
    );
    const rows = await loadCoreClients("2", db);
    expect(rows[0].affiliation).toBe("Radiology");
  });

  it("resolves the ADDING actor's name in the same query, case-insensitively", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    // The actor is a DIFFERENT person from the client, and their cwid arrives in
    // a different casing — both halves of what this resolution has to get right.
    const db = fakeDb(
      [{ cwid: "ccc1003", addedAt, addedBy: "DJB2001" }],
      [
        { cwid: "ccc1003", preferredName: "Casey Sample", slug: "casey-sample" },
        { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon" },
      ],
    );
    const rows = await loadCoreClients("2", db);
    expect(rows[0].name).toBe("Casey Sample");
    expect(rows[0].addedByName).toBe("Doug Ballon");
  });

  it("leaves addedByName null for an actor with no Scholar row", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    const db = fakeDb([{ cwid: "djb2001", addedAt, addedBy: "svc0001" }], []);
    expect((await loadCoreClients("2", db))[0].addedByName).toBeNull();
  });

  it("preserves the addedAt-ascending order the query returns", async () => {
    const t1 = new Date("2026-09-01T00:00:00Z");
    const t2 = new Date("2026-09-02T00:00:00Z");
    const db = fakeDb(
      [
        { cwid: "aaa111", addedAt: t1, addedBy: "rev01" },
        { cwid: "bbb222", addedAt: t2, addedBy: "rev01" },
      ],
      [],
    );
    const rows = await loadCoreClients("2", db);
    expect(rows.map((r) => r.cwid)).toEqual(["aaa111", "bbb222"]);
  });
});

describe("loadCoreClientPaperCounts", () => {
  const CONFIRMED = [
    { pmid: "p1", year: 2026 },
    { pmid: "p2", year: 2023 },
    { pmid: "p3", year: 2019 },
    { pmid: "p4", year: null },
  ];
  const NOW = new Date("2026-06-01T00:00:00Z"); // recency floor = 2022

  function fakeDb(
    rows: Array<{ pmid: string; cwid: string | null }>,
    spy?: (args: { where: { pmid: { in: string[] }; cwid: { in: string[] } } }) => void,
  ): CoreClientPaperCountLookup {
    return {
      publicationAuthor: {
        findMany: async (args) => {
          spy?.(args);
          return rows;
        },
      },
    };
  }

  it("counts a client's confirmed papers for this core, and how many are recent", async () => {
    const db = fakeDb([
      { pmid: "p1", cwid: "ccc1003" },
      { pmid: "p2", cwid: "ccc1003" },
      { pmid: "p3", cwid: "ccc1003" },
    ]);
    expect(await loadCoreClientPaperCounts(CONFIRMED, ["ccc1003"], db, NOW)).toEqual({
      ccc1003: { papers: 3, recent: 2 },
    });
  });

  it("treats the window floor as inclusive and a null year as not recent", async () => {
    const onFloor = fakeDb([{ pmid: "x", cwid: "c1" }]);
    expect(
      await loadCoreClientPaperCounts([{ pmid: "x", year: 2022 }], ["c1"], onFloor, NOW),
    ).toEqual({ c1: { papers: 1, recent: 1 } });
    expect(
      await loadCoreClientPaperCounts([{ pmid: "x", year: 2021 }], ["c1"], onFloor, NOW),
    ).toEqual({ c1: { papers: 1, recent: 0 } });
    expect(
      await loadCoreClientPaperCounts([{ pmid: "x", year: null }], ["c1"], onFloor, NOW),
    ).toEqual({ c1: { papers: 1, recent: 0 } });
  });

  it("counts one paper once when a byline lists the same person twice", async () => {
    const db = fakeDb([
      { pmid: "p1", cwid: "c1" },
      { pmid: "p1", cwid: "C1" },
    ]);
    expect(await loadCoreClientPaperCounts(CONFIRMED, ["c1"], db, NOW)).toEqual({
      c1: { papers: 1, recent: 1 },
    });
  });

  it("keys case-insensitively and gives each client their own tally", async () => {
    const db = fakeDb([
      { pmid: "p1", cwid: "AAA1" },
      { pmid: "p2", cwid: "aaa1" },
      { pmid: "p1", cwid: "bbb2" },
    ]);
    expect(await loadCoreClientPaperCounts(CONFIRMED, ["aaa1", "bbb2"], db, NOW)).toEqual({
      aaa1: { papers: 2, recent: 2 },
      bbb2: { papers: 1, recent: 1 },
    });
  });

  it("queries BOTH casings of each cwid, and only the confirmed pmids", async () => {
    let seen: { pmid: { in: string[] }; cwid: { in: string[] } } | null = null;
    const db = fakeDb([], (args) => {
      seen = args.where;
    });
    await loadCoreClientPaperCounts(CONFIRMED, ["ABC1"], db, NOW);
    expect(seen!.cwid.in).toEqual(["abc1", "ABC1"]);
    expect(seen!.pmid.in).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("ignores a byline row for a pmid outside the confirmed list", async () => {
    // Defence in depth: the query scopes by pmid, but a widened query must not
    // start counting candidates into a number the card prints as confirmed.
    const db = fakeDb([{ pmid: "not-confirmed", cwid: "c1" }]);
    expect(await loadCoreClientPaperCounts(CONFIRMED, ["c1"], db, NOW)).toEqual({});
  });

  it("does not query at all when the roster is empty or nothing is confirmed", async () => {
    let calls = 0;
    const db = fakeDb([], () => {
      calls += 1;
    });
    expect(await loadCoreClientPaperCounts(CONFIRMED, [], db, NOW)).toEqual({});
    expect(await loadCoreClientPaperCounts([], ["c1"], db, NOW)).toEqual({});
    expect(calls).toBe(0);
  });

  it("is NOT capped the way CoreQueueRow.wcmAuthors is — a 13th-author client still counts", async () => {
    // The whole reason this is a query. WCM_AUTHORS_CAP truncates each row's
    // wcmAuthors at 12, so a fold over that list would return {} here.
    const db = fakeDb([{ pmid: "p1", cwid: "late1" }]);
    expect(await loadCoreClientPaperCounts(CONFIRMED, ["late1"], db, NOW)).toEqual({
      late1: { papers: 1, recent: 1 },
    });
  });
});
