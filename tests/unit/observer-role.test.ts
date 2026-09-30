import { globSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetEffectiveEditSession, mockGetSession, mockImpersonationActive, mockIsSuperuser } =
  vi.hoisted(() => ({
    mockGetEffectiveEditSession: vi.fn(),
    mockGetSession: vi.fn(),
    mockImpersonationActive: vi.fn(),
    mockIsSuperuser: vi.fn(),
  }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: mockIsSuperuser }));

import { isObserver } from "@/lib/auth/observer";
import { stripObserverView, withObserverView } from "@/lib/auth/observer-view";
import { resolveEditIdentityForWrite } from "@/lib/edit/request";

const plain = { cwid: "obs01", isSuperuser: false, isCommsSteward: false };

describe("withObserverView / stripObserverView", () => {
  it("gives a plain observer a flagged, synthetic steward read view", () => {
    expect(withObserverView(plain, true)).toEqual({ ...plain, isCommsSteward: true, isObserver: true });
  });

  it("leaves non-observers and real superusers/stewards untouched", () => {
    expect(withObserverView(plain, false)).toBe(plain);
    const su = { ...plain, isSuperuser: true };
    expect(withObserverView(su, true)).toBe(su);
    const cs = { ...plain, isCommsSteward: true };
    expect(withObserverView(cs, true)).toBe(cs);
  });

  it("strip undoes the synthetic grant and nothing else", () => {
    expect(stripObserverView(withObserverView(plain, true))).toEqual({
      ...plain,
      isCommsSteward: false,
      isObserver: false,
    });
    const cs = { ...plain, isCommsSteward: true };
    expect(stripObserverView(cs)).toBe(cs);
  });
});

describe("isObserver", () => {
  it("is dormant unless OBSERVER_ENABLED is exactly 'on' and a group cn is set", async () => {
    vi.stubEnv("OBSERVER_ENABLED", "off");
    vi.stubEnv("SCHOLARS_OBSERVER_GROUP_CN", "ITS:Library:Scholars/observer-role");
    expect(await isObserver("obs01")).toBe(false);
    vi.stubEnv("OBSERVER_ENABLED", "on");
    vi.stubEnv("SCHOLARS_OBSERVER_GROUP_CN", "");
    expect(await isObserver("obs02")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("resolveEditIdentityForWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ cwid: "obs01", iat: 0, exp: 0 });
    mockImpersonationActive.mockReturnValue(false);
    mockIsSuperuser.mockResolvedValue(false);
  });

  it("strips the observer's synthetic steward grant before any write predicate", async () => {
    mockGetEffectiveEditSession.mockResolvedValue(withObserverView(plain, true));
    const r = await resolveEditIdentityForWrite();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id.session.isCommsSteward).toBe(false);
      expect(r.id.session.isObserver).toBe(false);
    }
  });

  it("refuses every write under a View-as overlay a non-superuser started", async () => {
    mockGetSession.mockResolvedValue({
      cwid: "obs01",
      iat: 0,
      exp: 0,
      impersonating: { targetCwid: "cur01", startedAt: 0 },
    });
    mockImpersonationActive.mockReturnValue(true);
    // The effective session is the TARGET's (a curator with real write rights).
    mockGetEffectiveEditSession.mockResolvedValue({ cwid: "cur01", isSuperuser: false });
    const r = await resolveEditIdentityForWrite();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toMatchObject({ error: "impersonation_readonly" });
    }
    expect(mockIsSuperuser).toHaveBeenCalledWith("obs01");
  });

  it("still lets a superuser write under View as (edit-enabled default)", async () => {
    mockGetSession.mockResolvedValue({
      cwid: "su01",
      iat: 0,
      exp: 0,
      impersonating: { targetCwid: "cur01", startedAt: 0 },
    });
    mockImpersonationActive.mockReturnValue(true);
    mockIsSuperuser.mockResolvedValue(true);
    mockGetEffectiveEditSession.mockResolvedValue({ cwid: "cur01", isSuperuser: false });
    const r = await resolveEditIdentityForWrite();
    expect(r.ok).toBe(true);
  });
});

/**
 * Gate: every mutating `/api/edit/*` handler must resolve its identity through
 * the write path (`readEditRequest` or `resolveEditIdentityForWrite`), or the
 * observer's synthetic steward grant would authorize a write. A re-export
 * (`export { POST } from "../x/route"`) is followed to its source.
 */
describe("observer write gate: every mutating /api/edit route uses the write resolver", () => {
  const MUTATING = /export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/;
  const REEXPORT = /export\s*\{[^}]*\b(POST|PUT|PATCH|DELETE)\b[^}]*\}\s*from\s*"([^"]+)"/;
  const WRITE_PATH = /\b(readEditRequest|resolveEditIdentityForWrite)\b/;
  const files = globSync("app/api/edit/**/route.ts");

  it("finds the route files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)("%s", (file) => {
    const src = readFileSync(file, "utf8");
    const re = src.match(REEXPORT);
    if (re) {
      const target = new URL(`${re[2]}.ts`, `file://${process.cwd()}/${file}`).pathname;
      expect(WRITE_PATH.test(readFileSync(target, "utf8"))).toBe(true);
      return;
    }
    if (!MUTATING.test(src)) return;
    expect(WRITE_PATH.test(src)).toBe(true);
  });
});
