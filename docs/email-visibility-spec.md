# SPEC — Email visibility from Web Directory release code

Status: DRAFT (awaiting approval before implementation)
Owner: Paul Albert
Date: 2026-06-11

## Problem

SPS publishes every scholar's email to the open internet with no regard for the
person's Web Directory preference. `components/profile/profile-view.tsx:203`
renders `profile.email` as a `mailto:` in the Contact card **unconditionally** —
anonymous, off-campus visitors included. If a faculty member set their email to
release only to the institution, we are currently over-disclosing them.

The Web Directory exposes that preference as a multi-valued LDAP attribute,
`weillCornellEduReleaseCode;mail`, which SPS does not import today. This SPEC adds
the attribute to the ED import and gates email display and export on it.

This is primarily a **privacy-correctness fix** on existing behavior, plus a new
read-only surface in `/edit` and a hard cap on bulk export.

## Source of truth (do not write back)

The release code is owned by the Web Directory (the SOR). Scholars change it
themselves at **https://directory.weill.cornell.edu/update/profile/index** by
setting the "publish to" value in the **Emails** section. SPS imports it on each
ED ETL run; SPS never authors it. An editable control in `/edit` would silently
desync on the next ETL run (same trap as `ed_locked` fields).

## The attribute (verified)

`weillCornellEduReleaseCode;mail` is **multi-valued** — a *set* of audiences the
email is released to. Confirmed against a live record (`paa2013`):

```
weillCornellEduReleaseCode;mail: institution
weillCornellEduReleaseCode;mail: public
```

Parse to a single effective audience by taking the most permissive value present,
**fail-closed** when the set is empty or carries only unrecognized values:

| Set contains | Effective `email_visibility` |
|---|---|
| `public` (with or without `institution`) | `public` |
| `institution` only | `institution` |
| empty / absent / only unrecognized (e.g. an explicit `private`) | `none` |

`paa2013` → `public`.

> Only two values are observed (`institution`, `public`). The `none` state is
> inferred, never observed; treating absent/unknown as `none` is the fail-closed
> default and is the whole point of the fix. Unrecognized values are ignored, so
> a future explicit `private` value also lands on `none` with no code change.

## Policy

Two distinct surfaces, two distinct gates.

### A. Profile display (single email, in context)

`email_visibility` × viewer:

| `email_visibility` | Anonymous off-campus | Internal (session OR on-campus) |
|---|---|---|
| `public` | show | show |
| `institution` | hide | show |
| `none` | hide | hide |

"Internal" reuses the existing `lib/auth/viewer-context.ts` predicate
(authenticated session **OR** `CloudFront-Viewer-Address` ∈ `INTERNAL_VIEWER_CIDRS`,
the #866 mechanism). No new viewer logic.

### B. Bulk export (CSV)

Builds on the shipped #847/#866 export (`app/api/export/scholars/[scope]`,
email column behind `SCHOLAR_LIST_EXPORT_EMAIL` + internal-viewer gate,
IP-audited). Two changes:

1. **Channel gate stays uniform internal** — session OR on-campus. Unchanged.
2. **Release code becomes a per-row filter** — blank a scholar's email cell unless
   `email_visibility ∈ {public, institution}` (i.e. `none` blanks it). This stacks
   on the existing hidden-display-role blanking; the looser of "shown to whom" does
   not matter for export — any internal viewer who clears the channel gate sees
   institution and public alike.
3. **Hard ≤50 cohort cap** — the download is offered **only when the cohort has 50
   or fewer scholars**. We do not support bulk download of WCM scholars, even for
   internal users. For cohorts >50 there is **no download button at all**, and the
   server refuses the request. When ≤50, export the **complete** cohort (drop the
   current top-50 truncation — a ≤50 cohort is complete by definition).

   This tightens the currently-shipped #847 behavior (which offers a top-50 export
   for every cohort). #847 is still dark, so this is a clean pre-prod change.

   The ≤50 count is the number of **displayable** scholars in the cohort (after
   suppression / hidden-role exclusion) — the rows that would actually be written.
   It is independent of how many of those rows carry an exportable email.

### C. `/edit` — read-only "Email" tab

Replace the single read-only "Email" field (`components/edit/edit-page.tsx:452`)
with an Email tab that shows:

- the imported email,
- the current visibility (`Public` / `Institution only` / `Not released`),
- a one-line plain-language explainer of who can see it (mirrors table A),
- a link to **https://directory.weill.cornell.edu/update/profile/index** with the
  instruction: *change the "publish to" value in the Emails section.*

No editable control. Follows the established "Request a change → route to SOR"
pattern.

## Data model

`prisma/schema.prisma`, `Scholar` model — additive, nullable so the migration
applies to existing rows; ED ETL backfills on next run:

```prisma
/// Effective email release audience derived from the multi-valued Web Directory
/// attribute `weillCornellEduReleaseCode;mail` (most-permissive-wins, fail-closed).
/// 'public' | 'institution' | 'none'. NULL until the first ED ETL backfill; treated
/// as 'none' (fail-closed) by the display/export gate.
emailVisibility String? @map("email_visibility") @db.VarChar(16)
```

## Touch-points

| File | Change |
|---|---|
| `lib/sources/ldap.ts` | Add `weillCornellEduReleaseCode;mail` to `ED_FACULTY_ATTRIBUTES`. **Code inspection (implementation) showed only `EdFacultyEntry` actually carries `email`** — produced by `fetchActiveFaculty` *and* `fetchDoctoralStudents` (doctoral reuses `EdFacultyEntry`). The separate postdoc (`EdPostdocEmploymentRecord`) and NYP (`EdNypAffiliateTitle`) fetches do **not** request `mail` and write only to title/mentor tables, never `Scholar.email`; adding the attribute there would be dead weight and violate the minimal-attributes policy. So the attribute + `emailVisibility` field live on `EdFacultyEntry` only — which covers 100% of email-bearing scholars. Parse multi-valued → effective audience. |
| `etl/ed/index.ts:789,833` | Persist `emailVisibility: f.emailVisibility` next to `email: f.email` in both writes. Verified these are the **only** two paths that write `Scholar.email` (all other scholar writes set unrelated fields). |
| `prisma/schema.prisma` + migration | Add `email_visibility` column (additive nullable). Generate offline (`prisma migrate diff --from-schema --to-schema --script`, per repo convention — never `migrate dev`). |
| `lib/api/profile.ts:869` (primary display gate) | Where `email: scholar.email` is set on the public profile. Apply table A here so a hidden email never reaches the client. The caller (`ProfileView`) is already dynamic and reads `cookies()/headers()` (#640); thread the resolved internal-viewer signal into this loader. No change needed in `components/profile/profile-view.tsx` itself once `profile.email` arrives already gated. |
| `lib/api/scholars.ts:59` | Scholar-list API also serializes `scholar.email` — apply the same table-A gate, or drop the field if no client consumer needs it. |
| `app/api/export/scholars/[scope]/route.ts` + `lib/api/export-scholars.ts` | Add the release-code row filter (blank email when `email_visibility = none`); enforce the ≤50 cohort cap server-side (refuse > 50 with the same dark-feature semantics — 404/empty, no partial top-50). |
| `app/(public)/methods/...`, topic/supercategory cohort views | Show the export button only when cohort ≤ 50. |
| `components/edit/edit-page.tsx` + `lib/api/edit-context.ts:664,821` | Email tab per section C. `edit-context.ts` already surfaces the owner's `scholar.email`; extend it to also surface `email_visibility` so the tab can show the current state and the right explainer. Owner-context is internal (the scholar editing their own profile), so email is always shown here — the visibility value is informational. |
| `lib/auth/viewer-context.ts` | Reuse as-is. |
| cdk `app-stack.ts` (per env) + flags module | Wire the new flag (below) into both envs; regenerate the app-stack snapshot. |

## Feature flag & rollout order

New flag **`PROFILE_EMAIL_RELEASE_GATE`** governs whether the release code is
respected across **both** display and the export row-filter:

- **off** → current behavior (email shown to everyone; export email column gated
  only by viewer-context + hidden-role, not by release code).
- **on** → tables A and B apply, fail-closed.

The ≤50 export cap is **not** behind this flag — it rides `SCHOLAR_LIST_EXPORT`
(the export feature) and applies whenever export is enabled.

**Order (reindex-then-flip discipline):** because `email_visibility` is NULL until
backfilled, flipping the gate before the data exists would hide every email
(NULL = `none`). So:

1. Merge importer + schema + gated code with `PROFILE_EMAIL_RELEASE_GATE` **off**.
2. Deploy; run the ED ETL to backfill `email_visibility` for all scholars.
3. Verify the backfill (audit below), then `cdk deploy Sps-App-<env>` with the flag
   on. Staging first, soak, then prod.

> **No reindex needed.** Confirmed: email is not part of the OpenSearch document
> (`lib/search-index-docs.ts` has no email field). The gate lives entirely at the
> profile-render and export-serialization layers, so a backfill is the only data
> step before flipping the flag.

## ⚠️ Cache-safety gate (BLOCKS prod flag-on — not yet solved)

The profile page is **cached by CloudFront keyed on path** (cookies stripped — see
`project_sps_edge_cookie_and_prod_oidc`). Of the three states, only **`institution`
varies by viewer**:

- `public` (always shown) and `none`/null (always hidden) are identical for every
  viewer → **cache-safe**, can be baked into the rendered page.
- `institution` (shown to internal, hidden to external) is **viewer-dependent** →
  baking it into the path-cached HTML lets whichever viewer populates the cache
  first decide what everyone sees: an internal-populated entry **leaks** the email
  to external viewers (or an external-populated entry hides it from internal ones).

The current implementation gates `email` in the server loader (`lib/api/profile.ts`),
which is correct **only** if the page is uncacheable or the cache varies on the
internal-viewer signal. **Do NOT flip `PROFILE_EMAIL_RELEASE_GATE` on in any
CloudFront-cached env until this is resolved.** Options (decision pending):

1. **#866 pattern (recommended):** bake the public-safe version (institution hidden)
   into the cached page; reveal `institution` emails via an **uncacheable** client
   fetch to a small `/api/profile/[cwid]/contact-email` endpoint that forwards
   `CloudFront-Viewer-Address` — exactly how the #866 sensitive-families reveal works.
2. Make the profile response `Vary` on the internal-viewer signal (split cache).
3. Make the profile page uncacheable (perf regression — likely unacceptable).

This affects only **profile display**. The export route is `force-dynamic` /
uncached, so its `institution` row-filtering is already cache-safe.

## Edge-case test table

| # | Release set | Viewer | Surface | Expected |
|---|---|---|---|---|
| 1 | `{public, institution}` | anon off-campus | profile | email shown |
| 2 | `{institution}` | anon off-campus | profile | email hidden |
| 3 | `{institution}` | session, off-campus | profile | email shown |
| 4 | `{institution}` | anon on-campus | profile | email shown |
| 5 | `{}` (absent) | session on-campus | profile | email hidden |
| 6 | `{public}` | anon off-campus | profile | email shown |
| 7 | unrecognized only (e.g. `private`) | session | profile | email hidden (fail-closed) |
| 8 | `{institution}` | anon off-campus (no session, off-net) | export | 401 (channel gate) |
| 9 | `{institution}` | internal | export, cohort = 30 | row included, email present |
| 10 | `{}` | internal | export, cohort = 30 | row included, **email blank** |
| 11 | any | internal | export, cohort = 51 | **no button; server refuses** |
| 12 | any | internal | export, cohort = 50 | full 50-row export |
| 13 | `PROFILE_EMAIL_RELEASE_GATE` off | anon off-campus | profile | email shown (legacy) |

## Audit SQL

Baseline before backfill — current fail-open population:

```sql
SELECT COUNT(*) AS public_facing_emails
FROM scholar
WHERE email IS NOT NULL AND status = 'active' AND deleted_at IS NULL;
```

After backfill — distribution and the over-disclosure that the fix corrects:

```sql
SELECT COALESCE(email_visibility, 'NULL(none)') AS visibility, COUNT(*) AS n
FROM scholar
WHERE email IS NOT NULL AND status = 'active' AND deleted_at IS NULL
GROUP BY email_visibility
ORDER BY n DESC;
-- institution + none rows = emails currently public that the gate will restrict.
```

## Out of scope

- Phone or any other `;<field>` release code — email only.
- Writing the release code back to the Web Directory.
- Changing the export channel gate or the #866 internal-viewer mechanism.
