/**
 * The synthetic steward READ views as pure session transforms: the observer's
 * read-only one (`lib/auth/observer.ts`) and the content editor's
 * (`lib/auth/content-editor.ts`). Kept dependency-free so the write
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

/**
 * Apply the content editor's steward READ view (`lib/auth/content-editor.ts`).
 * A real superuser/steward is left untouched: either already does everything a
 * content editor does, so `isContentEditor` is set only alongside the
 * synthetic grant. Apply it BEFORE {@link withObserverView}, which then leaves
 * a content editor who is also an observer editable rather than view-only.
 */
export function withContentEditorView(session: EditSession, contentEditor: boolean): EditSession {
  if (!contentEditor || session.isSuperuser || session.isCommsSteward) return session;
  return { ...session, isCommsSteward: true, isContentEditor: true };
}

/**
 * Undo the synthetic grant of {@link withContentEditorView} for a WRITE, but
 * KEEP `isContentEditor`: the write predicates that allow a content editor
 * name that flag, and every other steward write is refused.
 */
export function stripContentEditorView(session: EditSession): EditSession {
  if (!session.isContentEditor) return session;
  return { ...session, isCommsSteward: false };
}
