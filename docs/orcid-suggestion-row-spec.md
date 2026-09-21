# ORCID iD row on the self-edit home board, with the suggested iD

Flag: `SELF_EDIT_ORCID_SUGGESTION` (staging on, prod off). Companion: `/edit/orcid-coverage` (#2678), whose fold this row reuses.

## What the scholar sees

A fifth row on `/edit` "Complete your profile", under FROM WCM SYSTEMS, after Publications. It counts toward "N of N done".

| state | marker | title | subtitle | CTA |
|---|---|---|---|---|
| on file (`scholar.orcid`, or an `rpm_admin` candidate row when the flag is on) | done | ORCID iD on file | the iD linked to orcid.org | none |
| strong (exactly one strong-eligible iD per `orcidVerdict` at `SUGGEST_MIN_ACCEPTED` = 1) | to-do | Is this your ORCID iD? | the iD (orcid.org link) · seen on N of your accepted publications, or "matches your record in the ORCID registry" when the strength is registry-only | Confirm in ReCiter → `ORCID_MANAGE_URL` |
| weak / none | to-do | ORCID iD not on file | Needed for NIH SciENcv biosketches; also makes your publication matching more reliable. | Add it in ReCiter → `ORCID_MANAGE_URL` |

Superuser mode: the name appears once, in the title; body copy says "their", never the name again. The Name & Title panel's `OrcidValue` shows the same suggestion when the iD is absent: "Not on file. Is `…` yours? Confirm in ReCiter".

## Why the CTA is a link, not a button

ReCiter Publication Manager's Manage Profile page already lists the candidate iDs with the accepted / pending / rejected PMIDs behind each, lets the scholar pick or type one, and writes `admin_orcid`. The nightly `etl:orcid-candidates` mirror then lands an `rpm_admin` row, which `orcidVerdict` grades as asserted, so the row flips to done without waiting on the Identity ETL. One write path, PM's, already permissioned and audited.

## Code

- `lib/edit/orcid-coverage.ts` — `orcidVerdict(rows, minAccepted)`: `{ tier, orcid, accepted }`, the per-cwid fold extracted from `orcidTiers()` (which now calls it with the console default). One rule, two support bars.
- `lib/api/edit-context.ts` — `opts.includeOrcidSuggestion` → `client.orcidCandidate.findMany({ where: { cwid } })` → `ctx.orcidVerdict` (null when off).
- `app/edit/page.tsx`, `app/edit/scholar/[cwid]/page.tsx` — pass `includeOrcidSuggestion: isOrcidSuggestionEnabled()`.
- `components/edit/edit-page.tsx` — `orcidRowState(ctx)` feeds both `HomePanel` (`orcid` prop) and `OrcidValue` (`suggested` prop).
- `components/edit/home-panel.tsx` — `OrcidItem`; `total` 4 → 5.
- `cdk/lib/app-stack.ts` — the flag per env.

## Skipped

- "Not mine" dismissal: needs a dismissal store and a way to keep the same iD from returning on the next mirror. The weak tier already withholds ambiguous iDs.
- Live refresh after confirming: the row goes done after the nightly mirror.
- The console's strong tier stays at `STRONG_MIN_ACCEPTED` (3); the row asks at 1 accepted article (`SUGGEST_MIN_ACCEPTED`), so the row is deliberately more permissive than the console's "strong" count.

## Upstream

What the mirror reads today is ReciterDB `pubsource_orcid_person`, last written 2026-02-17. Refreshing it (accepted-only evidence, rejected veto, Crossref as a second source) is tracked in the ReCiter Research plan `docs/PLAN_orcid_identity_backfill.md`; prod flips on after that lands.
