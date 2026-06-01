/**
 * #637 — "View as" impersonation test helper (impersonation-spec.md §9).
 *
 * The one place the role × route matrix and the edge-case suite (E1–E10) mint
 * an impersonating `SessionData`. It feeds the *same* identity-resolution seam
 * the running app uses (`lib/auth/effective-identity.ts` reads the overlay this
 * sets), so a test proves exactly what a real session renders — no parallel
 * "test identity" abstraction that could drift from production behaviour.
 *
 * Everything here is a frozen literal: `NOW` is a fixed epoch-seconds constant,
 * never a live clock read. Tests that exercise the read-time TTL (E1) pass an
 * explicit `now` into `getEffectiveCwid`/`impersonationActive` rather than
 * advancing wall-clock time, so the fixtures stay deterministic across runs.
 *
 * This file lives under `tests/util/` (not `tests/unit/`), so the vitest
 * `include` glob (`tests/unit/**`) never collects it as a spec — it is a
 * reusable helper, not a test.
 */
import type { SessionData } from "@/lib/auth/session";

/**
 * The real SAML subject behind every impersonating session built here — a
 * stand-in superuser. This is the cwid that authorization on the *initiator*
 * (R1 `isSuperuser`, the escalation guard R2) and the audit attribution
 * (`actor_cwid` — always the real human, never the target) must read. `cwid`
 * stays this value in every `sessionAs(...)` result; only the overlay's
 * `targetCwid` is the impersonated identity.
 */
export const SUPERUSER_FIXTURE = "super0001";

/**
 * A fixed point in time, epoch seconds — `2026-06-01T00:00:00Z`. All fixture
 * `iat`/`exp`/`startedAt` stamps derive from this literal so digests, expiry
 * windows, and the read-time TTL are reproducible. Never read a live clock in
 * a fixture; tests that need "later" do `NOW + IMPERSONATION_TTL_SECONDS + 1`.
 */
export const NOW = 1_780_272_000;

/**
 * Build an impersonating `SessionData`: a superuser (`SUPERUSER_FIXTURE`)
 * viewing/acting as `targetCwid`, with a one-hour cookie window from `NOW`.
 *
 * `over` shallow-overrides the result *after* the overlay is set, so a test can
 * drop the overlay (`sessionAs(cwid, { impersonating: undefined })` → a plain
 * superuser session) or age it (`sessionAs(cwid, { impersonating: { targetCwid,
 * startedAt: NOW - 7200 } })` for the E1 stale-overlay case) without a second
 * builder.
 */
export function sessionAs(
  targetCwid: string,
  over: Partial<SessionData> = {},
): SessionData {
  return {
    cwid: SUPERUSER_FIXTURE,
    iat: NOW,
    exp: NOW + 3600,
    impersonating: { targetCwid, startedAt: NOW },
    ...over,
  };
}

/**
 * Representative target cwids, one per role label the switcher and the role ×
 * route matrix enumerate (impersonation-spec.md §8 chips: All · Owner · Curator
 * · Scholar · Public). The matrix iterates these as
 * `authorizeForRoute(sessionAs(fixture), route) === route.expected[role]`.
 *
 * `superuser` is included for the down-only escalation-guard cases (E4 / R2):
 * impersonating it must be rejected, so the guard tests need a target the
 * `isSuperuser` mock reports `true` for. It is intentionally NOT a switcher
 * chip — superusers are server-pre-filtered out of `/candidates`.
 *
 * Kept deliberately minimal: add a fixture only when a new role appears in the
 * route matrix, not speculatively.
 */
export const ROLE_FIXTURES = {
  /** Unit Owner — read+write+grant on their unit subtree (#358/#540). */
  owner: "owner001",
  /** Unit Curator — read+write on their unit, no grants (#358/#540). */
  curator: "curat001",
  /** A plain scholar — self-only edits (their own `overview`); the E3 target. */
  scholar: "schol001",
  /** No session / unauthenticated "public view" target — carries no unit data. */
  public: "public01",
  /** A superuser target — only ever a *rejected* impersonation (R2 / E4). */
  superuser: "super0002",
} as const;

/** A role label from {@link ROLE_FIXTURES} — the matrix's row key. */
export type RoleFixtureLabel = keyof typeof ROLE_FIXTURES;
