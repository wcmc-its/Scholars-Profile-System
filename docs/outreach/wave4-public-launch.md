# Wave 4 outreach — WCM-wide public launch

**Status:** Draft. Sends at T-zero, when the domain flips. Short, link-out only — the detail lives on the site and in the KB.

**Audience:** All WCM (faculty, staff, postdocs, students) via standard institutional channels.

**Sender / channel:** ITS weekly bulletin + the WCM announcements page. ITS Communications owns the send.

**Timing:** T-zero — the day `scholars.weill.cornell.edu` goes public. Do not send before the WAF/edge gate (#502) is lifted and the prod cutover (#445) is complete.

**Prerequisites before sending:**

- [ ] Domain flipped and publicly reachable; WCM-only gate lifted per the resolved WAF topology (#502)
- [ ] Scholars → ServiceNow intake (#519 / #520) live, or the in-app **Request a change** flow confirmed working
- [ ] Public **About** page (`/about`) and footer Help & support link live (the public FAQ front door)
- [ ] Waves 1–3 already sent

---

## Bulletin item (~120 words)

**Headline:** Scholars is live — WCM's new research-profile site

WCM's new research-profile site, **Scholars**, is now public at **`scholars.weill.cornell.edu`**. Browse faculty and research staff by name, department, center, or research topic, and explore publications, funding, and expertise across the institution.

**Faculty and research staff:** your profile is built automatically from WCM systems — you don't fill anything out. Sign in at `scholars.weill.cornell.edu/edit` to review your overview, choose which publications appear, or request a custom URL. Most details (titles, appointments, photos) come from WCM systems of record; the site shows you where each piece comes from and how to correct it.

Learn more: **`scholars.weill.cornell.edu/about`**.

---

## Acceptance checklist for this outreach

- [ ] Reviewed by ITS Communications (they own the channel and the final copy)
- [ ] All links resolve in prod: `/`, `/edit`, `/about`
- [ ] Service Desk briefed (KB Article 4) and staffed for the launch window
- [ ] No claims that overstate scope (e.g. "every WCM person" — doctoral students and non-eligible staff are not profiled at launch, per #536)

## Open questions before sending

1. Does Communications want a separate **external / press** announcement (news post, social)? If so, Comms owns it — not the Scholars project lead. *(Open in #506 D5 / #535.)*
2. Confirm the bulletin cadence and the exact publish date relative to the domain flip.
