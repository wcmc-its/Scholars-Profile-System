/**
 * GET /api/edit/reciter-pending — the self-only live ReCiter pending-articles
 * read (`SELF_EDIT_RECITER_PENDING_HINT`).
 *
 * Verifies: dormant flag-off returns `{ suggestions: [] }` WITHOUT touching the
 * session or the engine; no session returns `[]`; the engine read is keyed on
 * the REAL `session.cwid` (the self-only uid — never an impersonation target);
 * the route degrades to `[]` (and never throws) when the client read throws.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetSession, mockIsEnabled, mockFetchSuggested } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockIsEnabled: vi.fn(),
  mockFetchSuggested: vi.fn(),
}));

vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/edit/reciter-pending-hint", () => ({
  isReciterPendingHintEnabled: mockIsEnabled,
}));
vi.mock("@/lib/reciter/client", () => ({
  fetchSuggestedArticles: mockFetchSuggested,
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

describe("GET /api/edit/reciter-pending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: flag on, a genuine self session, the engine returns one suggestion.
    mockIsEnabled.mockReturnValue(true);
    mockGetSession.mockResolvedValue({ cwid: "self01" });
    mockFetchSuggested.mockResolvedValue([SUGGESTION]);
  });

  it("returns { suggestions: [] } and does NOT read the session or engine when the flag is off", async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await GET();
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockFetchSuggested).not.toHaveBeenCalled();
  });

  it("returns { suggestions: [] } and does NOT read the engine when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockFetchSuggested).not.toHaveBeenCalled();
  });

  it("reads the engine with the REAL session.cwid (self-only uid) and returns its suggestions", async () => {
    const res = await GET();
    expect(mockFetchSuggested).toHaveBeenCalledTimes(1);
    expect(mockFetchSuggested).toHaveBeenCalledWith("self01");
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("never marks the response cacheable (no-store)", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("degrades to { suggestions: [] } (never throws) when the client read throws", async () => {
    mockFetchSuggested.mockRejectedValue(new Error("engine down"));
    const res = await GET();
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});
