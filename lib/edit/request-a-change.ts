/**
 * "Request a Change" routing config (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Request a Change).
 *
 * The profile is assembled from several systems of record; a correction must
 * reach the *right* one. So "Request a Change" is a per-attribute triage that
 * names the issue type and routes it to the owning office — never a generic
 * mailbox. This module is the data behind that triage; the picker UI consumes
 * it. It adds **no** write path or authorization surface — every route is a
 * link out (email / form / instruction).
 *
 * Two intents are kept deliberately distinct (the copy must stop a scholar
 * reaching for the wrong one):
 *   - `request` — the data is *wrong or missing at the source*; fix it upstream.
 *   - `hide`    — the data is *correct* but shouldn't be displayed; use the
 *                 in-app Hide control on the editable attribute instead.
 *
 * Destinations are `pending` until the operator supplies them (D6 — see
 * `.planning/self-edit-D6-request-a-change-scenarios.md`). The picker renders a
 * graceful fallback for a `pending` destination, so the feature ships before
 * the addresses land; filling D6 is a data change here, not a code change.
 *
 * Operator corrections already applied: ASMS = Faculty Affairs; Registrar is a
 * separate office (not the education channel); there is no "WOOFA" — the SOR
 * owner for degrees/post-nominals is still open (D6 / scenario S5).
 */

/** Where a `request` route points. `pending` = D6 not yet supplied. */
export type RequestDestination =
  | { type: "email"; address: string; subjectHint?: string }
  | { type: "url"; href: string }
  | { type: "instruction"; text: string }
  | { type: "pending" };

export type RequestRoute = {
  /** The office/team that owns the fix (display label). Known before the exact
   *  address sometimes is — "TBD" marks an office still open in D6. */
  office: string;
  /** The system of record the value comes from. */
  sourceSystem: string;
  destination: RequestDestination;
};

export type ChangeIssue = {
  /** Stable id (maps to a D6 scenario; never shown to the user). */
  id: string;
  /** The picker option text. */
  label: string;
  action:
    | { kind: "request"; route: RequestRoute }
    /** Steer the user to the in-app Hide control rather than a correction. */
    | { kind: "hide"; note: string };
};

/** The editor attributes that expose a "Request a Change" picker. */
export type RequestAttribute =
  | "name-title"
  | "photo"
  | "education"
  | "appointments"
  | "funding"
  | "publications";

export type AttributeChangeConfig = {
  /** The picker heading ("What needs to change?" is the shared prompt). */
  heading: string;
  issues: ChangeIssue[];
};

const PENDING: RequestDestination = { type: "pending" };

/**
 * The routing map. One entry per editor attribute; each lists its issue types.
 * `request` issues name the owning office + source; `hide` issues redirect to
 * the in-app control. Addresses are `PENDING` until D6.
 */
export const REQUEST_A_CHANGE: Record<RequestAttribute, AttributeChangeConfig> = {
  "name-title": {
    heading: "What needs to change?",
    issues: [
      {
        id: "name-wrong", // D6 S1/S2
        label: "My name or preferred name is wrong",
        action: {
          kind: "request",
          route: { office: "Enterprise Directory", sourceSystem: "ED / LDAP", destination: PENDING },
        },
      },
      {
        id: "title-or-dept-wrong", // D6 S3/S4
        label: "My title or department is wrong",
        action: {
          kind: "request",
          route: { office: "TBD (Faculty Affairs / ED)", sourceSystem: "ED / LDAP", destination: PENDING },
        },
      },
      {
        id: "degrees-wrong", // D6 S5 — SOR owner still open (no WOOFA)
        label: "My degrees or post-nominals are wrong",
        action: {
          kind: "request",
          route: { office: "TBD (faculty SOR owner — D6/S5)", sourceSystem: "faculty SOR", destination: PENDING },
        },
      },
      {
        id: "email-wrong", // D6 S6
        label: "My email is wrong",
        action: {
          kind: "request",
          route: { office: "Enterprise Directory", sourceSystem: "ED / LDAP", destination: PENDING },
        },
      },
      {
        id: "orcid-wrong", // D6 S7
        label: "My ORCID is wrong or missing",
        action: {
          kind: "request",
          route: { office: "Identity team", sourceSystem: "WCM Identity", destination: PENDING },
        },
      },
    ],
  },
  photo: {
    heading: "What needs to change?",
    issues: [
      {
        id: "photo-issue", // D6 S8/S9/S10
        label: "My photo is wrong, outdated, or missing",
        action: {
          kind: "request",
          route: { office: "Directory photo process", sourceSystem: "WCM directory photo service", destination: PENDING },
        },
      },
    ],
  },
  education: {
    heading: "What needs to change?",
    issues: [
      {
        id: "education-wrong-or-missing", // D6 S11/S12 — ASMS = Faculty Affairs
        label: "An education or training entry is wrong or missing",
        action: {
          kind: "request",
          route: { office: "Faculty Affairs", sourceSystem: "ASMS", destination: PENDING },
        },
      },
      {
        id: "education-stale", // D6 S13
        label: "An entry is correct but I don't want it shown",
        action: { kind: "hide", note: "Use Hide on that entry — the data is fine, it just won't display." },
      },
    ],
  },
  appointments: {
    heading: "What needs to change?",
    issues: [
      {
        id: "appointment-wrong-or-missing", // D6 S14/S15/S16
        label: "An appointment is wrong or missing",
        action: {
          kind: "request",
          route: { office: "TBD (dept admin / Faculty Affairs — D6)", sourceSystem: "ED", destination: PENDING },
        },
      },
      {
        id: "appointment-hide", // D6 S17
        label: "An appointment is correct but I don't want it shown",
        action: { kind: "hide", note: "Use Hide on that appointment (a department chair role can't be hidden)." },
      },
    ],
  },
  funding: {
    heading: "What needs to change?",
    issues: [
      {
        id: "grant-wrong-or-missing", // D6 S19/S20/S21
        label: "A grant's title, sponsor, dates, or role is wrong, or a grant is missing",
        action: {
          kind: "request",
          route: { office: "OSRA (Office of Sponsored Research Administration)", sourceSystem: "InfoEd", destination: PENDING },
        },
      },
      {
        id: "grant-not-mine", // D6 S22
        label: "I shouldn't be listed on a grant",
        action: { kind: "hide", note: "Use Hide on that grant — it removes only your role, not the award." },
      },
    ],
  },
  publications: {
    heading: "What needs to change?",
    issues: [
      {
        id: "publication-missing", // D6 S23
        label: "A publication of mine is missing",
        action: {
          kind: "request",
          route: { office: "Publications curation (added in ReCiter)", sourceSystem: "ReCiter", destination: PENDING },
        },
      },
      {
        id: "publication-metadata-wrong", // D6 S24/S26
        label: "A publication's title, journal, year, or authors are wrong",
        action: {
          kind: "request",
          route: { office: "Publications curation (PubMed correction)", sourceSystem: "PubMed", destination: PENDING },
        },
      },
      {
        id: "publication-not-mine", // D6 S25
        label: "A publication isn't mine / is wrongly attributed",
        action: { kind: "hide", note: "Use Hide on that publication — it removes you from it now." },
      },
    ],
  },
};

/** The issue list + heading for one attribute. */
export function getChangeConfig(attr: RequestAttribute): AttributeChangeConfig {
  return REQUEST_A_CHANGE[attr];
}

/** True once an operator has supplied a real destination (not `pending`). */
export function isRouteResolved(route: RequestRoute): boolean {
  return route.destination.type !== "pending";
}
