/**
 * `POST /api/edit/news-mention/group` — Media highlights story grouping.
 * Pins: the comms gate, each op's `duplicate_of` writes, and the audit action
 * literal `news_mention_update` (a value outside the `scholars_audit` ENUM
 * throws MySQL 1265 and 500s every write while typecheck stays green).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  rows: new Map<string, { id: string; cwid: string; outlet: string | null; duplicateOf: string | null }>(),
  update: vi.fn(),
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
vi.mock("@/lib/db", () => {
  const tx = {
    newsMention: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = h.rows.get(where.id);
        return r ? { ...r } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { duplicateOf: string } }) =>
        [...h.rows.values()].filter((r) => r.duplicateOf === where.duplicateOf).map((r) => ({ ...r })),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { duplicateOf: string | null } }) => {
        h.update(where.id, data.duplicateOf);
        const r = h.rows.get(where.id)!;
        r.duplicateOf = data.duplicateOf;
        return { ...r };
      }),
    },
  };
  return { db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } } };
});

import { POST } from "@/app/api/edit/news-mention/group/route";

const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

function call(body: Record<string, unknown>, session: Record<string, unknown> = STEWARD) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cms1001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return POST(new Request("http://x/api/edit/news-mention/group", { method: "POST" }) as never);
}

const seed = (...rows: [string, string | null, string?][]) => {
  h.rows.clear();
  for (const [id, duplicateOf, cwid = "abc1234"] of rows) h.rows.set(id, { id, cwid, outlet: "Outlet", duplicateOf });
};
const dup = (id: string) => h.rows.get(id)!.duplicateOf;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  process.env.MEDIA_HIGHLIGHTS_SECTION = "on";
  h.resolveAffectedProfiles.mockResolvedValue([]);
  h.reflectVisibilityChange.mockResolvedValue(undefined);
});

describe("POST /api/edit/news-mention/group", () => {
  it("403 for a plain scholar; nothing written", async () => {
    seed(["lead", null], ["copy", "lead"]);
    const res = await call({ op: "ungroup", id: "copy" }, { cwid: "abc1234", isSuperuser: false, isCommsSteward: false });
    expect(res.status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("ungroup: the copy becomes its own story, audited as news_mention_update", async () => {
    seed(["lead", null], ["copy", "lead"]);
    expect((await call({ op: "ungroup", id: "copy" })).status).toBe(200);
    expect(dup("copy")).toBeNull();
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "news_mention_update", fieldsChanged: ["duplicateOf"], targetEntityId: "copy" }),
    );
  });

  it("make_lead: the copy leads; the old lead and the other copies point at it", async () => {
    seed(["lead", null], ["a", "lead"], ["b", "lead"]);
    await call({ op: "make_lead", id: "a" });
    expect([dup("a"), dup("lead"), dup("b")]).toEqual([null, "a", "a"]);
  });

  it("group: joins the target's story (its lead), carrying the row's own copies", async () => {
    seed(["lead", null], ["copy", "lead"], ["other", null], ["otherCopy", "other"]);
    await call({ op: "group", id: "other", leadId: "copy" });
    expect([dup("other"), dup("otherCopy")]).toEqual(["lead", "lead"]);
  });

  it("group refuses another scholar's clip", async () => {
    seed(["a", null], ["b", null, "zzz9999"]);
    expect((await call({ op: "group", id: "a", leadId: "b" })).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
});
