# Slug personalization — implementation SPEC (#497)

**Status:** Draft for sign-off · 2026-05-27
**Tracks:** #497 (re-scope of #29) · builds on #356/ADR-005 (manual-override layer), #160 (request-a-change)
**Author context:** Resolves the #29 slug-policy review. The override *storage* layer already shipped; this SPEC closes the gaps that make personalized URLs actually work, adds root-level profile URLs, and adds a curator approval queue.

---

## 1. Scope

In scope:

1. **Make slug overrides drive routing** (Option B — reconcile on write). Today the override is write-only and the pretty URL 404s.
2. **ETL re-mint precedence** — a name change must not clobber a pinned slug.
3. **Root-level profile URLs** (`scholars.weill.cornell.edu/<slug>`) as a 301 alias to `/scholars/<slug>`.
4. **Slug-request approval queue** — a scholar requests a preferred URL for their own profile; a superuser approves/rejects.
5. **Reserved-word denylist + slug validation** hardening.

Non-goals (explicit):

- Re-deriving the existing 10,815-slug baseline (frozen — see §3).
- Credential suffixes (`-md`/`-phd`) — names only.
- Self-service slug *application* — only superusers write the override; scholars only *request*.
- A ServiceNow/ticket integration — the queue is in-app.
- Orphan backfill — the 5 orphans are audit-confirmed benign (§6.4).
- Structured/non-scalar overrides — an ADR-005 non-goal, unchanged.

---

## 2. Background: shipped vs. gap

**Shipped (#356/ADR-005) — do not rebuild:**

| Concern | Where |
|---|---|
| Override storage | `FieldOverride` (`prisma/schema.prisma:1007`), `fieldName ∈ {overview, slug}` |
| Atomic cross-CWID uniqueness | migration `20260519120000_add_slug_override_uniqueness_guard` (`slug_guard` STORED generated col + UNIQUE) |
| Write / clear | `app/api/edit/field/route.ts`, `app/api/edit/clear-field/route.ts` |
| Collision + own-history reclaim validation | `lib/edit/validators.ts:202+` |
| Authz (slug = superuser-only) | `lib/edit/authz.ts:44` |
| Read-time application | `lib/api/manual-layer.ts` |

**Confirmed gap (trace 2026-05-27):** the override is **write-only**. `resolveBySlugOrHistory` (`lib/url-resolver.ts:23`), `getScholarFullProfileBySlug` (`lib/api/profile.ts:393`), `getActiveScholarSlugs` (`lib/api/profile.ts:801`) and the canonical metadata (`app/(public)/scholars/[slug]/page.tsx:73`) all key off `Scholar.slug` + `slug_history` and **never read `FieldOverride`**. Setting `brandon-swed` while `Scholar.slug='brandon-swed-2'` ⇒ `/scholars/brandon-swed` **404s**; canonical stays `brandon-swed-2`.

**Corpus baseline (local, 2026-05-27):** 10,815 scholars all slugged; 37 numeric-suffixed = 32 in 31 live collision groups (30 pairs + 1 triple `emily-cheng`) + 5 benign orphans; 2,550 `slug_history` rows (~24%, #28 displayName churn).

---

## 3. Ratified decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **Freeze the baseline** — no corpus re-derivation. | Re-derive all (adds churn to the 2,550 redirects to fix ≤31 cases). |
| D2 | **Incumbent keeps the bare slug**; new arrival gets the numeric floor. | Prominence/seniority tie-break (re-introduces churn). |
| D3 | **Numeric `-N` is the automatic floor**; meaning only via override. | Auto middle-name (often missing for the romanized names that dominate collisions). |
| D4 | **No credential suffix.** | Mirror clinical `…/brandon-swed-md` (credentials change → churn). |
| D5 | **Override → routing = reconcile on write (Option B):** approving an override updates `Scholar.slug` + writes `slug_history`; `FieldOverride(slug)` row becomes the *pin*. | Option A — fork the resolver to query `FieldOverride` (scatters override-awareness across every slug path). |
| D6 | **Root URLs = alias:** keep `/scholars/[slug]` canonical, `301 /<slug> → /scholars/<slug>`. | Root-canonical (one-way door over `/topics`, `/browse`, `/departments`, …). |
| D7 | **Slug requests = in-app approval queue (option 2).** | Reuse #160 mailer (slugs have no external data-owner office). |
| D8 | **Request right = self only**; **approval = superuser only.** | Open requests (squatting risk). |

---

## 4. Data model

### 4.1 New: `SlugRequest`

```prisma
/// Pending scholar requests for a personalized slug, feeding the superuser
/// approval queue. The authoritative override is still the FieldOverride(slug)
/// row written on approval; this table is the queue, not the source of truth.
model SlugRequest {
  id            String            @id @default(uuid()) @db.VarChar(64)
  cwid          String            @map("cwid") @db.VarChar(32)            // target scholar
  requestedSlug String            @map("requested_slug") @db.VarChar(255) // post-deriveSlug normalized form
  reason        String?           @db.Text
  status        SlugRequestStatus @default(pending)
  requestedBy   String            @map("requested_by") @db.VarChar(32)    // actor cwid (= cwid in self-mode)
  createdAt     DateTime          @default(now()) @map("created_at")
  decidedBy     String?           @map("decided_by") @db.VarChar(32)
  decidedAt     DateTime?         @map("decided_at")
  decisionNote  String?           @map("decision_note") @db.Text

  @@index([status, createdAt])   // queue view: oldest pending first
  @@index([cwid])
  @@map("slug_request")
}

enum SlugRequestStatus {
  pending
  approved
  rejected
  superseded   // a newer pending request for the same cwid auto-supersedes the older
}
```

No FK to `Scholar` (mirrors `FieldOverride`/`Suppression` — a request may concern a cwid not yet routable). `FieldOverride` is **unchanged**.

### 4.2 Migration

Generate **offline** (local dev DB is drifted — never `prisma migrate dev`): `prisma migrate diff --from-schema-datamodel … --to-schema-datamodel … --script`. Single additive migration (one table + enum). No change to `field_override` or `slug_history`.

### 4.3 B03 audit actions

Extend the audit `action` enum (the #398-extended one) with `slug_request`, `slug_request_approved`, `slug_request_rejected`. Each decision writes a B03 row keyed on the scholar (consistent with `request_change`).

---

## 5. Behavior

### 5.1 Override reconciliation — Option B (PR-1)

A new shared helper `reconcileScholarSlug(tx, cwid, newSlug)` (extracted from / sharing the `maybeUpdatedSlug` logic in `etl/ed/index.ts:1417`):

1. Read current `Scholar.slug`.
2. If unchanged → no-op.
3. Else, in one transaction: upsert `slug_history { oldSlug: current, currentCwid: cwid }`; set `Scholar.slug = newSlug`.

Wire it into both override mutation paths:

- **Set** (`app/api/edit/field/route.ts`, `fieldName==='slug'`): after the existing `FieldOverride` upsert + collision validation, call `reconcileScholarSlug(tx, cwid, value)` **in the same transaction**. The `FieldOverride(slug)` row persists as the *pin*.
- **Clear** (`app/api/edit/clear-field/route.ts`, `fieldName==='slug'`): delete the `FieldOverride` row, then reconcile `Scholar.slug` back to `nextAvailableSlug(deriveSlug(preferredName), …)` (old pinned slug → `slug_history`). I.e. clearing the pin returns the scholar to the derived slug immediately, not on the next ETL run.

Collision authority is unchanged: `Scholar.slug @unique` + `slug_guard` UNIQUE both guard; the transaction fails closed on either.

**Result:** `/scholars/<override>` resolves via the existing `Scholar.slug` path; the prior slug 301s via the existing `slug_history` path; canonical metadata is correct — **zero resolver/sitemap changes** (the point of Option B).

### 5.2 ETL re-mint precedence — the pin (PR-1)

`maybeUpdatedSlug` currently re-derives on any slug-affecting name change. New first step: **if a `FieldOverride(entityType=scholar, entityId=cwid, fieldName=slug)` row exists, return `{}` (skip re-mint entirely).** Requires the ETL run to load pinned cwids once (a `Set<cwid>` alongside the existing `existingSlugs` Set at `etl/ed/index.ts:431`). A name change on a pinned scholar leaves `Scholar.slug`, `slug_history`, and the override untouched.

### 5.3 Root-alias routing (PR-2)

Add `app/[slug]/page.tsx` (catch-all sibling to `(public)`, `api`, `edit`). Next resolves explicit segments first, so only **bare single-segment unknown paths** reach it.

Resolution order:
1. `slug` ∈ reserved denylist (§6.1) → `notFound()` (let it 404; never treat a route word as a scholar).
2. `resolveBySlugOrHistory(slug)` direct hit or history → `permanentRedirect('/scholars/' + targetSlug)` (301).
3. Else `notFound()`.

`looksLikeSlug` (`lib/slug.ts:93`, currently unused) gates obvious non-slugs cheaply before the DB hit. **Edge caveat:** root single-segment paths are not in the EdgeStack uncacheable list; the 301 must be cacheable and must not collide with cookie/query stripping (see the edge memo). EdgeStack behavior addition tracked as a PR-2 deploy task.

### 5.4 Slug-request queue (PR-3)

- **Request** `POST /api/edit/slug-request` `{ requestedSlug, reason? }`. Authz: `canAccessScholarEditPage(session, cwid)` self-or-superuser — but the *target is always `session.cwid`* in self-mode (a scholar requests only their own). Validates §6 rules + a **collision check that rejects at request time** (400 `collision`). *Rationale (settled 2026-05-27):* v1 ships no incumbent-swap (§3/§7) and the `slug_history` identity-bleed guard (§6.4) makes a cross-scholar collision **durable** — a colliding request can therefore only ever be declined. Rejecting up front gives the scholar immediate feedback and keeps doomed rows out of the queue. (The earlier "advisory, don't block" framing assumed approval-time swap flexibility that v1 does not have; revert to advisory only if incumbent-swap lands.) The approval-time UNIQUE guards remain the authoritative, race-proof gate for the one collision that *can* legitimately reach the queue: free-at-request, taken-by-approval. A newer pending request for the same cwid sets the prior to `superseded`. Rate-limited per-cwid via the existing `recordRequestChangeAttempt` pattern (`lib/edit/rate-limit.ts`), superusers exempt.
- **Queue** — superuser-only surface inside `/edit` (a `pending`-ordered list; reuses the Phase-7 superuser surface pattern from #398). Read endpoint `GET /api/edit/slug-request?status=pending`.
- **Decision** `POST /api/edit/slug-request/[id]/decision` `{ decision: 'approve'|'reject', note? }`, superuser-only. Approve → `reconcileScholarSlug` + `FieldOverride` upsert (§5.1) **in one transaction**, then mark the request `approved`. Reject → mark `rejected` with `decisionNote`. Both write a B03 row.
- **Requester notification** (PR-3) — on either decision, email the requester (approved: the new URL is live; rejected: the `decisionNote`) via `lib/edit/mailer.ts`, opt-out/default-on, best-effort (never fails the decision), resolved from the local `Scholar.email` (avoids the VPC↔WCM LDAP gap, mirroring the request-change receipt).

---

## 6. Validation

### 6.1 Reserved-word denylist (load-bearing for §5.3)

Add `RESERVED_SLUGS` to `lib/edit/validators.ts`, enforced at mint, override-set, and request time. Seed (every current + reserved-future top-level segment):

```
about, browse, centers, departments, scholars, search, topics, edit, api,
og, healthz, readiness, robots, sitemap, llms, not-found,
admin, login, logout, auth, static, _next, assets, news, help, support, contact
```

A derived slug that lands on a reserved word takes the numeric floor (`about` → `about-2`); a requested/override slug on a reserved word is **rejected**.

### 6.2 Format

Must equal `deriveSlug(input)` (idempotent — `[a-z0-9]` + single hyphens, no leading/trailing/double hyphen); length 2–255; not purely numeric (so it can't shadow a future `/123` and is distinguishable from a CWID per `looksLikeSlug`). CRLF/header-injection is structurally impossible given the charset, but validate post-`deriveSlug` equality to reject anything that normalizes away.

### 6.3 Profanity

Best-effort denylist check (English list, substring-aware with word boundaries). Explicitly best-effort — not a security control.

### 6.4 Collision (two layers)

1. **Application check (`checkSlugCollision`)** — the *friendly* half: a live `Scholar.slug`, another cwid's `field_override(slug)`, or a `slug_history.old_slug` pointing at a different scholar (the identity-bleed guard — a departed scholar's slug stays blocked, which is what makes collisions **durable**). Used to return a friendly `400 collision` at override-set **and request time** (§5.4), and to compute the per-row warning the approval queue shows. A scholar reclaiming a slug from **their own** history is allowed (every check excludes `forCwid`; `validators.ts`).
2. **Authoritative guard** — `slug_guard` UNIQUE (cross-override) + `Scholar.slug` UNIQUE (cross-scholar). The application check is not atomic; these indexes are the race-proof backstop. Approval runs reconcile+override in one transaction, so a slug that was free at request time but taken by approval makes the tx fail closed → the decision endpoint returns `409 collision` and the request stays `pending` for the reviewer to decline. The queue read (`GET ?status=pending`) re-runs the application check at load so the reviewer sees the warning before they try.

---

## 7. Threat model

| Threat | Mitigation | Status |
|---|---|---|
| Route shadowing (slug = `search`/`api`/future route) | §6.1 denylist at mint + override + request; catch-all 404s reserved words | In scope |
| Impersonation / squatting (request a notable name) | D8 curator approval gate; request is self-only | In scope |
| Header/CRLF injection via slug | §6.2 charset (`deriveSlug` equality) | In scope |
| Request-queue spam | §5.4 per-cwid rate limit (reused) | In scope |
| Privilege escalation (non-superuser approves) | decision endpoint superuser-only; request endpoint self-only | In scope |
| Identity bleed via slug reuse after departure | System soft-deletes (`deletedAt`/`status`); a *hard* delete cascades `slug_history` (`SlugHistory.current onDelete: Cascade`) and frees the slug. **Downstream requirement: hard-delete of `Scholar` is prohibited in app code; document in ADR-005.** | In scope (guard, not code) |
| Homoglyph/unicode confusables | N/A — `deriveSlug` strips to ASCII `[a-z0-9-]` | Out of scope (structurally moot) |
| Profanity completeness | Best-effort list; not a security boundary | Out of scope |
| Enumeration via root catch-all | Returns 404 for unknowns; leaks nothing beyond existing `/scholars` listing/sitemap | Accepted |

OWASP framing: §6.2 is input canonicalization (ASVS V5.1); §6.1+catch-all is access-control on a wildcard route (avoid mass-assignment of the namespace); D8 is enforced authorization (V4.1).

---

## 8. Test matrix

| Case | Expected |
|---|---|
| Set override `brandon-swed` (was `brandon-swed-2`) | `/scholars/brandon-swed` 200; `/scholars/brandon-swed-2` 301→`brandon-swed`; canonical = `brandon-swed` |
| Clear override | `Scholar.slug` reverts to derived; old pinned slug 301s; FieldOverride row gone |
| ETL name change on a **pinned** scholar | `Scholar.slug`, `slug_history`, override all unchanged (no re-mint) |
| ETL name change on an **unpinned** scholar | re-mints as today (regression guard) |
| Override collides with live `Scholar.slug` | rejected (tx fails closed) |
| Override collides with another override | rejected by `slug_guard` |
| Reclaim own historical slug | allowed |
| Override/request = reserved word (`search`) | rejected |
| Derived slug lands on reserved word | numeric floor (`about-2`) |
| Root `/<live-slug>` | 301 → `/scholars/<slug>` |
| Root `/<history-slug>` | 301 → `/scholars/<current>` |
| Root `/<reserved>` (`/about`) | served by the real route (explicit wins), never the catch-all |
| Root `/<unknown>` | 404 |
| Request by non-owner non-superuser | 403 `not_self` |
| Decision by non-superuser | 403 `not_superuser` |
| Second pending request, same cwid | prior → `superseded` |
| Request a currently-colliding slug | `400 collision` at request time — rejected, not queued (§5.4/§6.4) |
| Approve | override written + `Scholar.slug` reconciled + request `approved` + B03 row |
| Approve a request whose slug was taken since filing | tx fails closed → `409 collision`; request stays `pending`; reviewer declines |

Run `vitest` before any push (mock-factory/rendered-order regressions tsc can't see).

## 9. Audit SQL (runnable)

```sql
-- Live collision groups (bare + suffixed sharing a base)
SELECT REGEXP_REPLACE(slug,'-[0-9]+$','') AS base, COUNT(*) n
FROM Scholar WHERE slug<>'' GROUP BY base HAVING n>1 ORDER BY n DESC, base;

-- Orphan suffixes (suffixed slug with no bare holder) + their history classification
SELECT s.slug, REGEXP_REPLACE(s.slug,'-[0-9]+$','') base, h.current_cwid history_target,
       (SELECT status FROM Scholar x WHERE x.cwid=h.current_cwid) target_status
FROM Scholar s
LEFT JOIN slug_history h ON h.old_slug=REGEXP_REPLACE(s.slug,'-[0-9]+$','')
WHERE s.slug REGEXP '-[0-9]+$'
  AND NOT EXISTS (SELECT 1 FROM Scholar b WHERE b.slug=REGEXP_REPLACE(s.slug,'-[0-9]+$',''));

-- Pinned scholars (active slug overrides)
SELECT entity_id cwid, value pinned_slug, created_at
FROM field_override WHERE field_name='slug' ORDER BY created_at DESC;
```

## 10. PR breakdown

| PR | Content | Why first |
|---|---|---|
| **PR-1** | Option B reconciliation (§5.1) + ETL pin (§5.2) + reserved denylist (§6.1) + tests. Makes existing superuser overrides actually route. | Highest value, smallest, unblocks everything; no schema change. |
| **PR-2** | Root-alias catch-all (§5.3) + EdgeStack cacheable-301 deploy task + tests. | Independent; the "drop /scholars/" ask. |
| **PR-3** | `SlugRequest` table + migration (§4) + request/queue/decision endpoints + scholar request UI + superuser queue UI (per the §12 UI-SPEC) + requester notification + rate limit + B03 actions + tests. | Depends on PR-1 (approval calls reconciliation). |

Keep diffs tight (no blanket prettier; printWidth 100). Flag-gate PR-3 behind a `SELF_EDIT_SLUG_REQUEST` env (consistent with `SELF_EDIT_REQUEST_CHANGE_SEND`).

## 11. Decided follow-ups

- **ADR-005 amendment** (confirmed): record D5 (reconcile-on-write) and the hard-delete prohibition (§7). Part of PR-1.
- **Requester notification** (confirmed): in PR-3 (§5.4).
- **Request-time collision = hard reject** (settled 2026-05-27, §5.4/§6.4): block at request time (`400 collision`) rather than queue an advisory row, because v1 has no incumbent-swap and the identity-bleed guard makes collisions durable. Revisit (→ advisory) only if incumbent-swap is built.
- **Withdraw** (settled): added `withdrawn` to `SlugRequestStatus` (keeps the audit trail) + a self-only `POST …/[id]/withdraw` (`pending → withdrawn`).
- **Reason field** (settled): collapsed by default on the request card ("Add a note for the reviewer (optional)" disclosure).

## 12. UI surfaces (companion UI-SPEC: `docs/slug-personalization-ui-spec.md`)

This SPEC does not specify the UI in detail — the companion `slug-personalization-ui-spec.md` does (signed off 2026-05-27). The feature introduces three surfaces anchored to the Apollo master-detail `/edit` layout (mockup-first, per team practice; see #355 for the /edit UI-SPEC track):

| # | Surface | Audience | Must cover |
|---|---|---|---|
| U1 | **Profile-URL request entry** | Scholar (self) | Shows current URL; field to propose a new slug; inline validation feedback (format / reserved-word client-side; collision rejected server-side `400` and shown inline, §5.4); **"Request this URL"** action (not "Save" — they can't self-apply). **Placement (decided): its own "Profile URL" item in the ATTRIBUTES rail** (mirrors the superuser `slug-card`). URL displayed in **root form** `scholars.weill.cornell.edu/<slug>` (with `/scholars/<slug>` still valid). |
| U2 | **Request status** | Scholar (self) | Pending badge after submit + "Withdraw request"; on approve the live URL updates ("old address redirects automatically"); on reject, show `decisionNote` + allow re-request; supersede messaging if a newer request replaces an older. |
| U3 | **Approval queue** | Superuser | Pending list (oldest first); per row: target scholar (name + cwid), current → requested slug, reason, **live collision/reserved warning** computed at load (collision is the **race case only** — free-at-request, taken-by-approval — since same-time collisions never enter the queue, §6.4; v1 has **no incumbent-swap**, so collision/reserved both **disable approve and the reviewer declines**), approve/decline-with-note controls; empty state. **Placement (decided): dedicated `/edit/slug-requests` admin route** with a pending-count badge in the rail. |

Root-alias routing (§5.3) has **no UI** (server redirect only). The public profile already surfaces the canonical URL — no change. **Note (PR-1):** the superuser `slug-card.tsx` copy "takes effect on the next directory sync" must change to *immediate* (Option B reconciles on write).

**Process:** mockup built + visually signed off 2026-05-27 (`/tmp/sps-slug-mockup.html`); placements decided above. Next: write the UI-SPEC from this + the mockup, then PR-3 build. Do not assume spacing/sizing/icons beyond the mockup.
