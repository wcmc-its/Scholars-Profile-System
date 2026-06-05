/**
 * `app/edit/slugs/page.tsx` — the superuser slug-registry page (#497).
 * Route-level authorization + flag-aware segment wiring. Real
 * `requireSuperuserGet` (so the denial log line is exercised), mocked boundary
 * deps — mirroring the `/edit/scholars` roster page test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadRegistry,
  mockRedirect,
  mockRegistry,
  mockForbidden,
  mockEnabled,
  mockCountPending,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadRegistry: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockRegistry: vi.fn(() => null),
  mockForbidden: vi.fn(() => null),
  mockEnabled: vi.fn(),
  mockCountPending: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/slug-registry", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/slug-registry")>()),
  loadSlugRegistry: mockLoadRegistry,
}));
vi.mock("@/components/edit/slug-registry", () => ({ SlugRegistry: mockRegistry }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/lib/edit/administrators", () => ({ isAdministratorsTabEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: mockEnabled,
  countPendingSlugRequests: mockCountPending,
}));
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: vi.fn().mockResolvedValue(null) } }, write: {} },
}));

import EditSlugsPage from "@/app/edit/slugs/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const ADMIN = { cwid: "adm001", isSuperuser: true };
const SELF = { cwid: "self01", isSuperuser: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockLoadRegistry.mockResolvedValue({ rows: [], total: 0 });
  mockEnabled.mockReturnValue(true);
  mockCountPending.mockResolvedValue(2);
});

describe("/edit/slugs — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/slugs", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditSlugsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/slugs",
    );
    expect(mockLoadRegistry).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser → ForbiddenEditPage, no registry query", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asEl(await EditSlugsPage({ searchParams: sp() }));
    expect(result.type).toBe(mockForbidden);
    expect(mockLoadRegistry).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled(); // requireSuperuserGet denial line
  });

  it("superuser → renders the registry from a segment query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadRegistry.mockResolvedValue({ rows: [{ slug: "a", cwid: "1", name: "A" }], total: 1 });
    const result = asEl(await EditSlugsPage({ searchParams: sp() }));
    expect(result.type).toBe(mockRegistry);
    expect(result.props.total).toBe(1);
    expect(mockLoadRegistry).toHaveBeenCalledOnce();
  });
});

describe("/edit/slugs — segment + query parsing", () => {
  it("defaults to the active segment with page 0", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditSlugsPage({ searchParams: sp() });
    const [opts] = mockLoadRegistry.mock.calls[0];
    expect(opts).toMatchObject({ segment: "active", query: "", limit: 50, offset: 0 });
  });

  it("parses seg, q (trimmed), and page into the registry query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditSlugsPage({ searchParams: sp({ seg: "historical", q: "  smith ", page: "2" }) });
    const [opts] = mockLoadRegistry.mock.calls[0];
    expect(opts).toMatchObject({ segment: "historical", query: "smith", offset: 100 });
  });

  it("an unknown segment falls back to active; a bad page → 0", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditSlugsPage({ searchParams: sp({ seg: "bogus", page: "-9" }) });
    const [opts] = mockLoadRegistry.mock.calls[0];
    expect(opts.segment).toBe("active");
    expect(opts.offset).toBe(0);
  });
});

describe("/edit/slugs — flag gating (page is NEVER 404'd; only the requested segment is gated)", () => {
  it("flag OFF → the page still renders (not 404), requestedSegmentVisible=false, no pending count", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockEnabled.mockReturnValue(false);
    const result = asEl(await EditSlugsPage({ searchParams: sp() }));
    expect(result.type).toBe(mockRegistry);
    expect(result.props.requestedSegmentVisible).toBe(false);
    expect(result.props.pendingSlugRequests).toBeNull();
    expect(mockCountPending).not.toHaveBeenCalled();
  });

  it("flag OFF → a ?seg=requested URL is routed back to the active segment", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockEnabled.mockReturnValue(false);
    await EditSlugsPage({ searchParams: sp({ seg: "requested" }) });
    expect(mockLoadRegistry.mock.calls[0][0].segment).toBe("active");
  });

  it("flag ON → requestedSegmentVisible=true and the pending count is loaded", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockEnabled.mockReturnValue(true);
    const result = asEl(await EditSlugsPage({ searchParams: sp({ seg: "requested" }) }));
    expect(result.props.requestedSegmentVisible).toBe(true);
    expect(result.props.pendingSlugRequests).toBe(2);
    expect(mockLoadRegistry.mock.calls[0][0].segment).toBe("requested");
  });
});
