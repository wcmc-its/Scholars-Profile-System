# Feedback handling matrix + ServiceNow intake spec

**Issue:** #514 · **Status:** spec (recipients ⚠️ pending stakeholder resolution; integration contract pending ServiceNow team) · **Supersedes:** the email-only routing shipped in #160.

This spec defines (1) **how each piece of profile feedback is handled** — the canonical handling matrix — and (2) the **Scholars → ServiceNow integration contract** that graduates #160's `mailto:`/SES routing into tracked tickets. It is the "ask" to hand the ServiceNow team plus the locked routing the Scholars form derives from.

It does **not** introduce app code. The build (graduating the #160 "Request a change" modal from `mailto:` to a server endpoint that creates a ServiceNow request) is a separate follow-on; this is its contract.

---

## 1. Architecture

The correction form **lives in Scholars**, not in ServiceNow. The user is already authenticated to Scholars (the same WCM SSO session that gates `/edit`), so the form needs no second login. On submit, the **Scholars server** creates a request/incident on the ServiceNow side through an integration.

```
WCM faculty/staff (already SSO-authenticated to Scholars)
        │  opens "Request a change" on a profile field (#160 modal)
        ▼
Scholars in-app form  ── collects category + issue type + detail
        │  POST /api/edit/request-change  (authenticated; session-derived submitter)
        ▼
Scholars server
   • derives assignment group + source system from category  (server-side; client never sends them)
   • builds the ServiceNow payload
        │  ServiceNow integration (Table/Import API or scripted REST — see §5)
        ▼
ServiceNow  ── creates request/incident, routed to the derived assignment group queue
```

**Why server-mediated rather than a hosted ServiceNow form.** Three reasons:

1. **No second auth.** The submitter is already authenticated to Scholars; re-authenticating against a ServiceNow portal form is friction and breaks the in-context "Request a change" flow.
2. **Recipient-tampering guard (carried from #160 / `docs/self-edit-request-change-server-mailer-plan.md`).** The submitter must never choose the destination. The Scholars server derives the assignment group from the category, so the routing cannot be tampered with from the client. A hosted SN form with a user-selectable assignment-group field would reopen that hole.
3. **Provenance + prefill come free.** Scholars already knows the subject profile, the field's source system (#511 provenance map), and often the current value — it prefills them rather than asking the user to retype.

The three SES mailboxes from #160 remain the fallback transport until the integration ships; this spec is what lets the queue graduate off email.

---

## 2. The three handling shapes — only **Route** becomes a ticket

From #160's settled model (`docs/self-edit-launch-spec.md` § Item-level feedback):

| Shape | Meaning | Creates a ServiceNow ticket? |
|---|---|---|
| **Self-service** | The user fixes it in the owning tool (Web Directory, Publication Manager / ReCiter). | **No** — link + instruction, in place. |
| **Route** | The owning office must correct the source. | **Yes — this is what the integration feeds.** |
| **Explain** | Not an error / not fixable here (NCE grace window, non-PubMed publications). | **No** — in-place explanation; deliberately prevents junk tickets. |

The form must collect **only Route cases**. Self-service and Explain resolve inside the #160 modal without a submission. This keeps the ServiceNow queue free of "working as intended" and "go fix it yourself" noise.

---

## 3. Feedback-handling matrix

Rows marked **✅** are **locked** — the destination is already encoded in `lib/edit/request-a-change.ts` (#160) and shipping in production. Rows marked **⚠️** are net-new data sources added since #160 (see #511) and need an owning office + assignment group named before the integration goes live (see §3.3).

| Feedback type | Source system | Shape | Recipient (current email) | Proposed SN assignment group |
|---|---|---|---|---|
| Name / email / email-visibility | Enterprise Directory | self-service | — (Web Directory) | n/a |
| ORCID | ReCiter | self-service | — (ReCiter) | n/a |
| Photo | Enterprise Directory (Web Directory) | self-service | — (Web Directory "Publish to") | n/a |
| Title / department / division | Enterprise Directory | route | ✅ `support@med.cornell.edu` | ASMS / Directory |
| Degrees / post-nominals | ASMS | route | ✅ `ofa@med.cornell.edu` | Faculty Affairs |
| WCM appointments (title / dates / missing / not-mine / chair-ended) | ASMS by way of Enterprise Directory | route | ✅ `support@med.cornell.edu` | ASMS / Directory |
| Education (wrong / missing / not-mine) | ASMS | route | ✅ `ofa@med.cornell.edu` | Faculty Affairs |
| Education (duplicate) | ASMS import | route | ✅ `support@med.cornell.edu` | ASMS / Directory |
| Funding (wrong / missing / not-mine) | InfoEd (federal abstracts: NIH RePORTER) | route | ✅ `osra-operations@med.cornell.edu` cc `scholars@weill.cornell.edu` | Sponsored Research Admin |
| Funding "active but expired" | InfoEd | explain (NCE grace) | — | n/a |
| Publication not-mine / missing (PubMed) | PubMed / ReCiter | self-service | — (Publication Manager — **never Hide**) | n/a |
| Publication non-PubMed missing | — | explain (PubMed-only) | — | n/a |
| Publication metadata wrong / duplicate | PubMed | route | ✅ `support@med.cornell.edu` | ASMS / Directory |
| **Graduate School appointment** | **Jenzabar** | route | ⚠️ **TBD — Graduate School office?** | **TBD** |
| **Student mentor / mentee** | **Jenzabar** | route | ⚠️ **TBD — Graduate School office?** | **TBD** |
| **Postdoc mentee** | **Enterprise Directory (HR)** | route | ⚠️ **TBD — HR?** | **TBD** |
| **Hospital position** | **NYP IdentityIQ** | route | ⚠️ **TBD — NYP-side office** (may route outside WCM) | **TBD** |
| **Disclosures** | **Conflicts-of-Interest system** | route | ⚠️ **TBD — COI office?** | **TBD** |
| Topic / Impact / synopsis (wrong) | ReciterAI (computed) | route | ⚠️ proposed `scholars@weill.cornell.edu` | Scholars team |
| **Center membership** | **Scholars (this app)** | route | ⚠️ proposed `scholars@weill.cornell.edu` | Scholars team |
| **Whole-profile duplicate / identity** ("two profiles for one person") | ReCiter (disambiguation) | route | ⚠️ proposed `scholars@weill.cornell.edu` | Scholars team / ITS |
| **Technical / display problem** ("this page is broken / shows an error") | Scholars (this app) | route | ⚠️ proposed `scholars@weill.cornell.edu` | Scholars team |
| General feedback / "can't find an answer" | — | route | ⚠️ proposed `scholars@weill.cornell.edu` | Scholars team |

### 3.1 Source of truth for the ✅ rows

The locked destinations are not duplicated here as a second authority — they are read from `lib/edit/request-a-change.ts` (`REQUEST_A_CHANGE`, the operator-validated config). The matrix above is the human-readable projection; if a destination changes, change it there and update this table. The known mailboxes:

- `support@med.cornell.edu` — ASMS / Enterprise-Directory source data, import errors, publication metadata (catch-all).
- `ofa@med.cornell.edu` — Office of Faculty Affairs (degrees, education).
- `osra-operations@med.cornell.edu` (cc `scholars@weill.cornell.edu`) — Office of Sponsored Research Administration (funding).
- `scholars@weill.cornell.edu` — Scholars team.
- `no-reply-scholars@weill.cornell.edu` — SES sender identity (the #160 Phase-2 server-send `From`; not a destination).

### 3.2 Mailbox → assignment-group mapping

The integration sends an **assignment group**, not an email address. Each known mailbox maps to one proposed group; the SN team confirms the exact group names against the WCM ServiceNow instance:

| Mailbox (today) | Proposed SN assignment group |
|---|---|
| `support@med.cornell.edu` | ASMS / Directory |
| `ofa@med.cornell.edu` | Faculty Affairs |
| `osra-operations@med.cornell.edu` | Sponsored Research Admin |
| `scholars@weill.cornell.edu` | Scholars team |

### 3.3 ⚠️ Recipients to resolve before the integration ships

Each row below needs an **owning office** and an **assignment group** named. These are stakeholder decisions, not codebase facts — tracked here as the resolution checklist (driver: Omar / #506 Gate D):

- [ ] **Graduate School appointment** (Jenzabar) → office? group?
- [ ] **Student mentor / mentee** (Jenzabar) → office? group? *(likely same as Graduate School appointment)*
- [ ] **Postdoc mentee** (Enterprise Directory / HR) → office? group?
- [ ] **Hospital position** (NYP IdentityIQ) → office? group? **Confirm whether this routes to a WCM assignment group or off-WCM to NYP** (see §5, off-WCM destination).
- [ ] **Disclosures** (COI system) → office? group?
- [ ] **Confirm the Scholars-team destination** for ReciterAI-computed fields (topic/Impact/synopsis), center membership, and general feedback — proposed `scholars@weill.cornell.edu` / "Scholars team" group.

Until a row is resolved, its category must not be selectable in the form (or it falls back to the Scholars-team group with a "we'll route this" note) — never silently drop or misroute.

---

## 4. In-app intake form (Scholars side)

The form is the graduated #160 "Request a change" modal. It collects only Route cases (§2). Field provenance: **session** = from the authenticated Scholars session; **input** = user-entered; **derived/auto** = server-set, not user-editable.

| # | Field | Type | Source | Required |
|---|---|---|---|---|
| 1 | Submitter CWID | text | session | yes |
| 2 | Submitter name + email | text | session | yes |
| 3 | Subject profile (CWID / slug) | text | prefilled from the launching profile | yes |
| 4 | Submitter is the subject? | bool | derived (CWID match) | yes |
| 5 | Category / entity | select | from the matrix (Title, Appointment, Education, Funding, Publication, Hospital position, Disclosure, Topic/Impact/Synopsis, Center membership, Other) | yes |
| 6 | Issue type | select | wrong / missing / not-mine / duplicate / other | yes |
| 7 | Specific item ref | text | e.g. PMID, grant ID, appointment/education row | no |
| 8 | Current value (as shown) | text | prefilled where available | no |
| 9 | Requested change / detail | textarea | input (free text) | yes |
| 10 | Source system | text | **derived** from category (provenance map, #511) | auto |
| 11 | Assignment group | — | **derived server-side from category — never sent by the client** | auto |
| 12 | Attachment | file | optional supporting doc | no |
| 13 | Submitted-at + channel | datetime/text | auto | auto |

**Client → server payload** is intentionally minimal: `{ subjectCwid, category, issueType, itemRef?, currentValue?, detail, attachment? }`. The submitter identity (1, 2, 4), the source system (10), and the assignment group (11) are added server-side. The client **cannot** send fields 10 or 11 — sending them is rejected (recipient-tampering guard, §6).

---

## 5. ServiceNow integration contract — the "ask"

What the Scholars server needs from the ServiceNow team to create the ticket:

| Contract item | Decision needed |
|---|---|
| **Record type** | **Request (catalog item / RITM) vs Incident (INC).** Profile corrections are service requests, not break/fix — RITM via a catalog item is the likely fit, but the SN team decides. *(Open — the issue says "request / incident".)* |
| **Target API** | Table API (`POST /api/now/table/<table>`), Import Set, or a scripted REST endpoint / catalog-item submission. |
| **Auth (Scholars → SN)** | A dedicated **service account** (OAuth client credentials or basic) scoped to create-only on the target table. Secret in AWS Secrets Manager; never client-side. |
| **Assignment-group field** | The SN field the derived group maps to (`assignment_group` sysid). Scholars sends the group; confirm whether SN re-derives via a business rule instead (then Scholars sends `category` and SN maps). |
| **Field mapping** | Scholars form fields (§4) → SN fields (`short_description`, `description`, `caller_id`/`requested_for`, `u_subject_cwid`, `u_category`, `u_source_system`, attachment). Confirm the custom `u_*` fields or whether everything goes in `description`. |
| **Caller identity** | Map submitter CWID → SN `sys_user` (`caller_id` / `requested_for`). Confirm CWID is the SN correlation key. |
| **Off-WCM destination (NYP)** | Does a hospital-position correction route to a WCM assignment group, an NYP group in the **same** SN instance, or **email out** to NYP? (Resolves the §3.3 NYP row.) |
| **Response SLA per group** | Currently undefined (`docs/self-edit-launch-spec.md` ships a generic subject, no SLA). Each assignment group needs a target first-response / resolution SLA, or an explicit "no SLA" so the user-facing copy is honest. |
| **De-dup / correlation** | Optional `correlation_id` (e.g. `scholars:<subjectCwid>:<category>:<itemRef>`) so repeat submissions thread rather than spawn duplicates. |
| **Acknowledgement** | What Scholars shows on success — the SN ticket number echoed back, or a generic "submitted" (depends on whether the create call returns synchronously). |

---

## 6. Security & integrity guards

- **Recipient-tampering guard (load-bearing).** The client sends only the category; the server derives the assignment group and source system. Fields 10–11 in any client payload are rejected. This is the same principle as the #160 server mailer (`docs/self-edit-request-change-server-mailer-plan.md` § Recipient tampering — closed server-side).
- **Authenticated-only.** The endpoint requires the Scholars session; submitter identity (1, 2, 4) is taken from the session, never from the request body. An unauthenticated POST is a 401.
- **Subject-vs-not-subject is captured, not gated.** Field 4 records whether the submitter is the profile subject; anyone authenticated may submit a correction about any profile (a colleague reporting a misattribution is valid). The handling office weighs the relationship.
- **Injection.** CRLF-strip any value interpolated into SN headers/short_description; treat `detail` as untrusted text. Enforce a max length on `detail` and reject control characters. Attachment type/size allow-list.
- **Rate limiting.** Reuse the `/api/edit` limiter so a single session cannot flood the queue.
- **PII minimization.** Collect only what the handling office needs; do not copy unrelated profile fields into `description`.

---

## 7. Open questions

1. **Record type** — request (RITM) vs incident (INC). *(§5; SN team.)*
2. **Auth mechanism** Scholars → SN — service account flavor + scope. *(§5; SN team.)*
3. **Per-group SLAs** — undefined today; needed for honest user-facing copy. *(§5.)*
4. **Off-WCM NYP routing** — WCM group, NYP group in-instance, or email out. *(§3.3 / §5.)*
5. **⚠️ recipients** — the five unresolved owning offices + groups. *(§3.3 checklist; stakeholders.)*
6. **Custom `u_*` fields vs free-text `description`** — how much structure SN wants. *(§5.)*

---

## 8. Relationship to adjacent work

- **#160** — the "Request a change" modal + server mailer this graduates. The modal becomes the form trigger; its `mailto:`/SES transport is replaced by the §5 integration. The three shapes (§2) and locked destinations (§3.1) are inherited unchanged.
- **#511** — the per-field provenance map (`lib/edit/field-sources.ts`) is the source of field 10; the form's category list and source labels stay consistent with it.
- **#508 / #515** — the `/about/help/request-a-correction` page is the user-facing front door. Its contact-mechanism copy is the placeholder gated on **this spec**; once the integration ships, that page links to the in-app form and the source-system column is joined by a real "how to submit" path.
- **WCM ops model** — ServiceNow + Teams, no automated paging (`project_wcm_ops_model`). A Scholars ServiceNow CI / business service was already a tracked follow-on; this integration assumes it exists or names creating it as a precondition.

---

## 9. Validated against VIVO incident history

This matrix's three-shape model and route-only intake were validated against the predecessor system's ten-year ServiceNow record (604 incidents, 2016–2026; N = 594 after excluding infra noise) in `vivo-incident-analysis.md`. Key confirmations and the two changes that analysis drove:

- **The intake design holds.** ~25% of VIVO tickets closed as "Information provided" (an answer, no fix) — exactly the volume the self-service + explain shapes deflect without a ticket (§2). Publications (~27%) was the single largest theme and is the best-covered (auto-ingest + the publications attribute).
- **~40–50% of VIVO volume is structurally eliminated** by the Scholars platform (auto-generated profiles, unified SSO, the self-edit surface, no phone rendering), so it never reaches this matrix. The matrix's job is the source-data residual + the long tail.
- **Two rows added to §3** from gaps the history exposed: **whole-profile duplicate / identity** and **technical / display problem** (both → Scholars team).
- **The catch-all is load-bearing.** ~15% of VIVO tickets were vague ("just fix my profile"); without the "General feedback / can't find an answer" row reaching the form (build #520), that volume reverts to emailing support — the pattern this system replaces.
- **Confirmed out of scope:** phone/contact (not rendered), overview/bio (direct self-edit), provisioning/login (structural). See `vivo-incident-analysis.md` §7.
