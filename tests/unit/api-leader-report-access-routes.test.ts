/**
 * Leadership report access on the NCI Table 2A routes (LEADER_REPORT_ACCESS):
 *   - GET  /api/edit/center/[code]/nci-2a          — a center leader reads it (200);
 *   - PATCH /api/edit/center/[code]/nci-2a/[awardId] and
 *     POST /api/edit/center/[code]/nci-2a/accept    — a PROGRAM leader writes (200),
 *     a center-level leader without a program role is refused (403);
 *   - flag off, every leader is refused exactly as before (403).
 * The leadership read runs through the real `lib/edit/unit-leader-access.ts`
 * against a mocked `orgUnitRoleAssignment.findMany`. Fixture people are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  centerFindUnique: vi.fn(),
  unitAdminFindMany: vi.fn(),
  assignmentFindMany: vi.fn(),
  awardFindUnique: vi.fn(),
  transaction: vi.fn(),
  txAwardUpdate: vi.fn(),
  txFindMany: vi.fn(),
  txUpdateMany: vi.fn(),
  appendAuditRow: vi.fn(),
  loadNci2aReport: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: h.session }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await h.session();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: h.centerFindUnique },
      unitAdmin: { findMany: h.unitAdminFindMany },
      orgUnitRoleAssignment: { findMany: h.assignmentFindMany },
      cancerCenterFundingAward: { findUnique: h.awardFindUnique },
    },
    write: { $transaction: h.transaction },
  },
}));
vi.mock("@/lib/edit/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/audit")>()),
  appendAuditRow: h.appendAuditRow,
}));
vi.mock("@/lib/edit/nci-2a-report.server", () => ({ loadNci2aReport: h.loadNci2aReport }));

import { GET } from "@/app/api/edit/center/[code]/nci-2a/route";
import { PATCH } from "@/app/api/edit/center/[code]/nci-2a/[awardId]/route";
import { POST as ACCEPT } from "@/app/api/edit/center/[code]/nci-2a/accept/route";

const CENTER = "meyer_cancer_center";
const LEADER = { cwid: "lead001", isSuperuser: false, isCommsSteward: false };

type Assignment = { entityType: string; entityId: string; roleKey: string; roleGroup: string };
/** The leadership rows the mocked `orgUnitRoleAssignment.findMany` answers from. */
let held: Assignment[] = [];
const AD: Assignment = {
  entityType: "center",
  entityId: CENTER,
  roleKey: "associate_director",
  roleGroup: "leadership",
};
const PROGRAM_LEADER: Assignment = {
  entityType: "center_program",
  entityId: `${CENTER}:CB`,
  roleKey: "leader",
  roleGroup: "leadership",
};

function rowMatches(a: Assignment, where: Record<string, unknown>): boolean {
  const eq = (v: string, c: unknown) =>
    c === undefined ||
    (typeof c === "string"
      ? v === c
      : "in" in (c as object)
        ? (c as { in: string[] }).in.includes(v)
        : v.startsWith((c as { startsWith: string }).startsWith));
  if (where.OR) return (where.OR as Array<Record<string, unknown>>).some((w) => rowMatches(a, w));
  const role = where.role as { roleGroup?: string } | undefined;
  return (
    eq(a.entityType, where.entityType) &&
    eq(a.entityId, where.entityId) &&
    eq(a.roleKey, where.roleKey) &&
    (role?.roleGroup === undefined || a.roleGroup === role.roleGroup)
  );
}

function get(): NextRequest {
  return new NextRequest(`http://localhost/api/edit/center/${CENTER}/nci-2a`, {
    headers: { "sec-fetch-site": "same-origin" },
  });
}
function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/edit/center/${CENTER}/nci-2a/award-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
function accept(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/edit/center/${CENTER}/nci-2a/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
const codeParams = () => ({ params: Promise.resolve({ code: CENTER }) });
const awardParams = () => ({ params: Promise.resolve({ code: CENTER, awardId: "award-1" }) });

const prevFlag = process.env.LEADER_REPORT_ACCESS;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.LEADER_REPORT_ACCESS = "on";
  held = [];
  h.session.mockResolvedValue(LEADER);
  h.centerFindUnique.mockResolvedValue({ code: CENTER });
  h.unitAdminFindMany.mockResolvedValue([]);
  h.assignmentFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.cwid === LEADER.cwid ? held.filter((a) => rowMatches(a, where)) : [],
  );
  h.loadNci2aReport.mockResolvedValue({ cycle: "osra-2026-07-14", programs: [], awards: [] });
  h.awardFindUnique.mockResolvedValue({
    id: "award-1",
    cancerRelevantPercent: 50,
    reviewerNote: null,
    traineeSlots: null,
    allocations: [],
  });
  h.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      cancerCenterFundingAward: {
        update: h.txAwardUpdate,
        findMany: h.txFindMany,
        updateMany: h.txUpdateMany,
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    }),
  );
  h.txAwardUpdate.mockResolvedValue({ id: "award-1" });
  h.txFindMany.mockResolvedValue([
    { id: "award-1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "llm" },
  ]);
  h.txUpdateMany.mockResolvedValue({ count: 1 });
  h.appendAuditRow.mockResolvedValue(undefined);
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.LEADER_REPORT_ACCESS;
  else process.env.LEADER_REPORT_ACCESS = prevFlag;
});

describe("GET nci-2a (report data read)", () => {
  it("a center associate director reads it (200)", async () => {
    held = [AD];
    const res = await GET(get(), codeParams());
    expect(res.status).toBe(200);
    expect(h.loadNci2aReport).toHaveBeenCalledWith(CENTER, null);
  });

  it("a program leader reads it (200)", async () => {
    held = [PROGRAM_LEADER];
    expect((await GET(get(), codeParams())).status).toBe(200);
  });

  it("a non-leader is refused (403)", async () => {
    expect((await GET(get(), codeParams())).status).toBe(403);
  });

  it("flag off: a leader is refused, and no leadership row is read", async () => {
    delete process.env.LEADER_REPORT_ACCESS;
    held = [AD, PROGRAM_LEADER];
    expect((await GET(get(), codeParams())).status).toBe(403);
    expect(h.assignmentFindMany).not.toHaveBeenCalled();
    expect(h.loadNci2aReport).not.toHaveBeenCalled();
  });
});

describe("2A writes", () => {
  it("a program leader PATCHes a note (200) and the audit row is written", async () => {
    held = [PROGRAM_LEADER];
    const res = await PATCH(patch({ reviewerNote: "Aim 2 only" }), awardParams());
    expect(res.status).toBe(200);
    expect(h.txAwardUpdate).toHaveBeenCalled();
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorCwid: LEADER.cwid, action: "cancer_funding_override" }),
    );
  });

  it("a program leader bulk-Accepts (200)", async () => {
    held = [PROGRAM_LEADER];
    const res = await ACCEPT(accept({ awardIds: ["award-1"] }), codeParams());
    expect(res.status).toBe(200);
    expect(h.txUpdateMany).toHaveBeenCalled();
  });

  it("a center associate director without a program role is refused both writes (403)", async () => {
    held = [AD];
    expect((await PATCH(patch({ reviewerNote: "x" }), awardParams())).status).toBe(403);
    expect((await ACCEPT(accept({ awardIds: ["award-1"] }), codeParams())).status).toBe(403);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("a COE liaison (program leadership group, not a program lead) is refused (403)", async () => {
    held = [{ ...PROGRAM_LEADER, roleKey: "coe_liaison" }];
    expect((await PATCH(patch({ reviewerNote: "x" }), awardParams())).status).toBe(403);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("a program leader of ANOTHER center is refused (403)", async () => {
    held = [{ ...PROGRAM_LEADER, entityId: "other_center:CB" }];
    expect((await PATCH(patch({ reviewerNote: "x" }), awardParams())).status).toBe(403);
  });

  it("flag off: a program leader is refused both writes (403)", async () => {
    process.env.LEADER_REPORT_ACCESS = "off";
    held = [PROGRAM_LEADER];
    expect((await PATCH(patch({ reviewerNote: "x" }), awardParams())).status).toBe(403);
    expect((await ACCEPT(accept({ awardIds: ["award-1"] }), codeParams())).status).toBe(403);
    expect(h.assignmentFindMany).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
