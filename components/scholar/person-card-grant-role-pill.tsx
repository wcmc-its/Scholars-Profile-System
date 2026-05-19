/**
 * Grant role pill for PersonPopover on the grant-investigator surface (#257).
 *
 * Parallels PersonCardRolePill (the authorship pill) — same slate / amber /
 * neutral treatment — but maps the per-person grant role (`Grant.role`:
 * PI, Co-PI, PI-Subaward, Co-I, Key Personnel) rather than authorship flags.
 *
 * Tone: PI = lead (slate); Co-PI / PI-Subaward = co-lead (amber);
 * Co-I / Key Personnel = neutral. A PI on a multi-PI grant reads "Multi-PI",
 * still slate. Unknown roles render their raw value, neutral.
 */
export type GrantRoleTone = "lead" | "co-lead" | "neutral";

// Sub-PI / KP are not in the live data (the five values are PI, Co-PI,
// PI-Subaward, Co-I, Key Personnel) but are kept as defensive aliases — the
// indexer copies Grant.role verbatim and InfoEd role strings can drift.
const GRANT_ROLE_LABEL: Record<string, string> = {
  PI: "Principal Investigator",
  "Co-PI": "Co-Principal Investigator",
  "PI-Subaward": "PI (subaward)",
  "Sub-PI": "PI (subaward)",
  "Co-I": "Co-Investigator",
  "Key Personnel": "Key Personnel",
  KP: "Key Personnel",
};

const GRANT_ROLE_TONE: Record<string, GrantRoleTone> = {
  PI: "lead",
  "Co-PI": "co-lead",
  "PI-Subaward": "co-lead",
  "Sub-PI": "co-lead",
  "Co-I": "neutral",
  "Key Personnel": "neutral",
  KP: "neutral",
};

/** Human label for a raw `Grant.role` value; unknown roles fall back to raw. */
export function grantRoleLabel(role: string): string {
  return GRANT_ROLE_LABEL[role] ?? role;
}

/** Pill tone for a raw `Grant.role` value; unknown roles are neutral. */
export function grantRoleTone(role: string): GrantRoleTone {
  return GRANT_ROLE_TONE[role] ?? "neutral";
}

/**
 * Display label including the Multi-PI relabel: a PI on a project with ≥2 PIs
 * reads "Multi-PI". Every other role keeps its plain label.
 */
export function grantRolePillLabel(role: string, isMultiPi?: boolean): string {
  if (isMultiPi && role === "PI") return "Multi-PI";
  return grantRoleLabel(role);
}

export function GrantRolePill({
  role,
  isMultiPi,
  onGrant,
}: {
  role: string;
  /** When the project has ≥2 PIs, a PI reads "Multi-PI". */
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
