# Outreach message skeleton

The shared template every launch-window outreach message inherits (#506 Gate D5). Copy this structure; don't reinvent it per wave. The goal of every message is the same: get the right person to look at their profile and understand **what they can and can't change in Scholars**, so the first wave of corrections lands in a controlled window — not at flip.

**Hard rules**

- **≤ 250 words** in the body. Anything longer goes in a linked KB article, not the email.
- **Lead with the can/can't framing.** Scholars looks like a directory editor but most fields are read-only mirrors of upstream systems. A reader who doesn't grasp that files the wrong ticket to the wrong queue.
- **The opt-out / suppression path is named and clickable in every message.** For emeritus and trainees it goes *near the top*, not buried at the bottom.
- **"How to get help" points at two things:** the relevant KB article (`docs/kb/`) and the in-app **Request a change** entry point — never a bare service mailbox.
- **No assumption that a service mailbox reaches faculty.** Confirm channel + sender per audience (dean's-office cascade vs. liaison vs. newsletter).

**The five parts (in order)**

1. **What this is** — one sentence. (A new WCM research-profile site; you already have a profile; it's assembled, not filled out.)
2. **What you can do here** — at most three actions: edit your overview, hide an item (or your whole profile), request a correction or a custom URL.
3. **What you can't do here** — the source-of-record fields (Web Directory for name/title/photo, Faculty Affairs for appointments/degrees, ReCiter/Publication Manager for the publication list, OSRA for funding) and **where those *do* get changed**.
4. **How to get help** — link the relevant KB article + the in-app **Request a change** flow.
5. **Opt-out / suppression path** — explicit; lead with it for emeritus + trainees.

**Per-file header** — every wave file states: Status / gate, Audience, Sender, Channel, Timing (T-minus), Prerequisites, then the Message body, then an Acceptance checklist and Open questions.

**Routing** — the "Request a change" destinations every message implies are defined once in [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md) (#514). Don't restate destinations in outreach copy; point at the in-app flow, which derives them server-side.

**Wave sequence** (cascades backward from the prod flip; see #506 Gate D5):

| Wave | T-minus | Audience | File |
|---|---|---|---|
| 1 | 3 weeks | Superusers + library | `wave1-superusers-library.md` |
| 1 | 3 weeks | Pilot department admins | `wave1-pilot-dept-admins.md` |
| 1 | 3 weeks | Center directors / administrators | `wave1-center-admins.md` |
| 2 | 2 weeks | All scholars (faculty incl. emeritus, postdocs, fellows) | `wave2-scholars.md` |
| 3 | 1 week | Doctoral students (hidden at launch per #536) | `wave3-doctoral-students.md` |
| 4 | T-zero | WCM-wide public launch | `wave4-public-launch.md` |

**Post-Wave-1 retrospective is mandatory before Wave 2 sends** — capture confusing language from the pilot, fix it, then ship the broad faculty send.
