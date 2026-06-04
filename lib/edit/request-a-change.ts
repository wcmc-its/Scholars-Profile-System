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
 *     non-PubMed publications). Say so in place rather than route a junk ticket;
 *     for a true dead-end, state what WILL happen (e.g. auto-pickup if later
 *     indexed in PubMed) and acknowledge with "Got it" — never imply a request
 *     was filed.
 *
 * Each action carries a `cta` — the on-select footer verb (e.g. "Add by PMID",
 * "Report correction"), so the primary button names the actual next step
 * instead of a generic "Open"/"Submit". Phase 1 honors the no-deep-link rule:
 * the verb opens the tool's front door (or composes the email) and the callout
 * gives the precise step; true in-modal actions (a ReCiter feedback POST) wait
 * for Phase 2.
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
/** Weill Research Gateway (WRG) — the system of record for conflict-of-interest
 *  disclosures. A scholar manages their own disclosures there; Scholars only
 *  mirrors them read-only, so the "Request a change" path is a self-service
 *  external link, never a mailto / ticket (same shape as ORCID→ReCiter). */
const WEILL_RESEARCH_GATEWAY_URL = "https://wrg.weill.cornell.edu";
/** Publication Manager (ReCiter) front door — the single source of truth for
 *  the "reject a misattributed paper at the source" link, reused by the
 *  publications "Request a change" path and the first-hide notice (#570). */
export const PUBLICATION_MANAGER_URL = "https://reciter.weill.cornell.edu/";
/** ORCID self-management; `{cwid}` is substituted by the panel at render. */
const ORCID_MANAGE_URL = "https://reciter.weill.cornell.edu/manageprofile/{cwid}";

const SUPPORT_EMAIL = "support@med.cornell.edu"; // ITS — ED/ASMS source data, appointments, imports (catch-all)
const FACULTY_AFFAIRS_EMAIL = "facultyaffairs@med.cornell.edu"; // degrees + education (ASMS)
const OSRA_EMAIL = "osra-operations@med.cornell.edu";
const OSRA_CC = "scholars@weill.cornell.edu";

/** The scholar fixes it themselves in the owning tool. */
export type SelfServiceAction = {
  kind: "self-service";
  tool: string;
  /** May contain `{cwid}`, substituted at render. */
  href: string;
  instruction: string;
  /** On-select footer verb. Defaults to `Open {tool}`. */
  cta?: string;
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
  /** On-select footer verb. Defaults to `Email {office}`. */
  cta?: string;
};

/** Not an error, or not fixable here — explain in place. */
export type ExplainAction = {
  kind: "explain";
  detail: string;
  fallbackEmail?: string;
  /** On-select footer verb. Defaults to "Got it" (a dead-end acknowledgement). */
  cta?: string;
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
  | "publications"
  | "org-unit"
  | "coi"
  | "mentees"
  | "profile-url";

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
          cta: "Update in Web Directory",
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
          cta: "Update in Web Directory",
          instruction: "Update the Primary email field in Web Directory.",
        }),
      },
      {
        id: "email-hide",
        label: "I don't want my email shown publicly",
        action: selfService({
          tool: "Web Directory",
          href: WEB_DIRECTORY_URL,
          cta: "Update in Web Directory",
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
          cta: "Manage in ReCiter",
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
          cta: "Update in Web Directory",
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
          cta: "Update in Web Directory",
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
        label: "Isn't mine / wrongly attributed",
        action: selfService({
          tool: "Publication Manager",
          href: PUBLICATION_MANAGER_URL,
          cta: "Flag as not mine",
          instruction:
            "Don't just hide it. Reject the article in Publication Manager so it isn't misattributed in other venues too. The correction reaches Scholars within about 24 hours.",
        }),
      },
      {
        id: "publication-missing-pubmed",
        label: "A PubMed publication of mine is missing",
        action: selfService({
          tool: "Publication Manager",
          href: PUBLICATION_MANAGER_URL,
          cta: "Add by PMID",
          instruction:
            "Claim it in Publication Manager by its PubMed ID. It reaches Scholars within about 24 hours.",
        }),
      },
      {
        id: "publication-missing-nonpubmed",
        label: "A non-PubMed publication of mine is missing",
        action: explain({
          detail:
            "Scholars and ReCiter only index PubMed publications, so this one can't be displayed here. If it's added to PubMed later, ReCiter picks it up automatically — no action needed.",
        }),
      },
      {
        id: "publication-metadata-wrong",
        label: "Title, journal, year, or authors are wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          cta: "Report correction",
          sourceSystem: "ReCiter / PubMed / publisher",
          note: "This data comes from PubMed, the authoritative record at NLM. We'll flag it with ITS Support, but the correction flows from the source — it can't be edited in Scholars directly.",
        }),
      },
      {
        id: "publication-duplicate",
        label: "This publication is duplicated",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          cta: "Flag duplicate",
          sourceSystem: "ReCiter import",
          note: "Likely an import error — include the duplicate's details so support can merge it.",
        }),
      },
    ],
  },
  // #728 Phase D § 4.6 — org units are created by Scholars superusers; everyone
  // else asks ITS to route the request via the existing #160 mailer. One issue:
  // the proposed unit travels in the request's `itemId` + `detail` (server-side
  // recipient resolution; no new mailbox — SUPPORT_EMAIL).
  "org-unit": {
    heading: "What would you like to request?",
    issues: [
      {
        id: "request-new-org-unit",
        label: "Request a new org unit (department, division, or center)",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Enterprise Directory / Scholars",
          cta: "Request a new org unit",
          note: "New org units are created by Scholars superusers. Describe the unit (name, type, parent department) and we'll route it.",
        }),
      },
    ],
  },
  // Conflicts of interest are read-only here — they're managed by the scholar in
  // the Weill Research Gateway (WRG), the system of record. So every "issue" is
  // a self-service link back to WRG (no mailto / ticket; mirrors ORCID→ReCiter).
  coi: {
    heading: "What needs to change?",
    issues: [
      {
        id: "coi-wrong",
        label: "A disclosure is wrong, outdated, or missing",
        action: selfService({
          tool: "Weill Research Gateway",
          href: WEILL_RESEARCH_GATEWAY_URL,
          cta: "Manage in Weill Research Gateway",
          instruction:
            "Conflict-of-interest disclosures are managed in the Weill Research Gateway. Update or add a disclosure there; the change reaches Scholars on the next refresh.",
        }),
      },
      {
        id: "coi-not-mine",
        label: "A disclosure listed here isn't mine",
        action: selfService({
          tool: "Weill Research Gateway",
          href: WEILL_RESEARCH_GATEWAY_URL,
          cta: "Review in Weill Research Gateway",
          instruction:
            "Review your disclosures in the Weill Research Gateway and correct them at the source. Scholars mirrors WRG and can't edit the record directly.",
        }),
      },
    ],
  },
  // Mentees are derived from MD/PhD/postdoc training records. There's no
  // deep-linkable owning tool, so corrections route to ITS Support, which fixes
  // the source (Jenzabar or Employee Central). Hiding a mentee is the SEPARATE
  // per-row control on the panel — not an issue type here.
  mentees: {
    heading: "What needs to change?",
    issues: [
      {
        id: "mentee-not-mine",
        label: "Someone listed isn't my mentee",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Jenzabar or Employee Central",
          note: "Mentee relationships come from Jenzabar or Employee Central. Hiding the entry here won't correct the source — support will fix the record. (You can Hide it here in the meantime.)",
        }),
      },
      {
        id: "mentee-missing",
        label: "A mentee of mine is missing",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Jenzabar or Employee Central",
          note: "Mentee relationships come from Jenzabar (MD/PhD trainees) or Employee Central (postdocs). Support can check why a relationship isn't appearing.",
        }),
      },
      {
        id: "mentee-details-wrong",
        label: "A mentee's program, year, or details are wrong",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Jenzabar or Employee Central",
          note: "These details come from Jenzabar or Employee Central and are corrected at the source.",
        }),
      },
    ],
  },
  // Profile URL is OWNED by Scholars (not a sourced field). Personalized-URL
  // requests funnel to ITS Support — the Scholars support catch-all, one of the
  // three approved mailboxes — while the self-service slug-request flow is gated
  // (`SELF_EDIT_SLUG_REQUEST`). A request-only pseudo-attribute like `org-unit`.
  "profile-url": {
    heading: "Request a personalized URL",
    issues: [
      {
        id: "profile-url-personalize",
        label: "I'd like a personalized profile URL",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Scholars",
          note: "Personalized URLs aren't self-service. Tell us the name-based address you'd like — a variation of your own first and last name, using lowercase letters, numbers, and hyphens — and we'll set it up. Your current address keeps working.",
          cta: "Request a personalized URL",
        }),
      },
      {
        id: "profile-url-incorrect",
        label: "My current URL is wrong or broken",
        action: route({
          office: "ITS Support",
          email: SUPPORT_EMAIL,
          sourceSystem: "Scholars",
          note: "Tell us what's wrong with your current address and we'll look into it.",
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
