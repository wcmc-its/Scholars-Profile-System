/**
 * `app/edit/core/[coreId]/review/page.tsx` authorization gates (cores-as-org-units
 * P3/P4 restructure — the pub review queue split out of the core editor).
 *
 * Mirrors `center-history-page.test.tsx`'s shape: signed-out → SAML redirect,
 * no-role + core exists → 403 + logged denial, core absent → 404, authorized →
 * loads the queue and renders it. `authorizeCoreClaim`/`getCoreOwnerRole` are
 * the real (pure/injectable) functions from `lib/edit/authz` — only the DB
 * surface, session, and `loadCoreReviewQueue` are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockRedirect,
  mockNotFound,
  mockCoreFindUnique,
  mockUnitAdminFindUnique,
  mockLoadQueue,
  mockLogAuthzDenied,
  mockForbidden,
  mockQueueComponent,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockCoreFindUnique: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockLoadQueue: vi.fn(),
  mockLogAuthzDenied: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockQueueComponent: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/core-queue", () => ({ loadCoreReviewQueue: mockLoadQueue }));
vi.mock("@/lib/auth/authz-events", () => ({ logAuthzDenied: mockLogAuthzDenied }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: {},
  },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/core-claim-queue", () => ({ CoreClaimQueue: mockQueueComponent }));

import EditCoreReviewPage from "@/app/edit/core/[coreId]/review/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const params = (coreId: string) => Promise.resolve({ coreId });

/** Depth-first search of a returned element tree for the first node whose
 *  `type` matches — React.createElement never CALLS a component in these
 *  server-component tests, it just records `{ type, props }`, so finding the
 *  mocked `CoreClaimQueue` means walking `props.children`, not spying on a call. */
function findByType(node: unknown, type: unknown): El | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const el = asEl(node);
  if (el.type === type) return el;
  return findByType(el.props?.children, type);
}

const QUEUE = {
  core: { id: "2", name: "Biomedical Imaging" },
  candidates: [],
  confirmed: [],
  rejected: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadQueue.mockResolvedValue(QUEUE);
});

describe("/edit/core/[coreId]/review — authorization", () => {
  it("signed-out → SAML redirect with ?return=…/review, no queue load", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("2") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/core/2/review",
    );
    expect(mockUnitAdminFindUnique).not.toHaveBeenCalled();
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("no role + core exists → ForbiddenEditPage + logged denial, no queue load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "non001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue(null);
    mockCoreFindUnique.mockResolvedValue({ id: "2" });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    expect(result.type).toBe(mockForbidden);
    expect(result.props.targetEntity).toBe("2");
    expect(mockLogAuthzDenied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_core_owner", target_entity_id: "2" }),
    );
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("no role + core absent → 404, no queue load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "non001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue(null);
    mockCoreFindUnique.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("nope") })).rejects.toThrow("__NOTFOUND__");
    expect(mockLogAuthzDenied).not.toHaveBeenCalled();
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("owner/curator/superuser → loads the queue, renders CoreClaimQueue", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    expect(mockLoadQueue).toHaveBeenCalledWith("2", expect.anything());
    const queueEl = findByType(result, mockQueueComponent);
    expect(queueEl).toBeTruthy();
    expect(queueEl!.props).toMatchObject({
      core: QUEUE.core,
      candidates: QUEUE.candidates,
      confirmed: QUEUE.confirmed,
      rejected: QUEUE.rejected,
    });
  });

  it("queue absent (core row gone between the authz check and the load) → 404", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "sup001", isSuperuser: true });
    mockLoadQueue.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("2") })).rejects.toThrow("__NOTFOUND__");
  });
});
