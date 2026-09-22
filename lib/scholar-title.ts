/**
 * Scholar display-title resolution.
 *
 * `Scholar.primaryTitle` is the RESOLVED title — what every render surface
 * already reads (search hits, `/og` cards, person popovers, people result
 * cards, the profile sidebar, `/edit`). The raw inputs it is resolved FROM
 * live beside it as `Scholar.edPrimaryTitle` and `Scholar.workingTitle`, so
 * the `/edit` picker can offer the losing tiers without re-reading LDAP.
 *
 * Precedence, highest first:
 *
 *   1. operator override   `field_override(scholar, <cwid>, 'primaryTitle')`
 *   2. ED working title    `weillCornellEduWorkingTitle`
 *   3. division chief      `OrgUnitRoleAssignment(division, …, profileTitle)`
 *   4. center head         `OrgUnitRoleAssignment(center, …, profileTitle)`
 *   5. ED primary title    `weillCornellEduPrimaryTitle`
 *
 * DEPENDENCY-FREE ON PURPOSE, for the same reason `lib/org-unit-roles.ts` is:
 * `components/edit/edit-page.tsx` imports this at runtime, so it reaches the
 * CLIENT bundle. Nothing in this file's import graph may touch `@/lib/db` or
 * construct `prisma` at module scope, or the mariadb driver gets dragged into
 * the browser and the Next build dies on unresolvable `fs`/`net`. Keeping the
 * file literally import-free is the cheapest way to guarantee that — callers
 * pass data in, this module only computes strings.
 */

/** The tiers, in precedence order. `primary` is the floor. */
export type TitleTier = "working" | "chief" | "centerHead" | "primary";

/** Precedence order, highest first. Exported so callers iterate ONE list
 *  rather than each re-encoding the order and drifting from it. */
export const TITLE_TIERS: readonly TitleTier[] = [
  "working",
  "chief",
  "centerHead",
  "primary",
] as const;

/** Operator-facing label per tier — drives the `/edit` picker's option rows. */
export const TITLE_TIER_LABEL: Record<TitleTier, string> = {
  working: "Working title",
  chief: "Division chief",
  centerHead: "Center head",
  primary: "Primary title",
};

/** One row in the `/edit` picker. `value` is null when the tier does not apply
 *  to this scholar — the row still renders (disabled) so an operator can see
 *  WHY a tier did not win, rather than wondering where it went. */
export type TitleOption = {
  tier: TitleTier;
  label: string;
  value: string | null;
};

/** The per-scholar inputs. Every field is already a finished display string;
 *  this module never reaches a database or formats a unit name itself. */
export type TitleInputs = {
  /** ED `weillCornellEduWorkingTitle`, annotation-stripped. */
  workingTitle: string | null;
  /** Pre-formatted, e.g. "Chief, Cardiology (Medicine)" — see {@link formatUnitLeadershipTitle}. */
  chiefTitle: string | null;
  /** Pre-formatted, e.g. "Director, Example Cancer Center". */
  centerHeadTitle: string | null;
  /** ED `weillCornellEduPrimaryTitle`, annotation-stripped. */
  edPrimaryTitle: string | null;
};

/**
 * Build the picker's rows, in precedence order. Every tier always produces a
 * row; `value: null` marks a tier that does not apply.
 */
export function buildTitleOptions(inputs: TitleInputs): TitleOption[] {
  const byTier: Record<TitleTier, string | null> = {
    working: blankToNull(inputs.workingTitle),
    chief: blankToNull(inputs.chiefTitle),
    centerHead: blankToNull(inputs.centerHeadTitle),
    primary: blankToNull(inputs.edPrimaryTitle),
  };
  return TITLE_TIERS.map((tier) => ({
    tier,
    label: TITLE_TIER_LABEL[tier],
    value: byTier[tier],
  }));
}

export type ResolvedTitle = {
  /** What belongs in `Scholar.primaryTitle`. Null only when a scholar has no
   *  title at ANY tier — rare, and a null subtitle is correct there. */
  value: string | null;
  /** Which tier won, or null when an operator override won (or nothing did). */
  tier: TitleTier | null;
  /** True when `field_override(primaryTitle)` decided this. */
  overridden: boolean;
};

/**
 * Resolve the display title.
 *
 * `override` is the raw `field_override(scholar, <cwid>, 'primaryTitle')`
 * value. The EMPTY STRING is meaningful and means "no pin — fall through to
 * the derived default", which is how an operator undoes a pick without the
 * request path having to delete a row it may not own.
 *
 * Note this is the OPPOSITE of the `""` convention in
 * `etl/ed/unit-overrides.ts`, where an empty `leaderCwid` is an explicit
 * vacancy that must NOT re-engage auto-detection. The difference is
 * deliberate: a vacancy is a fact a curator asserts about a unit, whereas
 * there is no such thing as a scholar who asserts they have no title — the
 * floor tier always applies. Calling it out because the two conventions sit
 * two files apart and read identically.
 */
export function resolveScholarTitle(
  inputs: TitleInputs & { override: string | null },
): ResolvedTitle {
  const override = blankToNull(inputs.override);
  if (override !== null) return { value: override, tier: null, overridden: true };

  for (const option of buildTitleOptions(inputs)) {
    if (option.value !== null) {
      return { value: option.value, tier: option.tier, overridden: false };
    }
  }
  return { value: null, tier: null, overridden: false };
}

/**
 * Format a unit leadership assignment as a title line.
 *
 * Mirrors what `lib/api/profile.ts` already emits for `leadershipTitles`
 * (#1266) — `` `${formatLeadershipTitle(label, interim)}, ${unitName}` `` —
 * with one addition: a `(Department)` qualifier when the unit's NAME is not
 * unique.
 *
 * Probed 2026-09-22 across all 42 divisions: exactly ONE name is shared —
 * "Cardiology", which exists under two different departments and so affects
 * 2 of 25 chiefs. The qualifier is therefore conditional, not unconditional:
 * appending the department to all 25 would add noise to 23 of them in order
 * to disambiguate 2.
 * `ambiguous` is computed per run from the unit table (a name held by 2+
 * codes), never hardcoded, so a future collision qualifies itself.
 *
 * `(Department)` matches the convention the profile sidebar already uses for
 * divisions ("<Division> (<Department>)", issue #167).
 */
export function formatUnitLeadershipTitle(opts: {
  /** Vocabulary label, e.g. "Chief" / "Director". */
  roleLabel: string;
  interim: boolean;
  unitName: string;
  /** Parent department name. Only read when `ambiguous`. */
  parentName?: string | null;
  /** True when another unit of the same kind shares `unitName`. */
  ambiguous?: boolean;
}): string {
  const role = opts.interim ? `Interim ${opts.roleLabel}` : opts.roleLabel;
  const parent = blankToNull(opts.parentName ?? null);
  const unit = opts.ambiguous && parent !== null ? `${opts.unitName} (${parent})` : opts.unitName;
  return `${role}, ${unit}`;
}

/**
 * Names held by more than one unit, lowercased. Feeds `ambiguous` above.
 * Takes the whole unit list so the caller does one pass, not one query per
 * chief.
 */
export function ambiguousUnitNames(
  units: readonly { name: string }[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const u of units) {
    const key = u.name.trim().toLowerCase();
    if (key.length === 0) continue;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return dupes;
}

/** Whitespace-only is absence, not a title. Keeps a stray ED space from
 *  winning a tier and rendering an empty subtitle. */
function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
