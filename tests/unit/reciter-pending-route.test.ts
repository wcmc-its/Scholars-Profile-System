/**
 * GET /api/edit/reciter-pending — the live ReCiter pending-articles read
 * (`SELF_EDIT_RECITER_PENDING_HINT`).
 *
 * Verifies: dormant flag-off returns `{ suggestions: [] }` WITHOUT touching the
 * session or the engine; no session returns `[]`; a self read (no/own `?cwid`)
 * is keyed on the session's own cwid; a SUPERUSER may read another scholar's
 * suggestions via `?cwid=`; a NON-superuser asking for another scholar's cwid
 * degrades to `[]` (the engine is never read for the other target); the route
 * degrades to `[]` (and never throws) when the client read throws.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetSession, mockIsEnabled, mockFetchSuggested, mockFetchViaApi, mockPreferApi } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockIsEnabled: vi.fn(),
    mockFetchSuggested: vi.fn(),
    mockFetchViaApi: vi.fn(),
    mockPreferApi: vi.fn(),
  }));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetSession,
}));
vi.mock("@/lib/edit/reciter-pending-hint", () => ({
  isReciterPendingHintEnabled: mockIsEnabled,
}));
vi.mock("@/lib/reciter/client", () => ({
  fetchSuggestedArticles: mockFetchSuggested,
  fetchSuggestedArticlesViaApi: mockFetchViaApi,
  preferReciterApiSource: mockPreferApi,
}));

import { GET } from "@/app/api/edit/reciter-pending/route";

const SUGGESTION = {
  pmid: "39000001",
  score: 85,
  articleTitle: "A high-confidence candidate paper",
  authors: "Self A, Coauthor B",
  journal: "Nature",
  datePublished: "2025 May 28",
  isPreprint: false,
};

/** A minimal NextRequest-ish stand-in: GET only reads `request.url`. */
function req(url = "https://app.example/api/edit/reciter-pending"): Request {
  return new Request(url);
}

describe("GET /api/edit/reciter-pending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: flag on, a genuine self superuser-false session, one suggestion.
    mockIsEnabled.mockReturnValue(true);
    mockGetSession.mockResolvedValue({ cwid: "self01", isSuperuser: false });
    mockFetchSuggested.mockResolvedValue([SUGGESTION]);
    // Default source is DynamoDB/S3 (preferReciterApiSource false), matching prod.
    mockPreferApi.mockReturnValue(false);
    mockFetchViaApi.mockResolvedValue([SUGGESTION]);
  });

  it("returns { suggestions: [] } and does NOT read the session or engine when the flag is off", async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await GET(req() as never);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockFetchSuggested).not.toHaveBeenCalled();
  });

  it("returns { suggestions: [] } and does NOT read the engine when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(req() as never);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockFetchSuggested).not.toHaveBeenCalled();
  });

  it("reads the engine with the session's own cwid when no ?cwid is supplied (self)", async () => {
    const res = await GET(req() as never);
    expect(mockFetchSuggested).toHaveBeenCalledTimes(1);
    expect(mockFetchSuggested).toHaveBeenCalledWith("self01");
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("reads the engine with the session's own cwid when ?cwid equals it (self)", async () => {
    const res = await GET(req("https://app.example/api/edit/reciter-pending?cwid=self01") as never);
    expect(mockFetchSuggested).toHaveBeenCalledTimes(1);
    expect(mockFetchSuggested).toHaveBeenCalledWith("self01");
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("lets a SUPERUSER read another scholar's suggestions via ?cwid (superuser parity)", async () => {
    mockGetSession.mockResolvedValue({ cwid: "admin99", isSuperuser: true });
    const res = await GET(
      req("https://app.example/api/edit/reciter-pending?cwid=other22") as never,
    );
    expect(mockFetchSuggested).toHaveBeenCalledTimes(1);
    expect(mockFetchSuggested).toHaveBeenCalledWith("other22");
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("returns { suggestions: [] } and never reads the target when a NON-superuser asks for another cwid", async () => {
    mockGetSession.mockResolvedValue({ cwid: "self01", isSuperuser: false });
    const res = await GET(
      req("https://app.example/api/edit/reciter-pending?cwid=other22") as never,
    );
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockFetchSuggested).not.toHaveBeenCalledWith("other22");
    expect(mockFetchSuggested).not.toHaveBeenCalled();
  });

  it("reads the engine FG API (not DynamoDB/S3) when RECITER_PENDING_SOURCE=api", async () => {
    mockPreferApi.mockReturnValue(true);
    const res = await GET(req() as never);
    expect(mockFetchViaApi).toHaveBeenCalledTimes(1);
    expect(mockFetchViaApi).toHaveBeenCalledWith("self01");
    expect(mockFetchSuggested).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("never marks the response cacheable (no-store)", async () => {
    const res = await GET(req() as never);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("degrades to { suggestions: [] } (never throws) when the client read throws", async () => {
    mockFetchSuggested.mockRejectedValue(new Error("engine down"));
    const res = await GET(req() as never);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});
