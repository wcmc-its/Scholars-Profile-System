/**
 * "Request a change" routing config (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Item-level feedback). The per-item triage data;
 * the picker UI consumes it. No write path, no new authorization — every
 * resolution is a self-service link, a `mailto:`, or an in-place explanation.
 *
 * Three response shapes (from the operator's filled taxonomy,
 * `.planning/self-edit-item-feedback-taxonomy.md`):
 *
 *   - `self-service` — the scholar fixes it themselves in the owning tool
 *     (Web Directory, Publication Manager). The dominant case; instant.
 *   - `route` — email the owning office (no deep-linking is available, so this
 *     is a prefilled `mailto:`; the exact subject/body format is deferred).
 *   - `explain` — not an error, or not fixable here (e.g. the NCE grace window,
 *     non-PubMed publications) — say so in place rather than route a junk ticket.
 *
 * Hide (display-only suppression on Scholars) is a SEPARATE per-row control,
 * not an issue type here — and "not mine" is never Hide (the attribution would
 * persist in ReCiter / leadership reports / the Faculty Review Tool).
 *
 * Constraints (operator, 2026-05-26): no deep-linking to any system; no
 * ServiceNow business service for Scholars yet (route by email, not tickets;
 * the tracked-queue graduation waits on that service). Superusers / org-unit
 * admins can perform these fixes for scholars in their purview.
 */

const WEB_DIRECTORY_URL = "https://directory.weill.cornell.edu/update/profile/index";
const PUBLICATION_MANAGER_URL = "https://reciter.weill.cornell.edu/";
/** ORCID self-management; `{cwid}` is substituted by the panel at render. */
const ORCID_MANAGE_URL = "https://reciter.weill.cornell.edu/manageprofile/{cwid}";

const SUPPORT_EMAIL = "support@med.cornell.edu"; // ITS — ED/ASMS source data, appointments, imports (catch-all)
const FACULTY_AFFAIRS_EMAIL = "ofa@med.cornell.edu"; // degrees + education (ASMS)
const OSRA_EMAIL = "osra-operations@med.cornell.edu";
const OSRA_CC = "scholars@weill.cornell.edu";

/** The scholar fixes it themselves in the owning tool. */
export type SelfServiceAction = {
  kind: "self-service";
  tool: string;
  /** May contain `{cwid}`, substituted at render. */
  href: string;
  instruction: string;
};

/**
 * Email the owning office. No deep-linking exists, so this is a prefilled
 * `mailto:` composed at render (the item's identity goes in the body; the exact
 * subject/body format is deferred — see the spec). `note` carries a derivation
 * or caveat shown before the user sends.
 */
export type RouteAction = {
  kind: "route";
  office: string;
  email: string;
  cc?: string;
  sourceSystem: string;
  note?: string;
};

/** Not an error, or not fixable here — explain in place. */
export type ExplainAction = {
  kind: "explain";
  detail: string;
  fallbackEmail?: string;
};

export type ChangeAction = SelfServiceAction | RouteAction | ExplainAction;

export type ChangeIssue = {
  /** Stable id (never shown to the user). */
  id: string;
  /** The picker option text. */
  label: string;
  action: ChangeAction;
};

export type RequestAttribute =
  | "name-title"
  | "photo"
  | "appointments"
  | "education"
  | "funding"
  | "publications";

export type AttributeChangeConfig = {
  heading: string;
  issues: ChangeIssue[];
};

const route = (over: Omit<RouteAction, "kind">): RouteAction => ({ kind: "route", ...over });
const selfService = (over: Omit<SelfServiceAction, "kind">): SelfServiceAction => ({
  kind: "self-service",
  ...over,
});
const explain = (over: Omit<ExplainAction, "kind">): ExplainAction => ({ kind: "explain", ...over });

export const REQUEST_A_CHANGE: Record<RequestAttribute, AttributeChangeConfig> = {
  "name-title": {
    heading: "What needs to change?",
    issues: [
      {
        id: "name-wrong",
        label: "My name or preferred name is wrong",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          instruction:
            "Update the Preferred Name field in Web Directory. Changes reach Scholars within about 24 hours.",
        }),
      },
      {
        id: "title-wrong",
        label: "My title is wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "primary appointment (ASMS / Enterprise Directory)",
          note: "Your title is the title of your primary appointment, sourced from ASMS / Enterprise Directory.",
        }),
      },
      {
        id: "department-wrong",
        label: "My department is wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "primary appointment (ASMS / Enterprise Directory)",
          note: "Your department is the department of your primary appointment.",
        }),
      },
      {
        id: "division-wrong",
        label: "My division is wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "primary appointment (ASMS / Enterprise Directory)",
          note: "Your division is the division of your primary appointment's department.",
        }),
      },
      {
        id: "email-wrong",
        label: "My email is wrong",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          instruction: "Update the Primary email field in Web Directory.",
        }),
      },
      {
        id: "email-hide",
        label: "I don't want my email shown publicly",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          instruction:
            "In Web Directory, set your email's “Publish to” to “Institution only”.",
        }),
      },
      {
        id: "degrees-wrong",
        label: "My degrees or post-nominals are wrong or missing",
        action: route({
          office: "Office of Faculty Affairs",
          email: FACULTY_AFFAIRS_EMAIL,
          sourceSystem: "ASMS (faculty system of record)",
          note: "Your degree list is sourced from ASMS and imported into Enterprise Directory.",
        }),
      },
      {
        id: "orcid-wrong",
        label: "My ORCID is wrong or missing",
        action: selfService({
          tool: "ReCiter",
          href: ORCID_MANAGE_URL,
          instruction: "Manage your ORCID in ReCiter.",
        }),
      },
    ],
  },
  photo: {
    heading: "What needs to change?",
    issues: [
      {
        id: "photo-wrong",
        label: "My photo is wrong, outdated, or missing",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          instruction:
            "In Web Directory, go to the Profile Picture section to add, update, or remove your photo. Updates are immediate.",
        }),
      },
      {
        id: "photo-hide",
        label: "I don't want my photo shown publicly",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          instruction:
            "In Web Directory → Profile Picture, set “Publish to” to “Institution”. Updates are immediate.",
        }),
      },
    ],
  },
  appointments: {
    heading: "What needs to change?",
    issues: [
      {
        id: "appointment-title-wrong",
        label: "An appointment's title is wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ASMS / Enterprise Directory",
          note: "This may be an ASMS or Enterprise Directory source-data issue.",
        }),
      },
      {
        id: "appointment-missing",
        label: "An academic appointment is missing",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Enterprise Directory",
          note: "Scholars shows only approved appointments. If yours is approved and still missing, contact support.",
        }),
      },
      {
        id: "appointment-dates-wrong",
        label: "An appointment's dates are wrong (it shows active but I've left)",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ASMS / Enterprise Directory",
          note: "This may be an ASMS or Enterprise Directory source-data issue. You can also Hide it here to clear the display while it's corrected.",
        }),
      },
      {
        id: "appointment-not-mine",
        label: "This isn't my appointment",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ASMS / Enterprise Directory",
          note: "Hiding it here won't correct the source — support will fix the record.",
        }),
      },
      {
        id: "appointment-chair-ended",
        label: "A chair role is shown but has ended",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Enterprise Directory + chair detection",
          note: "A chair role can't be hidden here; it's corrected at the source.",
        }),
      },
    ],
  },
  education: {
    heading: "What needs to change?",
    issues: [
      {
        id: "education-wrong",
        label: "A degree, field, institution, or year is wrong",
        action: route({
          office: "Office of Faculty Affairs",
          email: FACULTY_AFFAIRS_EMAIL,
          sourceSystem: "ASMS",
          note: "Education is sourced from ASMS and corrected there.",
        }),
      },
      {
        id: "education-missing",
        label: "An education or training entry is missing",
        action: route({
          office: "Office of Faculty Affairs",
          email: FACULTY_AFFAIRS_EMAIL,
          sourceSystem: "ASMS",
          note: "Education is sourced from ASMS and corrected there.",
        }),
      },
      {
        id: "education-duplicate",
        label: "An entry is duplicated",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ASMS import",
          note: "This is likely an import error — include a screenshot. You can also Hide the duplicate here in the meantime.",
        }),
      },
      {
        id: "education-not-mine",
        label: "This isn't my education",
        action: route({
          office: "Office of Faculty Affairs",
          email: FACULTY_AFFAIRS_EMAIL,
          sourceSystem: "ASMS",
          note: "Hiding it here won't correct the source — Faculty Affairs will fix the record in ASMS.",
        }),
      },
    ],
  },
  funding: {
    heading: "What needs to change?",
    issues: [
      {
        id: "funding-wrong",
        label: "A grant's title, sponsor, dates, or role is wrong",
        action: route({
          office: "OSRA",
          email: OSRA_EMAIL,
          cc: OSRA_CC,
          sourceSystem: "InfoEd",
          note: "Funding is sourced from InfoEd; OSRA corrects the record.",
        }),
      },
      {
        id: "funding-missing",
        label: "A grant is missing",
        action: route({
          office: "OSRA",
          email: OSRA_EMAIL,
          cc: OSRA_CC,
          sourceSystem: "InfoEd",
          note: "Funding is sourced from InfoEd; OSRA corrects the record.",
        }),
      },
      {
        id: "funding-active-expired",
        label: "A grant shows Active but looks expired",
        action: explain({
          detail:
            "A grant stays Active for up to 12 months past its end date (a no-cost-extension grace window). This is usually correct.",
          fallbackEmail: OSRA_EMAIL,
        }),
      },
      {
        id: "funding-not-mine",
        label: "I shouldn't be listed on this grant",
        action: route({
          office: "OSRA",
          email: OSRA_EMAIL,
          cc: OSRA_CC,
          sourceSystem: "InfoEd",
          note: "Hiding it here won't correct InfoEd; OSRA fixes the investigator list so it stops appearing on funding reports.",
        }),
      },
    ],
  },
  publications: {
    heading: "What needs to change?",
    issues: [
      {
        id: "publication-not-mine",
        label: "A publication isn't mine / is wrongly attributed",
        action: selfService({
          tool: "Publication Manager",
          href: PUBLICATION_MANAGER_URL,
          instruction:
            "Don't just hide it. Log into Publication Manager and reject the article so it isn't misattributed in other venues. The correction reaches Scholars within about 24 hours.",
        }),
      },
      {
        id: "publication-missing-pubmed",
        label: "A PubMed publication of mine is missing",
        action: selfService({
          tool: "Publication Manager",
          href: PUBLICATION_MANAGER_URL,
          instruction: "Claim it in Publication Manager.",
        }),
      },
      {
        id: "publication-missing-nonpubmed",
        label: "A non-PubMed publication of mine is missing",
        action: explain({
          detail:
            "Scholars and ReCiter only support PubMed-indexed publications, so works outside PubMed can't be imported or displayed.",
        }),
      },
      {
        id: "publication-metadata-wrong",
        label: "A publication's title, journal, year, or authors are wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ReCiter / PubMed / publisher",
          note: "The metadata may originate in ReCiter, PubMed, or the publisher; support can help trace it.",
        }),
      },
      {
        id: "publication-duplicate",
        label: "A publication is duplicated",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "ReCiter import",
          note: "Likely an import issue — send a ticket with details.",
        }),
      },
    ],
  },
};

/** The issue list + heading for one attribute. */
export function getChangeConfig(attr: RequestAttribute): AttributeChangeConfig {
  return REQUEST_A_CHANGE[attr];
}

/** Substitute `{cwid}` in a self-service href (ORCID). */
export function resolveSelfServiceHref(href: string, cwid: string): string {
  return href.replace("{cwid}", encodeURIComponent(cwid));
}
