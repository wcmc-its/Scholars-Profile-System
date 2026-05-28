# Outreach — Wave 1, Scholars Superusers + Library

**Audience:** Members of `ITS:Library:Scholars/superuser-role` and library staff who curate or triage Scholars
**Channel:** Library / Scholars channel (Slack or Teams — match what the group uses) + direct email confirmation
**Sender:** Scholars project lead (Omar, per #506)
**Send date:** Approximately three weeks before `{{LAUNCH_DATE}}`
**Length:** Internal coordination — not bound by the 250-word cap. Aim for under 500.

---

## Variables to fill in before sending

- `{{LAUNCH_DATE}}` — public launch date
- `{{ONCALL_CHANNEL}}` — Teams channel for Scholars on-call (B23)
- `{{ONCALL_ROTATION_LINK}}` — rotation schedule for the launch window
- `{{KB_ARTICLE_3_URL}}`, `{{KB_ARTICLE_4_URL}}` — ServiceNow URLs

---

## Message body

> **Subject:** Scholars launch in 3 weeks — superuser on-call window, queues to expect

Team,

Heads-up that Scholars goes public on **{{LAUNCH_DATE}}** — three weeks out. Wave 2 outreach goes to all scholars (faculty / affiliated / postdocs / fellows) at T-2 weeks, and the first 72 hours after that are the highest-inbound window we expect.

**What you should know now:**

1. **Read KB Article 3** ({{KB_ARTICLE_3_URL}}) — it's the superuser SOP. New: the routing decision tree, the slug-queue review checklist, the unit-admin grant procedure, and the known-data-quirks table you'll be referencing on tickets. KB Article 4 ({{KB_ARTICLE_4_URL}}) is what Service Desk has for first-line triage; read it so you know what they're routing on.

2. **On-call rotation for the launch window.** Sign up via {{ONCALL_ROTATION_LINK}}. Coverage: continuous from T-2 weeks (when Wave 2 sends) through T+2 weeks. After T+2 weeks we revert to normal rotation. Escalation channel is {{ONCALL_CHANNEL}}.

3. **Expect a slug-queue spike.** Vanity-URL requests will surge in the first week after Wave 2. Review against the collision policy (hard-reject, no swap — #497 Option A) and the reserved-word denylist. The queue is fair, not first-come — if two requests collide on the same slug, both get declined.

4. **The known-data-quirks table in Article 3** is your friend when triaging. Most "Scholars is wrong" tickets reduce to one of those quirks. Don't escalate without checking it.

5. **What's still being built before launch:** scholar-level "Hide my profile" is real and shipped, but the **automated retraction filtering** promised in KB Article 1 is extended-scope on #63 — not yet merged. If a user reports a retracted paper is showing, it's currently a known gap, not a bug. Confirm with the dev team status before responding.

**Things to escalate to me directly:** privacy / safety / legal concerns; anything you're unsure how to triage; the first wave of "I don't recognize my own profile" tickets (we want to capture those — they're signal on data quality).

**Wave 1 dept-admin pilot** is going out separately to a small group of department chairs and admins. They'll be feeling out the curation UI and may file tickets that read like bug reports but are actually workflow questions. Treat patiently; flag patterns.

Thanks. We've done this carefully. Let's land it well.

— Omar
