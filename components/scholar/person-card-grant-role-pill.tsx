/**
 * Grant role pill for PersonPopover on the grant-investigator surface (#257).
 *
 * Parallels PersonCardRolePill (the authorship pill) — same slate / amber /
 * neutral treatment — but maps the per-person grant role (`Grant.role`:
 * PI, Co-PI, PI-Subaward, Co-I, Key Personnel) rather than authorship flags.
 *
 * Tone: PI / Co-PI = lead (slate); PI-Subaward = co-lead (amber);
 * Co-I / Key Personnel = neutral. Unknown roles render their raw value, neutral.
 *
 * The vocabulary itself lives in `lib/funding-roles.ts` — this file only renders
 * it. Co-PI is InfoEd's non-contact PD/PI (an NIH multiple-PI award), so it takes
 * the lead tone and reads "MPI", with or without `isMultiPi`.
 */
import {
  fundingRoleLabel,
  grantRoleTone,
  type GrantRoleTone,
} from "@/lib/funding-roles";

export { grantRoleTone };
export type { GrantRoleTone };

/** Human label for a raw `Grant.role` value; unknown roles fall back to raw. */
export function grantRoleLabel(role: string): string {
  return fundingRoleLabel(role);
}

/**
 * Display label including the MPI relabel. Reads "MPI" for a Co-PI row (an MPI
 * unconditionally — InfoEd only flags the contact PI, so a Co-PI row means the
 * award has ≥2 PD/PIs) and for the CONTACT PI of a project `isMultiPi` says has
 * ≥2 PD/PIs. Every other role keeps its plain label.
 */
export function grantRolePillLabel(role: string, isMultiPi?: boolean): string {
  if (role === "Co-PI" || (isMultiPi && (role === "PI" || role === "PI-Subaward"))) {
    return "MPI";
  }
  return grantRoleLabel(role);
}

export function GrantRolePill({
  role,
  isMultiPi,
  onGrant,
}: {
  role: string;
  /** When the project has ≥2 PD/PIs, the contact PI reads "MPI" too. */
  isMultiPi?: boolean;
  /** When true, suffixes "on this grant" for added clarity in the popover. */
  onGrant?: boolean;
}) {
  const tone = grantRoleTone(role);
  const label = grantRolePillLabel(role, isMultiPi);
  const toneClass =
    tone === "lead"
      ? "border-[var(--color-accent-slate)] bg-[rgba(44,79,110,0.06)] text-[var(--color-accent-slate)]"
      : tone === "co-lead"
        ? "border-amber-700/70 bg-amber-50 text-amber-900"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] ${toneClass}`}
    >
      {label}
      {onGrant ? (
        <span className="ml-1 font-normal normal-case tracking-normal">on this grant</span>
      ) : null}
    </span>
  );
}
