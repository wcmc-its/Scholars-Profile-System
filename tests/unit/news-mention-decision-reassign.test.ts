/**
 * `POST /api/edit/news-mention/decision` with `cwid` — the queues' "Wrong
 * person?" override. The original row is REJECTED (it stays as the tombstone
 * that stops etl/news re-proposing the wrong person) and the mention is credited
 * to the named, directory-verified scholar. Every write carries the undo stamp.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  tx: {
    scholar: { findFirst: vi.fn() },
    newsMention: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectVisibilityChange: h.reflectVisibilityChange,
  resolveAffectedProfiles: h.resolveAffectedProfiles,
}));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/news-mention/decision/route";

const URL_ = "https://news.example.org/imaging-lead";
const PENDING = {
  id: "news-1",
  cwid: "abc1001",
  url: URL_,
  status: "pending",
  title: "Invented Institute names a new imaging lead",
  publishedAt: new Date("2026-09-01T00:00:00Z"),
  excerpt: "An invented excerpt.",
  thumbnailUrl: null,
  detectedName: "Jordan Vale",
  sourceRef: `${URL_}|jordan vale`,
  showOnProfile: true,
  enteredByCwid: null,
  outlet: null,
  creditedOutlet: null,
};
const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

function request(body: Record<string, unknown>, session: Record<string, unknown> = STEWARD) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cms1001", impersonatedCwid: null, body, requestId: "req-9" },
  });
  return new Request("http://x/api/edit/news-mention/decision", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  h.tx.scholar.findFirst.mockResolvedValue({ cwid: "zzz9001", preferredName: "Casey Example" });
  // First findUnique: the decided row. Second: the target's (cwid, url) row.
  h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id ? { ...PENDING } : null,
  );
  h.tx.newsMention.findFirst.mockResolvedValue(null);
  h.tx.newsMention.findMany.mockResolvedValue([]);
  h.tx.newsMention.update.mockImplementation(async ({ where, data }: never) => ({
    ...PENDING,
    ...(where as { id: string }),
    ...(data as object),
  }));
  h.tx.newsMention.create.mockImplementation(async ({ data }: never) => ({
    id: "news-new",
    detectedName: null,
    sourceRef: null,
    ...(data as object),
  }));
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("reassign to a scholar with no row for the article", () => {
  it("rejects the original row and creates a CURATOR row for the named scholar", async () => {
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: " ZZZ9001 " }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "rejected",
      decisionId: "req-9",
      reassignedTo: { cwid: "zzz9001", name: "Casey Example" },
    });
    // The CWID is normalised and checked against the live scholar table.
    expect(h.tx.scholar.findFirst).toHaveBeenCalledWith({
      where: { cwid: "zzz9001", deletedAt: null },
      select: { cwid: true, preferredName: true },
    });
    // The original row is rejected, NOT moved: it stays the tombstone that stops
    // the nightly ETL re-proposing the wrong person.
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-1" },
      data: expect.objectContaining({
        status: "rejected",
        enteredByCwid: "cms1001",
        decisionId: "req-9",
        prevStatus: "pending",
      }),
    });
    expect(h.tx.newsMention.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cwid: "zzz9001",
        url: URL_,
        title: PENDING.title,
        status: "published",
        source: "CURATOR",
        showOnProfile: true,
        enteredByCwid: "cms1001",
        decisionId: "req-9",
        // prevStatus null + decisionId = "this decision created me": undo deletes.
        prevStatus: null,
      }),
    });
  });

  it("approve_hidden creates the new row hidden and leaves the original's visibility alone", async () => {
    await POST(request({ id: "news-1", decision: "approve_hidden", cwid: "zzz9001" }) as never);
    const orig = h.tx.newsMention.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(orig.data).not.toHaveProperty("showOnProfile");
    expect(h.tx.newsMention.create.mock.calls[0][0]).toMatchObject({
      data: { showOnProfile: false },
    });
  });

  it("audits both rows as news_mention_update, linked both ways, with one ts", async () => {
    await POST(request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never);
    const calls = h.appendAuditRow.mock.calls.map((c) => c[1]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ action: "news_mention_update" });
    expect(calls[0]).toMatchObject({
      targetEntityId: "news-1",
      afterValues: { reassignedTo: "zzz9001" },
    });
    expect(calls[1]).toMatchObject({
      targetEntityId: "news-new",
      afterValues: { reassignedFrom: "news-1" },
    });
    expect(new Set(calls.map((c) => c.ts.getTime())).size).toBe(1);
  });

  it("reflects both the old and the new scholar's profile", async () => {
    await POST(request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never);
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "zzz9001"]);
  });
});

describe("reassign to a scholar who already has a row for the article", () => {
  it("approves their pending row instead of creating one, and sweeps the other candidates", async () => {
    const theirs = { ...PENDING, id: "news-2", cwid: "zzz9001" };
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? { ...PENDING } : theirs,
    );
    h.tx.newsMention.findMany.mockResolvedValue([{ ...PENDING, id: "news-3", cwid: "def2002" }]);
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-2" },
      data: expect.objectContaining({
        status: "published",
        decisionId: "req-9",
        prevStatus: "pending",
      }),
    });
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-3" },
      data: expect.objectContaining({ status: "rejected" }),
    });
    // The sweep excludes the target's own candidate row.
    expect(h.tx.newsMention.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: "pending", cwid: { not: "zzz9001" } }),
    });
  });

  it("leaves an already-published row for them untouched", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? { ...PENDING }
        : { ...PENDING, id: "news-2", cwid: "zzz9001", status: "published" },
    );
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.tx.newsMention.update).toHaveBeenCalledTimes(1);
  });
});

describe("refusals write nothing", () => {
  it("422s a CWID with no live scholar row", async () => {
    h.tx.scholar.findFirst.mockResolvedValue(null);
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: "unknown_cwid", field: "cwid" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("400s a malformed CWID before touching the DB", async () => {
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "12; drop" }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwid" });
    expect(h.tx.newsMention.findUnique).not.toHaveBeenCalled();
  });

  it("400s a cwid on a reject", async () => {
    const res = await POST(request({ id: "news-1", decision: "reject", cwid: "zzz9001" }) as never);
    expect(res.status).toBe(400);
  });

  it("only reassigns a PENDING row", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? { ...PENDING, status: "rejected" } : null,
    );
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
  });

  it("409s when another candidate already won the name", async () => {
    h.tx.newsMention.findFirst.mockResolvedValue({ id: "news-4" });
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_decided" });
    expect(h.tx.newsMention.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: "published", cwid: { not: "zzz9001" } }),
      select: { id: true },
    });
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
  });

  it("keeps the steward / superuser gate", async () => {
    const res = await POST(
      request(
        { id: "news-1", decision: "approve", cwid: "zzz9001" },
        { cwid: "sch1", isSuperuser: false, isCommsSteward: false },
      ) as never,
    );
    expect(res.status).toBe(403);
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
  });
});

describe("naming the row's own scholar", () => {
  it("is a plain approval — no create, no directory lookup", async () => {
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "abc1001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "published" });
    expect(h.tx.scholar.findFirst).not.toHaveBeenCalled();
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
  });
});

describe("never overrides a rejection on the target's own row", () => {
  it("409s rejected_by_scholar when the scholar said 'not me' themselves, writing nothing", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? { ...PENDING }
        : {
            ...PENDING,
            id: "news-2",
            cwid: "zzz9001",
            status: "rejected",
            enteredByCwid: "zzz9001",
          },
    );
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rejected_by_scholar", field: "cwid" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409s target_rejected for a row someone else rejected, writing nothing", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? { ...PENDING }
        : {
            ...PENDING,
            id: "news-2",
            cwid: "zzz9001",
            status: "rejected",
            enteredByCwid: "cms2002",
          },
    );
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "target_rejected" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });
});

describe("approve_hidden onto a row already published for the target", () => {
  it("applies the hide (stamped, so Undo puts it back)", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? { ...PENDING }
        : { ...PENDING, id: "news-2", cwid: "zzz9001", status: "published", showOnProfile: true },
    );
    const res = await POST(
      request({ id: "news-1", decision: "approve_hidden", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-2" },
      data: expect.objectContaining({
        showOnProfile: false,
        decisionId: "req-9",
        prevStatus: "published",
        prevShowOnProfile: true,
      }),
    });
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
  });
});

describe("reassigning a Media highlights lead with copies", () => {
  it("rejects each copy with the original AND credits each to the named scholar, grouped", async () => {
    const lead = { ...PENDING, outlet: "Invented Gazette", sourceRef: null };
    const copy = {
      ...PENDING,
      id: "news-c1",
      url: "https://paper.example.org/syndicated",
      outlet: "Invented Daily",
      sourceRef: null,
    };
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? { ...lead } : null,
    );
    h.tx.newsMention.findMany.mockResolvedValue([copy]);
    let n = 0;
    h.tx.newsMention.create.mockImplementation(async ({ data }: never) => ({
      id: `new-${++n}`,
      detectedName: null,
      sourceRef: null,
      ...(data as object),
    }));
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-c1" },
      data: expect.objectContaining({ status: "rejected", decisionId: "req-9" }),
    });
    expect(h.tx.newsMention.create).toHaveBeenCalledTimes(2);
    const [first, second] = h.tx.newsMention.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(first).toMatchObject({ cwid: "zzz9001", url: URL_, status: "published" });
    expect(first).not.toHaveProperty("duplicateOf");
    expect(second).toMatchObject({
      cwid: "zzz9001",
      url: copy.url,
      outlet: "Invented Daily",
      status: "published",
      duplicateOf: "new-1",
      decisionId: "req-9",
    });
  });
});

describe("undo stays all or nothing", () => {
  it("re-stamping a row invalidates the earlier decision on every row it wrote", async () => {
    h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? { ...PENDING, decisionId: "old-1" } : null,
    );
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...PENDING, id: "news-3", cwid: "def2002", decisionId: "old-2" },
    ]);
    const res = await POST(
      request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.updateMany).toHaveBeenCalledTimes(1);
    const arg = h.tx.newsMention.updateMany.mock.calls[0][0] as {
      where: { decisionId: { in: string[] } };
      data: Record<string, unknown>;
    };
    expect(arg.where.decisionId.in.sort()).toEqual(["old-1", "old-2"]);
    expect(arg.data).toMatchObject({ decisionId: null, prevStatus: null });
  });

  it("a fresh row carries no earlier decision, so nothing is invalidated", async () => {
    await POST(request({ id: "news-1", decision: "approve", cwid: "zzz9001" }) as never);
    expect(h.tx.newsMention.updateMany).not.toHaveBeenCalled();
  });
});
