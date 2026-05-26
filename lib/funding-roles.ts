/**
 * Human-readable grant-role labels (#160 self-edit Funding panel).
 *
 * `Grant.role` stores InfoEd abbreviations (PI, Co-I, …). The self-edit Funding
 * panel spells them out so a scholar reading their own awards sees a full title,
 * not a code. Unknown values pass through unchanged (defensive — a new InfoEd
 * role won't render blank).
 */
const FUNDING_ROLE_LABELS: Record<string, string> = {
  PI: "Principal Investigator",
  "Co-PI": "Co-Principal Investigator",
  "Co-I": "Co-Investigator",
  "PI-Subaward": "Principal Investigator (subaward)",
  "Key Personnel": "Key Personnel",
};

export function fundingRoleLabel(role: string): string {
  return FUNDING_ROLE_LABELS[role] ?? role;
}
