/**
 * `GET /api/edit/effective-flags` (#1765) — the running task's effective flag
 * set. Superuser-gated on the effective identity; reports ONLY the generated
 * allowlist (never the whole env), unset flags as null, plus the build SHA.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockGetEditSession } = vi.hoisted(() => ({ mockGetEditSession: vi.fn() }));

vi.mock("@/lib/auth/superuser", () => ({
  getEditSession: vi.fn(),
  isSuperuser: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: vi.fn().mockReturnValue(false),
}));

import { GET } from "@/app/api/edit/effective-flags/route";
import { readEffectiveFlags } from "@/lib/diagnostics/effective-flags";
import { FLAG_INVENTORY } from "@/lib/diagnostics/flag-inventory.generated";

const ADMIN = { cwid: "adm001", isSuperuser: true };
const NONADMIN = { cwid: "non001", isSuperuser: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(ADMIN);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/edit/effective-flags", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("403 for a non-superuser, with no flag data in the body", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: "not_superuser" });
    expect(body.flags).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns every inventory flag (set value or null), the build SHA, and never an off-list env var", async () => {
    vi.stubEnv("MATCHA_RECENCY", "on");
    vi.stubEnv("NEXT_DEPLOYMENT_ID", "abc123");
    vi.stubEnv("DATABASE_URL", "mysql://user:pw@db/x");
    vi.stubEnv("SEARCH_TRIALS_TAB", "");
    delete process.env.SEARCH_PEOPLE_PHRASE_BOOST;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.buildSha).toBe("abc123");
    expect(Object.keys(body.flags).sort()).toEqual([...FLAG_INVENTORY].sort());
    expect(body.flags.MATCHA_RECENCY).toBe("on");
    expect(body.flags.SEARCH_PEOPLE_PHRASE_BOOST).toBeNull();
    expect(body.flags.SEARCH_TRIALS_TAB).toBe("");
    expect(JSON.stringify(body)).not.toContain("mysql://");
  });
});

describe("readEffectiveFlags", () => {
  it("reads only allowlisted names from the given env; buildSha null when unset", () => {
    const r = readEffectiveFlags({ MATCHA: "on", SECRET_THING: "x", SPS_ENV: "staging" });
    expect(r.buildSha).toBeNull();
    expect(r.spsEnv).toBe("staging");
    expect(r.flags.MATCHA).toBe("on");
    expect(r.flags).not.toHaveProperty("SECRET_THING");
  });
});

describe("FLAG_INVENTORY", () => {
  it("is a non-trivial, sorted, duplicate-free list of env-style names", () => {
    expect(FLAG_INVENTORY.length).toBeGreaterThan(50);
    expect([...FLAG_INVENTORY]).toEqual([...new Set(FLAG_INVENTORY)].sort());
    for (const n of FLAG_INVENTORY) expect(n).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("contains no secret- or infra-looking names", () => {
    const bad = FLAG_INVENTORY.filter((n) =>
      /SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|_KEY$|CREDENTIAL|PRIVATE|CWID|CIDR|DSN|DATABASE|_URL$|_ARN$|_CN$|_ALLOWLIST$|_ID$|_ENDPOINT$|^NODE_ENV$|^PORT$/.test(n),
    );
    expect(bad).toEqual([]);
  });
});
