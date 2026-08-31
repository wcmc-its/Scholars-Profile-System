/**
 * `app/edit/core/[coreId]/page.tsx` — #2559 server-to-client role-label
 * wiring.
 *
 * The component tests for `CoreLeaderCard` (`core-leader-card.test.tsx`)
 * inject `roleLabels` directly and never exercise the page that builds it.
 * `roleLabels` is an OPTIONAL prop with a safe `{}` default (deliberately —
 * see the prop's docblock), so a page-level regression that drops the query
 * or the prop degrades silently to raw stored keys instead of failing loudly,
 * and the component suite stays green throughout. This file closes that gap:
 * it asserts the page (a) queries `OrgUnitRole` for `entityType: "core"`, and
 * (b) the resulting label map is the exact object passed to `CoreLeaderCard`
 * — composed with the real (unmocked) `resolveCoreLeaderRoleLabel` to prove a
 * steward rename actually reaches the displayed string, not just the raw
 * stored key.
 *
 * Follows `core-review-page.test.tsx`'s pattern for this route family: the
 * real (pure/injectable) `lib/edit/authz` functions run unmocked; only the DB
 * surface, session, and child components are mocked. Server Component
 * elements are never rendered — `EditCorePage(...)` returns a `{ type, props
 * }` tree (React.createElement records, doesn't invoke), walked with
 * `findByType`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockRedirect,
  mockNotFound,
  mockCoreFindUnique,
  mockCoreLeaderFindMany,
  mockOrgUnitRoleFindMany,
  mockUnitAdminFindUnique,
  mockUnitAdminFindMany,
  mockScholarFindMany,
  mockLoadQueue,
  mockLoadConsoleTabs,
  mockLogAuthzDenied,
  mockLeaderCard,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockCoreFindUnique: vi.fn(),
  mockCoreLeaderFindMany: vi.fn(),
  mockOrgUnitRoleFindMany: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockLoadQueue: vi.fn(),
  mockLoadConsoleTabs: vi.fn(),
  mockLogAuthzDenied: vi.fn(),
  mockLeaderCard: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/auth/authz-events", () => ({ logAuthzDenied: mockLogAuthzDenied }));
vi.mock("@/lib/api/core-queue", () => ({ loadCoreReviewQueue: mockLoadQueue }));
vi.mock("@/lib/edit/console-tabs.server", () => ({ loadConsoleTabs: mockLoadConsoleTabs }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      coreLeader: { findMany: mockCoreLeaderFindMany },
      orgUnitRole: { findMany: mockOrgUnitRoleFindMany },
      unitAdmin: { findUnique: mockUnitAdminFindUnique, findMany: mockUnitAdminFindMany },
      scholar: { findMany: mockScholarFindMany },
    },
    write: {},
  },
}));
// Only the CLIENT COMPONENT is replaced — `resolveCoreLeaderRoleLabel` stays
// the real export, so the assertions below run the actual resolver, not a
// re-statement of what the component test already covers.
vi.mock("@/components/edit/core-leader-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/edit/core-leader-card")>();
  return { ...actual, CoreLeaderCard: mockLeaderCard };
});
vi.mock("@/components/edit/core-details-card", () => ({ CoreDetailsCard: vi.fn(() => null) }));
vi.mock("@/components/edit/unit-access-card", () => ({ UnitAccessCard: vi.fn(() => null) }));
vi.mock("@/components/edit/edit-shell", () => ({ EditShell: vi.fn(({ children }) => children) }));
vi.mock("@/components/edit/console-top-bar", () => ({ ConsoleTopBar: vi.fn(() => null) }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: vi.fn(() => null) }));

import { resolveCoreLeaderRoleLabel } from "@/components/edit/core-leader-card";
import EditCorePage from "@/app/edit/core/[coreId]/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const params = (coreId: string) => Promise.resolve({ coreId });
const searchParams = (attr?: string) => Promise.resolve(attr ? { attr } : {});

/** Depth-first search for the first node whose `type` matches (same helper
 *  as `core-review-page.test.tsx`: these Server Component calls never invoke
 *  child components, they just record `{ type, props }`). */
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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue({ cwid: "sup001", isSuperuser: true, isCommsSteward: false });
  mockUnitAdminFindUnique.mockResolvedValue(null);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockCoreFindUnique.mockResolvedValue({
    name: "Biomedical Imaging",
    description: null,
    url: null,
    visible: true,
  });
  mockCoreLeaderFindMany.mockResolvedValue([
    { cwid: "lead001", role: "director", interim: false, sortOrder: 0 },
  ]);
  mockScholarFindMany.mockResolvedValue([
    { cwid: "lead001", preferredName: "Dana One", primaryTitle: "Professor" },
  ]);
  // A steward has renamed the "core" vocabulary's "director" key away from
  // its seed label ("Director") — the case the FINDING calls out: only a
  // page that actually re-queries `OrgUnitRole` on every load will surface
  // the CURRENT label rather than a stale or default one.
  mockOrgUnitRoleFindMany.mockResolvedValue([{ key: "director", label: "Executive Director" }]);
  mockLoadQueue.mockResolvedValue({ candidates: [] });
  mockLoadConsoleTabs.mockResolvedValue({ units: true });
});

describe("/edit/core/[coreId] — #2559 role-label wiring", () => {
  it("queries OrgUnitRole scoped to entityType: core", async () => {
    await EditCorePage({ params: params("2"), searchParams: searchParams("leadership") });
    expect(mockOrgUnitRoleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: "core" } }),
    );
  });

  it("passes the queried labels to CoreLeaderCard, and a steward rename reaches the resolved display string (not the raw key)", async () => {
    const result = await EditCorePage({ params: params("2"), searchParams: searchParams("leadership") });
    const card = findByType(result, mockLeaderCard);
    expect(card).toBeTruthy();

    // Half 1: the map built from the query reached the prop verbatim.
    expect(card!.props.roleLabels).toEqual({ director: "Executive Director" });
    expect(card!.props.leaders).toMatchObject([{ cwid: "lead001", role: "director" }]);

    // Half 2: run those two pieces through the REAL resolver, exactly as
    // `CoreLeaderCard` itself does — proves the rename is what a viewer would
    // actually see, not merely present somewhere in a prop bag.
    const leaders = card!.props.leaders as Array<{ role: string }>;
    const roleLabels = card!.props.roleLabels as Record<string, string>;
    expect(resolveCoreLeaderRoleLabel(leaders[0].role, roleLabels)).toBe("Executive Director");
    expect(resolveCoreLeaderRoleLabel(leaders[0].role, roleLabels)).not.toBe("director");
  });

  it("an unrecognized stored role still degrades to raw text via the same page-supplied map (no crash, no blank)", async () => {
    mockCoreLeaderFindMany.mockResolvedValue([
      { cwid: "lead003", role: "Chief", interim: false, sortOrder: 0 },
    ]);
    mockScholarFindMany.mockResolvedValue([]);
    const result = await EditCorePage({ params: params("2"), searchParams: searchParams("leadership") });
    const card = findByType(result, mockLeaderCard);
    const leaders = card!.props.leaders as Array<{ role: string }>;
    const roleLabels = card!.props.roleLabels as Record<string, string>;
    expect(resolveCoreLeaderRoleLabel(leaders[0].role, roleLabels)).toBe("Chief");
  });
});
