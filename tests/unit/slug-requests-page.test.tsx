/**
 * `app/edit/slug-requests/page.tsx` — the superuser approval-queue page
 * (#497 PR-3c). Route-level authorization + flag-gating, mirroring the
 * `/edit/scholars` roster page test (real `requireSuperuserGet`, mocked
 * boundary deps).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockGetEditSession,
  mockRedirect,
  mockNotFound,
  mockForbidden,
  mockEnabled,
  mockLoadQueue,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockForbidden: vi.fn(() => null),
  mockEnabled: vi.fn(),
  mockLoadQueue: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: vi.fn().mockResolvedValue(null) } }, write: {} },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/admin-subnav", () => ({
  AdminSubnav: (p: { pendingSlugRequests: number | null }) => (
    <div data-testid="mock-subnav" data-pending={String(p.pendingSlugRequests)} />
  ),
}));
vi.mock("@/components/edit/slug-request-queue", () => ({
  SlugRequestQueue: (p: { initialRequests: unknown[] }) => (
    <div data-testid="mock-queue" data-count={p.initialRequests.length} />
  ),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: mockEnabled,
  loadSlugRequestQueue: mockLoadQueue,
}));

import SlugRequestsPage from "@/app/edit/slug-requests/page";

type El = { type: unknown };
const asEl = (v: unknown) => v as El;

const ADMIN = { cwid: "adm001", isSuperuser: true };
const SELF = { cwid: "self01", isSuperuser: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockLoadQueue.mockResolvedValue([]);
});

describe("/edit/slug-requests — authorization & flag", () => {
  it("signed-out → SAML redirect with ?return=/edit/slug-requests", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(SlugRequestsPage()).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/slug-requests",
    );
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser → ForbiddenEditPage, no queue load", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asEl(await SlugRequestsPage());
    expect(result.type).toBe(mockForbidden);
    expect(mockLoadQueue).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled(); // requireSuperuserGet denial line
  });

  it("superuser but flag off → notFound, no queue load", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockEnabled.mockReturnValue(false);
    await expect(SlugRequestsPage()).rejects.toThrow("__NOTFOUND__");
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("superuser + flag on → renders the queue + sub-nav with the pending count", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadQueue.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    render(await SlugRequestsPage());
    expect(screen.getByTestId("mock-queue").getAttribute("data-count")).toBe("2");
    expect(screen.getByTestId("mock-subnav").getAttribute("data-pending")).toBe("2");
    expect(mockLoadQueue).toHaveBeenCalledOnce();
  });
});
