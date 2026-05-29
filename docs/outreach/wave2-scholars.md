# Wave 2 outreach — All scholars (faculty, emeritus, postdocs, fellows)

**Status:** Draft. Do not send until the Wave 1 retrospective is complete (#506 D5) and the prerequisites below are live in **prod**.

**Audience:** Every scholar with a Scholars profile — full-time faculty (assistant / associate / full / endowed), affiliated and voluntary faculty, **emeritus** faculty, postdocs, and clinical + research fellows. One unified body; distributed per role through the channel that actually reaches that role.

**Sender / channel (per role — one body, many senders):**

| Role | Channel | Sender / owner |
|---|---|---|
| Full-time + endowed faculty | Dean's-office cascade (WCM norm — service mailboxes don't reach faculty reliably) | Each dean's office |
| Affiliated / voluntary faculty | Departmental affiliate liaison | Dept admins |
| Emeritus faculty | Dean's-office send (same body, no separate carve-out) | Each dean's office |
| Postdocs | Office of Postdoctoral Affairs distribution | OPA |
| Fellows (clinical + research) | Fellowship program directors | GME / program coordinators |

**Timing:** T-minus 2 weeks from prod flip.

**Prerequisites before sending:**

- [ ] Wave 1 retrospective complete; confusing language fixed in this draft
- [ ] In prod: the `/edit` flow, overview editor, per-publication hide, profile-hide (Visibility), slug-request, and **Request a change** (#160 / #356 / #497)
- [ ] KB **Article 1** (`docs/kb/01-scholars.md`) published and linked
- [ ] Correction routing resolved enough to be honest in the in-app flow — see [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md) §3.3 (#514)
- [ ] Open question (a) decided: deep-link each recipient to their own profile in the mail-merge? (see below)

---

## Message body (~245 words)

**Subject:** Your profile on the new WCM Scholars site — a quick look before launch

Hi [name],

WCM is launching a new research-profile site, **Scholars**, at `scholars.weill.cornell.edu`, and you already have a profile on it. Scholars doesn't ask you to fill anything out — it **assembles** your profile from systems that already hold your information (the Web Directory, faculty records, your PubMed publications, your NIH funding) and shows a copy. Before the site goes public, please take two minutes to look at yours: sign in at `scholars.weill.cornell.edu/edit`.

If you'd prefer not to appear at all, you can **hide your entire profile** from public view in one click on the Visibility tab — reversible at any time.

**What you can change in Scholars directly:**

- Your **overview** — the short narrative at the top of your profile.
- **Which of your publications show** — hide any item from your profile. It's display-only and reversible, and it changes nothing upstream.
- Request a **custom web address** for your profile.

**What you can't change here, and where it does get changed:**

- Name, title, department, email, photo — the **Web Directory**.
- Appointments and degrees — **Faculty Affairs**.
- Your publication list (a paper that's missing, or isn't yours) — corrected in **ReCiter / Publication Manager**, not by hiding it.
- Funding — the **Office of Sponsored Research Administration**.

For anything you can't fix yourself, use **Request a change** on the field — it routes to the office that owns it.

Questions: [link to KB Article 1].

[Sender]

---

## Acceptance checklist for this outreach

- [ ] Reviewed by the responsible office before each channel sends (deans' offices, OPA, GME)
- [ ] Suppression path ("hide your entire profile") present near the top — present ✓; confirm it survives any per-channel edits, especially the emeritus send
- [ ] "Request a change" and KB Article 1 are live and linked, not placeholders
- [ ] Channel + sender confirmed per role; no send from a service mailbox to faculty
- [ ] Inbound channel staffed for the first 72 hours: Service Desk has Article 4; ≥1 superuser on-call
- [ ] Sent only after Wave 1 retrospective fixes are folded in

## Open questions before sending

1. **Deep-link each recipient to their own profile** in the dean's-office mail-merge (`scholars.weill.cornell.edu/scholars/<slug>`)? High-effort, dramatically higher engagement. Decide before drafting the final mail-merge. *(Same open question as #506 D5 / #535.)*
2. **"Preview before public" period?** Probably no — profiles are pre-built and the WCM-only access gate (#502) keeps non-WCM traffic out — but confirm with leadership.
3. **Comms review of the body** — resolve once for Wave 1 + Wave 2 together (also open in `wave1-center-admins.md`).
4. **Press / external announcement** — if Communications wants one, they own it; not the Scholars project lead.
