# ORCID iD: the home-board row and the Identifiers & Profiles tab

Flag: `SELF_EDIT_ORCID_SUGGESTION` (staging on, prod off until the staging soak) — one kill switch for the suggestion, the Identifiers & Profiles tab, and the write route; off, the home row and Name & Title hand off to ReCiter Manage Profile as before. Companion: `/edit/orcid-coverage` (#2678), whose fold this row reuses.

## What the scholar sees

A fifth row on `/edit` "Complete your profile", under FROM WCM SYSTEMS, after Publications. It counts toward "N of N done".

| state | marker | title | subtitle | CTA |
|---|---|---|---|---|
| on file (`scholar.orcid`, or an `rpm_admin` candidate row when the flag is on) | done | ORCID iD on file | the iD linked to orcid.org | none |
| strong (exactly one strong-eligible iD per `orcidVerdict` at `SUGGEST_MIN_ACCEPTED` = 1) | to-do | Is this your ORCID iD? | the iD (orcid.org link) · seen on N of your accepted publications, or "matches your record in the ORCID registry" when the strength is registry-only | Confirm in ReCiter → `ORCID_MANAGE_URL` |
| weak / none | to-do | ORCID iD not on file | Needed for NIH SciENcv biosketches; also makes your publication matching more reliable. | Add it in ReCiter → `ORCID_MANAGE_URL` |

Superuser mode: the name appears once, in the title; body copy says "their", never the name again. The Name & Title panel's `OrcidValue` shows the same suggestion when the iD is absent: "Not on file. Is `…` yours? Confirm in ReCiter".

## The Identifiers & Profiles tab

The home row's CTA and Name & Title's ORCID value both link into `?attr=identifiers-profiles`, an owned tab under *Yours to edit* right after Honors. Its first card is ORCID iD (`components/edit/orcid-card.tsx`): on file (iD linked to orcid.org, Change), suggested (the iD and its evidence, **Yes, this is mine**, or enter a different one), none (the input). Superuser voice is third person. The tab is the home for later identifier cards (eRA Commons ID, Scopus Author ID) and profile links (lab website, Google Scholar).

Originally the CTA handed off to ReCiter Publication Manager's Manage Profile page, which is reachable only on the campus network. The tab replaces that.

## The write: `POST /api/edit/orcid`

Body `{ cwid, orcid, confirmedSuggestion?, dismiss? }`. Every iD, `dismiss` entries included, is normalized and checksummed (`lib/edit/orcid.ts`, ISO 7064 MOD 11-2): a typo is a 400, never a wrong iD on file. Authorization is `authorizeOverviewWrite` keyed on `cwid` (self, superuser, comms_steward, proxy, unit-admin).

SPS is the durable record. The route runs one `db.write` transaction and calls nothing outside SPS; ReciterDB `admin_orcid` is not written (RPM stopped writing it 2026-04-05, and nothing reads it back into Identity). Inside the transaction:

- The iD on file is re-read from `scholar.orcid` on the writer, not the reader, so a lagged replica cannot hide a confirm made a moment earlier.
- Set / confirm (`orcid` non-null): `scholar.orcid` = the iD, `orcid_confirmed_at` = now, and any `orcid_dismissal` row for exactly this (cwid, iD) is deleted, since the person is re-confirming an iD they once removed.
- Remove (`orcid: null`): `scholar.orcid` and `orcid_confirmed_at` are nulled. Every iD that made up "on file" gets an `orcid_dismissal` row: `scholar.orcid` and the iD on each `rpm_admin` candidate row. The local `rpm_admin` rows are deleted so the card flips now instead of after the 07:00 UTC re-mirror. The dismissal is what keeps a removed iD gone: the mirror re-creates `rpm_admin` rows from the still-populated `admin_orcid` every night, and every `orcid_candidate` reader drops dismissed pairs (`withoutDismissed`).
- `dismiss`: competing iDs the person rejected in the same action each get an `orcid_dismissal` row. The card's conflict state sends the suggested iD with "Keep the iD on file" (which confirms the on-file iD) and with "Remove both". `dismiss` may not include the iD being set.
- The B03 audit row `orcid_set`. `before` is the displayed iD (`scholar.orcid`, else the `rpm_admin` iD). `after` carries `removed: true` on a remove, `dismissed: [...]` when any dismissal was written, and `confirmed_suggestion: true` when the iD came from the suggestion.

Then profile revalidation, so the row, the biosketch worksheet and the dashboard flip immediately. The nightly `etl:orcid-push` (before `etl:identity`) carries `scholar.orcid` into WCM Identity and clears a dismissed iD Identity still holds.

## Code

- `lib/edit/orcid-coverage.ts` — `orcidVerdict(rows, minAccepted)`: `{ tier, orcid, accepted }`, the per-cwid fold extracted from `orcidTiers()` (which now calls it with the console default). One rule, two support bars.
- `lib/api/edit-context.ts` — `opts.includeOrcidSuggestion` → `client.orcidCandidate.findMany` and `client.orcidDismissal.findMany` for the cwid → `withoutDismissed` → `ctx.orcidVerdict` (null when off).
- `app/edit/page.tsx`, `app/edit/scholar/[cwid]/page.tsx` — pass `includeOrcidSuggestion: isOrcidSuggestionEnabled()`.
- `components/edit/edit-page.tsx` — `orcidRowState(ctx)` feeds both `HomePanel` (`orcid` prop) and `OrcidValue` (`suggested` prop).
- `components/edit/home-panel.tsx` — `OrcidItem`; `total` 4 → 5.
- `cdk/lib/app-stack.ts` — the flag per env.

## Skipped

- A "Not mine" button on a suggestion-only card (nothing on file). The route can already record it (`orcid: null, dismiss: [iD]`); the card offers dismissal only in the conflict state and through Remove. The weak tier already withholds ambiguous iDs.
- Showing the PMIDs behind the suggestion (the count is shown; the PMIDs are one query away in ReciterDB when someone asks).
- Request a Change's "My ORCID is wrong or missing" still hands off to ReCiter Manage Profile; retarget it to the tab when prod flips on.
- The console's strong tier stays at `STRONG_MIN_ACCEPTED` (3); the row asks at 1 accepted article (`SUGGEST_MIN_ACCEPTED`), so the row is deliberately more permissive than the console's "strong" count.

## Upstream

What the mirror reads today is ReciterDB `pubsource_orcid_person`, last written 2026-02-17. Refreshing it (accepted-only evidence, rejected veto, Crossref as a second source) is tracked in the ReCiter Research plan `docs/PLAN_orcid_identity_backfill.md`; prod flips on after that lands.
