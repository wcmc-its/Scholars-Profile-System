/**
 * `app/edit/unit/new/page.tsx` — the org-unit-create lockdown page gate (#728
 * Phase D § 4.5). When `SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY` is ON, a
 * non-superuser Owner sees the "Request a new org unit" affordance instead of
 * the center form (the create endpoint now refuses the same submission); a
 * superuser still sees the form; flag OFF preserves the Owner center form.
 *
 * The page is a Server Component returning a React element tree (it never
 * renders to the DOM here). We mock the boundary deps and walk the returned
 * tree for the sentinel `UnitCreateForm` / `RequestNewOrgUnitDialog` mocks.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const {
  mockGetEditSession,
  mockIsLockdown,
  mockCanManageAccess,
  mockGetEffectiveUnitRole,
  mockDeptFindUnique,
  mockDeptFindMany,
  mockForm,
  mockRequestDialog,
  mockForbidden,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockIsLockdown: vi.fn(),
  mockCanManageAccess: vi.fn(),
  mockGetEffectiveUnitRole: vi.fn(),
  mockDeptFindUnique: vi.fn(),
  mockDeptFindMany: vi.fn(),
  mockForm: vi.fn(() => null),
  mockRequestDialog: vi.fn(() => null),
  mockForbidden: vi.fn(() => null),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/unit-create-flags", () => ({
  isOrgUnitCreateSuperuserOnly: mockIsLockdown,
}));
vi.mock("@/lib/edit/authz", () => ({
  canManageAccess: mockCanManageAccess,
  getEffectiveUnitRole: mockGetEffectiveUnitRole,
  logEditDenial: vi.fn(),
}));
vi.mock("@/components/edit/unit-create-form", () => ({ UnitCreateForm: mockForm }));
vi.mock("@/components/edit/request-new-org-unit-dialog", () => ({
  RequestNewOrgUnitDialog: mockRequestDialog,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      department: { findUnique: mockDeptFindUnique, findMany: mockDeptFindMany },
    },
  },
}));

import NewUnitPage from "@/app/edit/unit/new/page";

const SUPERUSER = { cwid: "adm001", isSuperuser: true };
const OWNER = { cwid: "own01", isSuperuser: false };

/** Recursively search a React element tree for a node whose `.type` is `target`. */
function treeHas(node: unknown, target: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === target) return true;
  const children = el.props?.children;
  if (Array.isArray(children)) return children.some((c) => treeHas(c, target));
  return treeHas(children, target);
}

async function renderPage(params: { type?: string; dept?: string }) {
  return NewUnitPage({ searchParams: Promise.resolve(params) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockIsLockdown.mockReturnValue(false);
  mockCanManageAccess.mockReturnValue({ ok: true });
  mockGetEffectiveUnitRole.mockResolvedValue("owner");
  mockDeptFindUnique.mockResolvedValue({ code: "MED", name: "Medicine" });
  mockDeptFindMany.mockResolvedValue([{ code: "MED", name: "Medicine" }]);
});

describe("/edit/unit/new — org-unit-create lockdown gate (#728 Phase D)", () => {
  it("flag ON, non-superuser Owner → renders the Request affordance, NOT the form", async () => {
    mockIsLockdown.mockReturnValue(true);
    mockGetEditSession.mockResolvedValue(OWNER);
    const result = await renderPage({ type: "center", dept: "MED" });
    expect(treeHas(result, mockRequestDialog)).toBe(true);
    expect(treeHas(result, mockForm)).toBe(false);
    expect((result as ReactElement).type).not.toBe(mockForbidden);
  });

  it("flag ON, superuser → still renders the create form (lockdown only narrows non-superusers)", async () => {
    mockIsLockdown.mockReturnValue(true);
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const result = await renderPage({ type: "center" });
    expect(treeHas(result, mockForm)).toBe(true);
    expect(treeHas(result, mockRequestDialog)).toBe(false);
  });

  it("flag OFF (default), non-superuser Owner → renders the Owner center form (unchanged)", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const result = await renderPage({ type: "center", dept: "MED" });
    expect(treeHas(result, mockForm)).toBe(true);
    expect(treeHas(result, mockRequestDialog)).toBe(false);
  });
});
