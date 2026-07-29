/**
 * The ONE grant-role vocabulary. Every surface that turns a `Grant.role` value
 * into words goes through this file.
 *
 * ## The data
 *
 * `Grant.role` stores InfoEd's abbreviations and the set is FROZEN:
 *   `PI | PI-Subaward | Co-PI | Co-I | Key Personnel`
 *
 * ## What "Co-PI" actually is
 *
 * It is NOT a co-principal-investigator. InfoEd writes `Co-PI` for the
 * NON-CONTACT PD/PI — the other principal investigator on an NIH multiple-PI
 * (MPI) award. InfoEd flags only the contact PI as `PI`, so a `Co-PI` row means,
 * by construction, that the award has ≥2 PD/PIs. NIH has no "co-PI" concept at
 * all; that is NSF's term and must never render on an NIH award.
 *
 * Two consequences the rest of this file encodes:
 *   1. A `Co-PI` row is an MPI UNCONDITIONALLY — no extra data is needed.
 *   2. `isMultiPi` (≥2 distinct WCM cwids in {@link PI_ROLES} on one project) is
 *      needed only to relabel the CONTACT PI (`PI` / `PI-Subaward`) on such an
 *      award. It is optional everywhere here.
 *
 * ## House spelling
 *
 * Short form "MPI"; long form "Multiple Principal Investigator (MPI)". This
 * matches the About-page glossary, which is the spec.
 *
 * ## Two things that are NOT labels
 *
 *   - `FundingRoleBucket` ("PI" | "Multi-PI" | "Co-I", lib/api/search-funding.ts)
 *     is an OpenSearch/URL TOKEN written at lib/funding-projection.ts and indexed
 *     via lib/search.ts. Renaming it needs a reindex, so it stays "Multi-PI" on
 *     the wire and is relabelled for display by {@link FUNDING_ROLE_BUCKET_LABEL}.
 *   - `PiFilter` "multi" (lib/api/search.ts) means multi-GRANT, not multi-PI, and
 *     is unrelated to any of this.
 *
 * ## Constraint
 *
 * THIS FILE MUST STAY IMPORT-FREE. It ships in the client bundle AND in the ETL
 * image; a single import here can drag Prisma/mariadb into the Next build.
 * Unknown values pass through unchanged everywhere (defensive — a new InfoEd role
 * must never render blank).
 */

/** The frozen `Grant.role` vocabulary. */
export type GrantRole = "PI" | "PI-Subaward" | "Co-PI" | "Co-I" | "Key Personnel";

/**
 * The roles that carry principal-investigator standing.
 *
 * `PI-Subaward` is still a PI (on a subaward). `Co-PI` is the non-contact PD/PI
 * of an MPI award — a principal investigator, not a junior one. `Co-I` and
 * `Key Personnel` are NOT PI.
 */
export const PI_ROLES = ["PI", "PI-Subaward", "Co-PI"] as const;

/** True when the role carries principal-investigator standing. EXACT membership —
 *  never a prefix regex, which would also swallow anything InfoEd ever emits that
 *  merely starts with "PI". */
export function isPiRole(role: string): boolean {
  return (PI_ROLES as readonly string[]).includes(role);
}

/** The MPI long form, in one place so the four label maps below cannot drift. */
const MPI_LONG = "Multiple Principal Investigator (MPI)";

/** Long, spelled-out labels — the self-edit Funding panel and the popover pill. */
const ROLE_LABEL_LONG: Record<string, string> = {
  PI: "Principal Investigator",
  "PI-Subaward": "Principal Investigator (subaward)",
  "Co-PI": MPI_LONG,
  "Co-I": "Co-Investigator",
  "Key Personnel": "Key Personnel",
};

/** Compact pill labels — the profile Grants column and the sponsor evidence row.
 *  `Multi-PI` is the index BUCKET token, kept here so a bucket value that reaches
 *  a person-role renderer still reads in house spelling. */
const ROLE_LABEL_SHORT: Record<string, string> = {
  PI: "PI",
  "PI-Subaward": "Sub-PI",
  "Co-PI": "MPI",
  "Co-I": "Co-I",
  "Key Personnel": "KP",
  "Multi-PI": "MPI",
};

/** Tooltip / `title=` text — says what the abbreviation means, including the
 *  contact vs non-contact distinction that "Co-PI" hides. */
const ROLE_TITLE: Record<string, string> = {
  PI: "Principal Investigator",
  "PI-Subaward": "Principal Investigator (subaward)",
  "Co-PI": "Multiple Principal Investigator (non-contact PD/PI)",
  "Co-I": "Co-Investigator",
  "Key Personnel": "Key Personnel",
};

export type GrantRoleTone = "lead" | "co-lead" | "neutral";

/** Pill tone. `Co-PI` is "lead", not "co-lead": an MPI holds principal-investigator
 *  standing equally with the contact PI, so an amber "co-" treatment stated a
 *  seniority difference that does not exist. */
const ROLE_TONE: Record<string, GrantRoleTone> = {
  PI: "lead",
  "PI-Subaward": "co-lead",
  "Sub-PI": "co-lead",
  "Co-PI": "lead",
  "Co-I": "neutral",
  "Key Personnel": "neutral",
  KP: "neutral",
};

/** True when this row should read as an MPI: a `Co-PI` row always, and the
 *  contact PI (`PI` / `PI-Subaward`) only when the project is known multi-PI. */
function readsAsMpi(role: string, isMultiPi?: boolean): boolean {
  if (role === "Co-PI") return true;
  return !!isMultiPi && (role === "PI" || role === "PI-Subaward");
}

/**
 * Long, spelled-out label. `Co-PI` always reads as the MPI long form; the contact
 * PI reads the same way when `isMultiPi` says the award has ≥2 PD/PIs.
 * Unknown roles pass through unchanged.
 */
export function fundingRoleLabel(role: string, isMultiPi?: boolean): string {
  if (readsAsMpi(role, isMultiPi)) return MPI_LONG;
  return ROLE_LABEL_LONG[role] ?? role;
}

/**
 * Compact pill label: `PI`, `MPI`, `Co-I`, `Sub-PI`, `KP`.
 * Unknown roles pass through unchanged.
 */
export function grantRoleShortLabel(role: string, isMultiPi?: boolean): string {
  if (readsAsMpi(role, isMultiPi)) return "MPI";
  return ROLE_LABEL_SHORT[role] ?? role;
}

/**
 * Tooltip text for a role pill. Unknown roles pass through unchanged.
 */
export function grantRoleTitle(role: string, isMultiPi?: boolean): string {
  if (role === "Co-PI") return ROLE_TITLE["Co-PI"];
  if (readsAsMpi(role, isMultiPi)) {
    return "Multiple Principal Investigator (contact PD/PI)";
  }
  return ROLE_TITLE[role] ?? role;
}

/** Pill tone for a raw `Grant.role` value; unknown roles are neutral. */
export function grantRoleTone(role: string): GrantRoleTone {
  return ROLE_TONE[role] ?? "neutral";
}

/** The funding index's role BUCKETS — OpenSearch/URL tokens, not labels.
 *  Mirrors `FundingRoleBucket` in lib/api/search-funding.ts, which cannot be
 *  imported here (this file is import-free). */
export const FUNDING_ROLE_BUCKETS = ["PI", "Multi-PI", "Co-I"] as const;

/** Display label for each bucket token. The token stays "Multi-PI" on the wire —
 *  renaming it would need a full reindex — so the rename lives here. */
export const FUNDING_ROLE_BUCKET_LABEL: Record<
  (typeof FUNDING_ROLE_BUCKETS)[number],
  string
> = {
  PI: "PI",
  "Multi-PI": "MPI",
  "Co-I": "Co-I",
};
