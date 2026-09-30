/**
 * The observer's read-only steward view as pure session transforms
 * (`lib/auth/observer.ts` explains the role). Kept dependency-free so the write
 * preamble (`lib/edit/request.ts`) and pages can import it without pulling in
 * LDAP, and route tests that mock `@/lib/auth/superuser` don't have to stub it.
 */
import type { EditSession } from "@/lib/auth/superuser";

/**
 * Apply the observer's read-only steward view. A real superuser/steward is
 * left untouched (observer never narrows or re-labels an existing grant).
 */
export function withObserverView(session: EditSession, observer: boolean): EditSession {
  if (!observer || session.isSuperuser || session.isCommsSteward) return session;
  return { ...session, isCommsSteward: true, isObserver: true };
}

/** Undo {@link withObserverView} — the session a WRITE must authorize against. */
export function stripObserverView(session: EditSession): EditSession {
  if (!session.isObserver) return session;
  return { ...session, isCommsSteward: false, isObserver: false };
}
