# Self-edit — v1 SPEC

**Status:** Draft
**Date:** 2026-05-17
**Authors:** Scholars Profile System development team
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer (the `field_override` + `suppression` mechanism)
**Implements:** the feature layer of [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) (suppression) and [#29](https://github.com/wcmc-its/Scholars-Profile-System/issues/29) (slug override)
**Gated by:** B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) (SSO), B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) (authorization predicate + 403 telemetry), B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) (append-only audit log)
**Unblocks:** ADR-005 → Accepted (resolves its Open Question #1)

---

## Purpose

**Self-edit** is the writer feature behind launch blockers B01–B03: a WCM scholar, signed in through WCM SSO, correcting their own public profile — and a superuser (`scholars-admins` group member) suppressing records that must not be shown publicly. It does not exist yet: there is no `/api/edit` route and no `/edit/*` page tree.

ADR-005 settled the *mechanism* — two ETL-immune tables (`field_override`, `suppression`) merged at read time. This SPEC defines the *feature* on top of that mechanism: which fields a scholar may edit, what the suppression controls do, who is allowed to do what, and how each write commits. It does not reopen ADR-005.

This SPEC is the document ADR-005's Open Question #1 was waiting on. Its central deliverable — [the v1 editable-field set](#the-v1-editable-field-set) — enumerates the `field_override.fieldName` domain; enumerating that domain resolved ADR-005's Open Question #1 and moved the ADR from *Proposed* to *Accepted*.

*Terminology.* **Self-editing scholar** — a signed-in scholar acting on `scholar.cwid == session.cwid`. **Superuser** — a session whose SSO claims include the `scholars-admins` group. **Displayed author** — ADR-005's term: a confirmed, site-visible WCM-scholar authorship on a publication. "Override" denotes read-time precedence over ETL-projected data (ADR-005 § Context).

---

## Scope and actors

Two actors, and a deliberately small v1 capability set. The locked decisions below are encoded, not relitigated.

| Capability | Self-editing scholar | Superuser |
|---|---|---|
| Edit `overview` (profile bio) | ✅ own record only | ⛔ deferred — broad admin field-editing (ADR-005 § Non-goals, B02) |
| Set / clear the `slug` override | ⛔ | ✅ any scholar (#29 — curatorial) |
| Suppress own profile | ✅ immediate, no gate, notifies a superuser | — |
| Suppress any profile | — | ✅ immediate |
| Hide a publication (own authorship) | ✅ writes a per-author suppression | — |
| Whole-publication takedown (retraction / compliance) | ⛔ | ✅ |
| Revoke a suppression | ✅ only ones they applied themselves | ✅ any |

**A scholar acts only on their own data** — their profile, and themselves as a contributor on their own publications. A superuser's v1 powers are exactly two specific, individually-tracked mechanisms: **suppression** of any v1-supported entity, and the **`slug` override** (#29). Neither is the general "admin edits arbitrary scholar fields" surface — that remains deferred.

**v1 entity scope** is ADR-005's: `Scholar`, `Publication`, and the `(Publication, author)` pair. Grant, Education, and Appointment suppression is blocked on the ETL stable-key refactor ([#352](https://github.com/wcmc-its/Scholars-Profile-System/issues/352)) and is out of scope here.

---

## The v1 editable-field set

This is the central deliverable. The v1 `field_override.fieldName` domain is **exactly two values**:

```
field_override.fieldName ∈ { 'overview', 'slug' }
```

The write path validates `fieldName` against this allowlist; any other value is a `400`. (`fieldName` is `VarChar(64)` free text in the ADR-005 schema — the allowlist is enforced in application code, which this SPEC owns.) In v1 `field_override` only ever carries `entityType='scholar'`, `entityId = scholar.cwid`.

| `fieldName` | Overrides | Written by | Validation rule (enforced in the write path) |
|---|---|---|---|
| `overview` | `Scholar.overview` — the profile **Overview / bio** section. No ETL writes this column; the override is the field's effective source of truth. The column is retained as the read-merge fallback (it holds seed / legacy content). | Self-editing scholar, **own record only**. | Server-side sanitize to the tag allowlist `{ p, br, ul, ol, li, strong, em, a }`. The **only** permitted attribute is `href` on `<a>`, and its URL scheme must be `https`, `http`, or `mailto` — any other (`javascript:`, `data:`, `vbscript:`, `file:`, …) has the `href` dropped, leaving the link text as plain text. Each surviving `<a>` is rewritten with `rel="noopener noreferrer nofollow"`, and `http`/`https` links additionally get `target="_blank"`. Strip every other tag and every other attribute — `script`, `style`, `iframe`, `img`, `span`, `div`, headings, and every event-handler attribute. Normalize `b → strong`, `i → em`. Length ≤ **20,000 characters** of the sanitized HTML → else `400` (the bound is on the stored HTML string, not visible text — `field_override.value` is a MySQL `Text` column, so capping the HTML keeps every override safely inside it). An empty string is a valid value (means "no overview"); a sanitized result that is structurally empty (`<p></p>`, or whitespace only) is normalized to the empty string. |
| `slug` | `Scholar.slug` — the profile URL segment. ETL-written and `@unique`; `etl/ed` consults the override before minting (ADR-005 § ETL precedence). | **Superuser only** (#29 frames slug override as curatorial). | Lowercase-normalize, trim. Must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, contain no `--` run, and be ≤ 64 chars. **Reject** if it equals any other scholar's live `Scholar.slug`, any `field_override(slug)` value for a different CWID, a `SlugHistory.old_slug` whose `currentCwid` is a different scholar, or a reserved `/scholars/*` route segment (e.g. `by-cwid`). Collision → `400` (no swap in v1). The application collision check is **not atomic** — concurrent superuser writes of the same slug for *different* CWIDs each pass independently (the `field_override` `@@unique` is on the target, not the value). It is therefore backed by a **DB uniqueness guard**: MySQL has no partial index, so a stored generated column holds `value` only for `(entityType='scholar', fieldName='slug')` rows (`NULL` elsewhere; `VarChar(64)`) with a `UNIQUE` index — a concurrent duplicate fails at the DB and surfaces as the same `400`. |

**No other `Scholar` field is self-editable in v1.** The remaining scalar fields all have an authoritative upstream system of record; a `field_override` on them would permanently mask that upstream — including any future legitimate correction it makes — so corrections route upstream instead.

| `Scholar` field | Source of truth | Why it is not v1-editable |
|---|---|---|
| `preferredName`, `fullName` | ED / LDAP `displayName` (#28) | Authoritative directory data; name corrections route to ED. `preferredName` is also the `deriveSlug` input — overriding it would desync name and slug. The URL concern is served separately by the `slug` override. |
| `postnominal` (degree string) | WOOFA faculty SOR (`weillCornellEduDegree`) | SOR-authoritative; corrections route to the SOR. **Most likely fast-follow** if SOR-correction latency proves unacceptable to faculty. |
| `primaryTitle`, `primaryDepartment` | ED / LDAP | Institutionally governed — a scholar's title and department are not self-asserted on an official institutional site. |
| `email` | ED / LDAP | Authoritative and contact-critical; an arbitrarily self-set display email is a contact-redirection vector. Route corrections to ED. |
| `orcid` | WCM Identity system (`etl/identity`) | Identity-system-authoritative, and **not visibly rendered** on the profile (it appears only in JSON-LD for crawlers) — a scholar cannot see it to know it is wrong. A reasonable fast-follow given its clean validation regex. |
| `clinicalProfileUrl`, `hasClinicalProfile` | ED / LDAP (`labeledURI;pops`, person-type codes) | ED-authoritative. |
| `headshotUrl` | Not persisted — the live headshot is computed at render time from the WCM directory photo service (`identityImageEndpoint(cwid)`). | The photo is directory-authoritative (fix it upstream). A self-edited headshot needs an upload + storage pipeline; ADR-005 scopes `field_override.value` (`Text`) to "slug and bio", not binaries. See [Non-goals](#non-goals). |
| `status` | the `suppression` table (ADR-005) | Changed through the [suppression](#suppression-ux-and-behavior) path, never through `field_override`. |
| `roleCategory`, `deptCode`, `divCode`, `postdoctoralMentorCwid`, timestamp / system columns | derived / system | Not user-facing editable content. |

Two validation rules carry security weight and are not obvious:

- **`overview` sanitization is mandatory, not optional.** The public profile renders `overview` through `dangerouslySetInnerHTML` with **no sanitizer applied** (`app/(public)/scholars/[slug]/page.tsx` — verified; sibling publication fields go through `sanitizePubmedHtml`, `overview` does not). That is safe today only because `overview` is trusted seed data. The moment self-edit makes it user input it is a stored-XSS vector. The write path therefore sanitizes **on write**, so the stored value — and the value B03 audits — is already safe and the existing raw render path needs no change. Allowing `<a>` raises the bar rather than lowering it: the same write-time pass validates every `href` scheme (`https` / `http` / `mailto` only), since an unsanitized `javascript:` `href` is itself an XSS vector.
- **The `slug` `slug_history` check is an identity-bleed guard** (#29 risk 4). If a desired slug already exists in `SlugHistory` pointing at a *different* scholar, claiming it would silently shadow that scholar's 301 redirect, sending their old inbound links to the wrong person. Reject it.

### Hyperlinks in `overview` — an accepted trade-off

Allowing `<a>` (added with `self-edit-ui-spec.md`) deliberately widens the manual-content surface. Links in a faculty bio are a basic expectation, and the editing scholar is authenticated and acting on their own record — but three consequences are **accepted, not overlooked**:

- **Institutional-authority transfer.** A bio renders on a `weill.cornell.edu` URL inside the institution's chrome, so a clickable link there inherits an implied institutional endorsement — `https://wcm-payroll-update.example.com` (or a `mailto:` to a look-alike address) in a faculty bio reads as vouched-for to a non-suspicious visitor. A scholar could already *write* such a URL in prose; making it a live link materially raises click-through. `rel="noopener noreferrer nofollow"` covers tabnabbing and SEO, and the scheme allowlist blocks `javascript:`, but the social-engineering residue is real. It is accepted: a compromised scholar account is a larger problem than one bio link, and a deliberately-malicious scholar is outside the threat model of a self-edit feature.
- **No destination-domain policy.** The scheme allowlist (`https`/`http`/`mailto`) constrains how a link is formed, not where it points — a scholar may link any host. A curated destination allowlist (`.edu`, ORCID, PubMed, recognized publishers) would be a write-time validation this SPEC could own; v1 **defers it explicitly** (see [Non-goals](#non-goals)) rather than leaving it to surface later as a surprise.
- **One-shot sanitization.** The bio is sanitized once, on write; a destination benign on write-day can turn malicious months later. Re-sanitizing or re-resolving links on every render is the alternative — rejected for v1 on cost, since the render path is a raw read of the pre-sanitized value. The staleness window is accepted.

---

## Surfaces

Two route trees, both `CachingDisabled` + `AllViewer` at CloudFront (already specified — `cloudfront-cache-spec.md` rows 1–2, "lands with B01"). The visual and interaction design of the `/edit/*` pages is a separate `UI-SPEC.md` deliverable (`gsd-ui-phase`); this SPEC defines their routes, sections, and behavior only.

### `/edit/*` — pages (SSO-gated, uncached, GET)

| Route | Actor | Contents |
|---|---|---|
| `/edit` | self | The scholar's own edit surface, bound to `session.cwid` (no CWID in the URL). Three sections: **Overview** editor; **Profile visibility** (self-suppress / un-suppress); **My publications** (per-publication hide / show). |
| `/edit/scholar/[cwid]` | superuser | The same page component bound to an arbitrary `cwid`: suppress / un-suppress that scholar, and set / clear their `slug` override. A non-superuser requesting a `cwid` other than their own → `403`. (`cwid == session.cwid` behaves exactly like `/edit`.) |
| `/edit/publication/[pmid]` | superuser | Whole-publication suppression (retraction / compliance takedown) and its revoke. |

All `/edit/*` pages read the target record with the **suppression filter OFF** (ADR-005 § "One read-path exception") — a self-suppressed scholar must still be able to load `/edit` and lift the suppression. The "My publications" list reads the scholar's confirmed authorships *including* ones they have already hidden, each annotated with its current suppression state, so a hidden publication can be un-hidden. A page load with no valid session redirects to SSO login (B01).

### `/api/edit/*` — write endpoints (SSO-gated, uncached, POST-only)

Three flat routes under `/api/edit*`. All are `POST`, accept `application/json`, and return `200` on success, `400` on validation failure, `401` unauthenticated, `403` unauthorized, `5xx` on a failed transaction. There are no `GET` endpoints — the `/edit/*` pages do their own server-side reads.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/edit/field` | `{ entityType: "scholar", entityId, fieldName: "overview" \| "slug", value }` | Upsert one `field_override` row. |
| `POST /api/edit/suppress` | `{ entityType: "scholar" \| "publication", entityId, contributorCwid?, reason }` | Insert one `suppression` row (`contributorCwid` absent / `null` = whole-entity). |
| `POST /api/edit/revoke` | `{ suppressionId }` | Soft-revoke one `suppression` row. |

Success responses carry the post-merge result so the client need not refetch — e.g. `POST /api/edit/field` returns `{ ok: true, fieldName, value }` (the sanitized value); `POST /api/edit/suppress` returns `{ ok: true, suppressionId }`. Validation failures return `{ ok: false, error, field? }` and never echo a session token or another scholar's data.

---

## Authorization

The feature consumes B01's session and B02's predicate machinery; this section specifies the **rules** the predicate enforces. B01 (#100) establishes the HttpOnly / Secure / SameSite=Lax session cookie and the SSO integration; B02 (#101) plumbs the `scholars-admins` group claim, **re-checks it on every `/api/edit*` POST**, and emits the `edit_authz_denied` telemetry and its CloudWatch alarm.

**Session shape consumed:** `{ cwid: string, isSuperuser: boolean }`, where `isSuperuser` is `scholars-admins ∈ groups` re-evaluated **on every `/edit/*` request — each GET page load and each `/api/edit*` POST** — never cached for the session (see edge case 15).

**The GET re-check is not optional.** `/edit/scholar/[cwid]` and `/edit/publication/[pmid]` are superuser-only GET pages, and they read the target record with the **suppression filter OFF** — exposing a suppressed scholar's data and a suppression's `reason`. Re-checking the group claim only on the POST would leave a user removed from `scholars-admins` mid-session with read access to those pages for the rest of the session window (up to 8h). The page-level GET therefore re-evaluates the claim too — a session-claim read it already performs to resolve the predicate — so a mid-session deauthorization closes the data-exposure window, not just the write window.

**Per-action predicate** — a request is allowed iff its row matches:

| Action | Allowed iff |
|---|---|
| `field`, `fieldName = 'overview'` | `session.cwid == body.entityId` — **self only.** A superuser does *not* inherit this; broad admin field-editing is deferred. |
| `field`, `fieldName = 'slug'` | `session.isSuperuser` |
| `suppress`, `entityType = 'scholar'`, whole-entity (`contributorCwid` null) | `session.cwid == body.entityId` (self-suppress) **or** `session.isSuperuser` |
| `suppress`, `entityType = 'publication'`, per-author (`contributorCwid` set) | `session.cwid == body.contributorCwid` **and** a `publication_author(pmid = entityId, cwid = session.cwid)` row exists — **or** `session.isSuperuser` |
| `suppress`, `entityType = 'publication'`, whole-entity (`contributorCwid` null) | `session.isSuperuser` only |
| `revoke` | the target row's `created_by == session.cwid` (revoke own self-applied) **or** `session.isSuperuser` |

Beyond the predicate: an unrecognized `fieldName` (∉ `{overview, slug}`) → `400`; an `entityType` of `grant` / `education` / `appointment` → `400` (blocked on #352); a missing or invalid session → `401` with an **empty body** (B01 — no leakage). Every `403` emits `event: "edit_authz_denied"` with `{ actor_cwid, target_cwid, path, reason }` (B02).

**Defense in depth beyond `SameSite=Lax`.** The session cookie is `SameSite=Lax`, which already blocks the cookie from riding a cross-site `POST`. As a second layer the `/api/edit/*` handlers require `Content-Type: application/json` and verify the request is same-origin (`Sec-Fetch-Site: same-origin`, or an `Origin` check against the canonical host). A cross-site HTML form cannot satisfy both.

---

## Suppression UX and behavior

Suppression spans both actors and three shapes. ADR-005 owns the storage and the read-merge — including the **derived publication visibility** rule; this SPEC owns the user-facing actions and the write path.

### Whole-profile suppression

Site-wide, unilateral, available to both actors, and **immediate**. A scholar self-suppressing from `/edit` takes effect at once **with no approval gate** — but the write **notifies a superuser** as a care / follow-up signal (see below). A superuser suppresses any scholar from `/edit/scholar/[cwid]`.

The write inserts a `suppression` row and sets `Scholar.status = 'suppressed'` in the same transaction (ADR-005 § Scholar suppression — `status` is a denormalized projection of the table). The ~20 existing read filters, `lib/url-resolver.ts`, and `etl/search-index` then enforce it everywhere. Public visibility is the **conjunction** `status = 'active' AND deletedAt IS NULL`: `status` (manual suppression) and `deletedAt` (ETL-set when a scholar departs) are orthogonal exclusion criteria, and every read filter must test **both** — filtering on `status` alone would leak a departed-but-not-suppressed scholar. Audit query B below is the worked example; a read-filter audit (the CI grep / the branded `Merged<T>` types) should confirm no read site checks `status` without `deletedAt`. A superuser-suppressed scholar can still load `/edit` and edit their `overview` (harmless — the profile is non-public) but cannot revoke a superuser-applied suppression.

`reason` is a required column. For a self-suppress the `/edit` UI collects an optional short reason (free text, or a preset); if left blank the write stores a default (`"Self-suppressed via /edit"`). For a superuser suppression `reason` is mandatory free text — the retraction notice, compliance reference, or ticket link.

### Hide a publication

A scholar hiding one of their publications from `/edit` is **one action that always writes a per-author `suppression` row** — `entityType='publication'`, `entityId=pmid`, `contributorCwid = session.cwid`. The write path never chooses whole-publication suppression; whole-publication visibility is **derived** at read time (ADR-005 § Publication suppression: a publication is shown iff ≥ 1 displayed author remains). Hiding removes the scholar from that publication's WCM-author set: no profile hyperlink, omitted from the rendered author list and from author-derived links and counts, site-wide (#160), and excluded from their own profile and topic aggregations. The publication itself is kept for any remaining displayed authors.

This also serves the **misattribution** correction — a publication ReCiter wrongly attributed to a scholar is removed from their record by the same per-author hide.

The sole-displayed-author case is the degenerate one: the last displayed WCM author hides it, zero remain, and the publication derives to hidden site-wide. It self-heals — the scholar can revoke, or a new WCM co-author attributed later brings it back (ADR-005 § Publication suppression).

### Whole-publication takedown

`contributorCwid = null` on a `publication` suppression is the **editorial / superuser** path — a retraction or compliance takedown independent of authorship, invoked from `/edit/publication/[pmid]`. A publication is hidden iff *either* an explicit whole-publication suppression exists *or* it has zero displayed authors.

### Revoke

A suppression is revocable — soft-revoke, never a delete (ADR-005: a target is suppressed iff a matching row has `revoked_at IS NULL`). The revoke rule: **a scholar may lift only suppressions they applied themselves** (`created_by == session.cwid`); a superuser-applied suppression can be lifted only by a superuser. Revoking a *scholar* suppression sets `Scholar.status = 'active'` in the same transaction — **gated on no other un-revoked `suppression` row remaining** for that scholar (ADR-005 § Scholar suppression: there is no `previous_status` to restore — the only non-suppressed state is `active`).

### Notifying a superuser of a self-suppression

A scholar hiding their own profile is a signal a human should follow up on — why did they hide it, is the underlying data wrong, are they alright? v1 emits a structured log event `event: "self_suppression"` with `{ scholar_cwid, reason, ts, request_id }`, mirroring B02's `edit_authz_denied` pattern. A CloudWatch metric filter + alarm (or an SNS subscription on the log group) routes it to a **named notification channel with a defined owner** — reusing the `etl-failures` SNS pattern. The concrete topic, the channel it feeds, and the person or rota who watches it are set at build time and named in the runbook: without a defined audience an informational alarm is silently ignored. The alarm is **informational, not paging**. A richer in-app review queue or a direct email is a deferred enhancement.

---

## Write-path behavior

Every `/api/edit/*` action is **one MySQL transaction**, followed by best-effort post-commit reflection. The transaction model and the OpenSearch failure model are ADR-005's (§ Write-path failure model); this section specifies the per-action sequence and the CDN behavior.

### The transaction

`field_override` / `suppression` live in the application schema; the B03 audit table lives in a separate schema on the **same Aurora cluster**, so one MySQL transaction spans both (ADR-005). Per action:

1. **Validate** — predicate ([Authorization](#authorization)) + per-field rule ([editable-field set](#the-v1-editable-field-set)). On failure: `4xx`, nothing written, **no audit row**.
2. **Write the manual-layer row** — `upsert` the `field_override` row (`field`); `insert` a `suppression` row (`suppress`); set `revoked_at` / `revoked_by` (`revoke`).
3. **For a scholar suppression or its revoke** — also set `Scholar.status` (`'suppressed'` on suppress; `'active'` on revoke when no other un-revoked `suppression` row remains).
4. **Insert one B03 audit row** capturing actor, target, action, and the before/after values.

If any step fails the whole transaction rolls back — no half-applied write, no orphan audit row (edge case 14).

### Post-commit reflection

| Action | CDN / page revalidation | OpenSearch |
|---|---|---|
| `overview` edit | `revalidatePath('/scholars/{slug}')`. Edge-cache lag ≤ 24h is **acceptable** — a corrected bio tolerates it (ADR-005). | None at write time; the nightly `etl/search-index` rebuild reflects it. |
| `slug` override | **None at write time** — the URL does not change until the next `etl/ed` run consumes the override. | None; rides the nightly cycle. |
| Scholar suppression / revoke | `revalidatePath` **and a CloudFront invalidation** of `/scholars/{slug}`, `/browse`, and the scholar's `/departments/{d}`, `/departments/{d}/divisions/{v}`, `/centers/{c}`, and each `/topics/{t}` they appear on (a bounded set, computable from `deptCode` / `divCode` / center memberships / distinct `PublicationTopic.parentTopicId`). | Fast-path targeted delete / re-add; the ADR-005 reconciler is the durable guarantee. |
| Publication per-author hide / revoke | Invalidate the acting scholar's `/scholars/{slug}`; if the hide makes the publication derived-dark, also its `/topics/{t}`. | Fast-path document update. |
| Whole-publication takedown / revoke | Invalidate every displayed co-author's `/scholars/{slug}` and the publication's `/topics/{t}`. | Fast-path delete / re-add. |

**`revalidatePath()` alone does not purge the CDN.** It busts the Next.js cache so the origin regenerates, but CloudFront keeps its own copy for up to its 24h Default TTL (`cloudfront-cache-spec.md` § Cache TTLs). For an `overview` edit that lag is fine. For **suppression** it is not — a ≤ 24h edge-cache window reintroduces exactly the staleness ADR-005's urgency split exists to eliminate (retraction, FERPA / HIPAA exposure, harassment). So a suppression write must additionally issue a CloudFront `CreateInvalidation` for the affected paths. Every path above is already in `/api/revalidate`'s allow-list (`/scholars/{slug}`, `/topics/{slug}`, `/departments/*`, `/browse`); no allow-list change is needed. The write path calls the `revalidatePath` primitive in-process (it and `/api/revalidate` are the same ECS service — no self-HTTP-call, no token, no internal-ALB hop) and issues the CloudFront invalidation directly. Because the in-process call bypasses the HTTP `/api/revalidate` handler, it bypasses that handler's allow-list check too — so the write path validates every path against the **same shared allow-list constant** before calling `revalidatePath` or `CreateInvalidation`, catching an off-list path from a write-path bug exactly as the HTTP handler would. See [Open questions](#open-questions) #1 and [Interfaces](#interfaces-and-dependencies).

**The CloudFront invalidation needs the same durability as the OpenSearch path.** A `CreateInvalidation` call can fail — throttling, a `5xx`, an IAM denial. A silently-failed invalidation leaves the suppressed page served from the edge for up to 24h: exactly the staleness the urgency split exists to prevent, and exactly the failure the OpenSearch reconciler is built to absorb. So the CloudFront path cannot be best-effort-and-forget. The suppression write issues the invalidation with a **bounded synchronous retry**, and on exhaustion records the pending invalidation in a small durable outbox (`pending_cdn_invalidation { path, attempts, last_error, … }`) drained by a short-interval worker — the same "the table is the durable queue, a worker drains it" shape ADR-005 uses for the OpenSearch reconciler — with an operational alarm when an entry's age exceeds a threshold. The detailed mechanism is [#353](https://github.com/wcmc-its/Scholars-Profile-System/issues/353)'s scope; this SPEC fixes the **requirement**: a suppression's edge invalidation is durable, not fire-and-forget.

---

## Edge-case test table

Locks the boundary behaviors before implementation. ADR-005's 16-row table covers the *mechanism* (ETL survival, keying, derived visibility); this table covers the *feature* — authorization, validation, the write path, and multi-actor interactions — and does not duplicate it.

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | A self-suppressed scholar opens `/edit` | Page loads — `/edit/*` reads the own record suppression-OFF (ADR-005 read-path exception). The un-suppress control is shown. |
| 2 | Scholar A `POST`s `/api/edit/field` with `entityId` = scholar B | `403` `edit_authz_denied` `{reason: "not_self"}`. No write, no audit row. |
| 3 | A scholar self-suppresses their profile | One transaction: `suppression(scholar, cwid, NULL)` + `Scholar.status='suppressed'` + B03 row. Immediate, no gate. Emits `event: "self_suppression"`. Post-commit: CloudFront invalidation of the profile + listings; fast-path OpenSearch delete. |
| 4 | A superuser also suppresses that scholar (2 rows); the scholar then revokes their own row | The scholar's row is soft-revoked; the superuser row remains un-revoked → `status` stays `suppressed` (the revoke's status flip is gated on zero remaining un-revoked rows). |
| 5 | A scholar tries to revoke a superuser-created suppression on themselves | `403` — revoke requires `created_by == session.cwid` or superuser. |
| 6 | A scholar hides a publication they are a confirmed author of | `suppression(publication, pmid, contributorCwid = self)`. The publication drops from their profile; co-authors keep it; the scholar's name is omitted from the author list site-wide. |
| 7 | The sole displayed WCM author hides their publication | The per-author row is written; derived visibility → 0 displayed authors → the publication is hidden site-wide. Revocable by that scholar. |
| 8 | A scholar submits an `overview` containing `<script>`, an `onclick=` handler, or `<a href="javascript:…">` | The write path sanitizes server-side to the tag allowlist (`p br ul ol li strong em a`): `<script>` and event-handler attributes are stripped; an `<a>` whose `href` scheme is not `https`/`http`/`mailto` keeps its text but loses the `href`; an allowed-scheme `<a>` is kept and rewritten with `rel`. The **sanitized** value is what is stored and audited. |
| 9 | `overview` exceeds 20,000 chars after sanitization | `400` validation error; nothing written; no audit row. |
| 10 | A superuser sets a `slug` override that collides with another scholar's live `Scholar.slug` | `400` — rejected; no swap in v1 (the swap UX is a #29 follow-up). |
| 11 | A superuser sets a `slug` override equal to a `SlugHistory.old_slug` pointing at a different scholar | `400` — identity-bleed guard (#29 risk 4): claiming it would shadow that scholar's 301 redirect. |
| 12 | A `slug` override is stored successfully | The `field_override` row is written; **`Scholar.slug` is unchanged until the next `etl/ed` run** consumes it (ADR-005 § ETL precedence). `/scholars/{new}` 404s until then; `/scholars/{old}` still resolves. |
| 13 | A scholar edits `overview` twice | One `field_override(scholar, cwid, 'overview')` row, upserted in place (ADR-005 `@@unique`); **two** B03 audit rows (append-only history). |
| 14 | The B03 audit insert fails inside the write transaction | The whole transaction rolls back — no `field_override` / `suppression` row, no `Scholar.status` change. The endpoint returns `5xx`; nothing is half-applied. |
| 15 | A user removed from `scholars-admins` mid-session opens `/edit/scholar/[cwid]` or `POST`s a `slug` edit | The group claim is re-evaluated on **both** the GET page load and the POST → no longer superuser → the GET returns `403` and the POST returns `403` (`edit_authz_denied`). Admin is lost on the **next `/edit/*` request** — GET or POST — so the suppression-OFF data on the superuser GET pages stops being reachable immediately, not after the 8h session. |
| 16 | An unauthenticated `POST` to any `/api/edit/*` route | `401`, empty body — no leakage (B01). |
| 17 | A scholar sets `contributorCwid` to another scholar when hiding a publication | `403` — a scholar may suppress only *themselves* as a contributor (`contributorCwid == session.cwid`). |
| 18 | A scholar tries to hide a publication they are not an author of | `400` — no `publication_author(pmid, cwid = session.cwid)` row exists; there is nothing to suppress. |
| 19 | A `suppress` request targets an entity that already has an un-revoked matching suppression | **Idempotent no-op** — returns the existing `suppressionId`; no duplicate row, no new audit row. The realistic trigger is a double-submit (network retry / double-click) carrying the same `reason`, so nothing is lost. v1 has **no flow to change a suppression's `reason` after the fact** — the `/edit` UI offers revoke, not re-suppress — so `reason` is fixed at suppression time; correcting it means revoke + re-suppress. Mutating `reason` in place on a re-suppress, with a B03 audit row for the change, is the documented shape if a reason-edit affordance is later added; deferred. |
| 20 | A superuser sets a `slug` override for a CWID with no `Scholar` row yet (an incoming hire) | Stored — no FK, no row-existence check (ADR-005 edge case 6; #29 reservation). The collision checks still run against existing scholars and history. |
| 21 | A superuser sets a `slug` override equal to the target scholar's **own** `SlugHistory.old_slug` | **Allowed.** The identity-bleed guard rejects only an `old_slug` whose `currentCwid` is a *different* scholar; a scholar reclaiming a slug from their own history is legitimate and passes the check. |
| 22 | A scholar self-suppresses; a superuser then revokes that self-suppression | **Permitted** — the predicate lets a superuser revoke any row. But it returns a profile to public view against the scholar's own deliberate action, so v1 treats it as a **deliberate care decision, not routine cleanup**: a self-suppression is a follow-up signal (§ Notifying a superuser of a self-suppression), and a superuser overriding it should be intentional and informed. |

---

## Audit queries

Runnable against the v1 schema. ADR-005 already ships the slug-vs-scholar collision query and the `status` projection-drift query — not duplicated here. These are feature-operational.

```sql
-- A) Scholars currently self-suppressed — the care/follow-up queue.
--    A human should reach out; `reason` is the lead.
SELECT s.cwid, s.preferred_name, sup.reason, sup.created_at
FROM scholar s
JOIN suppression sup
  ON sup.entity_type = 'scholar' AND sup.entity_id = s.cwid
 AND sup.contributor_cwid IS NULL AND sup.revoked_at IS NULL
 AND sup.created_by = s.cwid                              -- self-applied
WHERE s.status = 'suppressed'
ORDER BY sup.created_at DESC;

-- B) Publications gone fully dark by per-author suppression (zero displayed
--    authors) — as distinct from explicit superuser takedowns. A paper every
--    WCM author is hiding may indicate an upstream attribution error.
SELECT p.pmid, p.title
FROM publication p
WHERE NOT EXISTS (                                        -- no explicit whole-pub takedown
        SELECT 1 FROM suppression s
        WHERE s.entity_type = 'publication' AND s.entity_id = p.pmid
          AND s.contributor_cwid IS NULL AND s.revoked_at IS NULL)
  AND EXISTS (                                            -- it does have WCM authorships
        SELECT 1 FROM publication_author pa
        WHERE pa.pmid = p.pmid AND pa.cwid IS NOT NULL AND pa.is_confirmed = 1)
  AND NOT EXISTS (                                        -- ...but none survives as a displayed author
        SELECT 1 FROM publication_author pa
        JOIN scholar sc ON sc.cwid = pa.cwid
         AND sc.status = 'active' AND sc.deleted_at IS NULL
        WHERE pa.pmid = p.pmid AND pa.cwid IS NOT NULL AND pa.is_confirmed = 1
          AND NOT EXISTS (
                SELECT 1 FROM suppression s2
                WHERE s2.entity_type = 'publication' AND s2.entity_id = p.pmid
                  AND s2.contributor_cwid = pa.cwid AND s2.revoked_at IS NULL));

-- C) Pending slug overrides not yet applied by etl/ed
--    (override value differs from the live scholar.slug).
SELECT fo.entity_id AS cwid, fo.value AS override_slug,
       sc.slug AS live_slug, fo.updated_at
FROM field_override fo
JOIN scholar sc ON sc.cwid = fo.entity_id
WHERE fo.entity_type = 'scholar' AND fo.field_name = 'slug'
  AND fo.value <> sc.slug;

-- D) Orphaned per-author publication suppressions — the contributor is no
--    longer an author on that pmid (ETL re-attribution dropped the authorship).
--    Inert; periodic cleanup.
SELECT s.id, s.entity_id AS pmid, s.contributor_cwid
FROM suppression s
LEFT JOIN publication_author pa
  ON pa.pmid = s.entity_id AND pa.cwid = s.contributor_cwid
WHERE s.entity_type = 'publication' AND s.contributor_cwid IS NOT NULL
  AND s.revoked_at IS NULL AND pa.id IS NULL;

-- E) Feature uptake — self-edited overviews, volume and recency.
SELECT fo.entity_id AS cwid, CHAR_LENGTH(fo.value) AS overview_len, fo.updated_at
FROM field_override fo
WHERE fo.entity_type = 'scholar' AND fo.field_name = 'overview'
ORDER BY fo.updated_at DESC;
```

---

## Interfaces and dependencies

What this feature consumes from the gating issues, and the one interface change it requires.

- **B01 #100 — SSO.** Provides the validated session this SPEC reads as `{ cwid, isSuperuser }`. The feature does not build SSO.
- **B02 #101 — authorization predicate + telemetry.** Provides the group-claim plumbing, the per-POST re-check, the `edit_authz_denied` event, and its CloudWatch alarm. This SPEC's [Authorization](#authorization) table is the *rules*; B02 is the *mechanism*.
- **B03 #102 — audit log.** The write-path transaction inserts exactly one B03 row per action. **Interface requirement:** B03's row as currently scoped (#102) is scholar-field-diff-shaped — `scholar_cwid`, `fields_changed`, `before_values`, `after_values`. It must also record (a) a **suppression create / revoke** event, which is not a field diff, and (b) a **publication target**, which has no `scholar_cwid`. #102 should generalize the row — a `target_entity_type` + `target_entity_id` and an `action` discriminator (`field_override` / `suppression_create` / `suppression_revoke`) — so every manual-layer write audits uniformly. This SPEC does not design B03's schema (ADR-005 § Non-goals); it states the requirement #102 must meet.
- **ADR-005 — manual-override layer.** Provides the `field_override` / `suppression` tables, the read-merge helpers (`lib/api/manual-layer.ts`), the branded `Merged<T>` types, the OpenSearch failure model, and the `etl/ed` slug-precedence consumption. This SPEC writes those tables; it does not modify ADR-005's read side.
- **`/api/revalidate`.** Its allow-list already covers every path suppression touches. Its primitive is `revalidatePath()`, which does **not** purge CloudFront — the suppression write path additionally needs a CloudFront `CreateInvalidation`, which requires `cloudfront:CreateInvalidation` on the ECS **task role** for the distribution ARN (a small, non-secret IAM addition). See [Open questions](#open-questions) #1.
- **#352 — ETL stable-key refactor.** Grant / Education / Appointment suppression is blocked on it. Not a dependency of *this* v1 (which is Scholar + Publication only), but the reason the [entity scope](#scope-and-actors) stops where it does.

---

## Non-goals

- **Broad admin field-editing** — a superuser editing arbitrary `Scholar` fields (title, department, …). A deferred fast-follow (ADR-005 § Non-goals, B02 #101). v1 superuser power is suppression + the `slug` override only.
- **The suppression-management admin console** — a UI to browse, search, filter, and bulk-manage all suppressions. A #160 follow-up. v1 superusers act per-record from `/edit/scholar/[cwid]` and `/edit/publication/[pmid]`.
- **Grant / Education / Appointment suppression** — blocked on the ETL stable-key refactor (#352).
- **The rest of #29's slug policy** — the numeric-suffix scheme, slug release / tombstones, keep-or-prune stickiness, the swap-on-collision UX, and the launch slug-freeze backfill (ADR-005 provides the mechanism; whether and how to run it is a #29 decision). v1 covers only setting and validating a slug override.
- **Headshot self-edit** — needs an upload + storage pipeline; `field_override.value` is `Text`, scoped by ADR-005 to "slug and bio". See the [excluded-fields table](#the-v1-editable-field-set).
- **`orcid` self-edit and other ED / SOR-authoritative field corrections** — they route to the upstream system of record.
- **Destination-domain restriction for `overview` links** — v1 validates a link's *scheme* (`https`/`http`/`mailto`) but not its destination host; a scholar may link any domain. A curated destination allowlist (`.edu`, ORCID, PubMed, recognized publishers) is a possible fast-follow, deferred. See § Hyperlinks in `overview`.
- **Structured (non-scalar) `field_override` values**, and **per-environment suppression scoping** — both ADR-005 § Non-goals.
- **The visual / interaction design of `/edit/*`** — a `UI-SPEC.md` deliverable (`gsd-ui-phase`).
- **Building SSO, the predicate plumbing, or the audit-table schema** — B01 / B02 / B03 own those. This SPEC specifies the rules and consumes the surfaces.

---

## Open questions

1. **CloudFront invalidation for suppression.** `/api/revalidate` today calls only `revalidatePath()`, which leaves the CloudFront edge cache stale for up to 24h — unacceptable for a suppression. Confirm whether the ETL revalidation path already issues a CloudFront `CreateInvalidation`; if not, the suppression write path must (needs `cloudfront:CreateInvalidation` on the task role). **Recommendation: add the explicit CloudFront invalidation for suppression writes.**
2. **Listing-page revalidation fan-out on scholar suppression.** v1 invalidates `/scholars/{slug}` + `/browse` + the scholar's department / division / center / topic pages. Confirm that bounded set is sufficient, or whether `/` (home, when the scholar is featured) must also be force-invalidated. **Recommendation: the bounded set; `/` rides the nightly rebuild — a featured-scholar suppression is rare and a superuser can manually revalidate `/`.**
3. **B03 audit row shape.** B03 (#102) is scholar-field-diff-shaped and must also record suppression events and publication targets. **Recommendation: #102 generalize the row** (`target_entity_type` + `target_entity_id`, an `action` discriminator) — see [Interfaces](#interfaces-and-dependencies). Owned by #102.
4. **`Scholar.overviewUpdatedAt`.** An orphaned column — nothing writes it, and `field_override.updatedAt` now timestamps overview edits. **Recommendation: leave it orphaned in v1** (the profile does not render it); revisit only if an "updated" date is wanted on the profile.
5. **Self-service slug.** v1 makes `slug` superuser-only (per #29). If product wants scholars to pick their own slug, the format / collision validator already covers it; the missing piece is #29's swap-on-collision UX. **Recommendation: keep superuser-only for launch; revisit post-launch.**
6. **Self-suppression notification.** v1 emits a `self_suppression` log event routed via CloudWatch / SNS. Is an in-app review queue or a direct email wanted instead or additionally? **Recommendation: the log event for v1; richer routing is a fast-follow.**

---

## Implementation

The concrete file map for this feature. ADR-005's Implementation table lists `app/api/edit/*` as "future — B01–B03"; this is that scope filled in.

| Path | Role |
|---|---|
| `app/edit/page.tsx` *(new)* | `/edit` — the self-edit surface bound to `session.cwid`. |
| `app/edit/scholar/[cwid]/page.tsx` *(new)* | Per-scholar edit surface; the superuser suppress + `slug` controls. Shares the page component with `/edit`. |
| `app/edit/publication/[pmid]/page.tsx` *(new)* | Superuser whole-publication takedown surface. |
| `app/api/edit/field/route.ts` *(new)* | `POST` — upsert a `field_override` row (`overview` self / `slug` superuser). |
| `app/api/edit/suppress/route.ts` *(new)* | `POST` — create a `suppression` row. |
| `app/api/edit/revoke/route.ts` *(new)* | `POST` — soft-revoke a `suppression` row. |
| `lib/edit/authz.ts` *(new)* | The per-action authorization predicate ([Authorization](#authorization)); emits `edit_authz_denied`. B02 #101 owns the group-claim / re-check / telemetry mechanism it builds on. |
| `lib/edit/validators.ts` *(new)* | Per-field validation — `overview` sanitize + length, `slug` format + collision. The validation ADR-005 explicitly delegates to the self-edit SPEC. The `overview` sanitizer is a **vetted, maintained HTML-sanitization library — never a hand-rolled regex** (entity, comment, CDATA, and mutation-XSS handling differ between libraries and must not be improvised). Recommended: `isomorphic-dompurify` (DOMPurify is the hardened default for a `dangerouslySetInnerHTML` sink), with `sanitize-html` as the alternative; configured to the exact tag allowlist, `href`-only-on-`<a>`, the `https`/`http`/`mailto` scheme set, and a transform adding `rel`/`target`. The final library pick is a security-review decision. |
| `lib/edit/revalidation.ts` *(new)* | Post-commit `revalidatePath` + CloudFront-invalidation fan-out for a given write. |
| `lib/api/edit-context.ts` *(new)* | Suppression-OFF reads for the `/edit/*` surfaces, including the scholar's authorship list annotated with per-publication suppression state. |
| `lib/api/manual-layer.ts` | ADR-005 — the read-merge helpers and `Merged<T>` types. Consumed here; not modified by this SPEC. |
| `etl/ed/index.ts`, `lib/slug.ts` | ADR-005 — consume `field_override(slug)` before minting. Not modified by this SPEC. |
| `prisma/schema.prisma`, `prisma/migrations/…` | ADR-005 — the `EntityType` enum, `FieldOverride`, `Suppression` models and their additive migration. Prerequisite; not owned here. |
| `prisma/migrations/…` *(this SPEC)* | An additive migration adding the **slug-override uniqueness guard** — a stored generated column over `field_override` plus its `UNIQUE` index ([§ The v1 editable-field set](#the-v1-editable-field-set), `slug` row). Closes the concurrent-write collision race. |

---

## References

- [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer. The mechanism this SPEC builds the feature on; this SPEC resolves its Open Question #1.
- [ADR-001](./ADR-001-runtime-dal-vs-etl-transform.md) — runtime DAL is read-only over MySQL + OpenSearch; the ETL is the only writer.
- [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) — § `/api/edit` (auth, two-tier authorization, the audit row), § `/api/revalidate`, § Cookies and the cache key, § Schema migration policy.
- [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) — behaviors 1–2 (`/api/edit*`, `/edit/*` — `CachingDisabled`), § Cache TTLs (the 24h Default TTL).
- [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) — suppression controls; [#29](https://github.com/wcmc-its/Scholars-Profile-System/issues/29) — slug policy; [#352](https://github.com/wcmc-its/Scholars-Profile-System/issues/352) — ETL stable-key refactor.
- B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) / B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) / B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) — SSO, authorization predicate, audit log.

---

> **On ratification:** with the `field_override.fieldName` domain enumerated as `{ 'overview', 'slug' }` ([The v1 editable-field set](#the-v1-editable-field-set)), ADR-005's Open Question #1 is answered — and on that basis **ADR-005 is now Accepted** (ADR-005 § Open questions).
