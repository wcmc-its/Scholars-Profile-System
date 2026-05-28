# Feedback badge — SPEC

**Status:** Draft
**Date:** 2026-05-28
**Authors:** Scholars Profile System development team
**Implements:** [#538](https://github.com/wcmc-its/Scholars-Profile-System/issues/538) — site-wide feedback badge → form
**Complements (does not replace):** [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) / [`docs/feedback-handling-matrix.md`](./feedback-handling-matrix.md) — the field-scoped "Request a change" corrections flow. This SPEC is the **general-feedback** counterpart; corrections continue to route through `/edit` → Request a change.
**Related:** [#506](https://github.com/wcmc-its/Scholars-Profile-System/issues/506) Gate D (launch KB), [#514](https://github.com/wcmc-its/Scholars-Profile-System/issues/514) (corrections routing matrix).

---

## Purpose

A site-wide opt-in feedback channel that captures usability, perceived accuracy, sentiment, and missing-affordance signal — the long-tail feedback that does **not** fit the field-scoped corrections shape. The instrument is designed so the accumulating dataset is publishable as program-evaluation work, not just operationally useful for triage.

**v1 is deliberately lightweight.** Submissions are **anonymous by default**: no session-derived identity, no IP/UA fingerprinting, no rate-limit. CWID is a single optional form field — pre-filled when a session happens to exist, but never tied to a server-captured identity. Friction is the enemy of long-tail feedback; we accept a higher floor of low-quality input in exchange for a higher ceiling of total response.

The form also points the user at the *right* tool for the *common* case: if they're a scholar with something specific wrong on their profile, the in-form callout sends them to `/edit` (which handles SSO) rather than letting them type the correction into a research-data table where it will never be acted on.

### Two modes, not one form

The form has **two epistemically distinct modes** that produce different question sets, different copy, and different analytical interpretation:

| Mode | Launched from | "This page" exists? | Accuracy / per-page usefulness ask? |
|---|---|---|---|
| **Contextual** | Badge click on a profile / unit / topic / search / `/edit` page. The originating URL + matched route are known. | Yes — a specific scholar, department, etc. | Yes — and the row is forensically actionable ("Jane Doe's profile, accuracy=1, 'pubs 7-9 aren't hers'"). |
| **Generic** | Direct nav to `/about/feedback`, the footer link, or an emailed share. No originating URL. | No. | **No.** Accuracy and per-page usefulness questions are hidden. Replaced with "Scholars overall" framing for the questions that still make sense. |

Conflating the two — letting someone rate "accuracy = 1" on `/about/feedback` without an anchor page — contaminates the dataset. A patient browsing in from the footer cannot answer "accuracy" against any specific content; the score that lands in the row is noise. The split is a **correctness property** of the instrument, not a UX nicety.

**Q1 (purpose of visit) drives further branching within each mode.** A patient looking up a clinician cannot assess whether the publication list is correct; a faculty member evaluating Scholars can. The accuracy question is gated on (mode = contextual) AND (Q1 ∈ a small set of intent values) — see [§ Q1 as the branching key](#q1-as-the-branching-key).

This SPEC is the artifact reviewers — Scholars project lead, IRB, library research-data stewards — sign off before the badge ships. It locks the question instrument (every question change after data collection starts costs analyzability), the data-handling rules, the access controls, and the rollout gate. It does not relitigate whether to build the feature; the issue settled that.

What this SPEC settles that the issue left open:

1. The **six open questions** in #538 — every one is given a v1 answer in [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions).
2. The **lightweight-mode pivot** away from the issue body's "server-captured CWID + rate-limit + tamper-proof URL" framing — the issue body presumed a heavier instrument; we are shipping the lighter one. The trade-offs are named in the table at [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions).
3. The **rollout gate**: a feature flag plus an explicit IRB-determination precondition, so the build can land merged-but-dark and ship only when the determination is on file.
4. The **file layout** under `app/`, `components/`, `lib/` — written to fit the existing patterns (`/edit/request-change`, `components/edit/`, server-action + Prisma).

It does not redesign the question wording — that is locked from the issue verbatim. It does not introduce analytics tooling beyond the submission table itself.

---

## Scope and non-goals

### In scope

- A badge fixed bottom-right of the viewport, visible on every public Scholars page **and** every `/edit/*` page, suppressed inside modal overlays.
- A feedback form at the linkable route `/about/feedback`, openable as a modal from the badge.
- Server-side capture of `(originating page URL, timestamp)`. CWID is **user-typed** in an optional form field — pre-filled from the session when one exists, but never independently captured.
- A `FeedbackSubmission` table populated by the form's server action.
- An in-form **viewer-correct sign-in-to-edit callout** that links to `/edit` (SSO-gated) — see [§ Sign-in-to-edit callout](#sign-in-to-edit-callout).
- A role-gated CSV export endpoint for authorized analysts.
- Versioned consent text, with the accepted version stored alongside each submission.
- A feature flag (`FEEDBACK_BADGE_ENABLED`) gating both the badge and the form route.

### Out of scope for v1 (could land in v2)

- **Rate-limiting.** v1 has no per-user, per-page, or per-IP cap. The form is unauthenticated and the table is append-only; if abuse appears, [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) — Q5 names the v2 path.
- **Server-captured identity.** The session CWID convenience-prefills the optional CWID field; the server does **not** override or independently record the session identity. A respondent can type any CWID (or none).
- **Tamper-proof originating URL.** The URL is sent from the client and re-validated server-side only as "looks like a Scholars URL"; it is not HMAC-bound to the session.

### Out of scope (and where each goes instead)

| Out of scope | Where it goes |
|---|---|
| Site-wide intercept survey (auto-popup, modal interruption). | A different product with a different invasiveness budget. Not this SPEC, not a follow-on without explicit governance review. |
| Replacement of `/edit` "Request a change". | Field-scoped corrections continue through that flow; this SPEC is the **general-feedback** complement. See [`docs/feedback-handling-matrix.md`](./feedback-handling-matrix.md). |
| Real-time analytics dashboard. | CSV export is v1. A dashboard, if there is appetite, is a follow-on issue. |
| A/B testing the question set on live users. | Forbidden until IRB sign-off on the variant. Any question-text change is a protocol amendment, not a code change. |
| Email digest of each submission to project lead. | Offline cron job reading the table on a configurable cadence; not part of the badge build. Follow-on if desired. |
| Webhook to ServiceNow. | Different system, different category of work — feedback is research data, corrections are tickets. |
| Outbound reply to a Q10-opt-in respondent from the app. | Out-of-band, coordinated by the Scholars project lead. The app records the opt-in flag and exposes it in the CSV; it does not send. |
| Inline "Was this helpful?" thumbs on individual surfaces. | Different product (per-surface micro-feedback). Not the badge. |

---

## Surfaces

### The badge

| Property | Value |
|---|---|
| **Component** | `components/site/feedback-badge.tsx` |
| **Placement** | Fixed, bottom-right of viewport. Tailwind: `fixed bottom-4 right-4 z-40` (one tier below dialog z, so the suppression rule below works). |
| **Default state** | Icon (chat / speech-bubble) + label "Feedback". Muted background; low visual weight. Tokens: `bg-muted text-muted-foreground border border-border`. |
| **Hover** | Tooltip "Help us improve Scholars." Slight color brightening; cursor `pointer`. |
| **Click** | Opens the feedback form as a modal (see [Form route + modal](#form-route--modal)). |
| **Visibility scope** | Every public page AND every `/edit/*` page. Suppressed inside any open Radix `Dialog` overlay — implemented via a small `FeedbackBadgeContext` that counts open dialogs; when count > 0 the badge returns `null`. |
| **Hidden on** | `/about/feedback` itself (would be a badge → form → badge loop), the post-submit confirmation page, and any error / 4xx / 5xx page. |
| **Auto-prompt** | **Never.** The badge is opt-in; there is no modal-survey interrupt, no scroll-triggered nudge, no time-on-page heuristic. |
| **Accessibility** | `aria-label="Open Scholars feedback form"`. Native `<button>`, keyboard-focusable, Enter / Space open. Focus visible via the existing focus-ring token. |
| **Reduced motion** | No animation on default state. Hover transition is opacity-only; respects `prefers-reduced-motion: no-preference`. |

### Form route + modal

| Property | Value |
|---|---|
| **Route** | `/about/feedback` — a real server-rendered page under `app/(public)/about/feedback/page.tsx`. Linkable, indexable internally, accessible directly. |
| **Modal trigger** | Badge click. The modal mounts the same form component the route renders, wrapped in Radix `Dialog`. Two surfaces, one form module — no duplication. |
| **Module layout** | `components/feedback/feedback-form.tsx` (the form itself, server-component with embedded client form), `components/feedback/feedback-modal.tsx` (the modal shell — client). |
| **Originating-page capture** | The page URL is set client-side from `window.location.href` (modal) or from the `Referer` header on direct-load (route), embedded in the form as a hidden `<input name="pageUrl">`. The server action **validates** the submitted URL against the configured site origin (`NEXT_PUBLIC_SITE_URL` and the production CloudFront origin) — anything off-origin or malformed is stored as `NULL`. This is "best-effort" — a hostile client could lie about the URL, which is the trade-off we accept for a lightweight, unauthenticated form. See [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) — Q4 for why this is the right floor for v1. |
| **Sign-in-to-edit callout** | Viewer-correct, conditionally shown — see [§ Sign-in-to-edit callout](#sign-in-to-edit-callout) below. The link target is `/edit`, which middleware handles (SAML redirect if no session; goes straight to the editor if there is one). |
| **Modal close** | ESC, overlay click, ✕ button. Closing without submitting discards the in-flight responses (no client-side draft persistence in v1). |
| **Confirmation** | After successful submit, the form replaces itself with a confirmation block: "Thank you. Your feedback has been recorded." plus a button "Return to <originating page>" that deep-links back. In the route surface, the confirmation is a full page render; in the modal, it replaces the form inside the dialog and the dialog auto-closes after 4 seconds (or user dismisses). |
| **Error path** | Submission failures show the form with an inline error banner (`role="alert"`). Validation errors highlight the offending field. There is no rate-limit response — see [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) — Q5. |
| **No login wall** | The form is reachable anonymous. The optional CWID field is pre-filled when a session already exists; the form does **not** redirect to SAML, and the submission server action does not override the user-typed CWID with a session-derived one. |

### Surfaces table — explicit decisions

| Surface | Badge visible? | Why |
|---|---|---|
| Homepage `/` | ✅ | Default. |
| `/scholars/[slug]` | ✅ | The page Q3 (usefulness) and Q4 (accuracy) are most directly about. |
| `/departments/[slug]`, `/divisions/[slug]`, `/centers/[slug]` | ✅ | Browse surfaces; Q1 segment "browsing a department" anchored here. |
| `/topics/[slug]` | ✅ | |
| `/search`, `/browse` | ✅ | |
| `/edit/*` | ✅ | The issue is explicit: visible on `/edit` views. A scholar's frustration with the editor is exactly the signal Q3 (usefulness, low tail) and Q2a (task-failure intent) want to catch. |
| Inside an open `Dialog` (e.g. publication detail modal, edit dialogs) | ❌ | Suppressed via `FeedbackBadgeContext`. Prevents stacking on top of the modal the user came to interact with. |
| `/about/feedback` | ❌ | Self-loop. |
| `/about/feedback?submitted=…` confirmation | ❌ | Don't ask for feedback about the feedback flow inside the feedback flow. |
| 4xx / 5xx error pages, `not-found.tsx` | ❌ | No coherent originating-page context. |

### Sign-in-to-edit callout

A small banner inside the form that routes profile-owner corrections to `/edit` (SSO-gated) instead of letting them accumulate as untriaged feedback rows. Earlier drafts assumed the viewer of a profile page owns that profile — wrong for two-thirds of the audience segments the form addresses. A patient or journalist viewing Dr. Park's profile *cannot* edit it; sending them to `/edit` would land them on their own different profile, on a 403, or on the SAML wall. The callout was actively misleading.

The v1.1 callout is **viewer-correct** by self-selection: it asks a question only the profile owner can answer "yes" to, so non-owners ignore it without being confused.

| Property | Locked value |
|---|---|
| **Copy** | *"Is this your profile? If the profile is about you, you can sign in and edit it directly — corrections to your own profile are faster than general feedback. [Sign in to edit →](/edit)"* The interrogative form is load-bearing: a non-owner reads "no" and moves on; an owner reads "yes" and clicks. |
| **When shown** | **Only** when `mode = contextual` AND `pageRoute = '/scholars/[slug]'`. |
| **When hidden** | Generic mode, dept / division / center / topic / search / browse / `/edit/*` / homepage. On non-profile contextual surfaces, there is no specific person to be "this is about," so the question is incoherent. On `/edit/*` the user is already authenticated and editing — the callout is redundant. |
| **No identity inference** | The callout does **not** read the session CWID or compare it to the profile slug's owner. We considered surfacing a confident "Edit your profile" variant when `session.cwid` matches the profile owner, and rejected it: it adds DB lookups + edge-case handling for a marginal UX win, and the self-selecting question works for everyone. |
| **Routes through middleware** | `/edit` is intercepted by `middleware.ts`, which SAML-redirects unauthenticated visitors and lands authenticated profile owners on their own editor. The callout does not need to know the auth state. |

---

## The question instrument — locked v1

**Question wording, scale points, and rationales** for the originally-issued questions trace back to [#538 § Questions](https://github.com/wcmc-its/Scholars-Profile-System/issues/538). The instrument has been substantially restructured in spec review — the v1 form is **intent-gated and mode-gated**, not the flat 8-question survey the issue body envisioned. The changes were driven by an external survey-design review (see [§ Spec-review revisions](#spec-review-revisions) for the audit trail).

**DB column naming note.** The schema uses **intent-based** column names (`usefulness`, `accuracy`, `what_helped`); the SPEC labels use Q-positions purely as cross-reference. Form position has changed three times in spec review; coupling DB columns to it is a maintenance trap.

### The full question set

| Q# | Question | DB column | Always shown? | Gated by |
|---|---|---|---|---|
| **Q1 — Purpose of visit** | `purpose`, `purpose_other` | ✅ | — |
| **Q2 — Task success** | `task_success` | ✅ | — |
| **Q2a — What were you trying to find?** *(NEW conditional)* | `task_failure_intent` (`VARCHAR(500)`) | Conditional | Revealed when `task_success ∈ {no, partially}`. The highest-information textarea on the form — failure-to-find is where discovery/search work lives. Same sanitize + 500-char bound as other textareas. |
| **Q3 — Usefulness** (5-pt Likert + N/A) *"How useful was this page to you?"* | `usefulness` | Contextual mode only | Hidden in generic mode (no anchor page to rate). |
| **Q3a — What worked well?** *(was Q4)* | `what_helped` | Conditional | Revealed when `usefulness ∈ {4, 5}` — praise tail. Copy reads "You rated this highly — what worked well?" |
| **Q3b — What was missing or didn't help?** *(NEW conditional, low tail)* | `what_missing` (`VARCHAR(500)`) | Conditional | Revealed when `usefulness ∈ {1, 2}` — frustration tail. The actionable signal the original SPEC was throwing away. Copy reads "Tell us what wasn't useful so we can improve it." `usefulness = 3` reveals neither (deliberate). |
| **Q4 — Accuracy** (5-pt Likert + N/A) *"How accurate did the information on this page appear?"* | `accuracy` | Contextual mode AND Q1 gate | Shown only when `mode = contextual` AND `purpose ∈ {lookup_person, lookup_topic, research_story, evaluate_scholars, other, unanswered}`. Hidden for `purpose = browse_unit` (browsers of a dept page cannot assess accuracy of its faculty roster) and for `mode = generic`. |
| **Q4a — What would you change to make this page more accurate?** *(was Q6)* | `one_change` | Conditional | Revealed when `accuracy ∈ {1, 2, 3}` AND Q4 was shown at all. The complaint prompt. |
| **Q5 — Would you use Scholars again?** *(replaces NPS, see below)* | `would_use_again` (`tinyint`, 1–5 or NULL) | ✅ | 5-point scale: definitely not / probably not / unsure / probably / definitely. **Replaces the NPS question** the issue body proposed — NPS's "recommend to a colleague" framing is semantically broken for the patient / journalist / public segments we explicitly list and it presumes choice / competition / word-of-mouth dynamics that don't apply to an institutional system. "Would you use again" measures intent without those presumptions, works for every audience segment, and still gives a continuous Likert that aggregates cleanly. **Locked 2026-05-28** — see [§ Architectural decisions](#architectural-decisions-locked-2026-05-28). |
| **Q6 — Respondent context** *(was Q8)* | `role`, `role_other` | ✅ | Pre-selected from `scholar.roleCategory` ([§ Q6 inference table](#q6-inference-from-rolecategory)) when a session exists. Always user-editable. The "Other" branch is a 100-char text field. |
| **Q7 — Consent** *(was Q9)* | `consent`, `consent_version` | ✅ | Required. Submission blocked client-side AND server-side if false. |
| **Q8 — Optional contact + follow-up opt-in** *(was Q10)* | `cwid`, `contact_email` (`VARCHAR(255)`), `followup_optin` | ✅ | See [§ Contact + follow-up](#contact--follow-up). |

### Q1 as the branching key

Q1 (purpose of visit) is **not a demographic** — it is the form's primary branching key, deciding which downstream questions appear. The matrix:

| Q1 purpose | Q3 usefulness shown? | Q4 accuracy shown? |
|---|---|---|
| `lookup_person` | contextual ✅ · generic ✅ | contextual ✅ · generic ❌ |
| `lookup_topic` | contextual ✅ · generic ✅ | contextual ✅ · generic ❌ |
| `browse_unit` | contextual ✅ · generic ✅ | ❌ (both modes — browsers of a dept page can't assess accuracy of its faculty roster) |
| `research_story` | contextual ✅ · generic ✅ | contextual ✅ · generic ❌ |
| `evaluate_scholars` | contextual ✅ · generic ✅ | contextual ✅ · generic ❌ (see rule below — diffuse accuracy is a category error) |
| `other` / unanswered | contextual ✅ · generic ✅ | contextual ✅ · generic ❌ |

**Rule**: a question never appears unless every gate condition passes. Generic mode hides accuracy **regardless of Q1**, including `evaluate_scholars`. Contextual mode further gates accuracy on Q1.

**Why `evaluate_scholars` doesn't override the generic-mode accuracy suppression.** An evaluator (CIO, vendor procurement, departmental tech lead) does form an informed opinion about Scholars' overall accuracy — but accuracy is **intrinsically a claim about something**, and without a specific anchor page the claim collapses into sentiment. We already have sentiment via Q5 (would-use-again) and Q3b (what was missing). A diffuse "accuracy = 2, in your experience" produces less actionable signal than "Jane Doe's profile, accuracy = 1, pubs 7-9 aren't hers" from a contextual submission, and worse, it muddies the analytical column — `AVG(accuracy)` across both modes is a category error, and silently mixing them produces wrong dashboards. Evaluators who want to call out accuracy specifically have the better path of clicking the badge while they're on the profile pages they were already inspecting.

**Why usefulness *isn't* suppressed in generic mode by the same logic.** Usefulness has a defensible diffuse reading ("did Scholars seem useful overall?") because utility is itself a global judgment. Accuracy is referent-bound; usefulness isn't. The asymmetry is deliberate.

### Path lengths

For respondents who only see what their Q1 + Q2 + Likerts surface (no opens), the form is genuinely short:

- **Patient looking up a clinician, generic mode** (footer link): Q1, Q2, Q5, Q6, Q7, Q8 → **6 questions, 0 textareas**.
- **Faculty member evaluating Scholars, contextual mode, scores everything high**: Q1, Q2, Q3, Q3a, Q4, Q5, Q6, Q7, Q8 → 9 questions, 1 textarea.
- **Reporter on a profile page, found what they needed but spotted errors** (Q1 = research_story, contextual): Q1, Q2, Q3, Q4, Q4a, Q5, Q6, Q7, Q8 → 9 questions, 1 textarea (the actionable one).
- **Faculty using `/edit`, task failed**: Q1, Q2, Q2a, Q3, Q3b, Q4, Q4a, Q5, Q6, Q7, Q8 → 11 questions, 3 textareas (all three actionable).

The form gets longer as the user has more to say, not as they have less.

### Contact + follow-up

The original SPEC had a CWID-only contact field — faculty-centric, excluded external researchers, journalists, and members of the public who might be the most valuable interview prospects. v1.x revision:

- The CWID field stays, pre-filled from session when present, validated against `^[a-z0-9]{2,16}$`, dropped to `NULL` if invalid.
- A `contact_email` field **reveals** when "I'd be willing to be contacted for a brief follow-up interview" is checked. The email field is `VARCHAR(255)`, server-validated against a minimal regex (must contain `@` with at least one char before and `.` after). Invalid emails drop to `NULL` and the submission succeeds (mirrors CWID's silent-drop behavior).
- The CWID is for WCM-internal follow-up; the email is for everyone else. They are not mutually exclusive — a CWID-bearing scholar can also leave an email if they prefer to be reached at a personal address.
- The follow-up checkbox is meaningful only if at least one of CWID or email is provided; helper text says so. If neither is provided and the checkbox is checked, the submission stores `followup_optin = true` with both contact columns `NULL` — the project lead reads it as "willing, but no contact path."

### Conditional follow-ups

Four open-ended questions reveal inline below their triggering question. All remain optional even when revealed. The set covers both **failure paths** (the actionable signal) and **success paths** (praise / wins worth preserving).

| Open-ended | Reveals when | Rationale |
|---|---|---|
| **Q2a — What were you trying to find?** | `task_success ∈ {no, partially}`. Hidden if Q2 = yes_completely / mostly / not_looking / unanswered. | The single highest-information question on the form. Failure-to-find is where the discovery + search work lives — this would have surfaced People-relevance issues a year ago if it had existed. The mostly/partially boundary is fuzzy; "partially" gates here because partial failure is still failure-information. |
| **Q3a — What worked well?** | `usefulness ∈ {4, 5}`. | Praise tail. Preserves wins; useful for leadership reporting and morale; lets analysts say "37% of high-usefulness respondents proactively praised feature X" in a publication. |
| **Q3b — What was missing or didn't help?** *(NEW low-tail probe)* | `usefulness ∈ {1, 2}`. | **Frustration tail — the actionable signal the original SPEC threw away.** The whole point of an improvement product is to ask unhappy users what's wrong. `usefulness = 3` ("Somewhat") reveals neither — neutral feedback doesn't produce specific complaints reliably. |
| **Q4a — What would you change to make this page more accurate?** | `accuracy ∈ {1, 2, 3}` AND Q4 was shown (mode + Q1 gate). | The complaint prompt. The "Mixed" score (3) gates here because mixed-accuracy = "something's wrong" in survey-methodology terms. |

**Reveal behavior:**

- Each conditional appears inline below its triggering question as soon as the user picks a qualifying score. Reveal is `display: block` toggle, no animation by default (respects `prefers-reduced-motion`; a 120 ms ease-out slide-in for users without that preference).
- If the user changes their Likert / task-success answer to a non-triggering value, the conditional is hidden **and** any typed text is **discarded**. Intentional: a praise note doesn't belong in a row where the user ultimately said the page was useless. The discard is silent — no warning dialog — because the rare edge case is better served by the user re-scoring.
- Server enforcement: the submission server action ignores each conditional column when its trigger predicate fails. A hostile client cannot stuff prose into a non-qualifying row.
- Empty-on-reveal is fine: the user can see the prompt and skip it. The column is `NULL` in that case, indistinguishable from "never revealed" — see [§ NULL semantics](#null-semantics-for-conditional-columns).

**On the threshold asymmetry between Q3 (usefulness) and Q4 (accuracy):**

- Q3 (usefulness) probes the **tails**: {1,2} and {4,5}. Neutral 3 reveals nothing.
- Q4 (accuracy) probes the **low half**: {1,2,3}. Neutral 3 reveals the complaint prompt; high {4,5} reveals nothing.

This is deliberate. Praise about *accuracy* doesn't tell us anything we can act on — "the publication list is correct" produces no operational signal. Praise about *usefulness* is project-evaluation signal worth preserving — "I found the dept page useful because of X" tells us what to keep. The asymmetry reflects what each construct can yield, not survey-design inconsistency.

### NULL semantics for conditional columns

Every conditional column (`task_failure_intent`, `what_helped`, `what_missing`, `one_change`) can be `NULL` for several distinct reasons. So can `usefulness` and `accuracy` themselves (mode + Q1 gating). Analysts must understand which reason applies before aggregating, or they will draw confidently wrong conclusions.

| Column | `NULL` reasons (in order of likelihood) | How to detect each |
|---|---|---|
| `mode` | (Never NULL — required column.) | — |
| `usefulness` | (1) Mode = generic, question not asked. (2) N/A clicked. (3) Skipped. | (1) `mode = 'generic'`. (2)/(3) indistinguishable; both → `usefulness IS NULL` with `mode = 'contextual'`. |
| `accuracy` | (1) Mode = generic. (2) Q1 gate failed (`purpose = browse_unit`). (3) N/A clicked. (4) Skipped. | (1) `mode = 'generic'`. (2) `mode = 'contextual' AND purpose = 'browse_unit'`. (3)/(4) indistinguishable. |
| `task_failure_intent` | (1) Q2 didn't qualify (success / mostly / not_looking / unanswered). (2) Q2 qualified, user skipped. | (1) `task_success NOT IN ('no', 'partially')`. (2) `task_success IN ('no','partially') AND task_failure_intent IS NULL`. |
| `what_helped` | (1) Q3 didn't qualify. (2) Q3 qualified, skipped. | (1) `usefulness NOT IN (4, 5)`. (2) `usefulness IN (4, 5) AND what_helped IS NULL`. |
| `what_missing` | (1) Q3 didn't qualify. (2) Q3 qualified, skipped. | (1) `usefulness NOT IN (1, 2)`. (2) `usefulness IN (1, 2) AND what_missing IS NULL`. |
| `one_change` | (1) Q4 not shown (mode = generic, or Q1 gated out, or skipped). (2) Q4 shown but accuracy ∉ {1,2,3}. (3) Q4 + accuracy qualified, user skipped. | Per-column compound predicate; the CSV export emits a `<col>_was_asked` synthetic boolean alongside each conditional column to spare analysts the predicate. |

Two rules of thumb downstream of this:

- **Never compute "response rate" on a conditional column as `COUNT(<col> IS NOT NULL) / total_rows`.** The denominator should be "rows where the column was asked." Use the `_was_asked` companion column emitted by the CSV export.
- **Never average `usefulness` across modes.** Generic-mode rows have `NULL` and are not "skipped 3s." Filter to `mode = 'contextual'` before any per-page metric.

### Q8 inference from `roleCategory`

Inference happens **only** when (a) a session is present at form-open time and (b) `scholar.roleCategory` is non-null. Otherwise the form opens with Q8 unselected. The session is read once at form-render (server-side); after that the form behaves identically for everyone — no client-side session calls, no re-fetch on submit.

| `roleCategory` (DB value, case-insensitive) | Q8 pre-selected option |
|---|---|
| `FULL_TIME_FACULTY`, `AFFILIATED_FACULTY`, `VOLUNTARY_FACULTY`, `ADJUNCT_FACULTY`, `COURTESY_FACULTY`, `FACULTY_EMERITUS`, `INSTRUCTOR`, `LECTURER` | "WCM faculty" |
| `POSTDOC`, `FELLOW`, `DOCTORAL_STUDENT`, `DOCTORAL_STUDENT_MD`, `DOCTORAL_STUDENT_PHD`, `DOCTORAL_STUDENT_MDPHD` | "WCM postdoc, fellow, or doctoral student" |
| `RESEARCH_STAFF`, `NON_FACULTY_ACADEMIC`, `NON_ACADEMIC` | "WCM staff or administrator" |
| `null` or any unmapped value | *(unselected)* |

The user-visible Q8 control is always editable; the inference is a default, not a constraint. The submission stores the *final* value the user chose, never the inferred one separately. (If we ever needed to distinguish "user accepted inference" from "user actively chose", that becomes a v2 telemetry question — recorded here as a non-blocker.)

### Sanitization and input bounds

Four free-text fields can carry user input: `purpose_other` (200), `what_helped` (500), `one_change` (500), `role_other` (100). For all four:

- The form posts the raw text; the server action **truncates to the documented limit before storage** and strips ASCII control characters except `\n` and `\t`.
- No HTML is ever rendered from these fields — they surface only in CSV export and the (future) analysis pipeline. The CSV writer quotes per RFC 4180 and escapes embedded `"`.
- Stored values are **not** Markdown, not HTML, not interpreted. The schema column is plain `Text`.
- A surviving null byte fails the submission with `400`.

---

## Resolving issue #538's open questions

The issue ends with six open questions. v1 answers below; revisit conditions where applicable. These resolutions are part of the spec sign-off — flag disagreement here, not after build.

| # | Question (issue § Open questions) | v1 decision |
|---|---|---|
| **Q1** | Q6 sub-segments for non-WCM-authenticated traffic — is the "inferred default, user can override" approach IRB-acceptable for the authenticated case? | The form **pre-selects** the (renumbered) Q8 option mapped from `scholar.roleCategory` (see [§ Q8 inference table](#q8-inference-from-rolecategory)) and **always lets the user change or clear it**. The consent text discloses both the inference rule and the user's right to change it. Submit to IRB as drafted; if IRB objects, fall back to an unprefilled Q8. |
| **Q2** | Page-conditional Q1 options. | **Defer to v2 / experimentation phase.** v1 uses the canonical Q1 list on every surface so the first dataset is cleanly aggregable across pages. A per-surface variant is a protocol amendment; we file it after the first six-month review identifies whether the generic list is uneven enough to warrant the cost. Hypotheses get a comment-only log in `docs/feedback-q1-hypothesis-log.md` (created on first hypothesis, not at PR-1). |
| **Q3** | NPS — keep, drop, or replace? | **Replaced** with "Would you use Scholars again?" (5-point Likert: definitely not / probably not / unsure / probably / definitely). External survey-design review correctly identified that NPS's "recommend to a colleague" framing is semantically broken for several of the audience segments we explicitly list (patient, journalist, member of the public) and presumes choice / competition / word-of-mouth dynamics that don't apply to an institutional system. Works for every audience segment, drops the cross-system benchmarkability earlier reviews valued. Locked 2026-05-28. |
| **Q4** | Anonymous-allowed for `/edit/*` pages? Surface "would you prefer anonymous?" in consent? | **Anonymous-by-default for every surface, including `/edit/*`.** The submission server action does **not** read or record the session CWID independently. The form has a single optional "CWID" field; on `/edit/*` (where a session is always present) this field is pre-filled for the user's convenience, but they can clear it and submit anonymously. The consent text discloses both the default (anonymous) and the pre-fill (when a session exists). This is the lightweight pivot away from the issue body's heavier framing — the trade-off is that retaliatory or low-quality anonymous feedback becomes easier; we accept that for the higher response ceiling. |
| **Q5** | Frequency cap. | **No rate-limit in v1.** The form is unauthenticated, the table is append-only, and the surface area for abuse is small (a single form, one row per submit). Adding rate-limit machinery (storage table, identity fingerprint, 429 handling) costs more than it saves at expected v1 volumes. Operational watch: if submissions exceed ~50/day or the same `one_change` text appears verbatim more than 3 times in a week, file a v2 to add a per-IP daily cap. Cap is *not* the first defense against bot spam — we add a simple invisible honeypot field in v1 (any non-empty value → silent 200 with no DB write). |
| **Q6** | Reporting cadence. | **Weekly automated digest email** to the Scholars project lead — a scheduled job (see [§ Weekly digest email](#weekly-digest-email)) emails a count + the new rows since the previous digest. Same SES pipeline as the #160 `request-change` mailer; reuse, not new infra. **Monthly internal summary** is the lead's existing operational rollup, sourced from the digests rather than from an ad-hoc CSV pull. **Quarterly aggregated report** to executive sponsors (Terrie, ITS leadership) — quarterly rather than the issue-proposed six-month so the report aligns with the WCM governance cycle. **Annual published report** if the dataset warrants. All cadences are documented in the IRB protocol. |

---

## Schema

A single new table, `feedback_submission`. No rate-limit table, no fingerprint columns.

```prisma
/// Site-wide general-feedback submissions from the bottom-right feedback
/// badge (#538). Distinct from /edit "Request a change" corrections (#160),
/// which write nothing to this table. One row per submitted form.
///
/// v1 is anonymous-by-default. `cwid` is user-typed (pre-filled from session
/// when present, but not server-enforced) — a `NULL` cwid is the common case,
/// not an error. All free-text columns are server-truncated to their
/// documented bounds before insert. `consent` is always true (the form
/// blocks submission otherwise); the column documents *which version* of
/// the consent text the respondent accepted.
///
/// Column names are intent-based (not Q-numbered) so reordering the form
/// in v1.x revisions doesn't drag a DB migration. See SPEC §
/// "The question instrument" for the rationale.
model FeedbackSubmission {
  id                  String   @id @default(uuid()) @db.VarChar(64)
  submittedAt         DateTime @default(now()) @map("submitted_at")

  // Originating context. page_url is the client-reported URL, validated
  // server-side as same-origin (else stored NULL). page_route is the matched
  // Next.js route pattern (e.g. "/scholars/[slug]") derived server-side from
  // page_url at insert time; makes aggregate analysis tractable.
  pageUrl             String?  @map("page_url") @db.Text
  pageRoute           String?  @map("page_route") @db.VarChar(255)

  // Identity. User-typed, optional. NULL is the default.
  cwid                String?  @db.VarChar(32)

  // Mode — "contextual" (badge launch, page anchor known) or "generic"
  // (direct nav, no anchor). Determines which questions appear; analysts
  // must segment by this column before aggregating any per-page metric.
  mode                FeedbackMode

  // Q1 — purpose of visit
  purpose             FeedbackPurpose?
  purposeOther        String?  @map("purpose_other") @db.VarChar(200)

  // Q2 — task success
  taskSuccess         FeedbackTaskSuccess? @map("task_success")

  // Q2a — task-failure detail (CONDITIONAL: stored only when task_success ∈ {no, partially})
  taskFailureIntent   String?  @map("task_failure_intent") @db.VarChar(500)

  // Q3 — perceived usefulness (1..5 or NULL for N/A / skipped / mode=generic)
  usefulness          Int?     @db.TinyInt

  // Q3a — what worked (CONDITIONAL: stored only when usefulness ∈ {4,5})
  whatHelped          String?  @map("what_helped") @db.VarChar(500)

  // Q3b — what was missing (CONDITIONAL: stored only when usefulness ∈ {1,2})
  whatMissing         String?  @map("what_missing") @db.VarChar(500)

  // Q4 — perceived accuracy (1..5 or NULL for N/A / skipped / hidden by Q1 gate / mode=generic)
  accuracy            Int?     @db.TinyInt

  // Q4a — what to change for accuracy (CONDITIONAL: stored only when accuracy ∈ {1,2,3})
  oneChange           String?  @map("one_change") @db.VarChar(500)

  // Q5 — would the respondent use Scholars again (1..5 or NULL).
  // Replaces NPS; see SPEC § "The question instrument" rationale.
  wouldUseAgain       Int?     @map("would_use_again") @db.TinyInt

  // Q6 — respondent context
  role                FeedbackRole?
  roleOther           String?  @map("role_other") @db.VarChar(100)

  // Q7 — consent (always true; column records the accepted version)
  consent             Boolean
  consentVersion      String   @map("consent_version") @db.VarChar(16)

  // Q8 — contact + follow-up. `cwid` (declared above under Identity) is for
  // WCM-internal follow-up; contactEmail is for everyone else. Both nullable,
  // never required, never both required-together.
  contactEmail        String?  @map("contact_email") @db.VarChar(255)
  followupOptin       Boolean  @default(false) @map("followup_optin")

  @@index([submittedAt])           // chronology, exports
  @@index([cwid, submittedAt])     // per-CWID activity (sparse — most rows NULL)
  @@index([pageRoute, submittedAt])// per-surface aggregate
  @@map("feedback_submission")
}

/// Mode the form was rendered in. Determines which downstream questions
/// were even *asked*, which is load-bearing for analysis — a `NULL`
/// accuracy column means very different things in contextual vs generic.
enum FeedbackMode {
  contextual                    @map("contextual")
  generic                       @map("generic")
}

enum FeedbackPurpose {
  lookup_person                 @map("lookup_person")
  lookup_topic                  @map("lookup_topic")
  browse_unit                   @map("browse_unit")
  research_story                @map("research_story")
  evaluate_scholars             @map("evaluate_scholars")
  other                         @map("other")
}

enum FeedbackTaskSuccess {
  yes_completely                @map("yes_completely")
  mostly                        @map("mostly")
  partially                     @map("partially")
  no                            @map("no")
  not_looking                   @map("not_looking")
}

enum FeedbackRole {
  wcm_faculty                   @map("wcm_faculty")
  wcm_trainee                   @map("wcm_trainee")          // postdoc, fellow, doctoral student
  wcm_staff                     @map("wcm_staff")
  external_researcher           @map("external_researcher")
  journalist                    @map("journalist")
  patient_or_public             @map("patient_or_public")
  prefer_not_say                @map("prefer_not_say")
  other                         @map("other")
}
```

### What the schema deliberately does **not** carry**

- **No `anon_id`, no `ua_hash`, no IP.** v1 has no rate-limit, so the fingerprint columns that backed one are absent. If a v2 rate-limit lands, it adds its own short-lived storage and does not retroactively fingerprint v1 rows.
- **No referrer header column.** Redundant with `page_url`.
- **No FK from `cwid` to `Scholar`.** Mirrors `FieldOverride` / `Suppression` — a submission may come from a CWID not yet in `scholar` (incoming hire), one that has been soft-deleted, or a typo. The CSV export left-joins to Scholar at export time when an analyst wants enrichment.
- **No `consent = false` rows.** The form blocks submission. We do not record "opened and declined" — that is a different research question requiring a different instrument.
- **No honeypot column.** The honeypot field exists in the *form*, not the schema — a non-empty honeypot returns 200 to the client without inserting, so it leaves no row at all.

### Migration

A single additive Prisma migration: `add_feedback_submission`. Generated offline (`prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`) per [`project_prisma_migration_offline`](../docs/) practice. No backfill. No data dependency on other tables.

---

## Anti-spam (lightweight, not rate-limit)

The form ships **without a per-IP rate-limit** ([§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) — Q5). Four minimal defenses keep the table from filling with obvious bot traffic:

| Defense | Mechanism |
|---|---|
| **Honeypot field** | A visually-hidden text input named `website` (or similar plausible-bait name) is included in the form. Browser users never see it; bots that fill every field tag themselves. Server: if non-empty, respond `200` with the same confirmation HTML and write **no** row. Silent — telling the bot it failed teaches the bot to retry. |
| **Same-origin enforcement** | The submission endpoint rejects with 403 any request whose `Origin` header is missing or doesn't match the configured site origin. CORS-preflighted POSTs from a malicious site fail the check; drive-by botnet probes fail the check; a naked `curl` without `--header origin` fails the check. |
| **Free-text bounds + null-byte fail-closed** | Every free-text field is server-truncated at the documented column bound before insert (purpose_other 200, role_other 100, all conditional textareas 500). A surviving null byte in any text field returns 400 — treated as a hostile probe, not a content artifact. See [§ Sanitization and input bounds](#sanitization-and-input-bounds). |
| **Duplicate-content guard (option A)** | When any of the four conditional textareas (`what_helped`, `what_missing`, `one_change`, `task_failure_intent`) contains text identical to the same column in any row submitted in the last 60 minutes, the endpoint returns a silent `{ok:true}` with no INSERT — same pattern as the honeypot, so a spammer hitting "Submit" 50 times with copy-pasted text gets one row recorded, not 50. Pure-metric submissions (Likerts + role only, all textareas null) are not deduped — they are not the spam shape this guard targets. Implementation: `lib/feedback/dedup.ts` `isDuplicateSubmission`. |

**Escalation path (option B, named here, not built).** If dedup proves insufficient against sustained abuse — a determined attacker spamming **metric-only** rows that dedup deliberately ignores, or distributing the same prose across many micro-variants — the next layer is a **per-IP daily cap**: a small `FeedbackRateLimit` table, identity = `sha256(ip + DAILY_SALT)` rotated at UTC midnight, default 10 submissions per IP per UTC day, 429 returned with a polite message when exceeded. Schema is additive-compatible; adding option B does not invalidate the dedup helper or any existing row. Operational triggers worth watching: submissions exceeding ~50/day, or a single source pattern (same `pageRoute`, same minute) repeating across many rows. The cost of (B) over (A) is one Prisma model + ~50 LOC + the operational decision to throw 429s at users, which is why it is held until the data argues for it.

---

## Access control

### Submission endpoint

- Public. No auth required. The optional CWID is whatever the user typed (or the form pre-filled) — the server does **not** independently verify the session.
- **CSRF**: a same-origin check on the `Origin` / `Referer` header; cross-origin submits are rejected. The form posts to a Next.js Server Action, which already enforces same-origin by default; no separate token machinery.
- **Honeypot**: as above. Honeypot fail returns 200 with confirmation HTML, no DB write.
- No rate-limit, no admin override surface.

### CSV export endpoint

| Property | Value |
|---|---|
| **Route** | `/api/feedback/export` (GET). |
| **Authorization** | Session present **and** `isSuperuser(cwid)` true. Plus an explicit allowlist of CWIDs named on the IRB protocol (env var `FEEDBACK_EXPORT_ALLOWLIST`, comma-separated). Superuser alone is **not sufficient** — the IRB protocol governs who may see raw responses. |
| **Output** | RFC-4180 CSV. One row per submission. Columns: every `feedback_submission` column. |
| **Filters** | Query-string filters: `?from=YYYY-MM-DD&to=YYYY-MM-DD&pageRoute=...`. Defaults to last 30 days if no filter. |
| **Audit** | Every successful export writes a row to the existing B03 audit log (`manual_edit_audit`-style) with `action='feedback_export'`, the actor CWID, and the filter parameters. Bulk-export of raw text is itself a sensitive action and is logged. |
| **No anonymous-only mode** | If the requester is allowlisted, they see everything; if not, they get 403. We do not ship a "publicly aggregated counts" endpoint in v1; aggregation is downstream of the CSV, by the analyst. |

### Weekly digest email

A scheduled job emails a digest to the Scholars project lead each week. This is what keeps the dataset *operationally alive* — without it, submissions accumulate unseen and the lead has to remember to pull the CSV.

| Property | Value |
|---|---|
| **Cadence** | Weekly, Monday 09:00 ET. (Configurable; `FEEDBACK_DIGEST_CRON` env var.) |
| **Recipient** | `FEEDBACK_DIGEST_RECIPIENT` env var. v1 = project lead's WCM address; multi-recipient is comma-separated. |
| **Trigger** | A `POST /api/feedback/digest` endpoint, called by a scheduler. The endpoint is internal-only — requires a bearer token (`FEEDBACK_DIGEST_BEARER`) matching the env-configured value. Same pattern as the existing `/api/revalidate` ETL hook. |
| **Scheduler** | The scheduler choice is implementation-level (EventBridge → Lambda; GitHub Actions cron; or a CloudWatch scheduled rule pointing at the existing ETL Step Function). The SPEC names the contract (an HTTP POST with a bearer token, on a weekly cadence) and defers the scheduler choice to the PLAN; the operator can pick whichever already exists in the deployed environment. |
| **Content** | Subject: *"Scholars feedback — N new submissions (week of YYYY-MM-DD)"*. Body: count by Q1 purpose, mean Q3 usefulness (contextual mode only), mean Q4 accuracy (gated rows only), Q5 "would use again" distribution mini-histogram, and the **most recent up to 10 verbatim responses across Q2a (failure intent), Q3b (what missing), and Q4a (one change)** — the three actionable textareas — so the lead reads concrete signal, not just numbers. Q3a (praise) responses are bundled into a separate "what's working" section, also up to 10. A link to `/api/feedback/export?from=...&to=...` for full data. |
| **No raw CWID in body** | The digest body shows aggregates and verbatim Q6/Q7 text. It does **not** include the `cwid` column even when present — the lead joins to Scholar at export time if they want to identify a respondent. This is a defense-in-depth so a forwarded digest doesn't leak identity. |
| **Idempotence** | The endpoint stores the timestamp of the last successful digest in `EtlState` (key: `feedback_digest_last_run`). Re-running emits a digest covering submissions since the last successful run, not since 7 days ago, so a missed run still gets included next time. |
| **Empty-week behavior** | If zero new submissions, send a one-line "No new feedback this week" so the lead knows the pipeline is alive — silence is ambiguous (could be no traffic, could be a broken job). |
| **Reuse** | Mailer reuses the same SES sender + IAM role as the `/api/edit/request-change` mailer (lib already exists). Adds no new AWS infra beyond an EventBridge schedule. |

---

## Feature flag and rollout

| Flag | Effect |
|---|---|
| `FEEDBACK_BADGE_ENABLED` | When `off` (default), the badge does not render and `/about/feedback` returns 404. When `on`, both are live. |
| `FEEDBACK_EXPORT_ALLOWLIST` | Comma-separated CWIDs allowed to hit the export endpoint. Empty (default) means no one can export — the IRB-protocol team is named here when the protocol is signed. |
| `FEEDBACK_SHADOW_MODE` | When `on`, the badge renders and the form accepts submissions but writes go to `feedback_submission_shadow` (a duplicate table created in the same migration) instead. Used during pre-launch internal smoke-testing to verify capture without polluting the analytical dataset. Defaults `off`. |
| `FEEDBACK_SITE_ORIGIN` | The configured site origin used to validate `pageUrl` is same-origin. Defaults to `NEXT_PUBLIC_SITE_URL`. Only override to add a non-default origin (e.g. an alias domain). |
| `FEEDBACK_DIGEST_RECIPIENT` | Email address (or comma-separated addresses) the weekly digest is sent to. Empty (default) disables the digest. |
| `FEEDBACK_DIGEST_BEARER` | Bearer token required on `POST /api/feedback/digest`. Set by the operator; the scheduler stores the same value. |
| `FEEDBACK_DIGEST_CRON` | Cron expression for the scheduler. Default: `0 14 * * MON` (09:00 ET ≈ 14:00 UTC; adjust for DST as needed). |

**Rollout sequence** (this is the gate, not a suggestion):

1. PR-1, PR-2, PR-3 merge with all flags off. Code is on master; nothing is live.
2. Internal smoke: enable `FEEDBACK_BADGE_ENABLED` and `FEEDBACK_SHADOW_MODE` on staging. Project lead + 3–5 internal testers submit; verify shadow rows arrive and the modal flow is correct end-to-end. Set `FEEDBACK_DIGEST_RECIPIENT` to the operator's address and trigger the digest endpoint manually once; confirm the email arrives with the expected aggregates.
3. IRB exempt-determination filed. The determination is the precondition for the next step — do not skip.
4. The IRB determination number is added to `docs/feedback-consent-v1.md`, the consent version is bumped to `v1.1` if (and only if) IRB requires wording changes.
5. `FEEDBACK_SHADOW_MODE` is set `off`, `FEEDBACK_EXPORT_ALLOWLIST` is populated, `FEEDBACK_DIGEST_RECIPIENT` is set to the project lead, and the digest scheduler is enabled. Production deploy ramps the badge on.
6. First Monday digest fires; the lead confirms receipt.

A rollback is a single env-var flip (`FEEDBACK_BADGE_ENABLED=off`) — no code revert, no DB rollback. The table is retained.

---

## IRB / governance

### Protocol scope

The first publication-shaped use of the dataset requires an IRB exempt-status determination — exempt status is **never** self-declared. The protocol covers, at minimum:

- The locked question instrument (this SPEC's [§ The question instrument](#the-question-instrument--locked-v1) — the question text from #538 verbatim where unchanged, plus the two SPEC-introduced questions: Q3 usefulness and Q6 "what stood out as helpful").
- The Q8 inference rule (the table above).
- The weekly digest pipeline — disclose that submission text is emailed to the named recipient on a weekly cadence.
- The consent text (`docs/feedback-consent-v1.md`).
- The data-handling and retention rules (below).
- The access controls ([§ Access control](#access-control)).
- The cadence of reporting and the criteria under which the question set may change.

### Retention

| Class | Retention |
|---|---|
| Aggregated counts and anonymized analyses (produced by analysts from the CSV). | Indefinite. |
| Raw responses with `cwid` (user-typed). | Retain for the publication-evaluation window — TBD on the IRB protocol; default proposal **3 years**, then `cwid` is nulled by an offline scheduled task, leaving the response permanently anonymous. |
| Raw responses with `cwid = NULL` (the common case). | Same 3-year retention; already anonymous, so the 3-year mark is a delete-or-keep decision rather than a nullification. Default proposal: keep aggregated rows; physically delete `q5_one_change` text after 3 years to bound any re-identification surface on long-form prose. |

### When the question set may change

The instrument is locked. The bar for change:

- **Wording change** (any word): an IRB protocol amendment must be approved before the change ships. The amended consent version is bumped (`v2` etc.).
- **Adding a question**: protocol amendment + IRB approval, and the new question is `nullable` for all prior rows in the analytical view (every analyst code path checks "this question existed in this consent version").
- **Removing a question**: never. Stop asking; preserve the column.
- **Reordering**: protocol amendment (reordering has measurable effects on response distributions).

The six-month-or-200-submissions review point ([§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) — Q3) is the **decision** point for NPS keep/drop. It is not an excuse to also retune Q1 wording.

---

## Accessibility

- **Badge**: native `<button>`, keyboard-focusable, descriptive `aria-label`, focus ring visible. No custom hit area beyond the button.
- **Likert / NPS**: real `<input type="radio">` inside a `<fieldset>` with a `<legend>` matching the question text. Radio groups, not custom-styled clickable cards — screen readers must announce "1 of 5" and "selected".
- **Q5 textarea**: associated `<label>`, character count announced via `aria-live="polite"` on state change, max-length enforced both client-side (UX) and server-side (truth).
- **Modal**: Radix `Dialog` with focus trap, ESC close, restoration of focus to the badge on close. Title and description are `aria-labelledby` / `aria-describedby`.
- **Color contrast**: badge default text/background meets WCAG AA at default token values. Hover state checked at the same bar.
- **Reduced motion**: badge and modal honor `prefers-reduced-motion`. No required animation.
- **Keyboard-only submission**: the form is fully usable with no pointer. The submit button is reachable in tab order after the last question.

---

## File layout

New files (PR-1 introduces the schema, PR-2 ships the badge + form, PR-3 wires the export + IRB consent text):

```
docs/
  feedback-badge-spec.md                       ← this file
  feedback-consent-v1.md                       ← consent text, versioned
  feedback-q1-hypothesis-log.md                ← created lazily (v2 work)

prisma/
  migrations/<timestamp>_add_feedback_submission/migration.sql
  schema.prisma                                ← FeedbackSubmission + FeedbackQ1Purpose,
                                                  FeedbackQ2TaskSuccess, FeedbackQ6Role enums

lib/feedback/
  same-origin.ts                               ← validate pageUrl is same-origin → normalized URL | null
  page-route.ts                                ← URL → Next.js route pattern (best-effort string match)
  sanitize.ts                                  ← truncate + control-char strip
  cwid.ts                                      ← validate + lowercase user-typed CWID
  q8-inference.ts                              ← roleCategory → Q8 option map
  consent.ts                                   ← current consent version + text loader
  dedup.ts                                     ← option A duplicate-content guard (last-60min same-text suppression)
  digest.ts                                    ← aggregate + render the weekly digest body

components/site/
  feedback-badge.tsx                           ← the fixed badge
  feedback-badge-context.tsx                   ← suppress-when-modal-open count

components/feedback/
  feedback-form.tsx                            ← the form (rendered both standalone and inside the modal)
  feedback-modal.tsx                           ← modal shell wrapping the form
  feedback-confirmation.tsx                    ← post-submit confirmation block
  sign-in-to-edit-callout.tsx                  ← the "Spot something wrong? Sign in to edit →" banner

app/(public)/about/feedback/
  page.tsx                                     ← server-renderable route
  submit-action.ts                             ← server action: same-origin check, honeypot, sanitize, INSERT

app/api/feedback/export/
  route.ts                                     ← GET, superuser + allowlist gated, CSV stream

app/api/feedback/digest/
  route.ts                                     ← POST, bearer-token gated, computes and sends the weekly digest
```

Touched files:

- `app/layout.tsx` — render `<FeedbackBadge />` at the root, behind the `FEEDBACK_BADGE_ENABLED` flag, inside a `<FeedbackBadgeProvider>`.
- `components/edit/` dialogs and any other Radix `Dialog` consumers — call the badge-context `setSuppressed` on mount/unmount. (A small `useDialogSuppressesFeedbackBadge()` hook lands in PR-2 to make this a single line.)
- `lib/auth/superuser.ts` — no change; the export endpoint uses it as-is.
- `.env.example` — add `FEEDBACK_BADGE_ENABLED`, `FEEDBACK_EXPORT_ALLOWLIST`, `FEEDBACK_SHADOW_MODE`, `FEEDBACK_SITE_ORIGIN`, `FEEDBACK_DIGEST_RECIPIENT`, `FEEDBACK_DIGEST_BEARER`, `FEEDBACK_DIGEST_CRON`.
- `lib/edit/request-change-mailer.ts` (or the equivalent existing module) — extract the SES sender into a small shared helper used by both the request-change mailer and the new digest. No behavior change to #160.

---

## PR cuts (preview — for the implementation PLAN, not part of this SPEC's locked text)

- **PR-1**: Prisma migration + enums + `lib/feedback/` library (same-origin, page-route, sanitize, cwid validator, q8 inference, consent loader). No UI. Unit tests for each lib module. All flags default off.
- **PR-2**: `<FeedbackBadge />`, `<FeedbackBadgeProvider />`, `app/(public)/about/feedback/page.tsx`, the form + modal + confirmation + sign-in-to-edit callout. Server action with honeypot + same-origin check. Wires `app/layout.tsx`. Suppresses the badge inside existing `/edit/*` dialogs (one line via the new hook).
- **PR-3**: `/api/feedback/export` route, `docs/feedback-consent-v1.md`, B03 audit-log integration for exports.
- **PR-4**: `lib/feedback/digest.ts` + `/api/feedback/digest` route + SES-sender extraction. Scheduler wiring (EventBridge / Step Function — TBD per environment) is operator config, not code. PRs 3 and 4 can be combined if review bandwidth allows.

The IRB filing is **not a PR** — it is a parallel workstream gated on PR-1's `docs/feedback-consent-v1.md` text.

---

## Acceptance criteria (mapping to #538's list)

| Issue criterion | This SPEC's resolution |
|---|---|
| Badge component, fixed bottom-right, every Scholars page including `/edit/*`, suppressed inside modals. | [§ The badge](#the-badge) + the surfaces table. |
| Form at `/about/feedback`, server-renderable, openable as a modal. | [§ Form route + modal](#form-route--modal). |
| Server-side pre-fills: originating page URL, timestamp, optional CWID; client cannot tamper. | **Lightweight pivot — see [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) Q4.** Timestamp is server-set; URL is client-reported and same-origin-validated; CWID is user-typed (session-prefilled when present). The "client cannot tamper" property is relaxed for v1 in exchange for a simpler form. |
| All eight questions per the inventory; Q7 blocks submission if unchecked; all others optional. | **Expanded to ten.** [§ The question instrument](#the-question-instrument--locked-v1) — adds Q3 usefulness and Q6 "what stood out as helpful" to the issue's original set; renumbers consent → Q9 (still required-to-submit) and CWID + follow-up → Q10. Issue's original Q1/Q2/Q3/Q4/Q5/Q6 map to new Q1/Q2/Q4/Q5/Q7/Q8. The schema's nullability still encodes "all but consent optional." |
| Submission writes to `feedback_submission`. | [§ Schema](#schema). |
| Rate-limit: 1 per (CWID OR anon_id) per page URL per 24h; 429 with polite message. | **Not in v1** — see [§ Resolving issue #538's open questions](#resolving-issue-538s-open-questions) Q5. Replaced by honeypot + same-origin + Q5 server-truncate. Reviewer to confirm acceptance of the lightweight trade-off. |
| Confirmation page after submit, deep-link back to originating page. | Confirmation row in [§ Form route + modal](#form-route--modal). |
| Aggregate CSV export endpoint, role-gated. | [§ Access control — CSV export](#csv-export-endpoint). |
| IRB exemption determination filed; noted in consent text. | [§ IRB / governance](#irb--governance) and the rollout sequence. |
| Documented data-handling + retention policy in `docs/`. | This SPEC + `docs/feedback-consent-v1.md` (PR-3). |
| Accessibility (keyboard-nav; `aria-label`; radio groups). | [§ Accessibility](#accessibility). |
| Pre-launch: project lead confirms question set is locked. | The signed-off version of *this SPEC* is the lock. |

---

## Architectural decisions (locked 2026-05-28)

Seven calls were surfaced from external survey-design review and signed off by the project lead. Each is a real architectural decision, not editorial cleanup, with the rejected alternative recorded for the audit trail.

| Decision | Locked v1 | Alternative considered + why rejected |
|---|---|---|
| Form split into contextual / generic modes? | **Yes** — different question sets, different copy, different downstream interpretation. | Single form accepting `accuracy` + `usefulness` from generic-mode respondents as noise. Rejected because diffuse accuracy claims are a category error that contaminate the analytical column. |
| Q1 as branching key (gates accuracy on `purpose`)? | **Yes** — accuracy hidden for `purpose = browse_unit`; gated on (mode AND purpose) for all others; **always hidden in generic mode regardless of Q1**. | Show accuracy to everyone, accept that some respondents can't answer it. Rejected — see [§ Q1 as the branching key](#q1-as-the-branching-key) rationale. |
| Probe low usefulness (1–2) tail? | **Yes** — Q3b "What was missing or didn't help?" The actionable signal the prior SPEC discarded. | Keep only the praise probe at 4–5. Rejected — improvement products need failure signal, not just praise. |
| Add Q2a (task-failure intent) conditional? | **Yes** — "What were you trying to find?" on task_success ∈ {no, partially}. | Rely on Q3b and Q4a to surface failure detail. Rejected — failure-to-find is its own construct distinct from low-usefulness or low-accuracy. |
| NPS — keep, replace, or gate? | **Replace** with "Would you use Scholars again?" (5-pt Likert). | (a) Keep NPS for cross-system benchmarkability. (b) Gate NPS to `role ∈ {wcm_faculty, wcm_trainee, wcm_staff}` only. Both rejected — NPS's "recommend to a colleague" framing is semantically broken for patient / journalist / public segments the form explicitly addresses. |
| Add `contact_email` field that reveals when "willing to be contacted" is checked? | **Yes** — distinct field, kept separate from CWID. Email is for non-WCM respondents. | Single field accepting either CWID or email by shape. Rejected — shape-disambiguation produces confusing error messages and the separate-fields form is more self-documenting. |
| Consent text update for CWID-at-rest? | **Yes** — add: *"Your CWID (if provided) is used only to contact you for an optional follow-up. It is never included in published reports."* | Leave consent text as-is. Rejected — the implicit reading produces an apparent contradiction with the CWID storage that an IRB reviewer will catch. |
| Viewer-correct sign-in-to-edit callout? *(added 2026-05-28 from prototype review)* | **Yes** — see [§ Sign-in-to-edit callout](#sign-in-to-edit-callout). Self-selecting copy ("Is this your profile?"); shown only on contextual + `/scholars/[slug]`. | Keep the original "your profile" copy. Rejected — actively misleading to non-owners, who are the majority of Scholars traffic on profile pages. |

## Spec-review revisions

This SPEC has been revised three times in review:

| Round | Driver | Net change |
|---|---|---|
| 1 | Lightweight-mode pivot (project lead) | Dropped rate-limit, HMAC origin token, server-captured CWID; CWID became a user-typed optional field; anonymous-by-default. |
| 2 | Q3 usefulness + Q6 "what helped" inserted; weekly digest added | Question count went from 8 to 10; conditional reveals on Q3 (high) and Q5 (low). |
| 3 | External survey-design review (this draft) | Form split into contextual / generic modes; Q1 became the primary branching key; usefulness probed at both tails; NPS proposed for replacement; contact field expanded beyond CWID. |

Each round narrowed the instrument's surface area while sharpening the signal it captures. Round 3 is the architecturally largest because it identified that **collecting an answer to a question the respondent can't meaningfully answer is worse than not asking** — a finding that retrofits backward into every prior round.

## Open questions remaining

None blocking implementation **once [§ Decisions still required](#decisions-still-required) is signed off**. Items deliberately deferred:

1. **Per-page Q1 variants** (issue Q2). Deferred to a v2 protocol amendment, contingent on the first six-month dataset.
2. **Per-IP rate-limit, option B** (issue Q5). v1 ships with duplicate-content dedup (option A) but no per-IP cap. Escalate to option B if dedup proves insufficient — see [§ Anti-spam](#anti-spam-lightweight-not-rate-limit). The schema is additive-compatible.
3. **Stronger origin trust** for `pageUrl`. If the dataset becomes load-bearing for a publication that depends on URL accuracy, the HMAC-token mechanism considered in the original SPEC draft can be added in v2.
4. **Digest recipient identification.** The SPEC names `FEEDBACK_DIGEST_RECIPIENT` as the operator-set address; the operator (likely the Scholars project lead) names themselves or a shared address. Pending confirmation as part of [§ IRB / governance](#irb--governance) signoff.
5. **In-app admin queue** at `/edit/feedback` (mirroring `/edit/slug-requests`). Considered for v1, deferred to v2 — the weekly digest is the v1 notification path. File the v2 if the lead wants triage / annotation / "mark as addressed" affordances inside the app.
6. **Mode-aware copy throughout the form.** Section headings ("How useful was *this page*…") need to switch to "Scholars overall" wording in generic mode. The SPEC names the rule; the exact copy variants get drafted in PR-2 alongside the mockup.
7. **Does generic mode earn its keep at all?** With accuracy fully suppressed and the per-page conditional textareas not firing, a generic-mode submission collects only Q1, Q2 (+ Q2a if it fires), Q3 (usefulness, diffuse reading), Q5 (would-use-again), Q6 (role), Q7 (consent), Q8 (contact). That is ~7 questions, mostly sentiment + intent + demographics. v2 may decide this is too thin to justify the `/about/feedback` surface, and that the page should redirect to "open Scholars, click the Feedback badge while you're on the page you want to comment on." We are **not** changing v1 — the question is one the dataset itself is being asked to answer. Re-evaluate at the 6-month review point alongside NPS / Q1-variants.
