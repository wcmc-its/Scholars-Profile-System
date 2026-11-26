/**
 * Who gets the "Method services" section on `/edit/department/[code]` and
 * `/edit/core/[coreId]`: a superuser, and nobody else. The site owner manages
 * every method service himself, so a unit's own Owner or Curator, a comms
 * steward and the Cores director are handed no list (`methodServices` null,
 * which renders no section) and the service list is never even read.
 *
 * The pages are called as functions and return a `{ type, props }` tree (the
 * `edit-core-page-role-labels.test.tsx` approach): child components are
 * mocked and only the props they are handed are read. Made-up units and
 * people only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: vi.fn(),
  loadServices: vi.fn(),
  loadUnitEditContext: vi.fn(),
  unitAdminFindUnique: vi.fn(),
  unitPage: vi.fn(() => null),
  coreSections: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: m.session }));
vi.mock("@/lib/auth/authz-events", () => ({ logAuthzDenied: vi.fn() }));
vi.mock("@/lib/api/method-services", () => ({ loadMethodServicesForUnit: m.loadServices }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: m.loadUnitEditContext }));
vi.mock("@/lib/api/unit-leadership-roles", () => ({ loadUnitLeadershipRoles: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/api/core-queue", () => ({ loadCoreReviewQueue: vi.fn().mockResolvedValue({ candidates: [] }) }));
vi.mock("@/lib/api/core-staff", () => ({ loadCoreStaff: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/edit/console-tabs.server", () => ({
  loadConsoleTabs: vi.fn().mockResolvedValue({ units: true, cores: true }),
}));
vi.mock("@/lib/edit/directory-names", () => ({
  resolveDirectoryNames: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      department: { findUnique: vi.fn().mockResolvedValue({ code: "DEPTA" }) },
      core: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ name: "Example Imaging Core", description: null, url: null, visible: true }),
      },
      coreLeader: { findMany: vi.fn().mockResolvedValue([]) },
      orgUnitRole: { findMany: vi.fn().mockResolvedValue([]) },
      unitAdmin: { findUnique: m.unitAdminFindUnique, findMany: vi.fn().mockResolvedValue([]) },
      scholar: { findMany: vi.fn().mockResolvedValue([]) },
    },
    write: {},
  },
}));
vi.mock("@/components/edit/unit-edit-page", () => ({ UnitEditPage: m.unitPage }));
vi.mock("@/components/edit/core-edit-sections", () => ({ CoreEditSections: m.coreSections }));
vi.mock("@/components/edit/console-top-bar", () => ({ ConsoleTopBar: vi.fn(() => null) }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: vi.fn(() => null) }));

import EditCorePage from "@/app/edit/core/[coreId]/page";
import EditDepartmentPage from "@/app/edit/department/[code]/page";

type El = { type: unknown; props: Record<string, unknown> };
function findByType(node: unknown, type: unknown): El | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const el = node as El;
  if (el.type === type) return el;
  return findByType(el.props?.children, type);
}

const SERVICES = [{ id: 1, name: "Example service" }];
const NOBODY = { cwid: "act0001", isSuperuser: false, isCommsSteward: false };

const departmentProps = async () => {
  const tree = await EditDepartmentPage({
    params: Promise.resolve({ code: "DEPTA" }),
    searchParams: Promise.resolve({}),
  });
  return findByType(tree, m.unitPage)!.props;
};
const coreProps = async () => {
  const tree = await EditCorePage({
    params: Promise.resolve({ coreId: "77" }),
    searchParams: Promise.resolve({}),
  });
  return findByType(tree, m.coreSections)!.props;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("METHOD_SERVICES", "on");
  vi.stubEnv("METHODS_LENS_PAGES", "on");
  vi.stubEnv("METHODS_LENS_ENABLED", "on");
  m.loadServices.mockResolvedValue(SERVICES);
  // The department page renders for anyone the context loader admits.
  m.loadUnitEditContext.mockResolvedValue({ unit: { code: "DEPTA", name: "Example Library" } });
  m.unitAdminFindUnique.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("/edit/department/[code]: the Method services section", () => {
  it("a superuser is handed the department's services", async () => {
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await departmentProps()).methodServices).toBe(SERVICES);
    expect(m.loadServices).toHaveBeenCalledWith("department", "DEPTA");
  });

  it.each([
    ["the department's own owner", {}],
    ["a comms steward", { isCommsSteward: true }],
    ["a content editor", { isCommsSteward: true, isContentEditor: true }],
    ["an observer", { isCommsSteward: true, isObserver: true }],
    ["the Cores director", { isCoreDirector: true }],
  ])("%s gets the page with no section, and the services are not read", async (_who, flags) => {
    m.session.mockResolvedValue({ ...NOBODY, ...flags });
    const props = await departmentProps();
    expect(props.methodServices).toBeNull();
    expect(m.loadServices).not.toHaveBeenCalled();
  });

  it("nobody gets it while the flag is off, a superuser included", async () => {
    vi.stubEnv("METHOD_SERVICES", "off");
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await departmentProps()).methodServices).toBeNull();
    expect(m.loadServices).not.toHaveBeenCalled();
  });
});

describe("/edit/core/[coreId]: the Method services section", () => {
  it("a superuser is handed the core's services", async () => {
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await coreProps()).methodServices).toBe(SERVICES);
    expect(m.loadServices).toHaveBeenCalledWith("core", "77");
  });

  it("the core's own owner gets the page with no section, and the services are not read", async () => {
    m.session.mockResolvedValue(NOBODY);
    m.unitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const props = await coreProps();
    expect(props.methodServices).toBeNull();
    expect(m.loadServices).not.toHaveBeenCalled();
  });

  it.each([
    ["the Cores director", { isCoreDirector: true }],
    ["a comms steward", { isCommsSteward: true }],
  ])("%s gets the page with no section", async (_who, flags) => {
    m.session.mockResolvedValue({ ...NOBODY, ...flags });
    expect((await coreProps()).methodServices).toBeNull();
    expect(m.loadServices).not.toHaveBeenCalled();
  });

  it("nobody gets it while the flag is off, a superuser included", async () => {
    vi.stubEnv("METHOD_SERVICES", "off");
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await coreProps()).methodServices).toBeNull();
    expect(m.loadServices).not.toHaveBeenCalled();
  });
});
