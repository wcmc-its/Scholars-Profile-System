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
 *   - **Superuser** → "Admin console" (`/edit/scholars`) only. The in-console
 *     `AdminSubnav` fans out from the roster to every other surface (URL requests /
 *     URL registry / Administrators / Method Families / Funding matcher), so the
 *     dropdown stays short — it routes them to the console, not to every tab.
 *   - **comms_steward** (not a superuser) → also "Admin console"
 *     (`/edit/scholars`), same collapse as a superuser. A steward's own
 *     `AdminSubnav` fans out too — just narrower (Method Families is the one
 *     tab it actually admits them to, per `TAB_PREDICATES` in
 *     `lib/edit/console-tabs.server.ts`) — so a dedicated "Method Families"
 *     dropdown row would be a redundant second door to the same console entry.
 *     This union is deliberately checked before `managesUnits` below: gaining a
 *     unit grant must never remove this row (I3-style monotonicity, mirroring
 *     `console-tabs.server.ts`'s own invariant).
 *   - **Unit Owner / Curator** (not a superuser, not a steward) → "Profiles"
 *     (`/edit/scholars`, scope-filtered to their units — B3), then "Org units"
 *     (`/edit/units`).
 *     People first: the roster is what they sign in to do, and it was
 *     previously not linked at all — `/edit/scholars` was superuser-gated, so
 *     their only door was "Org units". (The roster's own COI-review column is
 *     superuser-only, so it earns no separate link here — see
 *     `lib/edit/data-quality.ts`.)
 *
 * A viewer holding several non-superuser roles gets several links. The list is
 * profile-independent: a steward or unit admin with no `Scholar` row still gets
 * their entry point (the dwd2001 case).
 */

/** One console destination the viewer may open, rendered as a dropdown row. */
export type ConsoleLink = {
  /** Stable id — drives the React key, the row `data-testid`, and the icon map. */
  id: "manage-profiles" | "methods" | "units" | "profiles";
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
  /** `isCommsSteward(cwid)` — a live LDAPS group check already gated by its
   *  own `COMMS_STEWARD_ENABLED` kill switch (`lib/auth/comms-steward.ts`):
   *  `false` for everyone, with no directory call, when the flag is off. A
   *  `true` here collapses the dropdown to "Admin console", the same as a
   *  superuser — see the module doc comment. */
  isCommsSteward: boolean;
  /** The viewer holds ≥1 direct `unit_admin` grant
   *  (`loadManageableUnits(...).total > 0`). */
  managesUnits: boolean;
};

/**
 * Build the ordered list of console links for a viewer from their role verdicts.
 * Pure — no env reads, no I/O — so the policy is unit-testable in isolation.
 * Returns `[]` for a plain scholar (no console section renders).
 *
 * The superuser roster row is labeled "Admin console" (account-dropdown-nav
 * handoff, Workstream B; the `ACCOUNT_CONSOLE_NAV_RESTRUCTURE` flag that gated
 * the relabel was retired in #1440). The GrantRecs matcher tools are not
 * dropdown rows — they live in the in-console `AdminSubnav`
 * (`/edit/grant-matcha`, `/edit/matcha`).
 */
export function buildConsoleLinks(v: ConsoleLinkVerdicts): ConsoleLink[] {
  const links: ConsoleLink[] = [];

  // A superuser OR a comms_steward collapses to the Profiles roster — each has
  // an AdminSubnav that already fans out to whatever else they can reach (the
  // full surface set for a superuser, just Method Families for a steward), so
  // neither needs a second, redundant dropdown row for a surface their own
  // console nav already reaches. Checked BEFORE `managesUnits` on purpose: a
  // steward who later also picks up a unit grant must keep this row, never
  // fall back to the narrower Profiles/Org-units pair below.
  if (v.isSuperuser || v.isCommsSteward) {
    links.push({
      id: "manage-profiles",
      label: "Admin console",
      href: "/edit/scholars",
    });
  } else {
    // PEOPLE BEFORE UNITS. A unit Owner/Curator's own words for what they came
    // to do are "the people I edit", not "the org unit I administer" — and until
    // this row existed their only door was "Org units". Same destination and
    // same NAME every other role uses for it, so the surface reads identically
    // whoever opens it; the roster itself is scope-filtered server-side (B3).
    if (v.managesUnits) {
      links.push({ id: "profiles", label: "Profiles", href: "/edit/scholars" });
    }
    if (v.managesUnits) {
      links.push({ id: "units", label: "Org units", href: "/edit/units" });
    }
  }

  return links;
}
