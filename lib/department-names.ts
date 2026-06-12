/**
 * Hand-curated official + compact display names for WCM departments whose
 * ceremonial name differs from the raw ED LDAP `name`.
 *
 *   officialName — the full / ceremonial form shown on prominent surfaces
 *                  (profile affiliation, department-page heading, browse card).
 *                  e.g. ED name "Library" -> "Samuel J. Wood Library".
 *   compactName  — the short / common form shown on tight surfaces (facet
 *                  chips). e.g. "Library", "Medicine".
 *
 * Why a curated map (not the ED `name`): departments are ED-sourced and the ED
 * ETL rewrites `Department.name`/`slug` on every refresh, so a rename written to
 * `name` would be clobbered. These two columns are NEVER written by the ETL on
 * UPDATE (see etl/ed/index.ts) — only seeded on CREATE from this map — so the
 * curated names stick. Existing rows are aligned by the launch backfill
 * `scripts/backfills/2026-06-12-org-unit-comms-update.ts`.
 *
 * Keyed by `department.code` (e.g. "N1280" for Medicine). Only departments that
 * need a distinct official/compact name appear here; everything else falls back
 * to the ED `name` via the resolver in `lib/org-unit-names.ts`.
 */
export type DepartmentNameOverride = {
  officialName: string;
  compactName: string;
};

export const DEPARTMENT_NAMES: Record<string, DepartmentNameOverride> = {
  // Comms rename — head of Communications, 2026-06-12.
  N1760: {
    // Stays a department (retains departmental privileges) for now; slated to
    // move to Centers/Institutes later. Chair: Cos Iadecola (coi2001).
    officialName: "Feil Family Brain and Mind Research Institute",
    compactName: "Brain & Mind Research Institute",
  },
  N1220: {
    officialName: "Englander Institute of Dermatology",
    compactName: "Dermatology",
  },
  N1932: {
    officialName: "Samuel J. Wood Library",
    compactName: "Library",
  },
  N1280: {
    officialName: "Weill Department of Medicine",
    compactName: "Medicine",
  },
  N1360: {
    officialName: "Englander Department of Ophthalmology",
    compactName: "Ophthalmology",
  },
};
