/**
 * "Accept discrepancy" on the Titles queue (#3362).
 *
 *  - The marker hides a row from "Needs review" ONLY while the fingerprint of
 *    the inputs that flagged it still matches; a different auto title or a new
 *    flag brings the row back (`applyTitleAcceptances`, `titleTabOf`).
 *  - `POST /api/edit/title-accept`: the pin gate (superuser / comms steward),
 *    the body checks, one `field_override` upsert (never a pin) and one audit
 *    row in the same transaction.
 *
 * Fixture people and CWIDs are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  logEditDenial: vi.fn(),
  invalidate: vi.fn(),
  scholarFind: vi.fn(),
  tx: {
    fieldOverride: { findUnique: vi.fn(), upsert: vi.fn() },
    scholar: { update: vi.fn() },
  },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/authz")>()),
  logEditDenial: h.logEditDenial,
}));
vi.mock("@/lib/edit/titles-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/titles-queue")>()),
  invalidateTitlesPendingCount: h.invalidate,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { scholar: { findUnique: h.scholarFind } },
    write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) },
  },
}));

import { POST } from "@/app/api/edit/title-accept/route";
import {
  applyTitleAcceptances,
  classifyTitleRow,
  parseTitleAcceptMarker,
  TITLE_ACCEPT_FIELD,
  titleAcceptFingerprint,
  titleTabOf,
  type TitleDashboardRow,
} from "@/lib/edit/title-dashboard";
import { buildTitleOptions } from "@/lib/scholar-title";

const NO_ROLES = { chair: false, chief: false, centerDirector: false };

/** A row flagged "mismatch": chair text, no chair role. */
function mismatchRow(edPrimaryTitle = "Chair of Pediatrics"): TitleDashboardRow {
  const options = buildTitleOptions({
    workingTitle: null,
    chiefTitle: null,
    centerHeadTitle: null,
    edPrimaryTitle,
    appointmentTitles: [],
  });
  const row = classifyTitleRow(
    {
      cwid: "zzx9001",
      primaryTitle: options[0]?.value ?? null,
      override: null,
      options,
      texts: [{ title: edPrimaryTitle }],
      workingTitle: null,
    },
    NO_ROLES,
    "Cy Samplewell",
  );
  if (!row) throw new Error("fixture not listed");
  return row;
}

function clientWith(markers: Array<{ entityId: string; value: string }>) {
  const findMany = vi.fn(async () => markers);
  return { client: { fieldOverride: { findMany } } as never, findMany };
}

const marker = (fingerprint: string, title: string | null = "Chair of Pediatrics") =>
  JSON.stringify({ fingerprint, title });

describe("titleAcceptFingerprint", () => {
  it("is stable for the same inputs and a 64-char hex digest", () => {
    const a = titleAcceptFingerprint(mismatchRow());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(titleAcceptFingerprint(mismatchRow())).toBe(a);
  });

  it("changes with the auto-selected title", () => {
    expect(titleAcceptFingerprint(mismatchRow("Chair of Medicine"))).not.toBe(
      titleAcceptFingerprint(mismatchRow()),
    );
  });

  it("changes when a new flag or note appears", () => {
    const r = mismatchRow();
    expect(
      titleAcceptFingerprint({
        ...r,
        reasons: [...r.reasons, "conflictingRoles"],
        conflictNotes: ["Chair of Pediatrics is also held by Dee Mockford"],
      }),
    ).not.toBe(titleAcceptFingerprint(r));
  });

  it("ignores informational reasons (a pin alone does not resurrect the row)", () => {
    const r = mismatchRow();
    expect(titleAcceptFingerprint({ ...r, reasons: [...r.reasons, "pinned"] })).toBe(
      titleAcceptFingerprint(r),
    );
  });
});

describe("parseTitleAcceptMarker", () => {
  it("reads a marker and rejects junk without throwing", () => {
    expect(parseTitleAcceptMarker(marker("ab"))).toEqual({
      fingerprint: "ab",
      title: "Chair of Pediatrics",
    });
    expect(parseTitleAcceptMarker("not json")).toBeNull();
    expect(parseTitleAcceptMarker("{}")).toBeNull();
    expect(parseTitleAcceptMarker("null")).toBeNull();
  });
});

describe("applyTitleAcceptances — the loader's filter", () => {
  it("hides an accepted row from Needs review while its fingerprint matches", async () => {
    const r = mismatchRow();
    expect(titleTabOf(r)).toBe("review");
    const { client, findMany } = clientWith([
      { entityId: r.cwid, value: marker(titleAcceptFingerprint(r)) },
    ]);
    const [out] = await applyTitleAcceptances(client, [r]);
    expect(out.accepted).toBe(true);
    expect(titleTabOf(out)).toBe("fyi");
    expect(findMany).toHaveBeenCalledWith({
      where: { entityType: "scholar", fieldName: TITLE_ACCEPT_FIELD, entityId: { in: [r.cwid] } },
      select: { entityId: true, value: true },
    });
  });

  it("brings the row back when the inputs change (a different auto title)", async () => {
    const before = mismatchRow();
    const after = { ...mismatchRow("Chair of Medicine"), cwid: before.cwid };
    const { client } = clientWith([
      { entityId: before.cwid, value: marker(titleAcceptFingerprint(before)) },
    ]);
    const [out] = await applyTitleAcceptances(client, [after]);
    expect(out.accepted).toBeUndefined();
    expect(titleTabOf(out)).toBe("review");
  });

  it("ignores an unparseable marker", async () => {
    const r = mismatchRow();
    const { client } = clientWith([{ entityId: r.cwid, value: "garbage" }]);
    const [out] = await applyTitleAcceptances(client, [r]);
    expect(titleTabOf(out)).toBe("review");
  });

  it("does not query when no row is flagged for review", async () => {
    const r = { ...mismatchRow(), reasons: ["leadership" as const] };
    const { client, findMany } = clientWith([]);
    expect(await applyTitleAcceptances(client, [r])).toEqual([r]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/edit/title-accept
// ---------------------------------------------------------------------------

const FP = "a".repeat(64);
const SUPER = { cwid: "zzs0001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "zzc0001", isSuperuser: false, isCommsSteward: true };
const NOBODY = { cwid: "zzn0001", isSuperuser: false, isCommsSteward: false };

function request(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "zzr0001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/title-accept", { method: "POST" }) as never;
}

const BODY = { cwid: "zzx9001", fingerprint: FP, autoTitle: "Chair of Pediatrics" };

beforeEach(() => {
  vi.clearAllMocks();
  h.scholarFind.mockResolvedValue({ cwid: "zzx9001" });
  h.tx.fieldOverride.findUnique.mockResolvedValue(null);
});

describe("POST /api/edit/title-accept", () => {
  it("passes through the shared preamble's refusal (no session, cross-origin, View as)", async () => {
    const { NextResponse } = await import("next/server");
    h.readEditRequest.mockResolvedValue({
      ok: false,
      response: new NextResponse(null, { status: 401 }),
    });
    const res = await POST(new Request("http://x", { method: "POST" }) as never);
    expect(res.status).toBe(401);
    expect(h.tx.fieldOverride.upsert).not.toHaveBeenCalled();
  });

  it("refuses anyone who cannot pin (403), writing nothing", async () => {
    const res = await POST(request(BODY, NOBODY));
    expect(res.status).toBe(403);
    expect(h.logEditDenial).toHaveBeenCalled();
    expect(h.tx.fieldOverride.upsert).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cwid", { ...BODY, cwid: "" }],
    ["bad fingerprint", { ...BODY, fingerprint: "nothex" }],
    ["non-string title", { ...BODY, autoTitle: 7 }],
  ])("400 on %s", async (_label, body) => {
    const res = await POST(request(body, SUPER));
    expect(res.status).toBe(400);
    expect(h.tx.fieldOverride.upsert).not.toHaveBeenCalled();
  });

  it("400 on an unknown scholar", async () => {
    h.scholarFind.mockResolvedValue(null);
    const res = await POST(request(BODY, SUPER));
    expect(res.status).toBe(400);
  });

  it.each([
    ["superuser", SUPER],
    ["comms steward", STEWARD],
  ])("a %s accepts: one marker upsert, one audit row, never a pin", async (_l, session) => {
    const res = await POST(request(BODY, session));
    expect(res.status).toBe(200);
    const value = JSON.stringify({ fingerprint: FP, title: "Chair of Pediatrics" });
    expect(h.tx.fieldOverride.upsert).toHaveBeenCalledWith({
      where: {
        entityType_entityId_fieldName: {
          entityType: "scholar",
          entityId: "zzx9001",
          fieldName: TITLE_ACCEPT_FIELD,
        },
      },
      create: {
        entityType: "scholar",
        entityId: "zzx9001",
        fieldName: TITLE_ACCEPT_FIELD,
        value,
        actorCwid: session.cwid,
      },
      update: { value, actorCwid: session.cwid },
    });
    // The title is left alone: no Scholar.primaryTitle write, no primaryTitle override.
    expect(h.tx.scholar.update).not.toHaveBeenCalled();
    expect(h.tx.fieldOverride.upsert).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    const [, audit] = h.appendAuditRow.mock.calls[0];
    expect(audit).toMatchObject({
      actorCwid: "zzr0001",
      impersonatedCwid: null,
      targetEntityType: "scholar",
      targetEntityId: "zzx9001",
      // Already in the scholars_audit ENUM: no audit-log.sql change needed.
      action: "field_override",
      fieldsChanged: [TITLE_ACCEPT_FIELD],
      beforeValues: { [TITLE_ACCEPT_FIELD]: null },
      afterValues: { [TITLE_ACCEPT_FIELD]: value },
      requestId: "req-1",
    });
    expect(h.invalidate).toHaveBeenCalled();
  });

  it("re-accepting records the previous marker as the before value", async () => {
    h.tx.fieldOverride.findUnique.mockResolvedValue({ value: marker("b".repeat(64)) });
    await POST(request(BODY, SUPER));
    const [, audit] = h.appendAuditRow.mock.calls[0];
    expect(audit.beforeValues).toEqual({ [TITLE_ACCEPT_FIELD]: marker("b".repeat(64)) });
  });

  it("500 when the transaction fails", async () => {
    h.appendAuditRow.mockRejectedValueOnce(new Error("Data truncated"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(request(BODY, SUPER));
    expect(res.status).toBe(500);
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
