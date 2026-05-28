# Wave 1 outreach — Center directors and administrators

**Status:** Draft. Do not send until #540 Phases 1, 2, 5, and 7 are live in staging and at least one center has been provisioned end-to-end (Owner grant → roster edit → leader/description edit → proxy-edit a member's profile).

**Audience:** Directors and administrative staff of WCM research centers and institutes — the units that appear as `Center` rows in Scholars (sourced from `data/center-members/*.txt` today; migrating to manual roster curation per #540).

**Sender:** Scholars project lead, copying the Dean's office contact for the responsible division/department.

**Channel:** Direct email per center, with the center's named administrator and director on the To line. Not a mass send — each center gets a personalized note naming its Owner grantee and a direct link to its `/edit/center/<slug>` page.

**Timing:** T-minus 3 weeks from prod flip. Runs in the same Wave 1 window as the superuser/library brief and the pilot department admins.

**Prerequisites before sending:**

- [ ] #540 Phases 1, 2, 5, 7 live in staging
- [ ] Center roster import dry-run reconciled against `data/center-members/*.txt` baseline
- [ ] Owner grants pre-created for each center (one per center, naming the administrator; director is grantable as a second Owner if requested)
- [ ] KB Article 2 (dept/center admin SOP) drafted, even if not yet published

---

## Message body (~250 words)

**Subject:** Your center's page on the new WCM Scholars site — quick orientation before launch

Hi [name],

We're getting close to launching the new WCM faculty Scholars site at `scholars.weill.cornell.edu`, and your center has a dedicated page on it. Before we flip the domain, I want to make sure you know what you can curate directly and where the rest of the data comes from, so the page reads the way you want it to from day one.

**What you can change in Scholars directly** (sign in at `scholars.weill.cornell.edu/edit/center/<your-slug>`):

- The center's **description** and **leadership** (director, interim status)
- The center's **roster** — add or remove faculty affiliations that aren't captured upstream
- **Highlighted publications** for the center, and the order they appear in
- A **custom URL** for the center page (request flow; superuser-approved)

**What you can't change here, and where it does get changed:**

- Faculty appointments, titles, and primary departments — managed in the **Web Directory** (Enterprise Directory / OFA)
- Faculty photos — managed by **ITS** through the directory
- A faculty member's publication list — managed in **ReCiter** by the library; per-publication suppression is available to the scholar on their own profile

**Who has access:** You've been granted **Owner** access for the center, which lets you do everything above and grant **Curator** access (curate-only, no further grants) to colleagues who help maintain the page. To add a Curator, use the "Manage access" link inside the edit view.

**If something is wrong and you can't fix it here,** use "Request a change" on the page; it routes to the right team.

Happy to walk through it on a call — reply to this email and we'll set 20 minutes.

[Sender]

---

## Acceptance checklist for this outreach

- [ ] Personalized per center (no mass send) — substitute name, slug, Owner grantee
- [ ] Sent only after the recipient's Owner grant is live in staging *and* prod
- [ ] Inbound replies routed to the Scholars project lead and one on-call superuser for 72 hours
- [ ] Retrospective with first 3 centers before broader Wave 1 close — capture confusing language, fix, then send the rest
- [ ] Feeds into KB Article 2 (#534/D3) as user-language source material

## Open questions before sending

1. Director vs administrator as the primary Owner grantee — defaults to administrator; confirm exceptions per center with the responsible Dean's office.
2. For centers without a current administrative contact in `data/center-members/`, who do we ask? (Faculty Affairs / research deans, per #540 Phase 5 grant-issuance procedure.)
3. Does Comms want to review the body before first send? Same question is open for Wave 2 — resolve once for both.
