/**
 * `app/edit/slugs/page.tsx` — the superuser slug-registry page (#497).
 * Route-level authorization + flag-aware segment wiring. Real
 * `requireSuperuserGet` (so the denial log line is exercised), mocked boundary
 * deps — mirroring the `/edit/profiles` roster page test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadRegistry,
  mockRedirect,
  mockRegistry,
  mockForbidden,
  mockEnabled,
  mockLoadQueue,
  mockLastDecision,
  mockCounts,
  mockExtras,
  mockStatus,
  mockFindScholar,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadRegistry: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockRegistry: vi.fn(() => null),
  mockForbidden: vi.fn(() => null),
  mockEnabled: vi.fn(),
  mockLoadQueue: vi.fn(),
  mockLastDecision: vi.fn(),
  mockCounts: vi.fn(),
  mockExtras: vi.fn(),
  mockStatus: vi.fn(),
  mockFindScholar: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/slug-registry", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/slug-registry")>()),
  loadSlugRegistry: mockLoadRegistry,
  countSlugRegistrySegments: mockCounts,
  loadSlugRegistryExtras: mockExtras,
  resolveSlugStatus: mockStatus,
}));
vi.mock("@/components/edit/slug-request-queue", () => ({ SlugRequestQueue: () => null }));
vi.mock("@/components/edit/slug-registry", () => ({ SlugRegistry: mockRegistry }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/admin-subnav", () => ({ AdminSubnav: () => null }));
vi.mock("@/lib/edit/administrators", () => ({ isAdministratorsTabEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: mockEnabled,
  loadSlugRequestQueue: mockLoadQueue,
  loadLastSlugDecision: mockLastDecision,
}));
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: mockFindScholar } }, write: {} },
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
  mockLoadQueue.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  mockLastDecision.mockResolvedValue(null);
  mockCounts.mockResolvedValue({ active: 1 });
  mockExtras.mockResolvedValue({ people: {}, pinned: [], baseHolders: {} });
  mockStatus.mockResolvedValue({ state: "available", slug: "x" });
  mockFindScholar.mockResolvedValue(null);
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
    // C8/C9 — the denial branch is wrapped in the same ConsoleShell the
    // success path uses, so the top-level element is the shell and
    // ForbiddenEditPage is its child, not the return value itself.
    expect(asEl(result.props.children).type).toBe(mockForbidden);
    expect(mockLoadRegistry).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled(); // requireSuperuserGet denial line
  });

  it("superuser → renders the registry from a segment query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadRegistry.mockResolvedValue({ rows: [{ slug: "a", cwid: "1", name: "A" }], total: 1 });
    const result = asEl(await EditSlugsPage({ searchParams: sp() }));
    expect(result.type).not.toBe(mockForbidden);
    const reg = asEl(result.props.children);
    expect(reg.type).toBe(mockRegistry);
    expect(reg.props.total).toBe(1);
    expect(reg.props.counts).toEqual({ active: 1 });
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
    const reg = asEl(result.props.children);
    expect(reg.type).toBe(mockRegistry);
    expect(reg.props.requestedSegmentVisible).toBe(false);
    expect(result.props.pendingSlugRequests).toBeNull();
    expect(reg.props.requests).toBeNull();
    expect(mockLoadQueue).not.toHaveBeenCalled();
    expect(mockCounts.mock.calls[0][2]).toEqual({ requested: false });
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
    const reg = asEl(result.props.children);
    expect(reg.props.requestedSegmentVisible).toBe(true);
    expect(result.props.pendingSlugRequests).toBe(2);
    expect(reg.props.requests).not.toBeNull();
    // The requested tab lists decided requests; pending ones are in the queue card.
    expect(mockLoadRegistry.mock.calls[0][0]).toMatchObject({ segment: "requested", decidedOnly: true });
  });
});

describe("/edit/slugs — the input's verdict", () => {
  it("no query → no lookup, no verdict", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const reg = asEl(asEl(await EditSlugsPage({ searchParams: sp() })).props.children);
    expect(reg.props.verdict).toBeNull();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("a pasted profile URL is reduced to its slug and checked", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const reg = asEl(
      asEl(await EditSlugsPage({ searchParams: sp({ q: " https://example.org/scholars/Jane-Doe?x=1 " }) })).props
        .children,
    );
    expect(reg.props.query).toBe("Jane-Doe");
    expect(mockStatus.mock.calls[0][0]).toBe("jane-doe");
    expect(reg.props.verdict).toEqual({ kind: "status", status: { state: "available", slug: "x" } });
  });

  it("a CWID says where that scholar is, without a slug check", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockFindScholar.mockResolvedValue({ cwid: "zzq0001", slug: "pat-example", preferredName: "Pat Example", fullName: "Pat Example" });
    const reg = asEl(asEl(await EditSlugsPage({ searchParams: sp({ q: "zzq0001" }) })).props.children);
    expect(reg.props.verdict).toEqual({ kind: "cwid", cwid: "zzq0001", name: "Pat Example", slug: "pat-example" });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("a failed lookup shows no verdict instead of failing the page", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockStatus.mockRejectedValue(new Error("db down"));
    const reg = asEl(asEl(await EditSlugsPage({ searchParams: sp({ q: "anything" }) })).props.children);
    expect(reg.props.verdict).toBeNull();
  });
});
