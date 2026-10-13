/**
 * `POST /api/edit/honor/verify` — a curator verifies a self-asserted honor.
 * Load-bearing: never the scholar; only a published SELF row; audited; no-op
 * writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  tx: { honor: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/honor/verify/route";

const ROW = {
  id: "h1",
  cwid: "abc1001",
  name: "Best Presenter",
  organization: "Invented Conference",
  source: "SELF",
  status: "published",
  verifiedAt: null,
  verifiedByCwid: null,
};

function call(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cur1001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return POST(new Request("http://x/api/edit/honor/verify", { method: "POST" }) as never);
}

const CURATOR = { cwid: "cur1001", isSuperuser: false, isHonorsCurator: true };
const SCHOLAR = { cwid: "abc1001", isSuperuser: false, isHonorsCurator: false };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HONORS_APPROVAL_QUEUE = "on";
  h.tx.honor.findUnique.mockResolvedValue({ ...ROW });
});

describe("POST /api/edit/honor/verify", () => {
  it("refuses the scholar themselves", async () => {
    const res = await call({ id: "h1", verified: true }, SCHOLAR);
    expect(res.status).toBe(403);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean verified", async () => {
    expect((await call({ id: "h1", verified: "yes" }, CURATOR)).status).toBe(400);
  });

  it("refuses a row that is not a published self-asserted honor", async () => {
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW, source: "HONORS_SEED" });
    const res = await call({ id: "h1", verified: true }, CURATOR);
    expect(res.status).toBe(409);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it("stamps who verified it and audits the change", async () => {
    const res = await call({ id: "h1", verified: true }, CURATOR);
    expect(res.status).toBe(200);
    const data = h.tx.honor.update.mock.calls[0][0].data;
    expect(data.verifiedByCwid).toBe("cur1001");
    expect(data.verifiedAt).toBeInstanceOf(Date);
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
  });

  it("unverifying clears both columns; a no-op writes nothing", async () => {
    h.tx.honor.findUnique.mockResolvedValue({
      ...ROW,
      verifiedAt: new Date(),
      verifiedByCwid: "x",
    });
    await call({ id: "h1", verified: false }, CURATOR);
    expect(h.tx.honor.update.mock.calls[0][0].data).toEqual({
      verifiedAt: null,
      verifiedByCwid: null,
    });
    vi.clearAllMocks();
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW });
    await call({ id: "h1", verified: false }, CURATOR);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});
