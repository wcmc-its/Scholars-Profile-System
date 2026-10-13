/**
 * `POST /api/edit/honor/tier` — a curator sets or clears an honor's tier.
 * Load-bearing: only a curator (or superuser) gets in, never the scholar; the
 * tier is validated; every changed row gets an audit row; a no-op writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  tx: { honor: { findMany: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/honor/tier/route";

const ROW = {
  id: "h1",
  cwid: "abc1001",
  name: "CAREER Award",
  organization: "National Science Foundation",
  tierOverride: null,
};

function call(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cur1001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return POST(new Request("http://x/api/edit/honor/tier", { method: "POST" }) as never);
}

const CURATOR = { cwid: "cur1001", isSuperuser: false, isHonorsCurator: true };
const SCHOLAR = { cwid: "abc1001", isSuperuser: false, isHonorsCurator: false };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HONORS_APPROVAL_QUEUE = "on";
  h.tx.honor.findMany.mockResolvedValue([{ ...ROW }]);
});

describe("POST /api/edit/honor/tier", () => {
  it("refuses anyone who is not a curator, including the honor's own scholar", async () => {
    const res = await call({ ids: ["h1"], tier: 1 }, SCHOLAR);
    expect(res.status).toBe(403);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it.each([0, 7, 2.5, "3"])("rejects tier %p", async (tier) => {
    const res = await call({ ids: ["h1"], tier }, CURATOR);
    expect(res.status).toBe(400);
  });

  it("rejects a missing or oversized id list", async () => {
    expect((await call({ tier: 1 }, CURATOR)).status).toBe(400);
    expect(
      (await call({ ids: Array.from({ length: 51 }, (_, i) => `h${i}`), tier: 1 }, CURATOR)).status,
    ).toBe(400);
  });

  it("404s when an id does not exist", async () => {
    h.tx.honor.findMany.mockResolvedValue([]);
    expect((await call({ ids: ["nope"], tier: 1 }, CURATOR)).status).toBe(404);
  });

  it("writes the override and audits it", async () => {
    const res = await call({ ids: ["h1"], tier: 3 }, CURATOR);
    expect(res.status).toBe(200);
    expect(h.tx.honor.update).toHaveBeenCalledWith({
      where: { id: "h1" },
      data: { tierOverride: 3 },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: "honor_update",
        targetEntityId: "h1",
        fieldsChanged: ["tierOverride"],
        afterValues: expect.objectContaining({ tierOverride: 3 }),
      }),
    );
  });

  it("clears with null, and a no-op writes nothing", async () => {
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, tierOverride: 2 }]);
    await call({ ids: ["h1"], tier: null }, CURATOR);
    expect(h.tx.honor.update).toHaveBeenCalledWith({
      where: { id: "h1" },
      data: { tierOverride: null },
    });
    vi.clearAllMocks();
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, tierOverride: 2 }]);
    const res = await call({ ids: ["h1"], tier: 2 }, CURATOR);
    expect(res.status).toBe(200);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});
