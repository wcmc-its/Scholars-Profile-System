# SPEC — "Request a Change" modal (self-edit feedback, #160 UI follow-up)

**Status:** DRAFT — design settled, open questions resolved 2026-05-26 (§11).
Awaiting explicit go to build Phase 1.
**Supersedes:** the popover-of-links presentation of "Request a change" shipped in
`#487` (`components/edit/request-a-change-picker.tsx`). The *routing data*
(`lib/edit/request-a-change.ts`) is retained unchanged in substance.
**Extends:** `docs/self-edit-launch-spec.md` § Item-level feedback.
**Reference UI:** Apollo Management Console "Request an [Item] Change" modal
(the WCM clinical-profile editor this view mimics). Apollo = one section-level
"Request a Change" link → modal with a free-text box, an "I do not want to
receive an email receipt" checkbox, and Cancel / Submit.

## 1. Decision

Replace the dismissible popover (a list of small underlined `mailto:` links)
with an Apollo-style **modal**, but **keep SPS's per-issue routing brain**.
Apollo captures only free text and sends every request to a human; SPS instead
routes each issue to its correct destination — most are self-service (Web
Directory, Publication Manager) and resolve instantly without involving an
office, and `explain` issues are non-errors that should never become a ticket.
Discarding that routing to match Apollo's shell would regress the dominant case.

So: **Apollo's modal shell, SPS's routing inside it.**

### 1.1 Why not the alternatives (named, per review rigor)

- **Keep the popover, fix only readability.** Rejected: leaves the silent
  `mailto:` hand-off (no confirmation, fails silently with no mail handler) and
  the inconsistency with the system being mimicked.
- **Pure Apollo free-text modal, drop routing.** Rejected: sends self-service
  cases (photo, name, ORCID, publications) to a human who replies "do it
  yourself in <tool>"; lets `explain` non-errors (NCE grace window, non-PubMed
  pubs) become junk tickets.

## 2. Phasing (the load-bearing constraint)

SPS has **no server-side mailer** (no `nodemailer`/SES/SMTP in deps or code) —
the reason the current flow uses client `mailto:`. True "Submit → server sends +
email receipt" is therefore gated on mail infra (SES identity verification +
sandbox exit + IAM + CDK; a WCM SMTP relay is blocked by the known VPC↔WCM
connectivity gap). We ship in two phases.

| | Phase 1 (this spec, no infra) | Phase 2 (fast-follow, after mailer lands) |
|---|---|---|
| Modal shell + routing | ✅ | (unchanged) |
| `route` issue Submit | composes a **structured `mailto:`** (issue + free-text + item) and hands off to the mail client | flips to `POST /api/edit/request-change` → server sends |
| Confirmation | in-app banner: "Your email client should have opened. If not, email `<addr>`." (fixes silent failure) | in-app success toast: "Request sent." |
| Email receipt to user | ❌ (no server send → receipt checkbox **omitted** in Phase 1) | ✅ "I don't want an email receipt" checkbox |
| Server-side record / auditability | ❌ none (mailto leaves no DB trace — stated limitation) | ✅ `manual_edit_audit` row (B03) |

The receipt checkbox is **not** rendered in Phase 1 — showing a control that
cannot function is the kind of speculative UI we avoid. It arrives with the
server send in Phase 2.

## 3. UX contract — Phase 1

### 3.1 Trigger

- **Entity panels** (education, funding, appointments, publications — row-based):
  keep the existing **per-row** trigger, so the modal is item-scoped. Restyle
  the trigger as `Button variant="outline" size="sm"` reading **"Request a
  change"** (sentence case, unified across all panels — fixes the casing/variant
  inconsistency). Icon: keep **`Flag`** (decision 2026-05-26). Min target height 36px (`size="sm"` is 32px today — see §7 A11y).
- **Read-only panels** (name-title, photo — no rows): keep the **section-level**
  trigger inside the existing "This section is not editable" box.

### 3.2 Modal anatomy

```
┌ {title}                                                  ✕ ┐
│ What needs to change?                                       │
│   ( ) {issue.label}                  ← radio list, one per   │
│   ( ) {issue.label}                    config issue          │
│   …                                                          │
│ ─────────────────────────────────────────────────────────  │
│ {contextual body — depends on the selected issue's shape}    │
│ ─────────────────────────────────────────────────────────  │
│                                   {contextual footer action} │
└──────────────────────────────────────────────────────────── ┘
```

- **Title:** item-aware when a row label exists —
  `Request a change — {itemLabel}` (e.g. "Request a change — Ph.D., University
  of Montpellier"); attribute-level otherwise — `Request a change — {heading}`
  (e.g. "Request a change — Name & Title"). This is the named, accessible dialog
  title (`DialogTitle`), fixing the current unnamed-popover finding.
- **Issue selector:** a `RadioGroup` (new `components/ui/radio-group.tsx`
  wrapping the `radix-ui` umbrella dep already in use — **no new dependency**).
  One radio per `config.issues[]`. No pre-selection (avoids a misleading
  default). The contextual body + footer are empty until an issue is chosen.

### 3.3 Contextual body + footer, by action shape

The selected issue's `action.kind` drives the body and the footer's primary
action (each screen has exactly one primary action):

| `action.kind` | Body | Primary footer action |
|---|---|---|
| `self-service` | `action.instruction` | **"Fix it in {action.tool} →"** — opens `resolveSelfServiceHref(href, cwid)` in a new tab (`rel="noopener noreferrer"`). No textarea. |
| `route` | `action.note` (if any) + a **`Textarea`** labeled "Add any detail (optional)" | **"Submit"** — composes the structured `mailto:` (§3.4), then closes the modal and shows the confirmation banner (§3.5). |
| `explain` | `action.detail` | If `action.fallbackEmail`: secondary link **"Still wrong? Email us"** reveals a `route`-style textarea + "Submit". Else: footer is just **"Close"**. |

Cancel is always present (secondary). **Deselect / switch behavior:** changing
the selected radio resets the contextual body; any text typed into a `route`
textarea is **discarded on switch** and on Cancel — see the dismiss-guard edge
case (§8).

### 3.4 Structured `mailto:` composition (Phase 1)

Reuse the existing hand-built query encoding (`URLSearchParams` renders spaces
as `+`, which mail clients show literally; RFC 6068 wants `%20` — so
`encodeURIComponent` each part by hand). Improve over today's generic subject:

- **`to`:** `action.email`; **`cc`:** `action.cc` if present.
- **`subject`:** `Scholars profile correction — {attributeLabel}` (e.g.
  "Scholars profile correction — Education") — specific enough for the receiving
  office to triage, unlike today's single generic subject.
- **`body`:**
  ```
  Issue: {issue.label}
  Item: {itemLabel || "(whole section)"}
  Source: {action.sourceSystem}

  {free-text detail, or "(no additional detail provided)"}

  — Sent from the WCM Scholars profile editor by {session cwid}.
  ```

CRLF in any interpolated value is stripped (`\r`/`\n` → space) before
composition — header-injection guard (§6), and keeps the `mailto:` well-formed.

### 3.5 Confirmation (silent-failure fix)

On Submit (route shape), after invoking the `mailto:` the modal closes and an
inline, non-focus-stealing banner (`role="status"`, `aria-live="polite"`)
appears at the panel top:

> Your email client should have opened a pre-filled message to **{office}**. If
> nothing opened, email **{email}** directly.

`{email}` is rendered as selectable text + a plain `mailto:` link, so a webmail
user who has no OS handler can still copy it. This directly resolves the current
"click does nothing, no feedback" failure mode.

## 4. Components & files

| File | Change |
|---|---|
| `components/ui/radio-group.tsx` | **new** — shadcn-style wrapper over `radix-ui` RadioGroup (no new dep). |
| `components/edit/request-a-change-dialog.tsx` | **new** — the modal; consumes `getChangeConfig(attribute)`; owns selected-issue state + the contextual body/footer; composes the `mailto:` (§3.4). Replaces `RequestAChangeMenu`/`RequestAChangePicker`. |
| `components/edit/entity-panel.tsx` | swap per-row `RequestAChangeMenu` → new dialog trigger; restyle (outline, `PencilLine`, sentence case). |
| `components/edit/readonly-attribute-panel.tsx` | swap inline picker → section-level dialog trigger; unify button label/variant. |
| `components/edit/publications-card.tsx` | swap `RequestAChangeMenu` → new dialog trigger. |
| `components/edit/request-a-change-picker.tsx` | **delete** (popover + `IssueRow` superseded). |
| `lib/edit/request-a-change.ts` | **unchanged** (data + resolvers reused as-is). |

## 5. Phase 2 delta (documented now, built later)

- **Mailer:** SES in the SPS account. Decision deferred to a Phase-2 infra
  ticket: verified sender identity `no-reply-scholars@weill.cornell.edu`
  (decision 2026-05-26), sandbox exit, ECS task IAM `ses:SendEmail`, CDK wiring. (Alternative: WCM SMTP
  relay — currently blocked by the VPC↔WCM connectivity gap; not pursued.)
- **Endpoint:** `POST /api/edit/request-change`, mirroring `app/api/edit/suppress/route.ts`
  (`readEditRequest` → authorize → act → `appendAuditRow` in one tx).
  Body: `{ attribute, issueId, itemId?, detail }`. Server resolves the route
  from config server-side (the client never picks the recipient) and sends.
- **Audit:** writes a `manual_edit_audit` (B03) row → **depends on the
  `scholars_audit` INSERT grant** (the same gap that currently 500s Hide/Show;
  `scripts/sql/audit-log.sql`). Phase 2 must verify that grant.
- **Receipt:** the "I don't want an email receipt" checkbox returns; default =
  receipt sent (opt-out, matching Apollo).
- **Abuse controls:** per-cwid rate limit on the endpoint (out of scope for the
  Phase-1 client `mailto:`, which the user sends from their own client).

## 6. Threat model

- **In scope.** *Email header injection:* free-text and interpolated values may
  contain CRLF; strip `\r`/`\n` before `mailto:` composition (Phase 1) and
  before constructing SES headers (Phase 2). *Recipient tampering:* the office
  address comes from the server-trusted config, never from client input — in
  Phase 2 the client sends only `issueId`; the server maps to the recipient.
  *Open redirect via self-service href:* hrefs are a fixed in-code allowlist
  (`WEB_DIRECTORY_URL`, `PUBLICATION_MANAGER_URL`, `ORCID_MANAGE_URL`); only
  `{cwid}` is interpolated, URL-encoded. New tabs use `rel="noopener noreferrer"`.
- **Out of scope.** *Spam/volume* (Phase 1 send is the user's own mail client;
  Phase 2 adds rate limiting). *Authz* — unchanged: `/edit` is already gated to
  the owning scholar or a superuser; "request a change" grants no new capability
  (it sends mail / opens a link, it does not write profile data).

## 7. Accessibility (resolves the review findings)

- **Named dialog** (`DialogTitle`) — fixes the unnamed-popover finding.
- **No repeated ambiguous link text** — the modal shows one routed action for
  the *selected* issue, so the "Email Office of Faculty Affairs ×3" tab-order
  ambiguity disappears by construction.
- **No tiny always-underlined links** — body text ≥14px; the single action is a
  `Button`; any link underlines on hover/focus, not permanently (the user's
  readability complaint).
- **Focus:** on open, focus the issue `RadioGroup` (first input). `Esc` / scrim
  click dismiss with the unsaved-text guard (§8). Submit is not default-focused.
- **Touch:** trigger and footer actions ≥44px on touch (`size` bump + padding).
- Radios have visible labels; `aria-live="polite"` confirmation does not steal
  focus.

## 8. Edge cases

| # | Case | Expected |
|---|---|---|
| 1 | Open modal, select nothing, Cancel | Closes, no side effect. |
| 2 | Select a `route` issue, type detail, switch to another issue | Textarea content discarded; new issue's body shown. |
| 3 | Select `route`, type detail, press Esc / click scrim | Confirm "Discard your request?" before closing (unsaved text). |
| 4 | Select `route`, leave detail blank, Submit | Allowed; body shows "(no additional detail provided)". |
| 5 | `self-service` issue | No textarea, no Submit; primary action is the tool link (new tab). |
| 6 | `explain` issue, no `fallbackEmail` | Informational only; footer = "Close". |
| 7 | `explain` issue with `fallbackEmail`, user clicks "Still wrong?" | Reveals route textarea + Submit to `fallbackEmail`. |
| 8 | No OS mail handler on `route` Submit | Modal still closes + confirmation banner gives the copyable address (no silent dead-end). |
| 9 | Free-text contains newlines / `%0A` | CRLF stripped; `mailto:` stays well-formed (header-injection guard). |
| 10 | Locked chair appointment row | Trigger still present (chair-ended is a valid issue); behaves as a normal `route`. |
| 11 | `removed_by_admin` publication | Trigger still present; routes normally. |
| 12 | Very long free text | `mailto:` is best-effort; if length is a concern the confirmation banner's direct-address fallback covers it. (Server send in Phase 2 has no length limit.) |

## 9. Tests (Phase 1)

| Area | Assertion |
|---|---|
| Trigger render | Each entity row + each read-only panel renders exactly one "Request a change" trigger (sentence case, outline). |
| Dialog name | Open dialog exposes an accessible name including the item/attribute. |
| Routing — self-service | Selecting a self-service issue shows the tool link (correct `href` with encoded `{cwid}`), no textarea, no Submit. |
| Routing — route | Selecting a route issue shows the textarea + Submit; the composed `mailto:` has the right `to`/`cc`/specific subject/structured body. |
| Routing — explain | `explain` shows the detail; no Submit unless `fallbackEmail` revealed. |
| Switch reset (edge 2) | Switching the selected issue clears prior textarea text. |
| Dismiss guard (edge 3) | Esc with unsaved text triggers the discard confirm. |
| Header-injection (edge 9) | CRLF in detail/item is stripped from the composed `mailto:`. |
| Confirmation (edge 8) | After route Submit, the `aria-live` banner renders with the office name + copyable address. |
| A11y | Radios labeled; dialog focus lands on the radio group; no `text-xs` permanently-underlined action links remain. |

Run `vitest` (component + the mailto-composition unit) before any push.

## 10. Auditability note (honest limitation)

Phase 1 leaves **no server-side record** of a change request — the user's mail
client does the send. There is therefore no audit SQL to run in Phase 1. A
runnable audit lands with Phase 2's `manual_edit_audit` row, e.g.:

```sql
-- Phase 2 only: change-requests submitted in the last 7 days
SELECT actor_cwid, target_entity_type, target_external_id, created_at
FROM scholars_audit.manual_edit_audit
WHERE action = 'request_change'           -- (new B03 action value, Phase 2)
  AND created_at >= NOW() - INTERVAL 7 DAY
ORDER BY created_at DESC;
```

## 11. Resolved decisions (2026-05-26)

1. **Trigger granularity** — per-row on entity panels (item-scoped),
   section-level on the read-only Name/Photo panels.
2. **Icon** — keep `Flag`.
3. **Phase 2 sender identity** — SES From = `no-reply-scholars@weill.cornell.edu`.
