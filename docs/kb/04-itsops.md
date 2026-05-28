# KB Article 4 — ITSOPS / Service Desk

**Audience:** WCM Service Desk agents (Tier 1 + Tier 2) who receive Scholars-related tickets
**ServiceNow template:** SOP
**Working title:** *Categorizing, routing, and first-line response for Scholars Profile System tickets*
**Owner:** Service Desk knowledge management
**Visibility:** Service Desk agents + Scholars superusers + ITSOPS. Not general WCM.
**Review cadence:** Every release tag; the routing table changes whenever a downstream system's intake address changes.

---

## Variables to fill in before publishing

- `{{LAUNCH_DATE}}` — public launch date.
- `{{ONCALL_CHANNEL}}` — Microsoft Teams channel for Scholars on-call.
- `{{STATUS_PAGE_URL}}` — Scholars status page (or whichever surface the team uses to expose deploy / ETL state).
- `{{ASSIGNMENT_GROUP_NAMES}}` — fill from the #514 routing matrix once locked. Until then, the table below uses descriptive names — replace with ServiceNow assignment-group identifiers before publishing.

---

## What this article is for

This is the first-line SOP for any ticket whose subject involves Scholars (`scholars.weill.cornell.edu`). It does two things:

1. **Routing decision tree.** Who handles what.
2. **First-line BreakFix.** What to do when a user reports the site is down, slow, or showing stale data, before escalating.

Most Scholars-related tickets can be deflected to the user's own self-service flow (`scholars.weill.cornell.edu/edit`). When in doubt, send the user to `/edit` first. Only when they cannot do it themselves, or when the underlying record needs to change in an upstream system, should the ticket be reassigned.

## When is the site public?

On **`{{LAUNCH_DATE}}`**, Scholars becomes publicly accessible. Before that date, the site is restricted to the WCM network — users off-network will fail to reach the site, and that is correct behavior. After that date, anyone on the internet can reach the public surfaces; only signed-in users (CWID + SAML) reach `/edit`.

## Routing decision tree

Pick the row that matches the user's symptom; use the route in the right-hand column.

| User report | Category | Route to | Notes |
|---|---|---|---|
| Can't sign in to `/edit` | Access | ITS Identity | Likely SAML or CWID directory issue. If their CWID is `dormant`, they may be a former employee; verify with HR. |
| Page is down / 500 / blank | Outage | Scholars on-call via `{{ONCALL_CHANNEL}}` | See BreakFix flow below. Do not reassign without doing the first-line checks. |
| Site is slow but loads | Outage (degraded) | Scholars on-call via `{{ONCALL_CHANNEL}}` | After verifying it's not the user's network. |
| Name is wrong (preferred name, full name, spelling) | Directory data | ED / Web Directory team | Scholars mirrors ED; the fix happens upstream. |
| Degrees / post-nominal credentials wrong (MD, PhD) | Directory data | ED / Web Directory team | Same as above. |
| Title wrong (Assistant Prof, Associate Prof, etc.) | Faculty appointments | Office of Faculty Affairs | OFA owns title and appointment changes. |
| Department or division wrong | Faculty appointments / Directory | OFA for faculty; ED team for staff; the trainee's program office for trainees (Office of Postdoctoral Affairs for postdocs, GME for clinical fellows, the Weill Cornell Graduate School for doctoral students) | Three different routes — confirm role category before reassigning. The program office updates the trainee's record; ED follows; Scholars follows. |
| Photo wrong, missing, or outdated | Identity | WCM ID office | Photos come from the ID system. |
| Missing publication ("This paper should be on my profile") | Publications | Library / ReCiter team | The library evaluates whether ReCiter dropped it; if so, force-accept upstream. |
| Wrong publication on profile ("This isn't mine") | Self-service | User hides via `/edit` → Publications → Hide | Don't reassign — close-and-link to KB Article 1. |
| Retracted paper visible | Bug | Scholars project / library | Retractions are supposed to be auto-filtered (#63). If one is showing, it's a bug. |
| Mentoring relationship wrong (missing mentee, wrong mentor) | Records | Registrar (`registrar@med.cornell.edu`) | Training-program records owned by the Registrar. |
| Grant data wrong (amount, dates, NIH number, missing grant) | Records | Institutional grants → OSRA; federal grants → NIH RePORTER | Scholars displays both; corrections route to whichever is the source of the wrong value. |
| Want a custom URL / vanity slug | Self-service | User requests via `/edit` → Profile URL → "Request a custom URL" | Goes to the Scholars superuser queue automatically; don't route manually. |
| Want to hide entire profile | Self-service | User hides via `/edit` → Profile visibility → "Hide my profile" | This is a self-service toggle. Only escalate to a superuser if the user reports the toggle isn't working. |
| Want to be removed from Scholars *and* other WCM systems | Mixed | Self-service for Scholars; route separately for each other system | "Hide my profile" in Scholars does not propagate. They have to contact each system. |
| Privacy concern (safety issue, name change in progress) | Escalation | Scholars project lead via the on-call channel | Do not handle as a routine ticket. |
| Want to add a publication that isn't theirs to be on their profile | Records | Library / ReCiter team | Edge case — happens with corrections, books, retracted-and-restored papers. Library evaluates. |
| FAQ-shaped question already answered in KB Article 1 | Self-service | Close-and-link to Article 1 | The most common close. |

If a user's report doesn't match a row above, route to the Scholars project lead with a short summary; we'll either categorize it or add a row here.

## BreakFix first-line response (site down / slow / stale)

When a user reports the site itself is broken, before reassigning to Scholars on-call:

1. **Try the site yourself.** If the public surface is reachable for you, the issue is user-specific (network, sign-in, caching). Confirm with the user where they're trying from.
2. **Check `{{STATUS_PAGE_URL}}`.** If there's an active incident, link the user to it and add their ticket as a related impact.
3. **Check the most recent prod deploy.** If a deploy happened within the last 60 minutes and the symptom is "the site changed and now X is wrong," it may be release-related. Link to the on-call channel; the on-call has the rollback runbook.
4. **Check ETL last-run.** If the symptom is "my profile is showing old / missing data," the most likely cause is an ETL that didn't run last night. Scholars refreshes nightly; a missed run shows yesterday-or-older data. Link to the on-call channel.
5. **If pre-launch:** confirm the user is on the WCM network. The site is intentionally network-restricted before `{{LAUNCH_DATE}}`. Off-network reports are not bugs.

For any of the above where the first-line check doesn't explain the symptom, reassign to Scholars on-call via `{{ONCALL_CHANNEL}}`. Include: user CWID, page URL they were on, time, exact symptom, what you checked.

## When to close-and-link vs. reassign

- **Close-and-link to Article 1** when the user's question is answered there and the action is theirs to take in `/edit`. The most common case.
- **Reassign** when the action is not theirs to take (upstream record change, superuser action, outage).
- **Never** answer a Scholars data-correction question by giving the user a direct contact at OFA / ED / OSRA / Registrar — instead, tell them to use `/edit` → "Request a change," which routes to the right office with the context attached. The exception: degree changes via Web Directory, which the user can self-serve in the directory editor.

## Service overview

- **What Scholars is**: a public-facing profile + search system showcasing WCM research, scholarship, and clinical work. Public on `scholars.weill.cornell.edu` from `{{LAUNCH_DATE}}` onward; WCM-network-restricted before then.
- **Source of truth**: Scholars is not the source of truth for most of what it displays. It mirrors ED, OFA, ReCiter, NIH RePORTER, the Registrar, HR, and others. Corrections to most fields happen upstream.
- **Owner**: WCM ITS (library + research informatics).
- **On-call**: `{{ONCALL_CHANNEL}}` (Teams, per B23). 
- **Escalation order** (per #506 Gate B): Mahender (build) → Mohammad (dev lead) → Chris (leadership) → Omar (PM, project lead).
- **Related products**: ReCiter (publication disambiguation; library), ReciterAI (topic/signal/synopsis generation; library), NIH RePORTER (federal grant data; external).

## FAQ

**Q: A user is filing a Scholars ticket but their issue is in ED / OFA / RePORTER / etc. Should I reject?**
A: No — reassign to the correct queue with a one-line comment. The user contacted you in good faith; closing the ticket is worse than routing it.

**Q: A user wants to remove their profile entirely. Do I escalate?**
A: Only if the in-app "Hide my profile" toggle isn't working. Otherwise direct them to `/edit` → Profile visibility → "Hide my profile."

**Q: A user wants to add a publication that ReCiter missed. They've already filed a "Request a change" in `/edit`. Now they're filing a Service Desk ticket too because nothing happened.**
A: ReCiter requests have their own SLA which is not instant. Check with the library on current backlog before escalating. If the user has waited more than the published SLA, reassign to the library / ReCiter team.

**Q: I see "Please try again" reported repeatedly when users try to hide things. Bug?**
A: That symptom is `scholars_audit.manual_edit_audit` INSERT grant failure (#493, fixed by #498/#499). If it's recurring on a new environment, reassign to Scholars on-call — the audit bootstrap may not have run.

**Q: The site is publicly reachable from outside WCM and shouldn't be (pre-launch).**
A: Escalate to Scholars on-call immediately. Pre-launch the site should be WCM-only.

**Q: The site is NOT publicly reachable from outside WCM and should be (post-launch).**
A: Same — escalate. Confirm the date is past `{{LAUNCH_DATE}}` and the on-call channel is aware.

## Need help?

- Anything not covered above: Scholars project lead (Omar PM).
- Out-of-hours outage: `{{ONCALL_CHANNEL}}`.
