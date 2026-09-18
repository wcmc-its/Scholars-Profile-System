/**
 * `lib/edit/report-access.ts` — the row-based gate for the Mentored
 * publications report. Mocks `@/lib/db` and `appendAuditRow` at the module
 * boundary; no live DB. The behavior most worth protecting is FAIL-CLOSED:
 * a session with no row gets the EMPTY set, and nothing here reads an env
 * flag — an empty table IS the dark state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { reportAccess: { findMany: hoisted.mockFindMany, findUnique: hoisted.mockFindUnique } },
    write: { $transaction: hoisted.mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: hoisted.mockAppendAuditRow }));

import {
  ALL_SCOPES,
  canManageReportAccess,
  getReportScopes,
  grantReportAccess,
  isMentoredPubsScopeKey,
  loadReportScopesForCwid,
  MENTORED_PUBS_REPORT,
  MENTORED_PUBS_SCOPES,
  revokeReportAccess,
  scopeAdmits,
} from "@/lib/edit/report-access";

const PLAIN = { cwid: "abc1234", isSuperuser: false, isCommsSteward: false };
const SUPER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "stw0001", isSuperuser: false, isCommsSteward: true };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockFindMany.mockResolvedValue([]);
  hoisted.mockFindUnique.mockResolvedValue(null);
  hoisted.mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    grantedAt: new Date("2026-09-18T12:00:00Z"),
  }));
  hoisted.mockDelete.mockResolvedValue({});
  hoisted.mockAppendAuditRow.mockResolvedValue(undefined);
  hoisted.mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ reportAccess: { create: hoisted.mockCreate, delete: hoisted.mockDelete }, $executeRaw: vi.fn() }),
  );
});

describe("getReportScopes — fail closed", () => {
  it("returns the EMPTY set for a plain session with no rows", async () => {
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    expect(scopes.size).toBe(0);
    expect(hoisted.mockFindMany).toHaveBeenCalledWith({
      where: { reportKey: MENTORED_PUBS_REPORT, cwid: "abc1234" },
      select: { scopeKey: true },
    });
  });

  it("returns exactly the rows' scope keys for a holder", async () => {
    hoisted.mockFindMany.mockResolvedValue([{ scopeKey: "md" }, { scopeKey: "ecr" }]);
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    expect([...scopes].sort()).toEqual(["ecr", "md"]);
    expect(scopeAdmits(scopes, "md")).toBe(true);
    expect(scopeAdmits(scopes, "mdphd")).toBe(false);
  });

  it("a wildcard row admits every bucket", async () => {
    hoisted.mockFindMany.mockResolvedValue([{ scopeKey: "*" }]);
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    for (const s of MENTORED_PUBS_SCOPES) expect(scopeAdmits(scopes, s)).toBe(true);
  });

  it("superuser and comms_steward get '*' WITHOUT a table read", async () => {
    expect([...(await getReportScopes(SUPER, MENTORED_PUBS_REPORT))]).toEqual([ALL_SCOPES]);
    expect([...(await getReportScopes(STEWARD, MENTORED_PUBS_REPORT))]).toEqual([ALL_SCOPES]);
    expect(hoisted.mockFindMany).not.toHaveBeenCalled();
  });

  it("loadReportScopesForCwid: an empty cwid never touches the table", async () => {
    expect((await loadReportScopesForCwid("", MENTORED_PUBS_REPORT)).size).toBe(0);
    expect(hoisted.mockFindMany).not.toHaveBeenCalled();
  });
});

describe("canManageReportAccess / scope keys", () => {
  it("superuser || comms_steward, nobody else", () => {
    expect(canManageReportAccess(SUPER)).toBe(true);
    expect(canManageReportAccess(STEWARD)).toBe(true);
    expect(canManageReportAccess(PLAIN)).toBe(false);
  });

  it("isMentoredPubsScopeKey accepts the three buckets and '*' only", () => {
    expect(isMentoredPubsScopeKey("md")).toBe(true);
    expect(isMentoredPubsScopeKey("mdphd")).toBe(true);
    expect(isMentoredPubsScopeKey("ecr")).toBe(true);
    expect(isMentoredPubsScopeKey("*")).toBe(true);
    expect(isMentoredPubsScopeKey("phd")).toBe(false);
    expect(isMentoredPubsScopeKey("")).toBe(false);
    expect(isMentoredPubsScopeKey(null)).toBe(false);
  });
});

describe("grantReportAccess / revokeReportAccess — one transaction + one audit row", () => {
  const args = {
    reportKey: MENTORED_PUBS_REPORT,
    scopeKey: "md",
    cwid: "abc1234",
    actorCwid: "adm0001",
    requestId: "req-1",
  };

  it("grant creates the row and a report_access_grant audit row keyed on the triple", async () => {
    const out = await grantReportAccess(args);
    expect(out).toEqual({ changed: true });
    expect(hoisted.mockCreate).toHaveBeenCalledWith({
      data: { reportKey: MENTORED_PUBS_REPORT, scopeKey: "md", cwid: "abc1234", grantedBy: "adm0001" },
    });
    expect(hoisted.mockAppendAuditRow).toHaveBeenCalledTimes(1);
    const row = hoisted.mockAppendAuditRow.mock.calls[0][1];
    expect(row).toMatchObject({
      actorCwid: "adm0001",
      impersonatedCwid: null,
      targetEntityType: "report_access",
      targetEntityId: `${MENTORED_PUBS_REPORT}:md:abc1234`,
      action: "report_access_grant",
      beforeValues: null,
      requestId: "req-1",
    });
    expect(row.afterValues).toMatchObject({ scope_key: "md", cwid: "abc1234", granted_by: "adm0001" });
  });

  it("grant is idempotent: an existing row is neither re-created nor re-audited", async () => {
    hoisted.mockFindUnique.mockResolvedValue({ cwid: "abc1234" });
    expect(await grantReportAccess(args)).toEqual({ changed: false });
    expect(hoisted.mockTransaction).not.toHaveBeenCalled();
    expect(hoisted.mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("revoke deletes the row and writes report_access_revoke with the deleted row as before", async () => {
    hoisted.mockFindUnique.mockResolvedValue({
      reportKey: MENTORED_PUBS_REPORT,
      scopeKey: "md",
      cwid: "abc1234",
      grantedBy: "stw0001",
      grantedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(await revokeReportAccess({ ...args, impersonatedCwid: "tgt0001" })).toEqual({ changed: true });
    expect(hoisted.mockDelete).toHaveBeenCalledWith({
      where: { reportKey_scopeKey_cwid: { reportKey: MENTORED_PUBS_REPORT, scopeKey: "md", cwid: "abc1234" } },
    });
    const row = hoisted.mockAppendAuditRow.mock.calls[0][1];
    expect(row).toMatchObject({
      action: "report_access_revoke",
      impersonatedCwid: "tgt0001",
      afterValues: null,
    });
    expect(row.beforeValues).toMatchObject({ granted_by: "stw0001", granted_at: "2026-09-01T00:00:00.000Z" });
  });

  it("revoke of a missing row is a no-op with no audit row", async () => {
    expect(await revokeReportAccess(args)).toEqual({ changed: false });
    expect(hoisted.mockTransaction).not.toHaveBeenCalled();
    expect(hoisted.mockAppendAuditRow).not.toHaveBeenCalled();
  });
});
