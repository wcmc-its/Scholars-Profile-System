/**
 * Role-aware console entry points for the signed-in account menu
 * (`docs/role-aware-navigation-entry-points-spec.md`).
 *
 * The login dropdown (`components/site/account-menu.tsx`) is the one canonical
 * home for the privileged destinations a viewer is entitled to. Before this, the
 * dropdown only ever surfaced an admin link to **superusers** (`canBrowseProfiles`),
 * so a `comms_steward` (e.g. dwd2001) or a unit Owner/Curator who is not also a
 * superuser had no clickable path into the `/edit` console at all — the Method
 * Families / Units surfaces existed but were reachable only by typing the URL.
 *
 * `buildConsoleLinks` is the single source of *which* links a viewer sees. It is
 * a pure function of the viewer's already-resolved role verdicts (computed
 * server-side in `/api/auth/session`, where `isSuperuser` / `isCommsSteward` /
 * the unit-admin lookup live) — never re-derived on the client. The route guards
 * remain the real authorization boundary; this list is display only, and only
 * ever advertises a surface the viewer can actually open (mirrors the
 * `isMethodsTabVisible` / `superuserSurfaces` discipline in `AdminSubnav`).
 *
 * Policy (one entry per privileged role-entry-point, deduped):
 *   - **Superuser** → "Manage profiles" (`/edit/scholars`) only. The in-console
 *     `AdminSubnav` fans out from the roster to every other superuser surface
 *     (URL requests / Slug registry / Administrators / Method Families), so the
 *     dropdown stays short — it routes them to the console, not to every tab.
 *   - **comms_steward** (not a superuser) → "Method Families" (`/edit/methods`).
 *   - **Unit Owner / Curator** (not a superuser) → "Units you manage"
 *     (`/edit/units`).
 *
 * A viewer holding several non-superuser roles gets several links. The list is
 * profile-independent: a steward or unit admin with no `Scholar` row still gets
 * their entry point (the dwd2001 case).
 */

/** One console destination the viewer may open, rendered as a dropdown row. */
export type ConsoleLink = {
  /** Stable id — drives the React key, the row `data-testid`, and the icon map. */
  id: "manage-profiles" | "methods" | "units";
  label: string;
  href: string;
};

/**
 * The viewer's resolved role verdicts. All booleans are computed server-side
 * from the REAL signed-in cwid (never the impersonated one), exactly as the
 * existing `canImpersonate` / superuser verdicts in `/api/auth/session` are.
 */
export type ConsoleLinkVerdicts = {
  isSuperuser: boolean;
  /** `isMethodsTabVisible(session)` — `COMMS_STEWARD_ENABLED` on AND the viewer
   *  is a steward or superuser. The superuser branch returns early, so for the
   *  non-superuser path this reduces to "flag on AND a steward". */
  canManageMethods: boolean;
  /** The viewer holds ≥1 direct `unit_admin` grant
   *  (`loadManageableUnits(...).total > 0`). */
  managesUnits: boolean;
};

/**
 * Build the ordered list of console links for a viewer from their role verdicts.
 * Pure — no env reads, no I/O — so the policy is unit-testable in isolation.
 * Returns `[]` for a plain scholar (no console section renders).
 */
export function buildConsoleLinks(v: ConsoleLinkVerdicts): ConsoleLink[] {
  // A superuser collapses to the Profiles roster — its AdminSubnav already fans
  // out to the rest. Return early so a superuser who also happens to be a
  // steward / unit admin doesn't get redundant rows for surfaces the roster
  // already reaches.
  if (v.isSuperuser) {
    return [{ id: "manage-profiles", label: "Admin", href: "/edit/scholars" }];
  }

  const links: ConsoleLink[] = [];
  if (v.canManageMethods) {
    links.push({ id: "methods", label: "Method families", href: "/edit/methods" });
  }
  if (v.managesUnits) {
    links.push({ id: "units", label: "Org units", href: "/edit/units" });
  }
  return links;
}
