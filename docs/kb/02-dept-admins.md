# SOP: What you can and can't change about your department, division, or center page

**Audience:** Department administrators / unit owners (and center directors/administrators).
**ServiceNow template:** SOP · **Visibility:** All staff.

---

## ⚠️ DEFERRED — do not draft the body yet

Per **#506 Gate D3**, this article **cannot be finalized until #540 (unit curation) is concrete enough that the can/can't list is stable.** #540 was reopened on 2026-05-29 with Phases 7 (curation `/edit` UI), 8 (search facet keys + manual-div roster), and 9 (Path C retirement + backfill cutover) still outstanding — exactly the surfaces this article describes. Drafting now would document UI that's still changing and pin the wrong behavior version.

**Trigger to draft:** #540 Phases 1, 2, 5, 7 live (the schema + authz + grant endpoint + curation surfaces). **Pin the article to that phase boundary** ("behavior as of …") when written.

In the meantime, the pilot-dept-admin and center-admin outreach drafts ([`../outreach/wave1-pilot-dept-admins.md`](../outreach/wave1-pilot-dept-admins.md), [`../outreach/wave1-center-admins.md`](../outreach/wave1-center-admins.md)) carry the interim can/can't language and are the user-language source material for this article.

## Intended structure (when unblocked)

Organize around the three-tier RBAC and the can/can't boundary:

1. **The three tiers** — Superuser / Owner / Curator (#358 / #540): what each can do, who grants whom.
2. **What dept/center admins can curate** — description, leadership, highlighted faculty/publications and their order, informal subunits / manual rosters, custom URL request, granting Curator access via "Manage access".
3. **What stays with superusers** — the structural hierarchy (division→department roll-ups).
4. **What stays upstream** — faculty appointments, titles, primary departments (Web Directory / Faculty Affairs), photos (ITS); per-publication suppression stays with the individual scholar.
5. **Escalation path** — Request a change on the page; superuser for grants/structure; the matrix for source-data.

## Pre-publish checklist

- [ ] #540 Phases 1, 2, 5, 7 live; behavior version pinned
- [ ] Can/can't list reconciled against the shipped curation UI (not the spec)
- [ ] Reviewed by the library/Scholars team
- [ ] Cross-links the routing matrix and Article 1 (for the individual-scholar boundary)
