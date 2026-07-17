/**
 * #637 — "View as" impersonation: the effective-identity seam + role × route
 * matrix (impersonation-spec.md §2/§3/§9, edge cases E1/E3/E4/E5/E9).
 *
 * This suite proves the one decision the whole feature turns on — *which CWID am
 * I effectively acting as right now* — and that the read-time TTL (E1), the flag
 * gate (E5), the AEAD seal round-trip, and a tampered seal (E9) all behave. The
 * fixtures come from `@/tests/util/session-as`, so the tests feed the *same*
 * seam the running app reads; there is no parallel "test identity" that could
 * drift from production behaviour.
 *
 * The role × route matrix (§9) is built from the REAL authorization predicates
 * in `lib/edit/authz.ts` driven by the EFFECTIVE `EditSession` — exactly the
 * §3 contract ("edit authorization reads the effective identity"). The SPEC's
 * `authorizeForRoute` helper does not yet exist in the tree, so the matrix uses
 * the live predicates directly (the documented §9 fallback); the load-bearing
 * unlock it proves is E3: a superuser impersonating a scholar edits that
 * scholar's `overview` AS the scholar (the override + audit attribute the
 * scholar's identity). Since #844 a superuser may also edit any `overview`
 * directly (attributed to the admin) — impersonation is no longer the only path.
 *
 * `IMPERSONATION_ENABLED` / `IMPERSONATION_TTL_SECONDS` are read at call time by
 * `effective-identity.ts`, so each block sets exactly the env it needs and
 * restores it after — the feature is inert unless a test opts in (E5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two Node-only boundaries so the seam runs without an LDAP server or
// next/headers: the directory (`isSuperuser` membership) and B01's session
// reader (`getSession`, behind `getEffectiveEditSession`). Same shape the
// existing auth/superuser suite uses.
vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(),
}));

import {
  assertImpersonable,
  canImpersonate,
  getEffectiveCwid,
  getEffectiveEditSession,
  impersonationActive,
} from "@/lib/auth/effective-identity";
import { isSuperuser, type EditSession } from "@/lib/auth/superuser";
import {
  readSessionValue,
  withImpersonation,
  withoutImpersonation,
  type SessionData,
} from "@/lib/auth/session";
import { authorizeFieldEdit } from "@/lib/edit/authz";
import { openLdap } from "@/lib/sources/ldap";
import { getSession } from "@/lib/auth/session-server";
import {
  NOW,
  ROLE_FIXTURES,
  SUPERUSER_FIXTURE,
  sessionAs,
  type RoleFixtureLabel,
} from "@/tests/util/session-as";

const GROUP_CN = "ITS:Library:Scholars/superuser-role";
const TTL = 1800; // pinned for exact NOW+TTL fixture arithmetic (independent of the runtime default, now 3600)
const SECRET = "test-session-secret-0123456789-0123456789";

const mockedOpenLdap = vi.mocked(openLdap);
const mockedGetSession = vi.mocked(getSession);

// ---------------------------------------------------------------------------
// LDAP test doubles — mirror auth-superuser.test.ts so `isSuperuser` resolves
// from a scripted group search rather than a live directory.
// ---------------------------------------------------------------------------

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;
type CompareImpl = (dn: string, attr: string, value: string) => Promise<boolean>;

function fakeClient(search: SearchImpl, compare: CompareImpl) {
  return {
    search: vi.fn(search),
    compare: vi.fn(compare),
    unbind: vi.fn(async (): Promise<void> => {}),
  };
}

function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}

const GROUP_DN = `cn=${GROUP_CN},ou=application security,ou=Groups,dc=weill,dc=cornell,dc=edu`;

/**
 * Script `isSuperuser` so it reports `true` for exactly the CWIDs in
 * `superusers`. Mirrors the real two-step protocol: the search resolves the group
 * DN by `cn` (it carries no cwid), and the `compare` assertion value is the member
 * DN `uid=<cwid>,…`, so the double parses the cwid out of *that* to decide.
 */
function ldapReturnsSuperusersFor(superusers: Set<string>) {
  mockedOpenLdap.mockResolvedValue(
    asClient(
      fakeClient(
        async () => ({ searchEntries: [{ cn: GROUP_CN, dn: GROUP_DN }] }),
        async (_dn, _attr, value) => {
          const cwid = value.match(/^uid=([^,]+),/)?.[1] ?? "";
          return superusers.has(cwid);
        },
      ),
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SCHOLARS_SUPERUSER_GROUP_CN = GROUP_CN;
  process.env.SESSION_COOKIE_SECRET = SECRET;
  process.env.SESSION_COOKIE_SECURE = "false";
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  // Default the feature ON for the seam tests; the E5 block flips it off
  // explicitly. TTL pinned so `NOW + TTL` arithmetic in fixtures is exact.
  process.env.IMPERSONATION_ENABLED = "true";
  process.env.IMPERSONATION_TTL_SECONDS = String(TTL);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.IMPERSONATION_ENABLED;
  delete process.env.IMPERSONATION_TTL_SECONDS;
});

// ---------------------------------------------------------------------------
// impersonationActive / getEffectiveCwid — the read-time seam
// ---------------------------------------------------------------------------

describe("getEffectiveCwid / impersonationActive — the seam", () => {
  it("resolves the target while the overlay is live (basic active case)", () => {
    const s = sessionAs("targ001");
    expect(impersonationActive(s, NOW)).toBe(true);
    expect(getEffectiveCwid(s, NOW)).toBe("targ001");
  });

  it("falls back to the real cwid when there is no overlay", () => {
    const s = sessionAs("targ001", { impersonating: undefined });
    expect(impersonationActive(s, NOW)).toBe(false);
    expect(getEffectiveCwid(s, NOW)).toBe(SUPERUSER_FIXTURE);
  });

  it("E1 — an overlay older than the TTL is ignored; the effective cwid is the real one", () => {
    // `startedAt` is NOW; advance the read clock just past the TTL boundary.
    const s = sessionAs("targ001");
    const justExpired = NOW + TTL; // startedAt + TTL > now is strict — equal = expired
    expect(impersonationActive(s, justExpired)).toBe(false);
    expect(getEffectiveCwid(s, justExpired)).toBe(SUPERUSER_FIXTURE);

    const wellPast = NOW + TTL + 1;
    expect(impersonationActive(s, wellPast)).toBe(false);
    expect(getEffectiveCwid(s, wellPast)).toBe(SUPERUSER_FIXTURE);
  });

  it("is live right up to — but not including — the TTL boundary", () => {
    const s = sessionAs("targ001");
    expect(impersonationActive(s, NOW + TTL - 1)).toBe(true);
    expect(getEffectiveCwid(s, NOW + TTL - 1)).toBe("targ001");
  });

  it("E5 — with the flag off, a hand-crafted overlay is ignored entirely", () => {
    process.env.IMPERSONATION_ENABLED = "false";
    const s = sessionAs("targ001");
    expect(impersonationActive(s, NOW)).toBe(false);
    expect(getEffectiveCwid(s, NOW)).toBe(SUPERUSER_FIXTURE);

    // An unset flag is also off — never the string "true".
    delete process.env.IMPERSONATION_ENABLED;
    expect(impersonationActive(s, NOW)).toBe(false);
    expect(getEffectiveCwid(s, NOW)).toBe(SUPERUSER_FIXTURE);
  });
});

// ---------------------------------------------------------------------------
// AEAD seal round-trip — the overlay rides inside the same seal as `cwid`
// (impersonation-spec.md §2; spec tests E7/E8/E9)
// ---------------------------------------------------------------------------

describe("withImpersonation / withoutImpersonation round-trip", () => {
  // `reseal` and `readSessionValue` read the live clock (the seal `ttl`/`maxAge`
  // are derived from `exp - nowSeconds()`, and `readSessionValue` enforces the
  // `exp <= nowSeconds()` cap). Pin the clock to `NOW` so the fixture's
  // `exp: NOW + 3600` window is a fixed hour in the future regardless of the
  // real wall-clock — otherwise the round-trip flakes once real time passes the
  // fixture epoch. Fake ONLY `Date` (not the timer queue), so the real
  // microtask/timer scheduling iron-session's async crypto relies on is left
  // intact while `nowSeconds()` reads the pinned epoch.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seals an overlay that survives readSessionValue, preserving the real identity and window", async () => {
    const base: SessionData = { cwid: SUPERUSER_FIXTURE, iat: NOW, exp: NOW + 3600 };
    const cookie = await withImpersonation(base, "targ001");

    const decoded = await readSessionValue(cookie.value);
    expect(decoded).not.toBeNull();
    expect(decoded!.cwid).toBe(SUPERUSER_FIXTURE); // real subject NEVER mutated
    expect(decoded!.exp).toBe(base.exp); // window preserved — no extension
    expect(decoded!.iat).toBe(base.iat);
    expect(decoded!.impersonating?.targetCwid).toBe("targ001");
    expect(typeof decoded!.impersonating?.startedAt).toBe("number");

    // And the seam reads the overlay straight off the decoded session.
    expect(getEffectiveCwid(decoded!, decoded!.impersonating!.startedAt)).toBe("targ001");
  });

  it("drops the overlay on withoutImpersonation, leaving a plain session", async () => {
    const base: SessionData = { cwid: SUPERUSER_FIXTURE, iat: NOW, exp: NOW + 3600 };
    const impersonating = await readSessionValue(
      (await withImpersonation(base, "targ001")).value,
    );
    expect(impersonating!.impersonating).toBeDefined();

    const cleared = await readSessionValue(
      (await withoutImpersonation(impersonating!)).value,
    );
    expect(cleared).not.toBeNull();
    expect(cleared!.cwid).toBe(SUPERUSER_FIXTURE);
    expect(cleared!.impersonating).toBeUndefined();
    expect(getEffectiveCwid(cleared!, NOW)).toBe(SUPERUSER_FIXTURE);
  });

  it("E9 — a tampered seal unseals to null (the overlay is unforgeable)", async () => {
    const base: SessionData = { cwid: SUPERUSER_FIXTURE, iat: NOW, exp: NOW + 3600 };
    const cookie = await withImpersonation(base, "targ001");
    const tampered = cookie.value.slice(0, -4) + "AAAA";
    expect(await readSessionValue(tampered)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertImpersonable — the down-only escalation guard, R2 (spec test E4)
// ---------------------------------------------------------------------------

describe("assertImpersonable — R2 down-only escalation guard", () => {
  it("E4 — rejects a target that is itself a superuser, with the stable reason", async () => {
    ldapReturnsSuperusersFor(new Set([ROLE_FIXTURES.superuser]));
    expect(await assertImpersonable(SUPERUSER_FIXTURE, ROLE_FIXTURES.superuser)).toEqual({
      ok: false,
      reason: "target_is_superuser",
    });
  });

  it("permits a non-superuser target", async () => {
    ldapReturnsSuperusersFor(new Set([SUPERUSER_FIXTURE]));
    expect(await assertImpersonable(SUPERUSER_FIXTURE, ROLE_FIXTURES.scholar)).toEqual({
      ok: true,
    });
  });

  it("turns on the TARGET's tier, never the actor's", async () => {
    // Actor is a superuser (as every initiator is); the verdict still rides on
    // the target — a non-superuser target is allowed even when the actor is one.
    ldapReturnsSuperusersFor(new Set([SUPERUSER_FIXTURE]));
    expect(await assertImpersonable(SUPERUSER_FIXTURE, ROLE_FIXTURES.owner)).toEqual({
      ok: true,
    });
  });

  it("exposes canImpersonate as the live isSuperuser check (R1)", () => {
    // R1 reuses isSuperuser verbatim — a defensive identity assertion so a
    // refactor that breaks the alias is caught here.
    expect(canImpersonate).toBe(isSuperuser);
  });
});

// ---------------------------------------------------------------------------
// getEffectiveEditSession — resolves {cwid, isSuperuser} for the EFFECTIVE cwid
// (impersonation-spec.md §3 — "you can do exactly what they can")
// ---------------------------------------------------------------------------

describe("getEffectiveEditSession", () => {
  // `getEffectiveEditSession` reads the live clock (default `now` arg), so pin
  // it to `NOW` for the TTL cases — fixtures stamp `startedAt` off `NOW`.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    expect(await getEffectiveEditSession()).toBeNull();
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("resolves the EFFECTIVE (target) cwid and strips the admin tier while impersonating", async () => {
    // The session is a superuser impersonating a plain scholar; the effective
    // session must be the SCHOLAR's, with the scholar's (non-)superuser verdict.
    mockedGetSession.mockResolvedValue(sessionAs(ROLE_FIXTURES.scholar));
    ldapReturnsSuperusersFor(new Set([SUPERUSER_FIXTURE])); // only the real actor is a superuser
    expect(await getEffectiveEditSession()).toEqual({
      cwid: ROLE_FIXTURES.scholar,
      isSuperuser: false,
      isCommsSteward: false,
      isDeveloper: false,
      isHonorsCurator: false,
    });
  });

  it("resolves the real cwid when the overlay has expired (read-time TTL)", async () => {
    // Overlay aged out: effective identity collapses back to the real superuser.
    mockedGetSession.mockResolvedValue(
      sessionAs(ROLE_FIXTURES.scholar, {
        impersonating: { targetCwid: ROLE_FIXTURES.scholar, startedAt: NOW - TTL - 1 },
      }),
    );
    ldapReturnsSuperusersFor(new Set([SUPERUSER_FIXTURE]));
    expect(await getEffectiveEditSession()).toEqual({
      cwid: SUPERUSER_FIXTURE,
      isSuperuser: true,
      isCommsSteward: false,
      isDeveloper: false,
      isHonorsCurator: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Role × route authorization matrix  (impersonation-spec.md §9)
//
// Built from the REAL predicate (`authorizeFieldEdit`) driven by the EFFECTIVE
// EditSession. The matrix asserts that an impersonating superuser acts with
// *exactly the target's* permissions on the canonical self-only field
// (`overview`): the impersonated scholar may edit their own overview, and may
// not edit anyone else's — the superuser's own admin tier is gone for the
// duration. This is the §3 read/write split made testable.
// ---------------------------------------------------------------------------

/**
 * The effective `EditSession` a route handler would compute for a given role
 * fixture, with `isSuperuser` resolved for the EFFECTIVE cwid. None of the
 * switcher-chip roles (owner/curator/scholar/public) is a superuser — superuser
 * targets are R2-rejected before any session is minted.
 */
function effectiveSessionFor(role: RoleFixtureLabel): EditSession {
  return { cwid: ROLE_FIXTURES[role], isSuperuser: false, isCommsSteward: false, isDeveloper: false };
}

describe("role × route matrix — overview edit authorization on the effective identity", () => {
  const SWITCHER_ROLES: RoleFixtureLabel[] = ["owner", "curator", "scholar", "public"];

  it.each(SWITCHER_ROLES)(
    "an impersonated %s may edit their OWN overview (acts as the target)",
    (role) => {
      const effective = effectiveSessionFor(role);
      expect(
        authorizeFieldEdit(effective, { entityId: effective.cwid, fieldName: "overview" }),
      ).toEqual({ ok: true });
    },
  );

  it.each(SWITCHER_ROLES)(
    "an impersonated %s may NOT edit a different scholar's overview",
    (role) => {
      const effective = effectiveSessionFor(role);
      expect(
        authorizeFieldEdit(effective, { entityId: "someone-else", fieldName: "overview" }),
      ).toEqual({ ok: false, reason: "not_self" });
    },
  );

  it("E3 — a superuser impersonating a scholar CAN edit that scholar's overview", () => {
    // The unlock: the effective session is the scholar's (self), so the `overview`
    // predicate ALLOWS it via the self branch — the edit is made AS the scholar.
    const effective: EditSession = { cwid: ROLE_FIXTURES.scholar, isSuperuser: false, isCommsSteward: false, isDeveloper: false };
    expect(
      authorizeFieldEdit(effective, {
        entityId: ROLE_FIXTURES.scholar,
        fieldName: "overview",
      }),
    ).toEqual({ ok: true });
  });

  it("#844 — a superuser acting as THEMSELVES may NOW edit another scholar's overview directly", () => {
    // #844 widened `overview` to self-OR-superuser. The same superuser, NOT
    // impersonating, can edit the bio directly — the audit attributes the
    // superuser (no impersonated_cwid). Impersonation (E3 above) is no longer the
    // ONLY path; its distinct effect is attributing the edit to the scholar's
    // identity rather than the admin's.
    const real: EditSession = { cwid: SUPERUSER_FIXTURE, isSuperuser: true, isCommsSteward: false, isDeveloper: false };
    expect(
      authorizeFieldEdit(real, { entityId: ROLE_FIXTURES.scholar, fieldName: "overview" }),
    ).toEqual({ ok: true });
  });
});
