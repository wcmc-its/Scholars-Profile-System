/**
 * Who gets the "Method services" section on `/edit/department/[code]` and
 * `/edit/core/[coreId]`, and which half of it (`loadMethodServicesForViewer`,
 * run for real here):
 *   - a superuser: every service, the whole editor (`mode: "manage"`);
 *   - someone else who may edit the unit: the publications half
 *     (`mode: "publications"`), only when the unit already has a service, and
 *     never with the affiliation phrases or author names in the payload;
 *   - anyone else: `methodServices` null, which renders no section, and the
 *     service list is never even read.
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
  unitAdminFindMany: vi.fn(),
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
      unitAdmin: { findUnique: m.unitAdminFindUnique, findMany: m.unitAdminFindMany },
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

const SERVICES = [
  {
    id: 1,
    entityType: "department",
    entityId: "DEPTA",
    name: "Example service",
    url: "https://example.org/service",
    families: [{ supercategory: "s", familyLabel: "Example family" }],
    supportedPmids: ["111"],
    excludedPmids: [],
    countStaffPapers: false,
    affiliationPhrases: ["Example Library"],
    authorNames: ["Stone B"],
    coauthoredPmids: [],
    nameMatchedPmids: [],
  },
];
const NOBODY = { cwid: "act0001", isSuperuser: false, isCommsSteward: false };
/** The actor holds this role on the department (`getEffectiveUnitRole`). */
const grantDepartment = (role: "owner" | "curator") =>
  m.unitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPTA", role }]);

/** The publications half, as the browser of a unit's editor receives it. */
function expectPublicationsPayload(methodServices: unknown) {
  expect(methodServices).toMatchObject({
    mode: "publications",
    services: [{ id: 1, name: "Example service", supportedPmids: ["111"] }],
  });
  const [service] = (methodServices as { services: Array<Record<string, unknown>> }).services;
  expect(service).not.toHaveProperty("affiliationPhrases");
  expect(service).not.toHaveProperty("authorNames");
  expect(JSON.stringify(methodServices)).not.toMatch(/Example Library|Stone B/);
}

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
  m.unitAdminFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("/edit/department/[code]: the Method services section", () => {
  it("a superuser is handed the whole editor, phrases and names included", async () => {
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await departmentProps()).methodServices).toEqual({ mode: "manage", services: SERVICES });
    expect(m.loadServices).toHaveBeenCalledWith("department", "DEPTA");
  });

  it("a superuser gets the section for a department with no service yet", async () => {
    m.loadServices.mockResolvedValue([]);
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await departmentProps()).methodServices).toEqual({ mode: "manage", services: [] });
  });

  it.each([
    ["the department's own owner", {}, "owner" as const],
    ["the department's own curator", {}, "curator" as const],
    ["a comms steward", { isCommsSteward: true }, null],
    ["a content editor", { isCommsSteward: true, isContentEditor: true }, null],
  ])("%s is handed the publications half, without phrases or names", async (_who, flags, role) => {
    if (role) grantDepartment(role);
    m.session.mockResolvedValue({ ...NOBODY, ...flags });
    expectPublicationsPayload((await departmentProps()).methodServices);
    expect(m.loadServices).toHaveBeenCalledWith("department", "DEPTA");
  });

  it("the department's own owner gets no section while it has no service", async () => {
    grantDepartment("owner");
    m.loadServices.mockResolvedValue([]);
    m.session.mockResolvedValue(NOBODY);
    expect((await departmentProps()).methodServices).toBeNull();
  });

  it.each([
    // Admitted to the page by the (mocked) context loader, with no role on it.
    ["someone with no role on the department", {}],
    // The observer's steward view is read-only: nothing here they could save.
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
  it("a superuser is handed the whole editor", async () => {
    m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
    expect((await coreProps()).methodServices).toEqual({ mode: "manage", services: SERVICES });
    expect(m.loadServices).toHaveBeenCalledWith("core", "77");
  });

  it.each([
    ["the core's own owner", {}, true],
    ["the Cores director", { isCoreDirector: true }, false],
    ["a comms steward", { isCommsSteward: true }, false],
  ])("%s is handed the publications half, without phrases or names", async (_who, flags, owner) => {
    m.session.mockResolvedValue({ ...NOBODY, ...flags });
    if (owner) m.unitAdminFindUnique.mockResolvedValue({ role: "owner" });
    expectPublicationsPayload((await coreProps()).methodServices);
    expect(m.loadServices).toHaveBeenCalledWith("core", "77");
  });

  it("the core's own owner gets no section while it has no service", async () => {
    m.session.mockResolvedValue(NOBODY);
    m.unitAdminFindUnique.mockResolvedValue({ role: "owner" });
    m.loadServices.mockResolvedValue([]);
    expect((await coreProps()).methodServices).toBeNull();
  });

  it("an observer gets the page with no section, and the services are not read", async () => {
    m.session.mockResolvedValue({ ...NOBODY, isCommsSteward: true, isObserver: true });
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
