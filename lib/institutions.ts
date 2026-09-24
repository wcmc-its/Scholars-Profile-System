/**
 * Institution administrators — the `institution` unit-admin axis.
 *
 * ED's `weillCornellEduPrimaryOrganization` is a bare code (`HMC`); the
 * directory carries no verbose name, so this map (ported from
 * ReCiter-Institutional-Client's `getVerbosePrimaryOrganization`) is the only
 * code → name source. A `unit_admin(institution, <code>)` owner/curator
 * proxy-edits every scholar whose `Scholar.primaryOrgCode` matches
 * (lib/edit/unit-scholar-authz.ts) — the same bounded surface a department
 * owner gets. Superuser-granted on /edit/administrators.
 *
 * `WCMC` (the home institution) is deliberately absent: an admin over every
 * WCM scholar is `comms_steward`, not an institution grant.
 *
 * Pure data — safe in the client bundle.
 */
export const INSTITUTIONS: Readonly<Record<string, string>> = {
  "WCMC-Q": "Weill Cornell Medical College in Qatar",
  HMC: "Hamad Medical Corporation",
  SIDRA: "SIDRA Medical and Research Center",
  AspH: "Aspetar Hospital",
  PHCC: "Primary Health Care Corporation (Qatar)",
  FMMP: "Feto-Maternal Medical Polyclinic (Qatar)",
  NYP: "New York-Presbyterian Hospital",
  NYPQ: "New York Presbyterian - Queens",
  NYMH: "New York Methodist Hospital",
  HSS: "Hospital for Special Surgery",
  MSKCC: "Memorial Sloan Kettering Cancer Center",
  RU: "Rockefeller University",
  RI: "Rogosin Institute",
  HMH: "Houston Methodist Hospital",
  HMRI: "Houston Methodist Research Institute",
  WMBMRI: "Winifred Masterson Burke Medical Research Institute",
  CUCPS: "Columbia University College of Physicians and Surgeons",
  Cornell: "Cornell University",
  "CU GHS": "Cornell University Gannette Health Services",
  CMCIthaca: "Cayuga Medical Center of Ithaca",
  LMMHC: "Lincoln Medical and Mental Health Center",
  BHC: "The Brooklyn Hospital Center",
  JamaicaH: "Jamaica Hospital",
  FlushHMC: "Flushing Hospital Medical Center",
  LaGuardH: "La Guardia Hospital",
  Lenox: "Lenox Hill Hospital",
  ANH: "Amsterdam Nursing Home",
  AHP: "American Hospital of Paris",
  UGMA: "University Group Medical Associates",
};

/** Display name for a code; the bare code when unmapped (an ED code this map
 *  has not caught up with — the ETL writes whatever ED says). */
export function institutionName(code: string): string {
  return INSTITUTIONS[code] ?? code;
}

/** Code for a display name, when the map has one ("Cornell University" → "Cornell"). */
export function institutionCodeForName(name: string): string | undefined {
  return Object.keys(INSTITUTIONS).find((k) => INSTITUTIONS[k] === name);
}

/** ED `weillCornellEduPrimaryOrganization` code for the home institution. */
export const HOME_INSTITUTION_CODE = "WCMC";

/**
 * DISPLAY-ONLY name for a `Scholar.primaryOrgCode` (People-search "Institution"
 * facet rows + chips). `WCMC` is deliberately NOT in `INSTITUTIONS` — that map
 * doubles as the `unit_admin(institution, <code>)` grant vocabulary and an admin
 * over every WCM scholar is `comms_steward`, not an institution grant — so the
 * home institution is special-cased here instead of added to the map. Unmapped
 * codes fall through to the bare code, same as `institutionName`.
 */
export function institutionDisplayName(code: string): string {
  return code === HOME_INSTITUTION_CODE ? "Weill Cornell Medicine" : institutionName(code);
}

/**
 * Institution name for PUBLIC labels (profile header, popover, roster badge,
 * A–Z, metadata) — absence-as-default: `null` for the home institution and
 * for an unset/empty code, so a WCM scholar renders exactly as before and only
 * a non-WCMC primary organization (HSS, MSKCC, HMC, …) gets a line. Same
 * policy as #242's dropped "Weill Cornell Medicine" affiliation suffix.
 */
export function visibleInstitutionName(code: string | null | undefined): string | null {
  if (!code || code === HOME_INSTITUTION_CODE) return null;
  return institutionDisplayName(code);
}
