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

Body `{ cwid, orcid, confirmedSuggestion? }`. The iD is normalized and checksummed (`lib/edit/orcid.ts`, ISO 7064 MOD 11-2): a typo is a 400, never a wrong iD on file. Authorization is `authorizeOverviewWrite` keyed on `cwid` (self, superuser, comms_steward, proxy, unit-admin). Then two writes, in this order:

1. ReciterDB `admin_orcid` upsert, the table PM's Manage Profile writes: what the nightly `etl:orcid-candidates` mirror grades as asserted, and the source IC #155 (open) asks the Institutional Client to merge into DynamoDB `Identity.orcid` so ReCiter's `[auid]` retrieval fires. Unreachable → 502 `reciter_unavailable` and nothing has changed.
2. `scholar.orcid` + the B03 audit row `orcid_set` (`confirmed_suggestion: true` when it came from the suggestion), one transaction, then profile revalidation. This makes the row, the biosketch worksheet, and the dashboard flip immediately. If it fails after (1), the mirror repairs it tonight.

Clearing an iD is not offered; PM's reset endpoint still exists for that.

## Code

- `lib/edit/orcid-coverage.ts` — `orcidVerdict(rows, minAccepted)`: `{ tier, orcid, accepted }`, the per-cwid fold extracted from `orcidTiers()` (which now calls it with the console default). One rule, two support bars.
- `lib/api/edit-context.ts` — `opts.includeOrcidSuggestion` → `client.orcidCandidate.findMany({ where: { cwid } })` → `ctx.orcidVerdict` (null when off).
- `app/edit/page.tsx`, `app/edit/scholar/[cwid]/page.tsx` — pass `includeOrcidSuggestion: isOrcidSuggestionEnabled()`.
- `components/edit/edit-page.tsx` — `orcidRowState(ctx)` feeds both `HomePanel` (`orcid` prop) and `OrcidValue` (`suggested` prop).
- `components/edit/home-panel.tsx` — `OrcidItem`; `total` 4 → 5.
- `cdk/lib/app-stack.ts` — the flag per env.

## Skipped

- "Not mine" dismissal: needs a dismissal store and a way to keep the same iD from returning on the next mirror. The weak tier already withholds ambiguous iDs.
- Clearing the iD from SPS; and showing the PMIDs behind the suggestion (the count is shown; the PMIDs are one query away in ReciterDB when someone asks).
- Request a Change's "My ORCID is wrong or missing" still hands off to ReCiter Manage Profile; retarget it to the tab when prod flips on.
- The console's strong tier stays at `STRONG_MIN_ACCEPTED` (3); the row asks at 1 accepted article (`SUGGEST_MIN_ACCEPTED`), so the row is deliberately more permissive than the console's "strong" count.

## Upstream

What the mirror reads today is ReciterDB `pubsource_orcid_person`, last written 2026-02-17. Refreshing it (accepted-only evidence, rejected veto, Crossref as a second source) is tracked in the ReCiter Research plan `docs/PLAN_orcid_identity_backfill.md`; prod flips on after that lands.
