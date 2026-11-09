# docs/ADR-016 — ORCID iDs: system of record, authentication levels, scope and display

**Status:** Accepted 2026-11-06. D3/D4 display and confirmation rules ship behind `SELF_EDIT_ORCID_SUGGESTION`, `SELF_EDIT_PROFILE_LINKS` and `ORCID_CONNECT`; `ORCID_CONNECT` stays off in prod until production ORCID credentials are issued.
**Date:** 2026-11-06
**Revision:** 1
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

SPS holds an ORCID iD for a scholar from several routes: the person confirming it in `/edit`, a proxy or librarian confirming it, an ETL auto-confirm on a verified email match, ORCID sign-in (`/authenticate`, #3115), and older values of unknown origin inherited from WCM Identity. Suggestions come from several mirrors (`orcid_candidate`: RPM inferred/admin, ORCID registry email/works/name, Crossref).

WCM's Enterprise Directory is being reformulated and is not a viable home for ORCID iDs. The Institutional Client's rebuild wiped `Identity.orcid` nightly (IC #155, fixed in #156). Uptake of self-confirmation is negligible: of 2,490 active full-time faculty (2026-10-21), 13 had an iD on file, about 1,369 had a strong candidate, and 955 had none.

ORCID's membership at Cornell is held by Cornell University Library. ORCID reviews each integration's scopes; wider scopes need a separate integration review and fresh consent from every connected user.

## Decisions

### D1. SPS is the system of record for WCM ORCID iDs

`scholar.orcid` is authoritative. `Identity.orcid` (DynamoDB, shared by staging and prod) is a downstream copy, and SPS is its sole writer: `etl/orcid-push` runs before the Identity pull in the nightly, so a new confirmation is never reverted.

### D2. Four levels, defined

| Level | Meaning | `orcidConfirmMethod` |
|---|---|---|
| Authenticated | The scholar signed in to ORCID through our production client; ORCID returned the iD | `authenticated` |
| Confirmed | On `scholar.orcid` by any other route | `self`, `proxy`, `librarian`, `email_verified`, recovered values, or null (unknown) |
| Suggested | In `orcid_candidate`, not on file, not dismissed | — |
| Dismissed | "Not me" or Remove | `orcid_dismissal` row |

Only the authenticated level may be described as authenticated, in UI or in reports. Sandbox authentications (staging) are never authenticated outside staging and never reach Identity.

### D3. Display

- Every confirmed or authenticated iD is shown on the public profile and in JSON-LD. Restricting the profile to authenticated iDs would hide nearly every iD we hold.
- Per ORCID's iD display guidelines, every iD uses the full `https://orcid.org/` URL with an icon. An authenticated iD gets the green iD icon. Every other iD gets ORCID's unauthenticated icon and an "(unauthenticated)" suffix, and is marked no other way.
- Suggestions are never public. They appear only in `/edit` (the card, the home board, the librarian queue).
- A "What is ORCID?" info popover accompanies the iD in `/edit` and on the profile.

### D4. Confirmation flow

- The scholar's own view leads with ORCID sign-in. One-click confirm remains as a secondary action.
- A proxy, admin or librarian confirms in one click (they cannot sign in as the scholar).
- An iD is never typed in by the scholar while sign-in is available (ORCID minimum requirement).

### D5. Downstream

Every confirmed or authenticated iD flows to WCM Identity, and from there to ReCiter and NIH biosketch tooling. Dismissals propagate as nulls.

### D6. Scope: `/authenticate` only

No `/read-limited`, no `/activities/update` or `/person/update`, and therefore no ORCID Researcher Connect, which requires writing affiliations. Widening has three costs: re-consent from every connected scholar, a separate ORCID integration review, and the build. Revisit only for a coherent reason:

- a data need that public record data (readable anonymously at `pub.orcid.org`) cannot meet, or
- ORCID coverage becoming an institutional goal that justifies writing employment affiliations (Researcher Connect).

If revisited, request `/read-limited` and `/activities/update` in one review, as early as possible, while few scholars have connected.

### D7. Token storage

ORCID's minimum requirements ask integrators to store the access token. SPS stores it in `orcid_authentication`, encrypted with AES-256-GCM, with the key in AWS Secrets Manager (`scholars/<env>/orcid-api`). The token is never decrypted or used to call ORCID under D6.

## Consequences

- Public iDs carry two visual levels. Most will be "confirmed" for the foreseeable future.
- Provenance for older null-method iDs is recovered where evidence exists (RPM admin entry, audit log, email match); the rest stay "origin unknown" but public.
- Any change to `scholar.orcid` must clear the authenticated state.

## Open

- Key is CWID only. Extending to Cornell Ithaca (NetIDs, no WCM SSO, so no sign-in route) needs its own decision.
- Whether ORCID requires or merely recommends reserving the iD icon for authenticated iDs. Treated as required.
