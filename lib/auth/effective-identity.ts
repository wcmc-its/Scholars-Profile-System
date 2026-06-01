/**
 * "View as" impersonation — the effective-identity seam (#637,
 * impersonation-spec.md §2/§3, R1/R2/R6).
 *
 * The ONE place "acting as" is decided. The session cookie (`lib/auth/session.ts`)
 * carries an optional `impersonating` overlay inside the same AEAD seal; this
 * module reads it and answers the only question the rest of the app should ask:
 * *which CWID am I effectively acting as right now?* Render, data-scoping, and
 * edit authorization all read the EFFECTIVE cwid; only three call sites read the
 * real `s.cwid` directly — audit attribution, the banner, and the escalation
 * guard (spec §2).
 *
 * Auto-expiry is read-time (the security boundary, R6): an overlay older than
 * `IMPERSONATION_TTL_SECONDS` is ignored wherever `getEffectiveCwid` is read,
 * regardless of whether middleware has re-sealed it away yet. The whole feature
 * is gated by `IMPERSONATION_ENABLED` (default off) — flag-off means any overlay
 * present in a cookie is ignored entirely (spec test E5), so the feature lands
 * dark and a hand-crafted overlay on a flag-off deployment is inert.
 *
 * Node-runtime only: `getEffectiveEditSession`/`assertImpersonable` call
 * `isSuperuser` (`lib/auth/superuser.ts`), which runs a live LDAPS query. Like
 * `superuser.ts`, this module must never be pulled into the Edge middleware
 * bundle — middleware reads the overlay via `getEffectiveCwid` on a decoded
 * `SessionData`, which needs neither `next/headers` nor LDAP.
 */
import { getSession } from "@/lib/auth/session-server";
import { type SessionData, nowSeconds } from "@/lib/auth/session";
import { type EditSession, isSuperuser } from "@/lib/auth/superuser";

/**
 * Read-time impersonation TTL, seconds (#637). Default 30 min; the hard cap
 * remains the 8h cookie `exp`. Read at call time, not module load, so tests and
 * deployments can vary it without re-import.
 */
const TTL = Number(process.env.IMPERSONATION_TTL_SECONDS ?? 1800);

/** Whether the impersonation feature is enabled at all (default off). */
function impersonationEnabled(): boolean {
  return process.env.IMPERSONATION_ENABLED === "true";
}

/**
 * Whether `s` carries a *live* "view as" overlay at `now` (epoch seconds).
 * TRUE only when the feature flag is on AND the overlay exists AND it is within
 * its TTL — strict less-than, so the overlay is "down-only" in time and expires
 * exactly at `startedAt + TTL` (spec test E1). Flag-off ignores any overlay
 * (spec test E5).
 */
export function impersonationActive(s: SessionData, now: number): boolean {
  return (
    impersonationEnabled() &&
    !!s.impersonating &&
    s.impersonating.startedAt + TTL > now
  );
}

/**
 * The effective CWID: the impersonation target while the overlay is live,
 * otherwise the real signed-in CWID. The single source of truth for "who am I
 * acting as" — render, data scoping, and edit authorization all read this.
 */
export function getEffectiveCwid(s: SessionData, now = nowSeconds()): string {
  return impersonationActive(s, now) ? s.impersonating!.targetCwid : s.cwid;
}

/**
 * The effective edit session: `{ cwid, isSuperuser }` resolved for the EFFECTIVE
 * CWID (spec §3 — "you can do exactly what they can"). `null` when there is no
 * session. The `isSuperuser` verdict is the EFFECTIVE cwid's, computed live —
 * so impersonating a non-superuser strips the admin tier for the duration, as
 * intended. Initiator gating (R1) and the escalation guard (R2) read the REAL
 * cwid elsewhere; this function is deliberately about the effective identity.
 */
export async function getEffectiveEditSession(): Promise<EditSession | null> {
  const session = await getSession();
  if (!session) return null;
  const cwid = getEffectiveCwid(session);
  return { cwid, isSuperuser: await isSuperuser(cwid) };
}

/**
 * Initiator gate (R1): who may *start* impersonating. Reuses the existing
 * superuser check verbatim — no new LDAP group (spec §5). Always evaluated
 * against the REAL `session.cwid`, never the effective cwid (threat T1).
 */
export const canImpersonate = isSuperuser;

/**
 * Escalation guard, down-only (R2). A superuser may impersonate anyone who is
 * NOT themselves a superuser — `assertImpersonable` rejects a target that is a
 * superuser (`isSuperuser(targetCwid)`), blocking lateral admin→admin (strict
 * `<`, stricter than the generic spec's `≤`). The `actorCwid` is taken for
 * symmetry and future-proofing; the verdict turns only on the target's tier.
 */
export async function assertImpersonable(
  actorCwid: string,
  targetCwid: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (await isSuperuser(targetCwid)) {
    return { ok: false, reason: "target_is_superuser" };
  }
  return { ok: true };
}
