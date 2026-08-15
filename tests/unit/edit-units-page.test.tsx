/**
 * `app/edit/units/page.tsx` — regression coverage for the `loadConsoleTabs`
 * migration (docs/edit-console-ia-spec.md Part B §2). Gap 4 (`usageTab`/
 * `reportsTab` never passed to `ConsoleShell`) used to be fixed by this page
 * hand-computing both from grant reads it already ran; the migration deletes
 * that per-page computation entirely — `ConsoleShell` now derives every
 * grant-based tab itself from `session` via `loadConsoleTabs`. This file now
 * guards the OTHER direction of that same bug class: that the page doesn't
 * reintroduce a per-page override for anything `loadConsoleTabs` already
 * covers, and that it still passes the correct `session` through (a wrong
 * session here would silently break every tab `loadConsoleTabs` derives).
 * Shallow element inspection only (no render) — same pattern as
 * `administrators-page.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockLoadManageableUnits, mockLoadAllUnitsDirectory, mockRedirect } =
  vi.hoisted(() => ({
    mockGetEditSession: vi.fn(),
    mockLoadManageableUnits: vi.fn(),
    mockLoadAllUnitsDirectory: vi.fn().mockResolvedValue([]),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`__REDIRECT__:${url}`);
    }),
  }));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
}));
vi.mock("@/lib/edit/manageable-units", () => ({
  loadManageableUnits: mockLoadManageableUnits,
  loadAllUnitsDirectory: mockLoadAllUnitsDirectory,
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import EditUnitsPage from "@/app/edit/units/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;

const EMPTY_UNITS = { departments: [], divisions: [], centers: [], cores: [], total: 0 };
const OWNER = { cwid: "own01", isSuperuser: false, isCommsSteward: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadManageableUnits.mockResolvedValue(EMPTY_UNITS);
  mockLoadAllUnitsDirectory.mockResolvedValue([]);
});

describe("/edit/units — ConsoleShell wiring", () => {
  it("signed-out → SAML redirect", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditUnitsPage()).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/units",
    );
  });

  it("passes the EFFECTIVE session through to ConsoleShell — loadConsoleTabs derives every grant-based tab from it", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const result = asEl(await EditUnitsPage());
    expect(result.props.session).toBe(OWNER);
    // The bare escape hatch stays — this page has no unit-admin gate of its
    // own, unlike every other console page (docs/edit-console-ia-spec.md
    // Part B §2 / console-shell.tsx's own doc comment).
    expect(result.props.unitsTab).toBe(true);
  });

  it("no longer hand-computes dataQualityTab/usageTab/reportsTab — ConsoleShell derives them from session now", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const result = asEl(await EditUnitsPage());
    expect(result.props.dataQualityTab).toBeUndefined();
    expect(result.props.usageTab).toBeUndefined();
    expect(result.props.reportsTab).toBeUndefined();
  });
});
