/**
 * GET /api/edit/method-families: the family picker's source. The candidate
 * loader is mocked (its own visibility gate has its own tests); the session,
 * the grant lookup and the flags are driven per test. Made-up values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  session: vi.fn(),
  unitAdminFindFirst: vi.fn(),
  candidates: vi.fn(),
  logEditDenial: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: m.session }));
vi.mock("@/lib/api/search", () => ({ loadMethodFamilyCandidates: m.candidates }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: m.logEditDenial }));
vi.mock("@/lib/db", () => ({ db: { read: { unitAdmin: { findFirst: m.unitAdminFindFirst } } } }));

import { GET } from "@/app/api/edit/method-families/route";

const get = (q?: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/edit/method-families${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`,
    ),
  );

const NOBODY = { cwid: "act0001", isSuperuser: false, isCommsSteward: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("METHOD_SERVICES", "on");
  vi.stubEnv("METHODS_LENS_PAGES", "on");
  vi.stubEnv("METHODS_LENS_ENABLED", "on");
  m.session.mockResolvedValue({ ...NOBODY, isSuperuser: true });
  m.unitAdminFindFirst.mockResolvedValue(null);
  m.candidates.mockResolvedValue([
    { supercategory: "evidence_synthesis", familyId: "fam_0001", familyLabel: "Example review methods", scholarCount: 12 },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/edit/method-families", () => {
  it.each(["METHOD_SERVICES", "METHODS_LENS_PAGES", "METHODS_LENS_ENABLED"])(
    "404s when %s is off",
    async (flag) => {
      vi.stubEnv(flag, "off");
      const res = await get("review");
      expect(res.status).toBe(404);
      expect(m.session).not.toHaveBeenCalled();
      expect(m.candidates).not.toHaveBeenCalled();
    },
  );

  it("401s with no session", async () => {
    m.session.mockResolvedValue(null);
    expect((await get("review")).status).toBe(401);
    expect(m.candidates).not.toHaveBeenCalled();
  });

  it("403s a signed-in user with no unit to edit, and logs the denial", async () => {
    m.session.mockResolvedValue(NOBODY);
    const res = await get("review");
    expect(res.status).toBe(403);
    expect(m.unitAdminFindFirst).toHaveBeenCalledWith({
      where: { cwid: "act0001" },
      select: { cwid: true },
    });
    expect(m.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: "act0001", path: "/api/edit/method-families" }),
    );
    expect(m.candidates).not.toHaveBeenCalled();
  });

  it("admits anyone holding a unit grant", async () => {
    m.session.mockResolvedValue(NOBODY);
    m.unitAdminFindFirst.mockResolvedValue({ cwid: "act0001" });
    expect((await get("review")).status).toBe(200);
  });

  it.each([{ isSuperuser: true }, { isCommsSteward: true }, { isContentEditor: true }, { isCoreDirector: true }])(
    "admits %o without a grant lookup",
    async (flags) => {
      m.session.mockResolvedValue({ ...NOBODY, ...flags });
      expect((await get("review")).status).toBe(200);
      expect(m.unitAdminFindFirst).not.toHaveBeenCalled();
    },
  );

  it("does not admit an observer on the strength of the read-only steward view", async () => {
    // getEffectiveEditSession hands an observer a synthetic isCommsSteward.
    m.session.mockResolvedValue({ ...NOBODY, isObserver: true, isCommsSteward: true });
    expect((await get("review")).status).toBe(403);
  });

  it("returns the picker rows with the supercategory's label, uncached", async () => {
    const res = await get("  review ");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(m.candidates).toHaveBeenCalledWith("review", 10);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      families: [
        {
          supercategory: "evidence_synthesis",
          supercategoryLabel: expect.any(String),
          familyLabel: "Example review methods",
          scholarCount: 12,
        },
      ],
    });
    expect(body.families[0].supercategoryLabel.length).toBeGreaterThan(0);
  });

  it("never returns more than 10", async () => {
    m.candidates.mockResolvedValue(
      Array.from({ length: 14 }, (_, i) => ({
        supercategory: "s",
        familyId: `fam_${i}`,
        familyLabel: `Family ${i}`,
        scholarCount: i,
      })),
    );
    expect((await (await get("fam")).json()).families).toHaveLength(10);
  });

  it("answers an empty list for a missing or one-character query without searching", async () => {
    for (const q of [undefined, "", " a "]) {
      const res = await get(q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, families: [] });
    }
    expect(m.candidates).not.toHaveBeenCalled();
  });

  it("400s an over-long query", async () => {
    expect((await get("x".repeat(101))).status).toBe(400);
    expect(m.candidates).not.toHaveBeenCalled();
  });
});
