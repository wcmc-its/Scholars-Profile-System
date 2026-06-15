# Wave 3 outreach — Doctoral students

**Status:** Draft. This is the **"hidden at launch"** variant. Per #536 (CLOSED — Option B shipped), doctoral students do **not** have public Scholars profiles at launch, so this Wave is a short visibility-status note, not a "review your profile" prompt. *(If the launch decision is ever reversed, students fold into Wave 2 instead and this file is dropped.)*

**Audience:** WCM doctoral students.

**Sender / channel:** Weill Cornell Graduate School (WCGS) communications.

**Timing:** T-minus 1 week from prod flip. Can also send at T-zero alongside Wave 4 — it carries no "act before launch" ask.

**Prerequisites before sending:**

- [ ] #536 verified live in prod (no public profile page; excluded from search / browse / algorithmic surfaces; mentee + co-author mentions render as plain text, not links)
- [ ] A contact named for student questions (WCGS office and/or Scholars team)

---

## Message body (~150 words)

**Subject:** How doctoral students appear on the new WCM Scholars site

Hi [name],

WCM is launching a new research-profile site, **Scholars** (`scholars.weill.cornell.edu`), built for faculty and research staff. We want you to know how it treats doctoral students at launch.

You **won't have a public Scholars profile page**, and you **won't appear** in Scholars search or browse. Your name may still appear — as plain text, not a clickable profile — in two places: where a faculty **mentor lists you among their PhD mentees**, and as a **co-author** on a publication. Those are relational mentions on someone else's profile, not a profile of you.

This reflects the site's launch scope — a faculty-and-research-staff directory — not a judgment about your work. Whether and how trainee profiles are added later is a separate, future decision; if that changes, WCGS will let you know.

Questions? Contact [WCGS / Scholars team contact].

[Sender]

---

## Acceptance checklist for this outreach

- [ ] Reviewed by WCGS Dean's office before sending
- [ ] Visibility claims match the shipped #536 behavior exactly (no public page; plain-text mentor/co-author mentions only) — verify against prod, don't assume
- [ ] No promised "return date" for student profiles — framed as a future, undecided possibility
- [ ] Inbound questions routed to a named contact for 72 hours

## Open questions before sending

1. Send at T-minus 1 week, or fold into the T-zero Wave 4 window? It carries no pre-launch action, so either works — confirm with WCGS comms cadence.
2. Is there a student-specific privacy concern about the plain-text mentee / co-author mentions that WCGS wants addressed explicitly? (Names are visible but non-linked and non-searchable.) **#1026** broadens one such mention: it surfaces soft-deleted student co-authors as **non-linked chips** (name + headshot, no link, not searchable) on publication chip surfaces site-wide (search, topic feeds, methods pages, home spotlight). The code is merged but gated behind `COAUTHOR_HIDDEN_STUDENT_CHIPS`, **default-off**, and is enabled per-environment **only after this question is answered**. (Until then, a mentee's name shows only in the publication's full byline (detail modal) and on the mentor's co-pubs page.)
