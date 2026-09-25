/**
 * `POST /api/edit/news-mention` (profile hide / show / "not me") must clear the
 * review queue's undo stamp. Otherwise a reviewer's Undo, still on screen, would
 * put back the state from BEFORE their decision and silently overwrite this
 * newer one (lib/edit/news-decision.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  authorizeOverviewWrite: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: h.authorizeOverviewWrite }));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { newsMention: { findUnique: h.findUnique } },
    write: {
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) =>
        fn({ newsMention: { update: h.update } }),
      ),
    },
  },
}));

import { POST } from "@/app/api/edit/news-mention/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: { cwid: "abc1001", isSuperuser: false },
      realCwid: "abc1001",
      impersonatedCwid: null,
      body: { id: "news-1", action: "hide" },
      requestId: "req-2",
    },
  });
  h.authorizeOverviewWrite.mockResolvedValue({ ok: true });
  h.findUnique.mockResolvedValue({
    id: "news-1",
    cwid: "abc1001",
    url: "https://news.example.org/x",
    title: "An invented story",
    publishedAt: null,
    status: "published",
    source: "NAME",
    showOnProfile: true,
  });
  h.update.mockImplementation(async ({ data }: { data: object }) => ({
    id: "news-1",
    url: "https://news.example.org/x",
    title: "An invented story",
    publishedAt: null,
    status: "published",
    source: "NAME",
    ...data,
  }));
});

describe("profile news write", () => {
  it("clears the queue's undo stamp with the change", async () => {
    const res = await POST(
      new Request("http://x/api/edit/news-mention", { method: "POST" }) as never,
    );
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "news-1" },
      data: expect.objectContaining({
        showOnProfile: false,
        enteredByCwid: "abc1001",
        decisionId: null,
        decisionAt: null,
        prevStatus: null,
        prevShowOnProfile: null,
        prevEnteredByCwid: null,
      }),
    });
  });
});
