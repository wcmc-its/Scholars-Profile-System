/**
 * #2542 — the org-unit role vocabulary.
 *
 * ONE list per unit KIND for the whole institution, not a per-unit copy. A
 * superuser / comms_steward owns this vocabulary so the institution speaks with
 * one voice; per-unit copies would hand every unit an editable duplicate and
 * turn the governance layer's job into policing divergence. Keyed by kind,
 * divergence is unrepresentable rather than merely discouraged.
 *
 * Per-unit variation still works, three ways, none of which needs a local copy:
 *   1. WHO HOLDS WHAT. A role with no holders renders no section, so a generous
 *      list costs nothing.
 *   2. `interim`, on the assignment.
 *   3. Distinct entries for distinct concepts — a portfolio ("Associate Center
 *      Director, Health policy communication") is its own entry, which is why
 *      there is no free-text qualifier any more.
 *
 * DEPENDENCY-FREE ON PURPOSE. `lib/edit/manageable-units.ts` imports from here,
 * and that module reaches the CLIENT bundle via `components/edit/home-panel.tsx`
 * (a runtime `unitKindLabel` import). The invariant is not "zero imports" — a
 * type-only import is harmless — but NOTHING in this file's import graph may
 * reach `@/lib/db` or construct `prisma` at module scope, or the mariadb driver
 * is dragged into the browser and the Next build dies on unresolvable `fs`/`net`.
 * Keeping the file literally import-free is the cheapest way to guarantee that.
 */

/**
 * Which block a role renders in. Leadership sits at the top of the unit page,
 * membership below.
 */
export type OrgUnitRoleGroup = "leadership" | "membership";

/**
 * Which tier an entry may be assigned at. `unit` is the unit itself; `program`
 * is the sub-tier that folding `CenterProgramLeader` in will use.
 */
export type OrgUnitRoleScope = "unit" | "program";

/**
 * The unit kinds a vocabulary exists for. Values match the `EntityType` enum by
 * VALUE, deliberately not by type — `entityType` sits in the vocabulary's PK and
 * in the assignment's FK, so making it a Prisma enum would turn every future
 * member into a drop-FK/drop-PK/MODIFY/add-PK/add-FK rebuild of two tables
 * instead of a one-line `ALTER`.
 */
export type OrgUnitRoleEntityType = "department" | "division" | "center" | "core" | "center_program";

/** The kind whose vocabulary ships today. */
export const CENTER_ENTITY_TYPE = "center" satisfies OrgUnitRoleEntityType;

/** Stable key of the seeded leadership role that `Center.directorCwid` migrates to. */
export const DIRECTOR_ROLE_KEY = "director";

/**
 * Stable key of the department leadership role for every non-administrative
 * `category` (`clinical` | `mixed` | `basic`). Same literal a curator would
 * expect to see today; seeded so `departmentLeaderRoleKey` below has
 * something to return instead of the three ternary sites each deciding it
 * independently. `as const` so that function can return the literal union
 * `"chair" | "director"` rather than a widened `string`.
 */
export const DEPARTMENT_CHAIR_ROLE_KEY = "chair" as const;

/**
 * Stable key of the department leadership role for `category ===
 * "administrative"` departments (e.g. the Library). Coincidentally the SAME
 * literal as `DIRECTOR_ROLE_KEY` above — the two are unrelated: this one is
 * scoped to `entityType: "department"` in the vocabulary's composite PK, so
 * the collision is harmless and not an alias.
 */
export const DEPARTMENT_DIRECTOR_ROLE_KEY = "director" as const;

/**
 * Stable key of the division leadership role. Divisions have exactly one
 * leadership key — no category ternary exists for them — so this is a plain
 * constant rather than a function.
 */
export const DIVISION_CHIEF_ROLE_KEY = "chief";

/**
 * Stable key of the seeded membership role that an unclassified legacy row
 * migrates to. Deriving NULL from it (see `deriveMembershipType`) is what keeps
 * the migration invisible: the public roster's badge and type facet both read
 * `membershipType`, so an unclassified member looks exactly as it does today.
 */
export const MEMBER_ROLE_KEY = "member";

/** A seedable vocabulary entry. Mirrors the `OrgUnitRole` columns. */
export type OrgUnitRoleSeed = {
  key: string;
  label: string;
  group: OrgUnitRoleGroup;
  scope: OrgUnitRoleScope;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
};

/**
 * The default vocabulary per unit kind.
 *
 * `center`, `department`, `division` and `core` are populated. `center_program`
 * stays empty — folding `CenterProgramLeader` in is a later phase — and an
 * empty list there is genuinely dead data rather than a hedge, per the
 * comment on that phase in `OrgUnitRole.scope`.
 *
 * `department` seeds BOTH `chair` and `director` (Medicine holds one, the
 * Library the other); `departmentLeaderRoleKey` below is the single place
 * that decides which one a given department gets. Previously this comment
 * claimed the `category === "administrative" ? "Director" : "Chair"` ternary
 * was "duplicated across four sites" — that count was WRONG. Scoped to just
 * the ternary-plus-hardcoded-"Chief"-literal universe, there are exactly
 * THREE ternary sites (`lib/api/departments.ts`,
 * `components/browse/departments-grid.tsx`, and — a different deploy path,
 * since ETL code ships on ECR push rather than `cdk deploy` —
 * `etl/ed/index.ts`), plus ONE hardcoded literal with no ternary at all
 * (`components/division/division-page.tsx`, `role="Chief"`). Four call sites
 * in THAT universe, only three of which are a ternary — a narrower count
 * than the full repoint list just below, which also covers sites that
 * hardcoded a leader noun some other way, with no ternary in sight.
 * `division` seeds only `chief` — divisions have no administrative carve-out.
 * `core` seeds only `director`, with `singleHolder: false` — see the comment
 * on that entry below for why, it is not a copy-paste of the department rule.
 *
 * Seeding these rows here is not, by itself, what changes what any page
 * renders — `orgUnitRoleSeedRows` only makes the vocabulary exist. This same
 * phase does the repointing too, at more call sites than the four above:
 * those four had the ternary or the "Chief" literal; several more just
 * hardcoded a leader noun unconditionally, no ternary to spot.
 * Ternary/literal sites repointed: `lib/api/departments.ts` and
 * `divisions.ts` resolve the leader via `resolveUnitLeader`
 * (`lib/api/unit-leader.ts`) instead of reading `chairCwid` / `chiefCwid`
 * directly; `components/browse/departments-grid.tsx` now reads the
 * `chairLabel` field off its data source instead of its own ternary;
 * `etl/ed/index.ts` dual-writes an `OrgUnitRoleAssignment` row
 * (`writeUnitLeaderAssignment`) alongside every legacy-column write it
 * already made; and the division page renders `detail.chief.role` in place
 * of the hardcoded "Chief" literal. Unconditional-noun sites repointed, none
 * of which had a ternary: `lib/api/data-quality.ts` (`classifyLeadership`'s
 * label parameter, plus the `chairLabelByCwid` build that feeds it, both via
 * `departmentLeaderRoleKey` — previously an unconditional `"Chair"`);
 * `lib/api/profile.ts` (the leadership-title line, previously an
 * unconditional `` `Chair, ${dept}` ``); `lib/edit/overview-facts.ts` (the FK
 * leadership candidate, previously the same unconditional string); and
 * `lib/api/browse.ts` (adds the `chairLabel` field the browse grid above now
 * reads, vocabulary-resolved). What this phase does NOT do: backfill
 * `OrgUnitRoleAssignment` rows for units that already have a leader today —
 * that is `scripts/backfills/2026-08-31-dept-div-role-vocabulary.ts`, a
 * separate run against a given environment with its own rollout-ordering
 * constraint (see that script's docblock), not something seeding or the
 * repointed call sites do on their own.
 *
 * The center set is MIGRATION-PRESERVING, not aspirational:
 *   - `director` is the migration target for `Center.directorCwid`. As of
 *     Phase B, `components/center/center-page.tsx:148-153` hardcodes nothing
 *     — it renders `leader.roleLabel` for every leadership-group,
 *     profileTitle-eligible role holder, in vocabulary order, so this entry's
 *     `label` is what actually reaches the page.
 *   - `research` / `clinical` seed under the SAME literals as the
 *     `CenterMembershipType` enum, so `CenterCollabCandidate.isCurrentMember`
 *     (which matches the literal `research`) reports the same NCI CCSG
 *     REMOVE-eligible population it does today.
 *   - `member` receives legacy rows whose `membershipType` is NULL.
 *   - `co_director` / `associate_director` cover the common cases that forced
 *     #2542. They seed with zero holders, which costs nothing: a role with no
 *     holders renders no section.
 *
 * `research` / `clinical` are NCI CCSG vocabulary, not general org vocabulary,
 * and a second institution should not be born with them. They stay in the center
 * set for now because Meyer needs them and no opt-in seed-profile mechanism
 * exists yet; splitting them out is the first portability fix, not this change.
 *
 * `profileTitle` is `false` for membership roles because being a member of a
 * unit has never been a title on a scholar profile — only leading one is.
 */
export const DEFAULT_ORG_UNIT_ROLES: Readonly<
  Record<OrgUnitRoleEntityType, readonly OrgUnitRoleSeed[]>
> = {
  center: [
    {
      key: DIRECTOR_ROLE_KEY,
      label: "Director",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 10,
      profileTitle: true,
    },
    {
      key: "co_director",
      label: "Co-Director",
      group: "leadership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 20,
      profileTitle: true,
    },
    {
      key: "associate_director",
      label: "Associate Director",
      group: "leadership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 30,
      profileTitle: true,
    },
    {
      key: MEMBER_ROLE_KEY,
      label: "Member",
      group: "membership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 10,
      profileTitle: false,
    },
    {
      key: "research",
      label: "Research",
      group: "membership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 20,
      profileTitle: false,
    },
    {
      key: "clinical",
      label: "Clinical",
      group: "membership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 30,
      profileTitle: false,
    },
  ],
  department: [
    {
      key: DEPARTMENT_CHAIR_ROLE_KEY,
      label: "Chair",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 10,
      profileTitle: true,
    },
    {
      key: DEPARTMENT_DIRECTOR_ROLE_KEY,
      label: "Director",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 20,
      profileTitle: true,
    },
  ],
  division: [
    {
      key: DIVISION_CHIEF_ROLE_KEY,
      label: "Chief",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 10,
      profileTitle: true,
    },
  ],
  core: [
    {
      key: DIRECTOR_ROLE_KEY,
      label: "Director",
      group: "leadership",
      scope: "unit",
      // singleHolder is FALSE here on purpose, unlike department/division/
      // center's director-shaped roles. `CoreLeader`'s own docblock
      // (prisma/schema.prisma) says it plainly: "a core may be co-led" —
      // `CoreLeader` is a 0..N table for exactly that reason, matching
      // `CenterProgramLeader`. Seeding `singleHolder: true` here would assert
      // an invariant the source-of-truth model already contradicts.
      singleHolder: false,
      sortOrder: 10,
      profileTitle: true,
    },
  ],
  center_program: [],
};

/**
 * The department leadership role key for a given `Department.category`.
 *
 * The single place that decides Chair vs. Director, so the three call sites
 * that used to each own a copy of the `category === "administrative" ?
 * "Director" : "Chair"` ternary (`lib/api/departments.ts`,
 * `components/browse/departments-grid.tsx`, `etl/ed/index.ts`) can import
 * this instead of re-deciding it. `director` only for `administrative`;
 * `clinical`, `mixed` and `basic` all return `chair` — matching the four live
 * `category` values confirmed against prod.
 *
 * Takes `category: string`, not the narrower `DepartmentCategory` union type,
 * because the column itself is an unconstrained VARCHAR
 * (`Department.category`) and a row with a category this function has never
 * seen must still resolve to something rather than throw — it resolves to
 * `chair`, the same default `etl/ed/index.ts` already falls back to for an
 * unrecognized category.
 */
export function departmentLeaderRoleKey(
  category: string,
): typeof DEPARTMENT_CHAIR_ROLE_KEY | typeof DEPARTMENT_DIRECTOR_ROLE_KEY {
  return category === "administrative" ? DEPARTMENT_DIRECTOR_ROLE_KEY : DEPARTMENT_CHAIR_ROLE_KEY;
}

/**
 * `CenterMembership.membershipType` is DERIVED from `membershipRoleKey` and
 * never written independently. Keeping the real MySQL ENUM column, and keeping
 * it as the thing NCI analytics read, is what stops Cancer Center reporting from
 * ever touching the curator-editable vocabulary.
 *
 * Anything that is not one of the two enum literals derives to NULL — including
 * `member`, a leadership-only row's NULL key, and any entry a steward mints
 * later. Returning a non-enum string here would make MySQL reject the whole
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
 * Renders a leadership assignment as a title: the role's label plus the
 * "Interim" modifier.
 *
 * Interim stays a modifier rather than a role of its own — folding it into the
 * vocabulary would multiply every leadership entry by two. A PORTFOLIO does not:
 * "Associate Center Director, Health policy communication" is its own vocabulary
 * entry as of 2026-08-30, which is why this takes no qualifier argument and the
 * assignment carries no free text.
 */
export function formatLeadershipTitle(label: string, interim: boolean): string {
  return interim ? `Interim ${label}` : label;
}

/**
 * The seed rows for a kind's default vocabulary, shaped for a top-level
 * `orgUnitRole.createMany({ skipDuplicates: true })`.
 *
 * Unlike Phase 1's per-center version these carry their own `entityType`: the
 * vocabulary is no longer a child of a unit row, so there is no parent to supply
 * it and no nested-`createMany` FK-scalar trap to avoid. (That trap was real —
 * `ChildCreateManyParentInput` omits the FK scalar, and passing it throws
 * `Unknown argument` at REQUEST time, invisible to TypeScript when the rows come
 * from a function call. It cannot recur here, because nothing nests any more.)
 *
 * Idempotent by construction: every caller uses `skipDuplicates`, so re-seeding
 * can never clobber a label a steward has edited.
 */
export function orgUnitRoleSeedRows(entityType: OrgUnitRoleEntityType): {
  entityType: string;
  key: string;
  label: string;
  roleGroup: OrgUnitRoleGroup;
  scope: OrgUnitRoleScope;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
  source: string;
}[] {
  return DEFAULT_ORG_UNIT_ROLES[entityType].map((r) => ({
    entityType,
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
