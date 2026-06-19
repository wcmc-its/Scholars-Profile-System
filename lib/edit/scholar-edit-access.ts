/**
 * Shared scholar-editor authorization resolver (#955 finding #11 fast-follow).
 *
 * The scholar editor (`app/edit/scholar/[cwid]/page.tsx`) and its read-only
 * audit sibling (`app/edit/scholar/[cwid]/history/page.tsx`) gate on exactly the
 * same rule: **history visibility == edit access**. Both previously inlined the
 * identical five-gate sequence with a "keep this in sync" comment; this resolver
 * is that single source of truth.
 *
 * Five gates run in order, short-circuiting on the first that resolves:
 *
 *   1. **No raw session** → SAML-login redirect carrying the requested URL as
 *      `?return=` so the user lands back here after sign-in. The login gate keys
 *      on the RAW signed-in human (`getSession`), never the impersonation
 *      overlay (invariant 4).
 *   2. **`session.cwid === targetCwid`** → self.
 *   3. **Granted, conflict-free proxy** (#779 / scholar-proxy-spec.md) → proxy.
 *   4. **Org-unit administrator** of a unit the scholar belongs to (Amendment 4
 *      / scholar-proxy-unit-admin-amendment.md) → unit-admin; the conferring
 *      unit is returned so the editor can resolve its display name for the
 *      "via {unit} administrator" banner.
 *   5. **comms_steward / superuser** → authorized; anyone else → a logged 403.
 *
 * Authorization identity resolves via the EFFECTIVE seam
 * (`getEffectiveEditSession`), mirroring the write path: while impersonating
 * target T, `session.cwid` is T and `session.isSuperuser` re-derives from T, so
 * `/edit/scholar/T` is self and `/edit/scholar/U` (U≠T) 403s (#637). The proxy
 * and unit-admin gates are keyed on the RAW identity and run only when NOT
 * impersonating (`raw.cwid === session.cwid`) — a "View as" overlay must never
 * confer either path (IS-1). Neither a proxy nor a unit admin is a superuser, so
 * both remain subject to each caller's soft-deleted-404 and #536 hidden-class-404
 * guards — which stay in the callers because they derive role/deletion from data
 * the editor already loads (`loadEditContext`) and the history page reads on its
 * own, so folding them in here would add a redundant query to the editor.
 *
 * The resolver returns a verdict rather than calling `redirect()` / `notFound()`
 * / rendering JSX itself, so it stays a pure (testable) lib function and each
 * route keeps control of its own navigation and render.
 */
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getSession } from "@/lib/auth/session-server";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import {
  resolveEditableUnitViaUnitAdmin,
  type EditableUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

/**
 * The resolver's verdict:
 *   - `redirect` — send the browser to `to` (SAML login with `?return=`).
 *   - `forbidden` — render the visible 403; the denial line is already logged.
 *   - `authorized` — the actor may edit (and thus view the history of) the
 *     scholar. `unit` is the conferring org unit when (and only when)
 *     `isUnitAdmin`, for the editor's banner.
 */
export type ScholarEditAccess =
  | { kind: "redirect"; to: string }
  | { kind: "forbidden" }
  | {
      kind: "authorized";
      session: EditSession;
      isSelf: boolean;
      isProxy: boolean;
      isUnitAdmin: boolean;
      unit: EditableUnit | null;
    };

/**
 * Resolve who may edit `targetCwid`'s profile.
 *
 * `pathSuffix` distinguishes the sibling routes so the `?return=` redirect and
 * the `edit_authz_denied` log path match each route exactly: `""` for the
 * editor (`/edit/scholar/[cwid]`), `"/history"` for the audit view. The cwid is
 * URL-encoded in the redirect target but left raw in the log path, mirroring the
 * pre-extraction behavior of both routes verbatim.
 */
export async function resolveScholarEditAccess(
  targetCwid: string,
  pathSuffix: "" | "/history" = "",
): Promise<ScholarEditAccess> {
  const loginRedirect: ScholarEditAccess = {
    kind: "redirect",
    to: `/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}${pathSuffix}`,
  };

  // Gate 1 — login. Keys on the RAW signed-in human, never the overlay.
  const raw = await getSession();
  if (!raw) return loginRedirect;

  const session = await getEffectiveEditSession();
  // Defensive — `raw` is already non-null, so this branch is unreachable.
  if (!session) return loginRedirect;

  // Gate 2 — self.
  const isSelf = session.cwid === targetCwid;

  // Gate 3 — granted, conflict-free proxy (#779). RAW-keyed, not-impersonating.
  let isProxy = false;
  if (!isSelf && !session.isSuperuser && raw.cwid === session.cwid) {
    if (await isGrantedProxy(raw.cwid, targetCwid, db.read as unknown as ProxyLookup)) {
      const conflict = await checkProxyConflictingRole(
        raw.cwid,
        db.read as unknown as ProxyLookup,
        // Reuse the live verdict already resolved for this (non-impersonating)
        // cwid instead of a second LDAPS round-trip.
        async () => session.isSuperuser,
      );
      isProxy = conflict.ok;
    }
  }

  // Gate 4 — org-unit administrator (Amendment 4). RAW-keyed, not-impersonating,
  // not already self/proxy. The conferring unit feeds the editor's banner.
  let isUnitAdmin = false;
  let unit: EditableUnit | null = null;
  if (!isSelf && !isProxy && !session.isSuperuser && raw.cwid === session.cwid) {
    const resolved = await resolveEditableUnitViaUnitAdmin(
      raw.cwid,
      targetCwid,
      db.read as unknown as UnitScholarLookup,
    );
    if (resolved) {
      isUnitAdmin = true;
      unit = resolved;
    }
  }

  // Gate 5 — comms_steward / superuser / deny. The GET-time superuser re-check
  // emits one `edit_authz_denied` line (reason="not_superuser_get") so
  // mid-session deauthorisation (SPEC edge case 15) is logged.
  if (!isSelf && !isProxy && !isUnitAdmin && !session.isCommsSteward) {
    const denial = requireSuperuserGet({
      session,
      path: `/edit/scholar/${targetCwid}${pathSuffix}`,
      targetId: targetCwid,
    });
    if (denial !== null) return { kind: "forbidden" };
  }

  return { kind: "authorized", session, isSelf, isProxy, isUnitAdmin, unit };
}
