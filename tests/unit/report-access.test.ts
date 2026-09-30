/**
 * `lib/edit/report-access.ts` — the row-based gate for the Mentored
 * publications report. Mocks `@/lib/db` and `appendAuditRow` at the module
 * boundary; no live DB. The behavior most worth protecting is FAIL-CLOSED:
 * a session with no row gets the EMPTY set, and nothing here reads an env
 * flag — an empty table IS the dark state.
 *
 * The reader (`db.read`) and writer (`db.write`) are DISTINCT mock objects
 * here on purpose, as they are distinct clients in prod (Aurora reader
 * replica vs writer): the write-path tests assert the reader is never
 * touched, because a reader-side existence probe or post-write list races
 * replica lag (the `core-client` route's rule, PR #2620) and staging — with
 * no replica — could never show it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  // READER — only the gate (`loadReportScopesForCwid`) and the page's list
  // read may touch these.
  mockReadFindMany: vi.fn(),
  mockReadFindUnique: vi.fn(),
  mockReadScholarFindMany: vi.fn(),
  // WRITER, outside a transaction — the existence probes and the list a
  // no-change outcome returns.
  mockWriteFindMany: vi.fn(),
  mockWriteFindUnique: vi.fn(),
  mockWriteScholarFindMany: vi.fn(),
  // Inside the write transaction.
  mockTxFindMany: vi.fn(),
  mockTxScholarFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      reportAccess: { findMany: hoisted.mockReadFindMany, findUnique: hoisted.mockReadFindUnique },
      scholar: { findMany: hoisted.mockReadScholarFindMany },
    },
    write: {
      reportAccess: { findMany: hoisted.mockWriteFindMany, findUnique: hoisted.mockWriteFindUnique },
      scholar: { findMany: hoisted.mockWriteScholarFindMany },
      $transaction: hoisted.mockTransaction,
    },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: hoisted.mockAppendAuditRow }));

import {
  ALL_SCOPES,
  canManageReportAccess,
  getReportScopes,
  grantReportAccess,
  isMentoredPubsScopeKey,
  listReportAccess,
  loadReportScopesForCwid,
  MENTORED_PUBS_REPORT,
  MENTORED_PUBS_SCOPE_OPTIONS,
  MENTORED_PUBS_SCOPES,
  revokeReportAccess,
  scopeAdmits,
} from "@/lib/edit/report-access";

const PLAIN = { cwid: "abc1234", isSuperuser: false, isCommsSteward: false };
const SUPER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "stw0001", isSuperuser: false, isCommsSteward: true };

/** A row as the in-transaction re-read hands it back from the table. */
const TX_ROW = {
  reportKey: "mentored-publications",
  scopeKey: "md",
  cwid: "abc1234",
  grantedBy: "adm0001",
  grantedAt: new Date("2026-09-18T12:00:00Z"),
  granteeName: "Grantee Tx",
};
/** A row as the WRITER (outside a transaction) hands it back — distinct from
 *  `TX_ROW` so an assertion can tell which read produced the result. */
const WRITER_ROW = { ...TX_ROW, cwid: "zzz9999", scopeKey: "*", granteeName: "Grantee Writer" };
/** What the READER would answer — never expected on a write path. */
const READER_ROW = { ...TX_ROW, cwid: "rdr0001", scopeKey: "ecr", granteeName: "Grantee Reader" };

/** `listReportAccess` decorates each table row with its resolved `name`; with
 *  no Scholar match (the default below) that is the stored `granteeName`. */
function named<T extends { granteeName: string | null; cwid: string }>(row: T) {
  return { ...row, name: row.granteeName ?? row.cwid };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockReadFindMany.mockResolvedValue([READER_ROW]);
  hoisted.mockReadFindUnique.mockResolvedValue(null);
  hoisted.mockReadScholarFindMany.mockResolvedValue([]);
  hoisted.mockWriteFindMany.mockResolvedValue([WRITER_ROW]);
  hoisted.mockWriteFindUnique.mockResolvedValue(null);
  hoisted.mockWriteScholarFindMany.mockResolvedValue([]);
  hoisted.mockTxFindMany.mockResolvedValue([TX_ROW]);
  hoisted.mockTxScholarFindMany.mockResolvedValue([]);
  hoisted.mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    grantedAt: new Date("2026-09-18T12:00:00Z"),
  }));
  hoisted.mockDelete.mockResolvedValue({});
  hoisted.mockAppendAuditRow.mockResolvedValue(undefined);
  hoisted.mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      reportAccess: {
        create: hoisted.mockCreate,
        delete: hoisted.mockDelete,
        findMany: hoisted.mockTxFindMany,
      },
      scholar: { findMany: hoisted.mockTxScholarFindMany },
      $executeRaw: vi.fn(),
    }),
  );
});

describe("getReportScopes — fail closed", () => {
  beforeEach(() => {
    hoisted.mockReadFindMany.mockResolvedValue([]);
  });

  it("returns the EMPTY set for a plain session with no rows", async () => {
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    expect(scopes.size).toBe(0);
    expect(hoisted.mockReadFindMany).toHaveBeenCalledWith({
      where: { reportKey: MENTORED_PUBS_REPORT, cwid: "abc1234" },
      select: { scopeKey: true },
    });
  });

  it("returns exactly the rows' scope keys for a holder", async () => {
    hoisted.mockReadFindMany.mockResolvedValue([{ scopeKey: "md" }, { scopeKey: "ecr" }]);
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    expect([...scopes].sort()).toEqual(["ecr", "md"]);
    expect(scopeAdmits(scopes, "md")).toBe(true);
    expect(scopeAdmits(scopes, "mdphd")).toBe(false);
  });

  it("a wildcard row admits every bucket", async () => {
    hoisted.mockReadFindMany.mockResolvedValue([{ scopeKey: "*" }]);
    const scopes = await getReportScopes(PLAIN, MENTORED_PUBS_REPORT);
    for (const s of MENTORED_PUBS_SCOPES) expect(scopeAdmits(scopes, s)).toBe(true);
  });

  it("superuser and comms_steward get '*' WITHOUT a table read", async () => {
    expect([...(await getReportScopes(SUPER, MENTORED_PUBS_REPORT))]).toEqual([ALL_SCOPES]);
    expect([...(await getReportScopes(STEWARD, MENTORED_PUBS_REPORT))]).toEqual([ALL_SCOPES]);
    expect(hoisted.mockReadFindMany).not.toHaveBeenCalled();
  });

  it("loadReportScopesForCwid: an empty cwid never touches the table", async () => {
    expect((await loadReportScopesForCwid("", MENTORED_PUBS_REPORT)).size).toBe(0);
    expect(hoisted.mockReadFindMany).not.toHaveBeenCalled();
  });
});

describe("listReportAccess — reader by default, any client on request", () => {
  it("defaults to db.read (the page's server render), name resolution included", async () => {
    expect(await listReportAccess(MENTORED_PUBS_REPORT)).toEqual([named(READER_ROW)]);
    expect(hoisted.mockReadFindMany).toHaveBeenCalledWith({
      where: { reportKey: MENTORED_PUBS_REPORT },
      orderBy: [{ cwid: "asc" }, { scopeKey: "asc" }],
    });
    // The Scholar lookup rides the SAME client as the row read.
    expect(hoisted.mockReadScholarFindMany).toHaveBeenCalledWith({
      where: { cwid: { in: ["rdr0001"] } },
      select: { cwid: true, preferredName: true },
    });
    expect(hoisted.mockWriteFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockWriteScholarFindMany).not.toHaveBeenCalled();
  });

  it("resolves name as preferredName > granteeName > cwid, one Scholar query for every cwid", async () => {
    hoisted.mockReadFindMany.mockResolvedValue([
      { ...TX_ROW, cwid: "sch0001", scopeKey: "md", granteeName: "Captured Name" },
      { ...TX_ROW, cwid: "sch0001", scopeKey: "ecr", granteeName: "Captured Name" },
      { ...TX_ROW, cwid: "stf0001", scopeKey: "*", granteeName: "Staff Person" },
      { ...TX_ROW, cwid: "old0001", scopeKey: "md", granteeName: null },
    ]);
    hoisted.mockReadScholarFindMany.mockResolvedValue([{ cwid: "sch0001", preferredName: "Scholar Curated" }]);
    const rows = await listReportAccess(MENTORED_PUBS_REPORT);
    expect(rows.map((r) => [r.cwid, r.scopeKey, r.name])).toEqual([
      ["sch0001", "md", "Scholar Curated"], // a Scholar row's curated name wins
      ["sch0001", "ecr", "Scholar Curated"],
      ["stf0001", "*", "Staff Person"], // no Scholar row → the name captured at grant time
      ["old0001", "md", "old0001"], // pre-column row → the bare CWID
    ]);
    // `granteeName` is carried through untouched beside the resolved name.
    expect(rows[0].granteeName).toBe("Captured Name");
    expect(rows[3].granteeName).toBeNull();
    // ONE lookup, de-duplicated cwids.
    expect(hoisted.mockReadScholarFindMany).toHaveBeenCalledTimes(1);
    expect(hoisted.mockReadScholarFindMany).toHaveBeenCalledWith({
      where: { cwid: { in: ["sch0001", "stf0001", "old0001"] } },
      select: { cwid: true, preferredName: true },
    });
  });

  it("skips the Scholar query entirely when the report has no rows", async () => {
    hoisted.mockReadFindMany.mockResolvedValue([]);
    expect(await listReportAccess(MENTORED_PUBS_REPORT)).toEqual([]);
    expect(hoisted.mockReadScholarFindMany).not.toHaveBeenCalled();
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

  it("MENTORED_PUBS_SCOPE_OPTIONS: the wildcard first, then every grantable bucket under its degree name (md reads MD)", () => {
    expect(MENTORED_PUBS_SCOPE_OPTIONS).toEqual([
      [ALL_SCOPES, "All programs"],
      ["md", "MD"],
      ["mdphd", "MD-PhD"],
      ["ecr", "ECR"],
    ]);
    // Every option's key is grantable — the add form can never offer a key
    // the route would reject.
    expect(MENTORED_PUBS_SCOPE_OPTIONS.every(([key]) => isMentoredPubsScopeKey(key))).toBe(true);
    expect(MENTORED_PUBS_SCOPE_OPTIONS).toHaveLength(MENTORED_PUBS_SCOPES.length + 1);
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
  const TRIPLE = { reportKey_scopeKey_cwid: { reportKey: MENTORED_PUBS_REPORT, scopeKey: "md", cwid: "abc1234" } };

  /** Every write path: the READER is never consulted — an existence probe or
   *  post-write list on the replica is the race the module comment describes. */
  function expectReaderUntouched(): void {
    expect(hoisted.mockReadFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockReadFindUnique).not.toHaveBeenCalled();
  }

  it("grant creates the row and a report_access_grant audit row keyed on the triple", async () => {
    const out = await grantReportAccess(args);
    expect(out.changed).toBe(true);
    expect(hoisted.mockCreate).toHaveBeenCalledWith({
      data: {
        reportKey: MENTORED_PUBS_REPORT,
        scopeKey: "md",
        cwid: "abc1234",
        grantedBy: "adm0001",
        granteeName: null,
      },
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
    expect(row.afterValues).toMatchObject({
      scope_key: "md",
      cwid: "abc1234",
      granted_by: "adm0001",
      grantee_name: null,
    });
  });

  it("grant stores the grantee's directory name on the row and in the audit afterValues", async () => {
    await grantReportAccess({ ...args, granteeName: "Staff Person" });
    expect(hoisted.mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ cwid: "abc1234", granteeName: "Staff Person" }),
    });
    const row = hoisted.mockAppendAuditRow.mock.calls[0][1];
    expect(row.afterValues).toMatchObject({ cwid: "abc1234", grantee_name: "Staff Person" });
  });

  it("grant probes existence on the WRITER and returns the list re-read INSIDE its transaction", async () => {
    const out = await grantReportAccess(args);
    expect(hoisted.mockWriteFindUnique).toHaveBeenCalledWith({ where: TRIPLE, select: { cwid: true } });
    // The list is the in-tx re-read, not a standalone writer read and never the reader.
    expect(out.rows).toEqual([named(TX_ROW)]);
    expect(hoisted.mockTxFindMany).toHaveBeenCalledWith({
      where: { reportKey: MENTORED_PUBS_REPORT },
      orderBy: [{ cwid: "asc" }, { scopeKey: "asc" }],
    });
    // …and its name lookup rides the same transaction client.
    expect(hoisted.mockTxScholarFindMany).toHaveBeenCalledTimes(1);
    expect(hoisted.mockWriteFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockWriteScholarFindMany).not.toHaveBeenCalled();
    expectReaderUntouched();
  });

  it("grant is idempotent: an existing row is neither re-created nor re-audited; the list still comes off the writer", async () => {
    hoisted.mockWriteFindUnique.mockResolvedValue({ cwid: "abc1234" });
    const out = await grantReportAccess(args);
    expect(out).toEqual({ changed: false, rows: [named(WRITER_ROW)] });
    expect(hoisted.mockTransaction).not.toHaveBeenCalled();
    expect(hoisted.mockAppendAuditRow).not.toHaveBeenCalled();
    expectReaderUntouched();
  });

  it("grant that loses a concurrent-grant race (P2002 from the create) is the idempotent no-op, not a throw", async () => {
    hoisted.mockTransaction.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const out = await grantReportAccess(args);
    expect(out).toEqual({ changed: false, rows: [named(WRITER_ROW)] });
    expectReaderUntouched();
  });

  it("grant rethrows any other transaction failure", async () => {
    hoisted.mockTransaction.mockRejectedValue(Object.assign(new Error("deadlock"), { code: "P2034" }));
    await expect(grantReportAccess(args)).rejects.toThrow("deadlock");
  });

  it("revoke deletes the row and writes report_access_revoke with the deleted row as before", async () => {
    hoisted.mockWriteFindUnique.mockResolvedValue({
      reportKey: MENTORED_PUBS_REPORT,
      scopeKey: "md",
      cwid: "abc1234",
      grantedBy: "stw0001",
      grantedAt: new Date("2026-09-01T00:00:00Z"),
      granteeName: "Staff Person",
    });
    const out = await revokeReportAccess({ ...args, impersonatedCwid: "tgt0001" });
    expect(out.changed).toBe(true);
    expect(hoisted.mockDelete).toHaveBeenCalledWith({ where: TRIPLE });
    const row = hoisted.mockAppendAuditRow.mock.calls[0][1];
    expect(row).toMatchObject({
      action: "report_access_revoke",
      impersonatedCwid: "tgt0001",
      afterValues: null,
    });
    expect(row.beforeValues).toMatchObject({
      granted_by: "stw0001",
      granted_at: "2026-09-01T00:00:00.000Z",
      grantee_name: "Staff Person",
    });
  });

  it("revoke probes existence on the WRITER and returns the list re-read INSIDE its transaction", async () => {
    hoisted.mockWriteFindUnique.mockResolvedValue({ ...TX_ROW });
    const out = await revokeReportAccess(args);
    expect(hoisted.mockWriteFindUnique).toHaveBeenCalledWith({ where: TRIPLE });
    expect(out.rows).toEqual([named(TX_ROW)]);
    expect(hoisted.mockTxFindMany).toHaveBeenCalledTimes(1);
    expect(hoisted.mockWriteFindMany).not.toHaveBeenCalled();
    expectReaderUntouched();
  });

  it("revoke of a missing row is a no-op with no audit row; the list still comes off the writer", async () => {
    const out = await revokeReportAccess(args);
    expect(out).toEqual({ changed: false, rows: [named(WRITER_ROW)] });
    expect(hoisted.mockTransaction).not.toHaveBeenCalled();
    expect(hoisted.mockAppendAuditRow).not.toHaveBeenCalled();
    expectReaderUntouched();
  });
});
