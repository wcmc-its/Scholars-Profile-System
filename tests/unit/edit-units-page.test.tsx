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

const EMPTY_UNITS = {
  departments: [],
  divisions: [],
  centers: [],
  cores: [],
  institutions: [],
  total: 0,
};
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

/** Depth-first search of an UNRENDERED element tree (props.children only). */
function findAll(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  findAll(el.props.children, pred, out);
  return out;
}
const textOf = (el: El): string => {
  const c = el.props.children;
  return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === "string" ? x : "")).join("");
};

describe("/edit/units — page header", () => {
  it("superuser: directory copy mentions retired units, and the header carries Create a unit", async () => {
    mockGetEditSession.mockResolvedValue({
      cwid: "su01",
      isSuperuser: true,
      isCommsSteward: false,
    });
    const result = asEl(await EditUnitsPage());
    const create = findAll(result, (el) => el.props["data-testid"] === "all-units-create");
    expect(create).toHaveLength(1);
    expect(create[0].props.href).toBe("/edit/unit/new");
    const p = findAll(result, (el) => el.type === "p")[0];
    expect(textOf(p)).toContain("including retired ones");
  });

  it("comms steward: directory copy without retired units, and no Create a unit", async () => {
    mockGetEditSession.mockResolvedValue({
      cwid: "cs01",
      isSuperuser: false,
      isCommsSteward: true,
    });
    const result = asEl(await EditUnitsPage());
    expect(findAll(result, (el) => el.props["data-testid"] === "all-units-create")).toHaveLength(0);
    const p = findAll(result, (el) => el.type === "p")[0];
    expect(textOf(p)).toContain("Every department, division, center and core.");
  });

  it("unit owner: keeps the 'you can edit' copy and gets no directory", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const result = asEl(await EditUnitsPage());
    const p = findAll(result, (el) => el.type === "p")[0];
    expect(textOf(p)).toContain("you can edit");
    expect(findAll(result, (el) => el.type === "section")).toHaveLength(0);
  });
});

describe("/edit/units — ?kind= filter (unit editor kind crumb)", () => {
  const unit = (kind: string, code: string) => ({
    kind,
    code,
    name: `Unit ${code}`,
    role: "owner",
    href: `/edit/${kind}/${code}`,
  });
  const GRANTS = {
    departments: [unit("department", "D1")],
    divisions: [],
    centers: [unit("center", "C1")],
    cores: [],
    institutions: [],
    total: 2,
  };
  const DIRECTORY = [
    { kind: "department", code: "D1" },
    { kind: "center", code: "C1" },
    { kind: "center", code: "C2" },
    { kind: "core", code: "7" },
  ];
  const props = (kind?: string | string[]) => ({
    searchParams: Promise.resolve(kind === undefined ? {} : { kind }),
  });
  const indexUnits = (result: El) =>
    findAll(result, (el) => "units" in el.props && "isSuperuser" in el.props)[0]?.props.units as
      | typeof GRANTS
      | undefined;
  const directoryUnits = (result: El) =>
    findAll(result, (el) => Array.isArray(el.props.units) && !("isSuperuser" in el.props))[0]
      ?.props.units as Array<{ kind: string }> | undefined;
  const byTestId = (result: El, id: string) =>
    findAll(result, (el) => el.props["data-testid"] === id);

  it("kind=center narrows the manageable index to centers, with a 'Show all' clear link", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadManageableUnits.mockResolvedValue(GRANTS);
    const result = asEl(await EditUnitsPage(props("center")));
    const units = indexUnits(result)!;
    expect(units.centers).toHaveLength(1);
    expect(units.departments).toHaveLength(0);
    expect(units.total).toBe(1);
    const clear = byTestId(result, "units-kind-filter-clear");
    expect(clear).toHaveLength(1);
    expect(clear[0].props.href).toBe("/edit/units");
    const line = byTestId(result, "units-kind-filter")[0];
    const showing = findAll(line, (el) => el.type === "span")[0];
    expect((showing.props.children as unknown[]).join("")).toBe("Showing centers");
  });

  it("kind=center narrows the superuser all-units directory too", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "su01", isSuperuser: true, isCommsSteward: false });
    mockLoadAllUnitsDirectory.mockResolvedValue(DIRECTORY);
    const result = asEl(await EditUnitsPage(props("center")));
    expect(directoryUnits(result)!.map((u) => u.kind)).toEqual(["center", "center"]);
  });

  it.each([["bogus"], [["center", "core"]], [undefined]])(
    "ignores an unknown / repeated / absent kind (%j) — full lists, no filter line",
    async (kind) => {
      mockGetEditSession.mockResolvedValue({ cwid: "su01", isSuperuser: true, isCommsSteward: false });
      mockLoadManageableUnits.mockResolvedValue(GRANTS);
      mockLoadAllUnitsDirectory.mockResolvedValue(DIRECTORY);
      const result = asEl(await EditUnitsPage(props(kind)));
      expect(indexUnits(result)!.total).toBe(2);
      expect(directoryUnits(result)).toHaveLength(4);
      expect(byTestId(result, "units-kind-filter")).toHaveLength(0);
    },
  );

  it("an owner with no grants of that kind sees a 'none of that kind' line, not the no-units empty state", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadManageableUnits.mockResolvedValue(GRANTS);
    const result = asEl(await EditUnitsPage(props("core")));
    expect(byTestId(result, "units-kind-filter-empty")).toHaveLength(1);
    expect(indexUnits(result)).toBeUndefined();
  });
});
