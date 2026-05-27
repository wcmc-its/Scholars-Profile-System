# Slug personalization — UI-SPEC (PR-3 surfaces)

**Status:** Draft for sign-off · 2026-05-27
**Companion to:** `docs/slug-personalization-spec.md` (the implementation SPEC; this doc specifies only the PR-3 UI).
**Mockup:** `/tmp/sps-slug-mockup.html` (visually signed off 2026-05-27 — this SPEC is the authoritative source where the two diverge).
**Tracks:** #497 · #355 (the /edit UI-SPEC track) · mirrors the Apollo language from `self-edit-launch-spec.md`.

---

## 0. Surfaces & placement (decided)

| ID | Surface | Audience | Route | Component |
|---|---|---|---|---|
| U1+U2 | Profile-URL request card (entry + status states) | Scholar, self | `app/edit/page.tsx` (self editor) — **new "Profile URL" rail item** | new `components/edit/slug-request-card.tsx` |
| U3 | Approval queue | Superuser | **new `app/edit/slug-requests/page.tsx`** | new `components/edit/slug-request-queue.tsx` + `slug-request-row.tsx` |

The superuser **direct-set** card (`components/edit/slug-card.tsx`, on `/edit/scholar/[cwid]`) is unchanged except the PR-1 copy fix (immediate, not "next sync"). Superusers set slugs directly there; **scholars never get the direct-set card** — only the request card.

## 1. Design language

Reuse the Apollo chrome and primitives — introduce no new tokens:

- Shell: `EditShell` (`components/edit/edit-shell.tsx`) — `mode="self"` for U1, `mode="superuser"` for U3; pass `railItems`, `activeAttr`, `basePath`, `previewHref`.
- Tokens: `--apollo-bar #1a1a1a`, `--apollo-maroon #7d1c1c`, `--apollo-rail #f6f4f3`, `--apollo-rail-border #e4dedc` (`app/globals.css` ~66). Maroon = accents only (rail active marker, sub-nav underline, links, count pill). Primary action buttons use the default (dark) `Button` variant, matching `slug-card`.
- Primitives: `Card/CardHeader/CardTitle/CardDescription/CardContent`, `Input`, `Button` (`default` | `ghost` | `destructive`), `Alert` (`info` | `destructive` + a new `success`/`warning` variant if not present — confirm in `components/ui/alert.tsx`), `ConfirmDialog`, `UnsavedChangesGuard`.
- URLs render in **root form** `scholars.weill.cornell.edu/<slug>`; the input prefix is `scholars.weill.cornell.edu/`. Copy states `/scholars/<slug>` keeps working.

---

## 2. U1 + U2 — `SlugRequestCard` (scholar, self)

One component, a state machine driven by the scholar's **current slug** and their **latest `SlugRequest`** (the page loads both).

### 2.1 State machine

| State | Condition | Renders |
|---|---|---|
| **Idle** | no `pending` request | current URL · input (prefilled empty) · "Request this URL" · format hint |
| **Pending** | latest request `status=pending` | `Pending review` title tag · info alert (what they requested + date + "current URL stays active") · "Withdraw request" (ghost) · **no input** |
| **Rejected** | latest request `status=rejected` AND no newer pending | `Not approved` title tag · destructive alert with `decisionNote` · input (prefilled with the rejected value) · "Request this URL" |
| **Just-approved** | latest request `status=approved` within the session/since-last-view | transient `Approved` success alert (new URL live; old redirects) → then collapses to **Idle** showing the new current URL |

`superseded` requests never surface (a newer request replaced them). After a successful submit, the card transitions Idle/Rejected → Pending without a reload (optimistic, reconciled by `router.refresh()`).

### 2.2 Layout (Idle)

```
Profile URL
Request a personalized web address for your public profile. A Scholars
administrator reviews every request.

Your current URL:  [ scholars.weill.cornell.edu/jane-q-smith ]

Requested address
[ scholars.weill.cornell.edu/ | jane-smith____________ ]
Lowercase letters, numbers, and hyphens only. /scholars/jane-smith will keep working too.

[ Request this URL ]   Sends to a Scholars administrator for approval.
```

### 2.3 Validation (client, live)

- Reuse `validateSlugFormat` (`lib/edit/validators.ts`) — same function the server uses. Errors: `format`, `too_long`, `reserved` (the PR-1 `RESERVED_SLUGS` feeds this). Messages reuse `slug-card`'s `formatErrorMessage`.
- **Collision is not checked live, but the submit is rejected server-side** (settled 2026-05-27 — see SPEC §5.4/§6.4): there is no live collision check (it would leak which slugs are taken and duplicates the server), so `Request this URL` stays enabled on a format-valid value. The request `POST` runs `checkSlugCollision` and returns `400 collision`, which the card surfaces inline ("That web address is already taken. Please choose another."). *Why reject, not queue:* v1 has no incumbent-swap and the identity-bleed guard makes collisions durable, so a colliding request can only ever be declined — rejecting up front is immediate feedback, not a doomed multi-day wait. (The free-at-request, taken-by-approval **race** is a different path: the request files fine and the collision surfaces in the U3 queue / at approval, §3.4.)
- "Request this URL" is enabled iff: non-empty, format-valid, and `≠` the current slug.
- Mount `UnsavedChangesGuard` with `dirty = input !== ""` in Idle/Rejected (typing-then-leaving warns).

### 2.4 Interactions / endpoints

| Action | Call | Result |
|---|---|---|
| Submit | `POST /api/edit/slug-request { requestedSlug: <normalized>, reason? }` | 200 → Pending state; `400` → inline error (collision / reserved / format / numeric / too-short); `429` → rate-limit copy (§5) |
| Withdraw | `POST /api/edit/slug-request/[id]/withdraw` (self-only) — **see §6 open item** | 200 → Idle |
| (no Save/Clear) | — | scholars cannot apply or clear an override |

A **reason** field is optional (short textarea). **Decided:** collapsed by default behind an "Add a note for the reviewer (optional)" disclosure (the mockup omits it from Idle; the disclosure keeps the default view clean).

### 2.5 Accessibility / copy

- Title tag (`Pending review` / `Not approved` / `Approved`) is a `<span>` with an accessible label, not color-only.
- Error text uses `role="alert"`, `aria-invalid`/`aria-describedby` on the input (mirror `slug-card`).
- Exact strings in §5.

---

## 3. U3 — `SlugRequestQueue` (superuser, `/edit/slug-requests`)

### 3.1 Route & auth

- `app/edit/slug-requests/page.tsx`, server component. **Superuser-only** — gate with the same check the other superuser surfaces use; non-superuser → the existing `forbidden-edit-page` pattern (200 + visible 403, per the #356 carryover).
- `EditShell mode="superuser"` with an **Admin** rail: `All profiles` · `URL requests `+ pending-count pill (maroon) · `Audit log`. Active = `URL requests`.

### 3.2 Data

- Load `GET /api/edit/slug-request?status=pending` server-side, ordered oldest-first (`@@index([status, createdAt])`).
- For each, the server **re-checks collision/reserved at load time** (not stored) — a slug free at request time may be taken now. Each row carries `{ request, currentSlug, collidesWith?: cwid, reserved?: boolean }`.

### 3.3 Row anatomy (`SlugRequestRow`)

```
Jane Q. Smith · jqs2001 · Medicine                         [ Approve ]
jane-q-smith → jane-smith                                  [ Decline… ]
"This is how I'm known professionally…"   (reason, muted box)
Requested May 27, 2026
```

- Header: `{name} · {cwid} · {primary dept}` (resolve name/dept from the local Scholar; cwid always shown).
- Change line: `currentSlug` (strikethrough, muted) → `requestedSlug` (bold).
- Reason: muted box; "(no note)" if empty.
- Meta: requested date.

### 3.4 Warning states (block approval)

| Condition | Render | Approve |
|---|---|---|
| Clean | — | enabled |
| **Collision** | warning alert: "`<slug>` is already in use by another scholar (`<cwid>`). v1 does not auto-swap — decline and ask the scholar to choose another." | **disabled** |
| **Reserved** | destructive alert: "Reserved word — cannot be used as a URL." | **disabled** |

**v1 does NOT build incumbent-swap** (moving the colliding scholar to `-N` is a destructive cross-scholar change — deferred, §6). Collision ⇒ decline. A collision row here is the **race case** (free at request time, taken by the time the reviewer looks) — same-time collisions are rejected at request (§2.3), so they never reach this queue. The authoritative guard still runs at approval: if the slug is taken in the window between this load and the click, the decision tx fails closed (`409 collision`) and the row stays.

### 3.5 Interactions / endpoints

| Action | Call | Result |
|---|---|---|
| Approve | `POST /api/edit/slug-request/[id]/decision { decision: "approve" }` | server runs reconcile+override in one tx; `slug_guard` is the authoritative gate (fails closed if a race made it collide) → remove row, decrement count; `409 collision` → show the collision warning inline |
| Decline | inline textarea (`decisionNote`, required) → `POST …/decision { decision: "reject", note }` | remove row; the note goes to the requester (notification, main SPEC §5.4) |

- Approve: no confirm dialog needed (reversible by re-request); Decline requires a note (a `ConfirmDialog reasonMode="required"` or an inline expand — match the mockup's inline textarea).
- **Empty state:** "No pending URL requests." with a muted illustration-free panel.
- **Loading:** skeleton rows (reuse the existing skeleton pattern).

---

## 4. Component inventory

| Component | New? | Notes |
|---|---|---|
| `slug-request-card.tsx` | new | U1+U2; client component; the self-arm sibling of `slug-card.tsx` |
| `slug-request-queue.tsx` | new | U3 list + empty/loading |
| `slug-request-row.tsx` | new | one pending request + warnings + actions |
| rail item "Profile URL" (self) | edit | add to the self editor's `railItems` |
| Admin rail + "URL requests" pill | new/edit | superuser rail for `/edit/slug-requests` |
| `slug-card.tsx` | edit (PR-1) | copy: "next sync" → immediate |
| `EditShell`, `AttributeRail`, `Card*`, `Input`, `Button`, `Alert`, `ConfirmDialog`, `UnsavedChangesGuard` | reuse | — |

---

## 5. Copy deck (exact)

- Card title: **Profile URL**
- Card description: "Request a personalized web address for your public profile. A Scholars administrator reviews every request."
- Current URL label: "Your current URL: "
- Input label: "Requested address"; format hint: "Lowercase letters, numbers, and hyphens only. `/scholars/<slug>` will keep working too."
- Submit button: "Request this URL"; helper: "Sends to a Scholars administrator for approval."
- Pending alert: "You requested `scholars.weill.cornell.edu/<slug>` on `<date>`. A Scholars administrator will review it — you'll get an email when it's decided. Your current URL stays active until then."; button "Withdraw request".
- Approved alert: "Your URL is now `scholars.weill.cornell.edu/<slug>`. The old address redirects automatically."
- Rejected alert: "Your request for `/<slug>` wasn't approved. **Note from the reviewer:** "`<decisionNote>`" You can submit a different address below."
- Rate-limited inline: "You've sent several requests recently — please try again later."
- Queue title: "Profile URL requests"; description: "Pending scholar requests for a personalized URL, oldest first. Approving writes the override and redirects the old address."
- Collision warning: "`<slug>` is already in use by another scholar (`<cwid>`). Decline and ask the scholar to choose another — v1 doesn't auto-swap."
- Reserved warning: "Reserved word — cannot be used as a URL."
- Decline note placeholder: "Reason for declining (sent to the scholar)".
- Empty state: "No pending URL requests."

---

## 6. Test matrix (UI)

| Case | Expected |
|---|---|
| Idle: type valid slug | Request enabled |
| Idle: reserved/format-invalid | Request disabled + inline error |
| Idle: equals current slug | Request disabled |
| Submit success | → Pending state, no full reload |
| Submit rate-limited (429) | inline rate-limit copy, stays Idle |
| Pending: withdraw | → Idle |
| Rejected: shows reviewer note + re-request enabled | true |
| Approved: transient success → Idle shows new current URL | true |
| Queue (superuser): rows oldest-first | true |
| Queue: collision row | warning + Approve disabled |
| Queue: reserved row | warning + Approve disabled |
| Approve clean | row removed, count decremented |
| Approve that races into collision | `409` surfaces inline, row stays |
| Decline without note | blocked (note required) |
| Non-superuser hits `/edit/slug-requests` | visible 403 (forbidden-edit-page) |

Run `vitest` (component + route tests) before push.

---

## 7. Resolved / deferred

- **Withdraw endpoint + status** — RESOLVED: added `withdrawn` to `SlugRequestStatus` (keeps the audit trail) + self-only `POST …/[id]/withdraw` (`pending → withdrawn`). Shipped PR-3a.
- **Reason field default visibility** (§2.4) — RESOLVED: collapsed by default behind the "Add a note (optional)" disclosure. Shipped PR-3b.
- **Request-time collision** (§2.3) — RESOLVED: rejected server-side (`400`), surfaced inline; not queued. See SPEC §5.4/§6.4.
- **Incumbent-swap on collision** — DEFERRED from v1 (destructive cross-scholar change); collision ⇒ decline. Revisiting it is the only thing that would flip request-time collision back to advisory.
- **Requester notification copy** — the email bodies live in `lib/edit/slug-request.ts` (`composeApprovedEmail` / `composeRejectedEmail`), shipped PR-3a; they reuse the request-change receipt tone.
