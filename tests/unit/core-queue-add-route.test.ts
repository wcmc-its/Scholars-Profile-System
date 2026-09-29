/**
 * POST /api/edit/core-queue-add — "Add PMIDs → Send to review" (Core Review
 * Queue v2 PR B). readEditRequest is mocked to inject a parsed context;
 * editOk/editError stay real so status codes are exercised; the active-claim
 * read (loadActiveCoreClaimsByCore) runs for real against a mocked
 * `coreClaim.findMany`. DB + audit are mocked. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockReadEditRequest,
  mockCoreFindUnique,
  mockClaimFindMany,
  mockUnitAdminFindUnique,
  mockPublicationFindMany,
  mockPublicationCoreFindMany,
  mockQueueFindMany,
  mockTransaction,
  mockQueueUpsert,
  mockAppendAuditRow,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockClaimFindMany: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationCoreFindMany: vi.fn(),
  mockQueueFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockQueueUpsert: vi.fn(),
  mockAppendAuditRow: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      coreClaim: { findMany: mockClaimFindMany },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
      publication: { findMany: mockPublicationFindMany },
      publicationCore: { findMany: mockPublicationCoreFindMany },
      coreQueueAdd: { findMany: mockQueueFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/core-queue-add/route";

const ACTOR = "rev01";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/edit/core-queue-add", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}

async function call(
  bodyOver: Record<string, unknown> = {},
  sessionOver: Record<string, unknown> = {},
) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: { cwid: ACTOR, isSuperuser: true, isCommsSteward: false, ...sessionOver },
      realCwid: ACTOR,
      impersonatedCwid: null,
      requestId: "req-1",
      body: { coreId: "2", pmids: ["11", "12", "13"], ...bodyOver },
    },
  });
  return POST(req());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCoreFindUnique.mockResolvedValue({ id: "2" });
  mockUnitAdminFindUnique.mockResolvedValue(null);
  mockClaimFindMany.mockResolvedValue([]);
  mockPublicationCoreFindMany.mockResolvedValue([]);
  mockQueueFindMany.mockResolvedValue([]);
  mockPublicationFindMany.mockImplementation(
    async ({ where }: { where: { pmid: { in: string[] } } }) =>
      where.pmid.in.map((pmid) => ({ pmid })),
  );
  mockQueueUpsert.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coreQueueAdd: { upsert: mockQueueUpsert } }),
  );
});

describe("POST /api/edit/core-queue-add", () => {
  it("queues every new pmid in ONE transaction, one core_queue_add audit row each", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      coreId: "2",
      added: 3,
      inQueue: 0,
      decided: 0,
      notFound: [],
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueueUpsert).toHaveBeenCalledTimes(3);
    const upsert = mockQueueUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ coreId_pmid: { coreId: "2", pmid: "11" } });
    expect(upsert.create).toMatchObject({ coreId: "2", pmid: "11", addedBy: ACTOR });
    expect(upsert.update).toEqual({});
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(3);
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "core_queue_add",
      targetEntityType: "core",
      targetEntityId: "2:11",
      fieldsChanged: ["queued"],
      beforeValues: null,
      afterValues: { queued: true },
      actorCwid: ACTOR,
      requestId: "req-1",
    });
  });

  it("de-dupes: a pmid already queued, or already an open engine candidate, is inQueue", async () => {
    mockQueueFindMany.mockResolvedValue([{ pmid: "11" }]);
    mockPublicationCoreFindMany.mockResolvedValue([{ pmid: "12", status: "candidate" }]);
    const res = await call();
    expect(await res.json()).toMatchObject({ added: 1, inQueue: 2, decided: 0 });
    expect(mockQueueUpsert).toHaveBeenCalledTimes(1);
    expect(mockQueueUpsert.mock.calls[0][0].create.pmid).toBe("13");
    // the reads are scoped to this core
    expect(mockQueueFindMany.mock.calls[0][0]).toMatchObject({ where: { coreId: "2" } });
    expect(mockPublicationCoreFindMany.mock.calls[0][0]).toMatchObject({ where: { coreId: "2" } });
  });

  it("repeated pmids in one body are written once", async () => {
    await call({ pmids: ["11", "11", "11"] });
    expect(mockQueueUpsert).toHaveBeenCalledTimes(1);
  });

  it("an already-decided pmid (active claim, or engine-confirmed) is not queued", async () => {
    mockClaimFindMany.mockResolvedValue([{ pmid: "11", status: "rejected" }]);
    mockPublicationCoreFindMany.mockResolvedValue([{ pmid: "12", status: "confirmed" }]);
    const res = await call();
    expect(await res.json()).toMatchObject({ added: 1, decided: 2, inQueue: 0 });
    expect(mockQueueUpsert.mock.calls.map((c) => c[0].create.pmid)).toEqual(["13"]);
  });

  it("a below-threshold engine row IS queued (it is invisible to the reviewer otherwise)", async () => {
    mockPublicationCoreFindMany.mockResolvedValue([{ pmid: "11", status: "below_threshold" }]);
    const res = await call({ pmids: ["11"] });
    expect(await res.json()).toMatchObject({ added: 1 });
  });

  it("reports a pmid SPS hasn't ingested as notFound and doesn't write it", async () => {
    mockPublicationFindMany.mockResolvedValue([{ pmid: "11" }]);
    const res = await call();
    expect(await res.json()).toMatchObject({ added: 1, notFound: ["12", "13"] });
    expect(mockQueueUpsert).toHaveBeenCalledTimes(1);
  });

  it("writes nothing (no transaction) when nothing is new", async () => {
    mockQueueFindMany.mockResolvedValue([{ pmid: "11" }, { pmid: "12" }, { pmid: "13" }]);
    const res = await call();
    expect(await res.json()).toMatchObject({ added: 0, inQueue: 3 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("validates like the manual add: empty, over-cap, malformed → 400 invalid_pmids", async () => {
    for (const pmids of [
      [],
      Array.from({ length: 501 }, (_, i) => String(i + 1)),
      ["11", "0123"],
      ["abc"],
    ]) {
      const res = await call({ pmids });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_pmids" });
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s a bad coreId and 404s an unknown core", async () => {
    expect((await call({ coreId: "" })).status).toBe(400);
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "core_not_found" });
  });

  it("403s a non-superuser with no role on the core, before any write", async () => {
    const res = await call({}, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows a curator of the core and a comms_steward (the claim routes' rule)", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({ role: "curator" });
    expect((await call({}, { isSuperuser: false })).status).toBe(200);
    mockUnitAdminFindUnique.mockResolvedValue(null);
    expect((await call({}, { isSuperuser: false, isCommsSteward: true })).status).toBe(200);
  });

  it("dryRun runs every check and writes NOTHING", async () => {
    mockQueueFindMany.mockResolvedValue([{ pmid: "11" }]);
    mockPublicationFindMany.mockResolvedValue([{ pmid: "11" }, { pmid: "12" }]);
    const res = await call({ dryRun: true });
    expect(await res.json()).toMatchObject({
      dryRun: true,
      added: 0,
      wouldAdd: 1,
      inQueue: 1,
      notFound: ["13"],
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("dryRun still enforces authorization", async () => {
    expect((await call({ dryRun: true }, { isSuperuser: false })).status).toBe(403);
  });

  it("returns 500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
