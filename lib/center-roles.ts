/**
 * #2542 Phase 1 — the per-center role vocabulary.
 *
 * A center defines its own list of roles: the label is a property OF THE UNIT,
 * not a global enum. The Cornell Health Policy Center publishes "Founding
 * Center Director" and "Core Faculty Fellow"; the Meyer Cancer Center calls its
 * members "Research" and "Clinical". One mechanism serves both because each
 * center carries its own `CenterRole` rows.
 *
 * DEPENDENCY-FREE ON PURPOSE. `lib/edit/manageable-units.ts` imports from here,
 * and that module reaches the CLIENT bundle via `components/edit/home-panel.tsx`
 * (a runtime `unitKindLabel` import). A value import of `@/lib/db` — or of
 * anything that constructs `prisma` at module scope — anywhere in this file's
 * import graph drags the mariadb driver into the browser and breaks the Next
 * build on unresolvable `fs`/`net`. Keep this file import-free.
 */

/**
 * Which block a role renders in. Leadership sits at the top of the unit page,
 * membership below. A person holds at most one role from each group — a Core
 * Faculty Fellow who is also Research Director has both, which is why these are
 * two nullable columns on the membership row rather than one list.
 */
export type CenterRoleGroup = "leadership" | "membership";

/**
 * Which tier an entry may be assigned at. Phase 1 seeds only `center`; Phase 2
 * folds `CenterProgramLeader` in as `program`.
 */
export type CenterRoleScope = "center" | "program";

/** Stable key of the seeded leadership role that `Center.directorCwid` migrates to. */
export const DIRECTOR_ROLE_KEY = "director";

/**
 * Stable key of the seeded membership role that an unclassified legacy row
 * migrates to. Deriving NULL from it (see `deriveMembershipType`) is what keeps
 * the migration invisible: the public roster's badge and type facet both read
 * `membershipType`, so an unclassified member looks exactly as it does today.
 */
export const MEMBER_ROLE_KEY = "member";

/** A seedable vocabulary entry. Mirrors the `CenterRole` columns. */
export type CenterRoleSeed = {
  key: string;
  label: string;
  group: CenterRoleGroup;
  scope: CenterRoleScope;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
};

/**
 * The default vocabulary every center is seeded with, copied onto the center at
 * creation rather than resolved through a global fallback — so there is no "is
 * this inherited or overridden?" question and Phase 3's editing is just editing
 * rows.
 *
 * Chosen to be MIGRATION-PRESERVING, not aspirational:
 *   - `director` is the migration target for `Center.directorCwid`, and matches
 *     the string `components/center/center-page.tsx` hardcodes for every center.
 *   - `research` / `clinical` are the existing `CenterMembershipType` values,
 *     which already render as a public badge and a filter facet. Seeding them
 *     under the SAME literals keeps `CenterCollabCandidate.isCurrentMember`
 *     (which matches the literal `research`) reporting the same NCI CCSG
 *     REMOVE-eligible population it does today.
 *   - `member` receives legacy rows whose `membershipType` is NULL.
 *   - `co_director` / `associate_director` cover the common cases that forced
 *     #2542. They are seeded with zero holders, which costs nothing: a role with
 *     no holders renders no section.
 *
 * `profileTitle` is `false` for membership roles because being a member of a
 * center has never been a title on a scholar profile — only leading one is.
 */
export const DEFAULT_CENTER_ROLES: readonly CenterRoleSeed[] = [
  {
    key: DIRECTOR_ROLE_KEY,
    label: "Director",
    group: "leadership",
    scope: "center",
    singleHolder: true,
    sortOrder: 10,
    profileTitle: true,
  },
  {
    key: "co_director",
    label: "Co-Director",
    group: "leadership",
    scope: "center",
    singleHolder: false,
    sortOrder: 20,
    profileTitle: true,
  },
  {
    key: "associate_director",
    label: "Associate Director",
    group: "leadership",
    scope: "center",
    singleHolder: false,
    sortOrder: 30,
    profileTitle: true,
  },
  {
    key: MEMBER_ROLE_KEY,
    label: "Member",
    group: "membership",
    scope: "center",
    singleHolder: false,
    sortOrder: 10,
    profileTitle: false,
  },
  {
    key: "research",
    label: "Research",
    group: "membership",
    scope: "center",
    singleHolder: false,
    sortOrder: 20,
    profileTitle: false,
  },
  {
    key: "clinical",
    label: "Clinical",
    group: "membership",
    scope: "center",
    singleHolder: false,
    sortOrder: 30,
    profileTitle: false,
  },
];

/**
 * `CenterMembership.membershipType` is DERIVED from `membershipRoleKey` and
 * never written independently. Keeping the real MySQL ENUM column, and keeping
 * it as the thing NCI analytics read, is what stops Cancer Center reporting from
 * ever touching the curator-editable vocabulary.
 *
 * Anything that is not one of the two enum literals derives to NULL — including
 * `member`, a leadership-only row's NULL key, and any entry a curator mints in
 * Phase 3. Returning a non-enum string here would make MySQL reject the whole
 * transaction with error 1265 and roll the audit row back with it, so the
 * allowlist is explicit rather than a passthrough.
 */
export function deriveMembershipType(
  membershipRoleKey: string | null | undefined,
): "research" | "clinical" | null {
  return membershipRoleKey === "research" || membershipRoleKey === "clinical"
    ? membershipRoleKey
    : null;
}

/**
 * Renders a leadership assignment as a title: the role's label, the "Interim"
 * modifier, and the optional portfolio qualifier CHPC needs ("Associate Center
 * Director, Health policy communication").
 *
 * Interim stays a modifier rather than a role of its own — folding it into the
 * vocabulary would multiply every leadership entry by two.
 */
export function formatLeadershipTitle(
  label: string,
  interim: boolean,
  qualifier?: string | null,
): string {
  const base = interim ? `Interim ${label}` : label;
  const trimmed = qualifier?.trim();
  return trimmed ? `${base}, ${trimmed}` : base;
}

/**
 * The seed rows for a center's default vocabulary, shaped for a NESTED
 * `roles: { createMany: { data } }` on a `center.create` / `center.upsert`.
 *
 * Deliberately carries NO `centerCode`: Prisma's nested
 * `CenterRoleCreateManyCenterInput` omits the FK scalar (the parent supplies
 * it), and passing it throws `Unknown argument \`centerCode\`` at REQUEST time,
 * not compile time — the rows come from a function call, so TypeScript's
 * excess-property check never fires. For a top-level `centerRole.createMany`,
 * spread these onto a `centerCode` yourself.
 *
 * Every path that creates a center must call this: a center with no vocabulary
 * has no `director` key for a leadership assignment to reference, so its
 * leadership editor would fail the FK forever.
 */
export function centerRoleSeedRows(): {
  key: string;
  label: string;
  roleGroup: CenterRoleGroup;
  scope: CenterRoleScope;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
  source: string;
}[] {
  return DEFAULT_CENTER_ROLES.map((r) => ({
    key: r.key,
    label: r.label,
    roleGroup: r.group,
    scope: r.scope,
    singleHolder: r.singleHolder,
    sortOrder: r.sortOrder,
    profileTitle: r.profileTitle,
    source: "seed",
  }));
}
