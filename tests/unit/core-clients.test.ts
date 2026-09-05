/**
 * "Known clients" data layer (lib/api/core-clients) — ReciterAI #383 / SPS
 * #2607, CWID-only pass. `parseCwidBlock` is pure; `loadCoreClients` is
 * exercised against a fake, injectable Prisma-shaped client (no DB).
 */
import { describe, expect, it } from "vitest";

import { loadCoreClients, parseCwidBlock, type CoreClientLookup } from "@/lib/api/core-clients";

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
    clientRows: Array<{ cwid: string; addedAt: Date; addedBy: string }>,
    scholarRows: Array<{ cwid: string; preferredName: string; slug: string }>,
  ): CoreClientLookup {
    return {
      coreClient: {
        findMany: async ({ where }) => {
          expect(where.removedAt).toBeNull();
          return clientRows;
        },
      },
      scholar: {
        findMany: async ({ where }) => {
          const wanted = new Set(where.cwid.in.map((c) => c.toLowerCase()));
          return scholarRows.filter((s) => wanted.has(s.cwid.toLowerCase()));
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
      { cwid: "djb2001", name: "Doug Ballon", slug: "doug-ballon", addedAt, addedBy: "rev01" },
    ]);
  });

  it("resolves name: null / slug: null for a CWID with no Scholar row — never rejected", async () => {
    const addedAt = new Date("2026-09-01T00:00:00Z");
    const db = fakeDb([{ cwid: "xy9999", addedAt, addedBy: "rev01" }], []);
    const rows = await loadCoreClients("2", db);
    expect(rows).toEqual([{ cwid: "xy9999", name: null, slug: null, addedAt, addedBy: "rev01" }]);
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
