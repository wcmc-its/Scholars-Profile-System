import { describe, expect, it, vi } from "vitest";

import {
  isAuthorHidden,
  isPublicationDark,
  loadAllPublicationSuppressions,
  loadPublicationSuppressions,
} from "@/lib/api/manual-layer";

type SuppressionRow = { entityId: string; contributorCwid: string | null };
type SuppressionClient = Parameters<typeof loadPublicationSuppressions>[1];

/** A client whose `suppression.findMany` resolves to `rows`. */
function clientReturning(rows: SuppressionRow[]): {
  client: SuppressionClient;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    client: { suppression: { findMany } } as unknown as SuppressionClient,
    findMany,
  };
}

describe("loadPublicationSuppressions", () => {
  it("issues no query and returns empty sets for an empty pmid list", async () => {
    const { client, findMany } = clientReturning([]);
    const sup = await loadPublicationSuppressions([], client);
    expect(findMany).not.toHaveBeenCalled();
    expect(sup.darkPmids.size).toBe(0);
    expect(sup.hiddenAuthorsByPmid.size).toBe(0);
  });

  it("returns empty sets when no suppression rows match", async () => {
    const { client } = clientReturning([]);
    const sup = await loadPublicationSuppressions(["1", "2"], client);
    expect(sup.darkPmids.size).toBe(0);
    expect(sup.hiddenAuthorsByPmid.size).toBe(0);
  });

  it("collects a whole-publication takedown (contributorCwid null) into darkPmids", async () => {
    const { client } = clientReturning([{ entityId: "111", contributorCwid: null }]);
    const sup = await loadPublicationSuppressions(["111"], client);
    expect(sup.darkPmids.has("111")).toBe(true);
    expect(sup.hiddenAuthorsByPmid.size).toBe(0);
  });

  it("collects multiple per-author hides on one pmid", async () => {
    const { client } = clientReturning([
      { entityId: "111", contributorCwid: "abc1234" },
      { entityId: "111", contributorCwid: "xyz9999" },
    ]);
    const sup = await loadPublicationSuppressions(["111"], client);
    expect(isAuthorHidden(sup, "111", "abc1234")).toBe(true);
    expect(isAuthorHidden(sup, "111", "xyz9999")).toBe(true);
    expect(sup.darkPmids.size).toBe(0);
  });

  it("queries publication suppressions, un-revoked only, deduping the pmid list", async () => {
    const { client, findMany } = clientReturning([]);
    await loadPublicationSuppressions(["1", "1", "2"], client);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "publication",
          entityId: { in: ["1", "2"] },
          revokedAt: null,
        }),
      }),
    );
  });
});

describe("isAuthorHidden", () => {
  it("is true only for the exact (pmid, cwid) pair that was hidden", async () => {
    const { client } = clientReturning([{ entityId: "111", contributorCwid: "abc1234" }]);
    const sup = await loadPublicationSuppressions(["111"], client);
    expect(isAuthorHidden(sup, "111", "abc1234")).toBe(true);
    expect(isAuthorHidden(sup, "111", "xyz9999")).toBe(false); // same pmid, other cwid
    expect(isAuthorHidden(sup, "222", "abc1234")).toBe(false); // other pmid, same cwid
  });
});

describe("isPublicationDark", () => {
  /** Build a PublicationSuppressions through the public loader path. */
  async function load(rows: SuppressionRow[]) {
    const { client } = clientReturning(rows);
    const pmids = rows.map((r) => r.entityId);
    return loadPublicationSuppressions(pmids.length > 0 ? pmids : ["_none_"], client);
  }

  it("is dark for an explicit whole-publication takedown", async () => {
    const sup = await load([{ entityId: "111", contributorCwid: null }]);
    expect(isPublicationDark(sup, "111", ["abc1234"])).toBe(true);
  });

  it("is dark when every confirmed WCM author has a per-author hide (derived)", async () => {
    const sup = await load([
      { entityId: "222", contributorCwid: "a" },
      { entityId: "222", contributorCwid: "b" },
    ]);
    expect(isPublicationDark(sup, "222", ["a", "b"])).toBe(true);
  });

  it("is not dark while at least one confirmed WCM author remains displayed", async () => {
    const sup = await load([{ entityId: "222", contributorCwid: "a" }]);
    expect(isPublicationDark(sup, "222", ["a", "b"])).toBe(false);
  });

  it("is not dark for a publication with no confirmed WCM authorship", async () => {
    const sup = await load([]);
    expect(isPublicationDark(sup, "333", [])).toBe(false);
  });

  it("an explicit takedown darkens regardless of the displayed-author set", async () => {
    const sup = await load([{ entityId: "111", contributorCwid: null }]);
    expect(isPublicationDark(sup, "111", ["a", "b"])).toBe(true);
  });
});

describe("loadAllPublicationSuppressions", () => {
  it("returns empty sets when no active suppression rows exist", async () => {
    const { client } = clientReturning([]);
    const sup = await loadAllPublicationSuppressions(client);
    expect(sup.darkPmids.size).toBe(0);
    expect(sup.hiddenAuthorsByPmid.size).toBe(0);
  });

  it("collects takedowns and per-author hides across many pmids in one pass", async () => {
    const { client } = clientReturning([
      { entityId: "111", contributorCwid: null }, // whole-pub takedown
      { entityId: "222", contributorCwid: "abc1234" }, // per-author
      { entityId: "222", contributorCwid: "xyz9999" }, // per-author, same pmid
      { entityId: "333", contributorCwid: "def5678" }, // per-author
    ]);
    const sup = await loadAllPublicationSuppressions(client);
    expect(sup.darkPmids.has("111")).toBe(true);
    expect(sup.darkPmids.size).toBe(1);
    expect(isAuthorHidden(sup, "222", "abc1234")).toBe(true);
    expect(isAuthorHidden(sup, "222", "xyz9999")).toBe(true);
    expect(isAuthorHidden(sup, "333", "def5678")).toBe(true);
  });

  it("queries the whole publication-suppression table, un-revoked only — no entityId filter", async () => {
    const { client, findMany } = clientReturning([]);
    await loadAllPublicationSuppressions(client);
    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      entityType: "publication",
      revokedAt: null,
    });
    // Specifically: no `entityId` clause — the batch ETL build needs the whole
    // table, not a pmid-scoped slice. This is the contract that distinguishes
    // it from `loadPublicationSuppressions`.
    expect(call.where).not.toHaveProperty("entityId");
  });
});
