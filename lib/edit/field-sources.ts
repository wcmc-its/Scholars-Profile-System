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
 * Overview, Visibility (publication visibility), Profile URL, and Center
 * membership — Scholars is their system of record.
 */
import type { RequestAttribute } from "@/lib/edit/request-a-change";

export const FIELD_SOURCE: Record<RequestAttribute, string> = {
  "name-title": "Enterprise Directory",
  photo: "Enterprise Directory",
  appointments: "ASMS by way of Enterprise Directory",
  education: "ASMS",
  funding: "InfoEd",
  publications: "PubMed (attributed by ReCiter)",
  // #728 Phase D — `org-unit` is a request-only pseudo-attribute (no `/edit`
  // panel renders a source line for it); the entry exists only because the map
  // is a total Record over the shared `RequestAttribute` union.
  "org-unit": "Enterprise Directory / Scholars",
};

/** The system-of-record label for a sourced `/edit` attribute. */
export function fieldSource(attribute: RequestAttribute): string {
  return FIELD_SOURCE[attribute];
}
