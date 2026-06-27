/**
 * Per-field data provenance for the `/edit` panels (#511).
 *
 * Names the system of record for each sourced attribute so a faculty member
 * understands why a field isn't editable in Scholars and where to fix it. The
 * inline "Source: …" line in each panel header is the per-field complement of
 * the global provenance map at `/about#provenance` (#515 / #508).
 *
 * Keyed off `RequestAttribute` — the same union the panels and the
 * "Request a change" routing already share, which is exactly the set of sourced
 * panels. The labels mirror the operator-validated `sourceSystem` values in
 * `request-a-change.ts` (the authoritative routing config shipping in the same
 * UI), condensed to one user-facing system name per panel.
 *
 * Attributes the user manages here have NO entry and render no source line:
 * Overview, Visibility (publication visibility), and Center membership —
 * Scholars is their system of record.
 */
import type { RequestAttribute } from "@/lib/edit/request-a-change";

export const FIELD_SOURCE: Record<RequestAttribute, string> = {
  "name-title": "Enterprise Directory",
  photo: "Enterprise Directory",
  appointments: "ASMS by way of Enterprise Directory",
  education: "ASMS",
  funding: "InfoEd",
  // Request-only (no panel renders a source line keyed to it — the Funding
  // header shows the combined "InfoEd and NIH RePORTER" when RePORTER rows are
  // present). The entry exists for `RequestAttribute` Record totality.
  "funding-reporter": "NIH RePORTER",
  publications: "PubMed (attributed by ReCiter)",
  // #728 Phase D — `org-unit` is a request-only pseudo-attribute (no `/edit`
  // panel renders a source line for it); the entry exists only because the map
  // is a total Record over the shared `RequestAttribute` union.
  "org-unit": "Enterprise Directory / Scholars",
  // Conflicts of interest are read-only here; the scholar manages them in WRG.
  coi: "Weill Research Gateway",
  // Mentee relationships are derived from training records (Jenzabar / EC).
  mentees: "Jenzabar or Employee Central",
  // `profile-url` is OWNED by Scholars but, like `org-unit`, is a request-only
  // pseudo-attribute — the read-only Profile URL panel renders "Request a change"
  // but no source line, so this entry exists only for Record totality.
  "profile-url": "Scholars",
};

/** The system-of-record label for a sourced `/edit` attribute. */
export function fieldSource(attribute: RequestAttribute): string {
  return FIELD_SOURCE[attribute];
}

/**
 * Source key for a single CV-outline record (the per-row provenance badge in the
 * `/edit` "CV (WCM format)" preview). Reuses the panel `RequestAttribute`
 * vocabulary above, extended with the two CV origins that have no `/edit` panel:
 * `pops` (the WCM physician directory) and `generated` (the M1 LLM summary).
 */
export type CvSourceKey = RequestAttribute | "pops" | "generated";

/** Labels for the CV-only sources that aren't in {@link FIELD_SOURCE}. The bare
 *  acronym "POPS" is never surfaced — it reads as the WCM physician directory. */
const CV_EXTRA_SOURCE: Record<"pops" | "generated", string> = {
  pops: "WCM physician directory",
  generated: "AI-drafted",
};

/** The system-of-record label for one CV-outline record's source key. */
export function cvFieldSource(key: CvSourceKey): string {
  return key === "pops" || key === "generated" ? CV_EXTRA_SOURCE[key] : FIELD_SOURCE[key];
}
