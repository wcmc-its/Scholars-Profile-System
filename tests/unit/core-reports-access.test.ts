/**
 * The core-reports widening (2026-09-06) in `lib/edit/cancer-center-reports.ts`
 * — cores as a fourth reportable unit kind.
 *
 * Scoped to what the widening ADDED: the `kind === "core"` authz branch of
 * `loadReportsContext`, cores in BOTH branches of
 * `loadReportableUnitsForActor`, core liveness in `loadReportLiveness`, and the
 * `REPORT_NUMBERS_BY_KIND` catalog. The pre-existing center/department/division
 * behavior keeps its own suites (`cancer-center-reports.test.ts`,
 * `cancer-center-reports-index.test.ts`); the per-report publication-set
 * resolution has its own (`cancer-center-publications-report.test.ts`,
 * `nih-funded-publications-report.test.ts`).
 *
 * Same mocking shape as `cancer-center-reports-index.test.ts`: the
 * `manageable-units` loaders and `next/navigation` are stubbed, the Prisma
 * surface is a fake object, no live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadAllUnitsDirectory,
  mockLoadManageableUnits,
  mockLoadUnitEditContext,
  mockLogAuthzDenied,
  mockRedirect,
} = vi.hoisted(() => ({
  mockLoadAllUnitsDirectory: vi.fn(),
  mockLoadManageableUnits: vi.fn(),
  mockLoadUnitEditContext: vi.fn(),
  mockLogAuthzDenied: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));
vi.mock("@/lib/edit/manageable-units", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/manageable-units")>();
  return {
    ...actual,
    loadAllUnitsDirectory: mockLoadAllUnitsDirectory,
    loadManageableUnits: mockLoadManageableUnits,
  };
});
// `loadReportsContext`'s NON-core branch — stubbed so a test can assert that a
// core NEVER reaches it (routing a core through `loadUnitEditContext` would read
// the CENTER table keyed by a core id).
vi.mock("@/lib/api/unit-edit-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/unit-edit-context")>();
  return { ...actual, loadUnitEditContext: mockLoadUnitEditContext };
});
// The denial-telemetry sink `logEditDenial` writes to — asserted rather than
// silenced, since a denied actor must leave exactly one `edit_authz_denied`.
vi.mock("@/lib/auth/authz-events", () => ({ logAuthzDenied: mockLogAuthzDenied }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, redirect: mockRedirect };
});

import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  loadReportsContext,
  REPORT_NUMBERS_BY_KIND,
} from "@/lib/edit/cancer-center-reports";

const ALL_KINDS = ["center", "department", "division", "core"] as const;

beforeEach(() => {
  mockLoadAllUnitsDirectory.mockReset();
  mockLoadManageableUnits.mockReset();
  mockLoadUnitEditContext.mockReset();
  mockLogAuthzDenied.mockReset();
  mockRedirect.mockClear();
});

/** A Prisma stand-in for the core authz branch: one `unit_admin` row lookup
 *  plus the core's own name. `grants` maps `<coreId>:<cwid>` → role. */
function fakeCoreDb(opts: {
  grants?: Record<string, "owner" | "curator">;
  cores?: Record<string, string>;
} = {}) {
  const grants = opts.grants ?? {};
  const cores = opts.cores ?? { "14": "Biomedical Imaging" };
  return {
    unitAdmin: {
      findUnique: vi.fn(
        async (args: {
          where: { entityType_entityId_cwid: { entityType: string; entityId: string; cwid: string } };
        }) => {
          const { entityType, entityId, cwid } = args.where.entityType_entityId_cwid;
          if (entityType !== "core") return null;
          const role = grants[`${entityId}:${cwid}`];
          return role ? { role } : null;
        },
      ),
    },
    core: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        cores[args.where.id] === undefined ? null : { name: cores[args.where.id] },
      ),
    },
  };
}

const OUTSIDER = { cwid: "nobody1", isSuperuser: false, isCommsSteward: false };

describe("loadReportsContext — core owner / curator gate", () => {
  it("a core OWNER passes and gets the core's display name", async () => {
    const db = fakeCoreDb({ grants: { "14:owner01": "owner" } });
    const ctx = await loadReportsContext(
      "14",
      { cwid: "owner01", isSuperuser: false, isCommsSteward: false },
      db as never,
      "core",
    );
    expect(ctx).toEqual({ unit: { name: "Biomedical Imaging" } });
    expect(mockLogAuthzDenied).not.toHaveBeenCalled();
    // The core branch must NOT go through loadUnitEditContext, whose `else`
    // arm reads the CENTER table for anything that isn't dept/division.
    expect(mockLoadUnitEditContext).not.toHaveBeenCalled();
  });

  it("a core CURATOR passes too — the same pair /edit/core/[coreId]/review admits", async () => {
    const db = fakeCoreDb({ grants: { "14:cur01": "curator" } });
    const ctx = await loadReportsContext(
      "14",
      { cwid: "cur01", isSuperuser: false, isCommsSteward: false },
      db as never,
      "core",
    );
    expect(ctx).toEqual({ unit: { name: "Biomedical Imaging" } });
  });

  it("an actor with NO grant on that core is denied, and the denial is logged as a core denial", async () => {
    const db = fakeCoreDb({ grants: { "14:owner01": "owner" } });
    const ctx = await loadReportsContext("14", OUTSIDER, db as never, "core");
    expect(ctx).toBeNull();
    expect(mockLogAuthzDenied).toHaveBeenCalledTimes(1);
    expect(mockLogAuthzDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_cwid: "nobody1",
        reason: "not_core_owner",
        target_entity_type: "core",
        target_entity_id: "14",
      }),
    );
    // Denied before the name read — no metadata leaks to a non-actor.
    expect(db.core.findUnique).not.toHaveBeenCalled();
  });

  it("a grant on a DIFFERENT core confers nothing — access never widens across cores", async () => {
    const db = fakeCoreDb({
      grants: { "9:owner09": "owner" },
      cores: { "9": "Genomics", "14": "Biomedical Imaging" },
    });
    const ctx = await loadReportsContext(
      "14",
      { cwid: "owner09", isSuperuser: false, isCommsSteward: false },
      db as never,
      "core",
    );
    expect(ctx).toBeNull();
  });

  it("a superuser and a comms_steward pass on any core (2026-08-26 policy widening decision #6)", async () => {
    const db = fakeCoreDb();
    await expect(
      loadReportsContext("14", { cwid: "su", isSuperuser: true, isCommsSteward: false }, db as never, "core"),
    ).resolves.toEqual({ unit: { name: "Biomedical Imaging" } });
    await expect(
      loadReportsContext("14", { cwid: "cs", isSuperuser: false, isCommsSteward: true }, db as never, "core"),
    ).resolves.toEqual({ unit: { name: "Biomedical Imaging" } });
  });

  it("an unknown core id resolves to null even for a superuser — never a fabricated context", async () => {
    const db = fakeCoreDb();
    const ctx = await loadReportsContext(
      "999",
      { cwid: "su", isSuperuser: true, isCommsSteward: false },
      db as never,
      "core",
    );
    expect(ctx).toBeNull();
  });

  it("a non-core kind still routes through loadUnitEditContext, unchanged", async () => {
    mockLoadUnitEditContext.mockResolvedValue({ unit: { name: "Meyer Cancer Center" } });
    const db = fakeCoreDb();
    const ctx = await loadReportsContext(
      "meyer",
      { cwid: "cur01", isSuperuser: false, isCommsSteward: false },
      db as never,
      "center",
    );
    expect(ctx).toEqual({ unit: { name: "Meyer Cancer Center" } });
    expect(mockLoadUnitEditContext).toHaveBeenCalledWith("center", "meyer", expect.anything(), db);
    // The core-only unit_admin lookup never fired.
    expect(db.unitAdmin.findUnique).not.toHaveBeenCalled();
  });
});

/** The directory/suppression Prisma surface `loadReportableUnitsForActor` reads. */
function fakeDirectoryDb(
  opts: { programCodes?: string[]; retiredCodes?: string[]; centerTypeRows?: Array<{ code: string; centerType: string }> } = {},
) {
  return {
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    center: { findMany: vi.fn().mockResolvedValue(opts.centerTypeRows ?? []) },
    centerProgram: {
      findMany: vi.fn().mockResolvedValue((opts.programCodes ?? []).map((centerCode) => ({ centerCode }))),
    },
    suppression: {
      findMany: vi.fn().mockResolvedValue((opts.retiredCodes ?? []).map((entityId) => ({ entityId }))),
    },
  };
}

describe("loadReportableUnitsForActor — cores in both branches", () => {
  it("a superuser sees cores in the reportable index (global branch)", async () => {
    mockLoadAllUnitsDirectory.mockResolvedValue([
      { kind: "center", code: "meyer", name: "Meyer Cancer Center", centerType: "center" },
      { kind: "core", code: "14", name: "Biomedical Imaging", centerType: null },
      { kind: "core", code: "9", name: "Genomics", centerType: null },
    ]);
    const db = fakeDirectoryDb({ programCodes: ["meyer"] });
    const units = await loadReportableUnitsForActor(
      { cwid: "su", isSuperuser: true, isCommsSteward: false },
      db as never,
      ALL_KINDS,
    );
    expect(units).toEqual([
      { code: "meyer", kind: "center", name: "Meyer Cancer Center", centerType: "center" },
      { code: "14", kind: "core", name: "Biomedical Imaging", centerType: null },
      { code: "9", kind: "core", name: "Genomics", centerType: null },
    ]);
  });

  it("a comms_steward takes the same global branch and also sees cores", async () => {
    mockLoadAllUnitsDirectory.mockResolvedValue([
      { kind: "core", code: "14", name: "Biomedical Imaging", centerType: null },
    ]);
    const db = fakeDirectoryDb();
    const units = await loadReportableUnitsForActor(
      { cwid: "cs", isSuperuser: false, isCommsSteward: true },
      db as never,
      ALL_KINDS,
    );
    expect(units).toEqual([{ code: "14", kind: "core", name: "Biomedical Imaging", centerType: null }]);
  });

  it("a core owner/curator sees their own core (actor-scoped branch, from loadManageableUnits.cores)", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [],
      cores: [{ kind: "core", code: "14", name: "Biomedical Imaging", role: "owner", href: "/edit/core/14" }],
      total: 1,
    });
    const db = fakeDirectoryDb();
    const units = await loadReportableUnitsForActor(
      { cwid: "owner01", isSuperuser: false, isCommsSteward: false },
      db as never,
      ALL_KINDS,
    );
    expect(units).toEqual([{ code: "14", kind: "core", name: "Biomedical Imaging", centerType: null }]);
    expect(mockLoadAllUnitsDirectory).not.toHaveBeenCalled();
    // `Suppression` never carries entityType="core", so a core-only candidate
    // set issues no retirement query at all.
    expect(db.suppression.findMany).not.toHaveBeenCalled();
    // No center candidates → no CenterProgram taxonomy query either.
    expect(db.centerProgram.findMany).not.toHaveBeenCalled();
  });

  it("cores are still EXCLUDED when the caller doesn't ask for them — reports 1/2/4/5 are unaffected", async () => {
    mockLoadAllUnitsDirectory.mockResolvedValue([
      { kind: "center", code: "meyer", name: "Meyer Cancer Center", centerType: "center" },
      { kind: "core", code: "14", name: "Biomedical Imaging", centerType: null },
    ]);
    const db = fakeDirectoryDb({ programCodes: ["meyer"] });
    // Default allowedKinds (["center"]) — what reports 1/2/4/5 call with.
    const defaults = await loadReportableUnitsForActor(
      { cwid: "su", isSuperuser: true, isCommsSteward: false },
      db as never,
    );
    expect(defaults.map((u) => u.kind)).toEqual(["center"]);
    // The pre-widening explicit set, likewise.
    const preWidening = await loadReportableUnitsForActor(
      { cwid: "su", isSuperuser: true, isCommsSteward: false },
      db as never,
      ["center", "department", "division"],
    );
    expect(preWidening.map((u) => u.kind)).toEqual(["center"]);
  });

  it("a retired CENTER is still excluded when cores ride along — the suppression query keeps its non-core kinds", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [
        { kind: "center", code: "retired_ctr", name: "Retired Center", role: "curator", href: "/x" },
        { kind: "center", code: "meyer", name: "Meyer Cancer Center", role: "curator", href: "/y" },
      ],
      cores: [{ kind: "core", code: "14", name: "Biomedical Imaging", role: "owner", href: "/edit/core/14" }],
      total: 3,
    });
    const db = fakeDirectoryDb({
      programCodes: ["meyer", "retired_ctr"],
      centerTypeRows: [
        { code: "meyer", centerType: "center" },
        { code: "retired_ctr", centerType: "center" },
      ],
      retiredCodes: ["retired_ctr"],
    });
    const units = await loadReportableUnitsForActor(
      { cwid: "cur01", isSuperuser: false, isCommsSteward: false },
      db as never,
      ALL_KINDS,
    );
    expect(units.map((u) => u.code)).toEqual(["meyer", "14"]);
    // "core" is never sent as a suppression entityType — no such row exists.
    const where = db.suppression.findMany.mock.calls[0][0].where;
    expect(where.entityType.in).toEqual(["center", "department", "division"]);
    expect(where.entityId.in).toEqual(["retired_ctr", "meyer"]);
  });

  it("an actor with no grants at all gets [] — the clean 'no reportable units' path, not a crash", async () => {
    // The expected state for almost every core today: 13 of the 14 catalog
    // cores carry zero unit_admin rows (staging probe, 2026-09-06).
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [],
      cores: [],
      total: 0,
    });
    const units = await loadReportableUnitsForActor(OUTSIDER, fakeDirectoryDb() as never, ALL_KINDS);
    expect(units).toEqual([]);
  });
});

/** Liveness Prisma surface. Cores read `publicationCore` + `coreClaim` through
 *  `loadConfirmedCorePmidsByCore`; the other kinds keep their member proxies. */
function fakeLivenessDb(
  opts: {
    publicationCore?: Array<{ coreId: string; pmid: string; status: string }>;
    coreClaim?: Array<{ coreId: string; pmid: string; status: string }>;
  } = {},
) {
  return {
    centerCollabCandidate: { groupBy: vi.fn().mockResolvedValue([]) },
    cancerCenterFundingAward: { groupBy: vi.fn().mockResolvedValue([]) },
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
    publicationCore: { findMany: vi.fn().mockResolvedValue(opts.publicationCore ?? []) },
    coreClaim: { findMany: vi.fn().mockResolvedValue(opts.coreClaim ?? []) },
  };
}

describe("loadReportLiveness — cores", () => {
  it("a core with confirmed usages reads LIVE on both of its reports", async () => {
    const db = fakeLivenessDb({
      publicationCore: [
        { coreId: "14", pmid: "111", status: "confirmed" },
        { coreId: "14", pmid: "222", status: "candidate" },
      ],
    });
    const result = await loadReportLiveness([{ code: "14", kind: "core" }], db as never);
    const core = result.get("14");
    expect(core?.totalCount).toBe(2);
    expect(core?.liveCount).toBe(2);
    expect(core?.perReport.map((r) => r.n)).toEqual([3, 6]);
    expect(core?.perReport.every((r) => r.live)).toBe(true);
  });

  it("a core whose only engine-confirmed pair carries an active REJECTED claim is NOT live", async () => {
    // The CoreClaim merge is load-bearing here, not decorative: an operator's
    // rejection removes the pair, and with nothing else confirmed the core has
    // no publication set at all.
    const db = fakeLivenessDb({
      publicationCore: [{ coreId: "14", pmid: "111", status: "confirmed" }],
      coreClaim: [{ coreId: "14", pmid: "111", status: "rejected" }],
    });
    const result = await loadReportLiveness([{ code: "14", kind: "core" }], db as never);
    expect(result.get("14")?.liveCount).toBe(0);
  });

  it("a manual PMID add (a claimed pair the engine never scored) makes a core live", async () => {
    const db = fakeLivenessDb({
      publicationCore: [],
      coreClaim: [{ coreId: "14", pmid: "333", status: "claimed" }],
    });
    const result = await loadReportLiveness([{ code: "14", kind: "core" }], db as never);
    expect(result.get("14")?.liveCount).toBe(2);
  });

  it("a core with zero confirmed usages is not live, and the count is 0 of 2 — never a crash or a padded six", async () => {
    const db = fakeLivenessDb();
    const result = await loadReportLiveness([{ code: "7", kind: "core" }], db as never);
    expect(result.get("7")).toEqual({
      perReport: [
        { n: 3, live: false, lastRefreshedAt: null },
        { n: 6, live: false, lastRefreshedAt: null },
      ],
      liveCount: 0,
      totalCount: 2,
      lastRefreshedAt: null,
    });
  });

  it("issues no core queries at all when the unit list has no cores", async () => {
    const db = fakeLivenessDb();
    await loadReportLiveness([{ code: "surg", kind: "department" }], db as never);
    expect(db.publicationCore.findMany).not.toHaveBeenCalled();
    expect(db.coreClaim.findMany).not.toHaveBeenCalled();
  });
});

describe("REPORT_NUMBERS_BY_KIND", () => {
  it("a core gets reports 3 and 6 only — 1/2/4/5 stay center-only", () => {
    expect(REPORT_NUMBERS_BY_KIND.core).toEqual([3, 6]);
    // Follows the department/division precedent exactly.
    expect(REPORT_NUMBERS_BY_KIND.core).toEqual(REPORT_NUMBERS_BY_KIND.department);
    for (const n of [1, 2, 4, 5] as const) {
      expect(REPORT_NUMBERS_BY_KIND.core).not.toContain(n);
      expect(REPORT_NUMBERS_BY_KIND.center).toContain(n);
    }
  });
});
