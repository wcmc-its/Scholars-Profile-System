/**
 * `app/api/directory/people/route.ts` — SSO gate, q-mode + cwids-mode
 * validation, and the 503 LDAP-unavailable path (#540 Phase 7 § 13). The LDAP
 * helpers are mocked at the module boundary (cleaner than a raw ldapts client
 * stub and equally faithful to the route's contract).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetEditSession, mockSearchByName, mockFetchByCwid } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockSearchByName: vi.fn(),
  mockFetchByCwid: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/sources/ldap", () => ({
  searchDirectoryPeopleByName: mockSearchByName,
  fetchDirectoryPeopleByCwid: mockFetchByCwid,
}));

import { GET } from "@/app/api/directory/people/route";

const SESSION = { cwid: "act001", isSuperuser: false };
const PERSON = { cwid: "abc123", name: "Ada Lovelace", title: "Professor", dept: "CS" };

/** Build the request, run the route, and return the response. */
function get(query: string) {
  return GET(new NextRequest(`https://x.test/api/directory/people${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue(SESSION);
  mockSearchByName.mockResolvedValue([PERSON]);
  mockFetchByCwid.mockResolvedValue([PERSON]);
});

describe("GET /api/directory/people — auth + mode selection", () => {
  it("401 when there is no session", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await get("?q=ad");
    expect(res.status).toBe(401);
  });

  it("400 when neither q nor cwids is present", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("400 when both q and cwids are present", async () => {
    expect((await get("?q=ada&cwids=abc123")).status).toBe(400);
  });

  it("sets no-store on every response", async () => {
    const res = await get("?q=ada");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/directory/people — q mode", () => {
  it("400 when the query is shorter than 2 chars", async () => {
    expect((await get("?q=a")).status).toBe(400);
    expect(mockSearchByName).not.toHaveBeenCalled();
  });

  it("returns matches for a valid fragment", async () => {
    const res = await get("?q=ada");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; people: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.people).toEqual([PERSON]);
    expect(mockSearchByName).toHaveBeenCalledWith("ada");
  });
});

describe("GET /api/directory/people — cwids mode", () => {
  it("hydrates a batch of valid cwids", async () => {
    const res = await get("?cwids=abc123,def456");
    expect(res.status).toBe(200);
    expect(mockFetchByCwid).toHaveBeenCalledWith(["abc123", "def456"]);
  });

  it("400 on an invalid cwid", async () => {
    expect((await get("?cwids=abc123,bad!cwid")).status).toBe(400);
    expect(mockFetchByCwid).not.toHaveBeenCalled();
  });

  it("400 when more than 50 cwids are requested", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `cwid${i}`).join(",");
    expect((await get(`?cwids=${many}`)).status).toBe(400);
  });
});

describe("GET /api/directory/people — failures", () => {
  it("503 when the directory is unreachable", async () => {
    mockSearchByName.mockRejectedValue(new Error("SCHOLARS_LDAP_URL is not set"));
    const res = await get("?q=ada");
    expect(res.status).toBe(503);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toBe("directory_unavailable");
  });
});
