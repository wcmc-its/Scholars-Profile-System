# Comms Steward — profile editing + ED-name bridge (plan)

**Status:** Plan, awaiting approval. No code written. Implementation begins only
after the §3 field-scope decision is confirmed.
**Driver:** Operator feedback (2026-06-13) while viewing as dwd2001 — (1) the
"View as" banner shows the CWID, not a name; (2) the console offers tabs a
steward can't use, and "comms_steward should be able to see and edit profiles."
**Builds on:** `comms-steward-methods-visibility-spec.md` (the methods-only role,
which this deliberately broadens) and `role-aware-navigation-entry-points-spec.md`.

---

## 1. Decisions taken (from this round)

- **Expand `comms_steward` to edit profiles** — a deliberate authz scope increase
  beyond the methods-only spec. Scoped per §3 (least-privilege recommendation
  below; this is the one decision still open).
- **Resolve the steward name from ED** via an ED→S3 bridge (§5), since live LDAP
  from the SPS VPC times out (#443) and there is no in-VPC person source today.

Both ride the existing `COMMS_STEWARD_ENABLED` kill switch (staging-on /
prod-off), so all of this stays dark in prod until the gated rollout.

---

## 2. Two bugs to fix regardless of scope

### 2a. `/edit/methods` ignores the "View as" overlay (preview-fidelity)

`/edit/methods` authorizes + renders its nav from the **real** identity
(`getEditSession` → the signed-in superuser), while its siblings `/edit/scholars`
and `/edit/administrators` use the **effective** identity
(`getEffectiveEditSession`). So while *impersonating* a steward you see the
superuser's tabs (which then deny on click). A real steward logging in directly
already sees only "Method Families" — this artifact is visible only under
"View as".

**Fix:** switch `/edit/methods` to `getEffectiveEditSession`, matching its
siblings. Then the preview reflects the target's real access. Small, correct,
and needed no matter what §3 decides.

### 2b. Tabs not matched to the role

`AdminSubnav`'s single `superuserSurfaces` boolean is too coarse for a role that
gets *some* admin surfaces but not others. Replace it with an explicit
capability set (§4).

---

## 3. Authz scope — the open decision

### 3a. Which profiles?  → **All non-deleted scholars** (recommended)

Communications manages every scholar's public presentation, so the steward edits
any profile (global, like a superuser — *not* unit-scoped). Confirm; the
alternative (unit/center-scoped) would need a scoping mechanism comms doesn't map
to.

### 3b. CONFIRMED SCOPE (2026-06-13)

**Superuser-level profile editing across all scholars, MINUS three governance
areas** (operator's words: "superuser parity minus slug review, adding/removing
users, adding/remove org units"):

- ❌ **Slug** — no URL-requests queue (`/edit/slug-requests`), no Slug registry
  (`/edit/slugs`), and no per-profile "Profile URL" (`profile-url`) field.
- ❌ **Administrators** — no admin / unit-admin grant management
  (`/edit/administrators`).
- ❌ **Org-unit create/remove** (`/edit/unit/new`, unit CRUD).
- ✅ **All other profile fields** a superuser edits: `overview`, `highlights`,
  `visibility`, `publications` (incl. suppression). Read-only/sourced fields
  stay read-only.
- ✅ **Tabs:** Profiles + Method Families only.

> ⚠️ Open confirm before PR B: "superuser parity" as written **includes
> publication suppression/takedown** — the highest-power, compliance-adjacent
> profile field. Carve out only if the operator says so.

Implementation note: because this is near-superuser parity (minus slug + the two
governance surfaces), the per-scholar editor reuses the **superuser** editor path
with slug gated OUT, rather than a tightly-restricted bespoke mode — simpler and
less divergent. The exclusions are enforced at the route, not just hidden in UI.

#### (historical) the options that were on the table

The editable attrs today are `overview`, `highlights`, `visibility`,
`publications` (suppression), `profile-url` (slug); everything else
(`name-title`, `email`, `photo`, `funding`, `appointments`, `education`,
`mentees`, `coi`) is WCM-sourced / read-only.

**Recommended (least-privilege — "the communications narrative"):**

| Field | Steward edits? | Why |
|---|---|---|
| **Overview** (bio) | ✅ | Core comms — the public narrative |
| **Highlights** (featured pubs) | ✅ | Comms curates featured work |
| Visibility (section toggles) | ⚠️ optional | Presentation control, but can hide what a scholar wants shown — include only if you want comms to manage section visibility |
| Publications (suppression/takedown) | ❌ | A scholar/compliance decision, not comms |
| Profile URL (slug) | ❌ | Namespace authority = superuser |
| COI / COI-gap | ❌ | Compliance; already read-only |
| name/email/photo/funding/appointments/education/mentees | ❌ | WCM-sourced, read-only for everyone |

Rationale: the "communications" remit is the public story (bio + highlights),
not compliance (COI), identity/namespace (slug), the academic record (sourced),
or RBAC (admin grants). Least-privilege keeps the blast radius of a comms account
to presentational fields + auditable.

**Named alternative — full superuser parity (rejected as default):** give the
steward the entire superuser profile editor (incl. publication takedowns + slug).
Simpler to implement (reuse the superuser path) but over-grants — it folds
compliance and namespace authority into a comms role and widens the blast radius.
Offered only if you explicitly want comms to be a profile super-editor.

> **This is the decision that gates implementation.** Default below assumes the
> recommended subset (overview + highlights, visibility optional).

---

## 4. Design (assuming the recommended subset)

### 4a. A new `comms_steward` EditMode

`EditMode` becomes `self | superuser | proxy | unit-admin | comms_steward`.
`attrsForMode("comms_steward")` exposes only the comms-editable attrs (overview,
highlights, [visibility]) + the read-only context attrs (name/title, photo) for
orientation. The per-scholar editor (`/edit/scholar/[cwid]`) renders in this mode
when the viewer is a steward (and not a superuser/self).

### 4b. Page guards

- `canAccessScholarEditPage(session, targetCwid)` — admit a `comms_steward`
  (today superuser-only). Mode resolves to `comms_steward` for a steward, so the
  rail is the restricted set.
- `/edit/scholars` roster — admit a steward to browse/find a profile (read), so
  they have an entry point to the per-scholar editor.
- `/edit/scholar/[cwid]` — load in `comms_steward` mode for a steward.

### 4c. Field-write authz

`authorizeFieldEdit(session, target)` — allow a `comms_steward` to write the
in-scope fields (`overview`, `selectedHighlightPmids`, [visibility]) on **any**
scholar; deny every out-of-scope field (slug, suppression, …) with a stable
reason (`not_comms_scope`). The route handlers (`/api/edit/*`) enforce the same —
the page mode is UX, the route is the boundary. Writes are attributed to the real
actor and audited (existing `manual_edit_audit`), exactly as superuser edits are.

### 4d. Nav capability set (replaces `superuserSurfaces`)

`AdminSubnav` takes an explicit capability object instead of one boolean, e.g.
`surfaces: { profiles, slugRequests, slugs, administrators }` each gated by the
viewer's role. A steward gets **Profiles + Method Families** (+ My Profile);
**not** URL requests / Slug registry / Administrators (superuser/owner RBAC +
namespace surfaces). Computed from the **effective** identity (so §2a holds).

---

## 5. ED-name bridge

Mirror the email-visibility bridge (`etl:ed:export` / `:import`, S3
`ed/email-visibility/bridge.ndjson`):

- `etl:ed:steward-names:export` — runs WCM-side (has LDAP), writes
  `{cwid, displayName}` for the steward allowlist to S3
  `ed/steward-names/bridge.ndjson`.
- `etl:ed:steward-names:import` — runs in-VPC, upserts a small `steward_directory`
  table (cwid → displayName). New etl IAM grant `ed/steward-names/*` (needs
  `cdk deploy Sps-Etl-<env>` — the per-prefix grant gotcha).
- The session probe (banner) and `/api/impersonation/candidates` resolve the name
  from `steward_directory`, falling back to the CWID when absent (so it degrades
  honestly, like every other bridge).

Scope note: this covers the steward set only (tiny). It does not attempt a general
ED-person mirror.

---

## 6. Threat model / security notes (for review)

- **New capability:** a comms account can edit overview/highlights on any
  profile. Mitigations: least-privilege field set (no COI/takedown/slug/RBAC);
  every write attributed to the real actor + audited; flag-gated + allowlist-
  gated (a tightly-held operator set); the role is still *not* a superuser
  (`isSuperuser` stays the higher authority for everything out of scope).
- **Out of scope (explicit):** publication suppression, slug minting, unit-admin
  grants, COI — a steward must be denied these at the route, not just hidden in
  the UI.
- **Impersonation:** unchanged invariants (R1/R2/R3 + audit). A superuser viewing
  as a steward now previews the steward's *real* (expanded) access via §2a.
- **Rollout:** `COMMS_STEWARD_ENABLED` off in prod ⇒ the whole expansion is inert
  (role resolves false, mode never selected, routes deny). Staging-only until the
  gated prod rollout.

---

## 7. Test plan

- Field authz: a steward may write overview/highlights on any scholar; is denied
  slug/suppression/COI (route-level, not just UI).
- Mode: `attrsForMode("comms_steward")` exposes only the in-scope rail items.
- Nav: a steward sees Profiles + Method Families, not URL requests / Slug registry
  / Administrators; computed from the effective identity (View-as fidelity).
- `/edit/methods` honors the overlay (§2a) — viewing as a steward shows the
  steward's tabs.
- Name bridge: import upserts; banner/switcher show the name; missing → CWID.
- Flag off ⇒ everything denies/hides.

---

## 8. Files (scoping; not yet changed)

- `lib/auth/comms-steward.ts` — (name lookup helper if not in a new module).
- `lib/edit/authz.ts` — `authorizeFieldEdit`, `canAccessScholarEditPage`, the
  `not_comms_scope` reason.
- `components/edit/edit-page.tsx` — `comms_steward` EditMode + `attrsForMode`.
- `components/edit/admin-subnav.tsx` — capability set replacing `superuserSurfaces`.
- `app/edit/methods/page.tsx` — effective identity (§2a).
- `app/edit/scholars/page.tsx`, `app/edit/scholar/[cwid]/page.tsx` — admit steward.
- `app/api/edit/*` — field-scope enforcement at the route.
- ETL: `etl/ed/*` steward-names export/import; `cdk` etl IAM grant; a
  `steward_directory` migration; session + candidates name resolution.
- Tests across the above.

---

## 9. Open decisions for you

1. **Field scope (§3b)** — recommended subset (overview + highlights), or add
   visibility, or full superuser parity? *(Gates implementation.)*
2. **Profiles (§3a)** — all scholars (recommended) or scoped?
3. Sequencing — this is sizable; suggest **two PRs**: (A) the §2a preview fix +
   nav capability set + the ED-name bridge (smaller, no new write authority), then
   (B) the profile-edit authz expansion (the security-sensitive core), each its
   own review.
