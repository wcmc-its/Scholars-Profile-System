/**
 * `POST /api/edit/news-mention/add-person` — Media highlights "Add person".
 * Credits a clip to one more scholar (published) without touching the clip's
 * own row. Shares `creditMention` with reassign; every write is undo-stamped.
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

import { POST } from "@/app/api/edit/news-mention/add-person/route";

const URL_ = "https://outlet.example.org/invented-story";
const CLIP = {
  id: "clip-1",
  cwid: "abc1001",
  url: URL_,
  status: "published",
  title: "Invented story quoting two invented researchers",
  publishedAt: new Date("2026-09-01T00:00:00Z"),
  excerpt: null,
  thumbnailUrl: null,
  detectedName: "Jordan Vale",
  sourceRef: `${URL_}|jordan vale`,
  showOnProfile: true,
  enteredByCwid: "cms1001",
  decisionId: null,
  outlet: "Invented Daily",
  creditedOutlet: null,
};
const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

function request(body: Record<string, unknown>, session: Record<string, unknown> = STEWARD) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cms1001", impersonatedCwid: null, body, requestId: "req-7" },
  });
  return new Request("http://x/api/edit/news-mention/add-person", { method: "POST" }) as never;
}

/** The target's existing row for the article (findUnique by cwid_url). */
function targetHas(row: Record<string, unknown> | null, source: Record<string, unknown> = CLIP) {
  h.tx.newsMention.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id ? { ...source } : row,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  h.tx.scholar.findFirst.mockResolvedValue({ cwid: "zzz9001", preferredName: "Casey Example" });
  targetHas(null);
  h.tx.newsMention.findFirst.mockResolvedValue(null);
  h.tx.newsMention.findMany.mockResolvedValue([]);
  h.tx.newsMention.update.mockImplementation(async ({ where, data }: never) => ({
    ...CLIP,
    ...(where as object),
    ...(data as object),
  }));
  let n = 0;
  h.tx.newsMention.create.mockImplementation(async ({ data }: never) => ({
    id: `new-${++n}`,
    detectedName: null,
    sourceRef: null,
    ...(data as object),
  }));
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("add a person to a clip", () => {
  it("creates a published CURATOR row for them and leaves the clip's own row alone", async () => {
    const res = await POST(request({ id: "clip-1", cwid: " ZZZ9001 " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      decisionId: "req-7",
      addedTo: { cwid: "zzz9001", name: "Casey Example" },
    });
    expect(h.tx.newsMention.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cwid: "zzz9001",
        url: URL_,
        outlet: "Invented Daily",
        status: "published",
        source: "CURATOR",
        showOnProfile: true,
        decisionId: "req-7",
        prevStatus: null,
      }),
    });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ afterValues: expect.objectContaining({ addedFrom: "clip-1" }) }),
    );
    // Their profile is refreshed post-commit, not the clip owner's.
    expect(h.resolveAffectedProfiles).toHaveBeenCalledTimes(1);
    expect(h.resolveAffectedProfiles.mock.calls[0][1]).toBe("zzz9001");
  });

  it("works from a still-pending clip, which stays pending", async () => {
    targetHas(null, { ...CLIP, status: "pending" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.create).toHaveBeenCalledTimes(1);
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });

  it("approves their existing pending row instead of creating one", async () => {
    targetHas({ ...CLIP, id: "theirs", cwid: "zzz9001", status: "pending", enteredByCwid: null });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "theirs" },
      data: expect.objectContaining({ status: "published", decisionId: "req-7" }),
    });
  });


  it("carries the story's copies, each pointing at their row for the lead", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...CLIP, id: "copy-1", url: `${URL_}-syndicated`, outlet: "Other Invented Paper" },
    ]);
    await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(h.tx.newsMention.create).toHaveBeenCalledTimes(2);
    expect(h.tx.newsMention.create.mock.calls[1][0].data).toMatchObject({
      url: `${URL_}-syndicated`,
      duplicateOf: "new-1",
    });
  });
});

describe("refusals write nothing", () => {
  function expectNoWrites() {
    expect(h.tx.newsMention.create).not.toHaveBeenCalled();
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.resolveAffectedProfiles).not.toHaveBeenCalled();
  }

  it("409 rejected_by_scholar when they said 'not me'", async () => {
    targetHas({ ...CLIP, id: "theirs", cwid: "zzz9001", status: "rejected", enteredByCwid: "zzz9001" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("rejected_by_scholar");
    expectNoWrites();
  });

  it("409 target_rejected when a reviewer rejected it for them", async () => {
    targetHas({ ...CLIP, id: "theirs", cwid: "zzz9001", status: "rejected", enteredByCwid: "cms1001" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("target_rejected");
    expectNoWrites();
  });

  it("409 source_rejected on a rejected clip", async () => {
    targetHas(null, { ...CLIP, status: "rejected" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expectNoWrites();
  });

  it("409 contested while another candidate is pending for the detected name", async () => {
    targetHas(null, { ...CLIP, status: "pending" });
    h.tx.newsMention.findFirst.mockResolvedValue({ id: "rival" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("contested");
    expectNoWrites();
  });

  it("409 already_credited when they already have it published (no empty Undo)", async () => {
    targetHas({ ...CLIP, id: "theirs", cwid: "zzz9001", status: "published" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_credited");
    expectNoWrites();
  });

  it("409 contested when THEIR pending row competes with another candidate", async () => {
    targetHas({
      ...CLIP,
      id: "theirs",
      cwid: "zzz9001",
      status: "pending",
      enteredByCwid: null,
      sourceRef: `${URL_}|casey example`,
    });
    // The clip's own row is published, so only their row's rival is found.
    h.tx.newsMention.findFirst.mockResolvedValue({ id: "rival" });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("contested");
    expectNoWrites();
  });

  it("422 unknown_cwid for a cwid with no live scholar row", async () => {
    h.tx.scholar.findFirst.mockResolvedValue(null);
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(422);
    expectNoWrites();
  });

  it("400 same_scholar when the clip is already theirs", async () => {
    const res = await POST(request({ id: "clip-1", cwid: "abc1001" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("same_scholar");
    expectNoWrites();
  });

  it("400 not_a_clip on a newsroom mention", async () => {
    targetHas(null, { ...CLIP, outlet: null });
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }));
    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it("404 for a missing row", async () => {
    h.tx.newsMention.findUnique.mockResolvedValue(null);
    const res = await POST(request({ id: "nope", cwid: "zzz9001" }));
    expect(res.status).toBe(404);
  });

  it("403 for a scholar with no steward, editor or superuser role", async () => {
    const res = await POST(request({ id: "clip-1", cwid: "zzz9001" }, { cwid: "abc1001", isSuperuser: false }));
    expect(res.status).toBe(403);
    expectNoWrites();
  });
});
