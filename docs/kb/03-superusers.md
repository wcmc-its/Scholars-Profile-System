# KB Article 3 — Scholars Superusers + Library Curators

**Audience:** Members of the Scholars superuser group (`ITS:Library:Scholars/superuser-role`) and ITSOPS staff who triage Scholars tickets
**ServiceNow template:** SOP
**Working title:** *Operating Scholars — what superusers can do that nobody else can*
**Owner:** Scholars project / library curation group
**Visibility:** Restricted to the superuser group + ITSOPS. Not visible to general WCM. The article documents operational shortcuts that should not be advertised.
**Review cadence:** Every 6 months; verify on every release tag (`vN.N.N`) that the documented commands, routes, and SLAs still match production.

---

## Variables to fill in before publishing

- `{{LAUNCH_DATE}}` — public launch date.
- `{{ONCALL_CHANNEL}}` — Microsoft Teams channel for Scholars on-call (per B23). Confirm before publishing.
- `{{LIBRARY_REQUEST_EMAIL}}` — the address for the library / ReCiter team.
- `{{ASSIGNMENT_GROUP_NAMES}}` — the canonical ServiceNow assignment-group names for ED, OFA, OSRA, ReCiter, ID office, Registrar. Pull from #514 once that issue's matrix locks.

---

## What superusers can do that nobody else can

This is the privileged-access surface. Use it sparingly; every action lands in the audit log (`scholars_audit.manual_edit_audit`, #102 tamper-evidence). If you can route a request to the user's own `/edit` instead of taking the action yourself, do that — it keeps audit provenance honest.

### 1. Edit any scholar's profile, including dormant CWIDs

- Route: `/edit/scholar/<cwid>` (note the `/scholar/<cwid>` path — distinct from the user-facing `/edit`, which is bound to the signed-in CWID).
- Works for any scholar in the DB, including dormant CWIDs (soft-deleted, retired, or hidden). Use to investigate "I can't find my profile" reports and to make in-place corrections in narrow circumstances (e.g. a scholar is travelling without WCM access and needs a single field cleared before a press appearance).
- Every action you take on someone else's profile is audited with `actor_cwid != target_cwid`.

### 2. Edit any publication

- Route: `/edit/publication/<pmid>`.
- Use to suppress a publication for everyone (rare — usually each affected scholar should hide it on their own profile via `/edit`). Reserved for retraction-policy edge cases, privacy escalations, and library-data-quality corrections that don't yet have ETL fixes.

### 3. Approve or decline slug requests

- Route: `/edit/slug-requests`.
- Queue of pending slug requests from scholars (vanity URLs). For each: review the requested slug, check the collision policy, check the reserved-word denylist, and approve or decline with a reason.
- The collision policy is hard-reject (Option A from #497): if the requested slug collides with an existing scholar's slug, the request must be declined. Do not swap slugs; the durable identity-bleed guard depends on it.
- Reserved-word denylist lives in code (see `lib/slug-policy.ts` or the route handler). If a user is requesting a word you think should be denied but isn't, add it to the denylist via the standard PR process, then re-evaluate the request.
- The user gets a decision in-app, including the reason for declines.

### 4. Grant or revoke Owner / Curator roles, anywhere in the org

- Route: any unit page → "Manage access" (you'll see this menu on every unit, not just your subtree).
- Owners can grant within their subtree (KB Article 2). Superusers can grant anywhere, useful for initializing a new subtree's first Owner.
- Be deliberate: an Owner grant transfers significant authority. Confirm via ServiceNow or email before granting.

### 5. Restore suppressed items + scholars

- A scholar's "Hide my profile" sets `Scholar.status = 'suppressed'`. To restore, edit the scholar via `/edit/scholar/<cwid>` and toggle status back to active. (You can also do this directly in the DB in an emergency, but the in-app route preserves audit.)
- Row-level suppressions (publications, grants, appointments, education) can be restored via `/edit/scholar/<cwid>` → switch to the "Hidden" view → "Show" on each row.
- Restoration, like any superuser action on another person's profile, is audited; the prior suppression remains visible in the audit log.

### 6. Clear individual fields

- Some fields can be cleared rather than rewritten (e.g. clear a wrong override that was set incorrectly and let the ETL re-derive from upstream).
- Route: `/edit/scholar/<cwid>` → field → "Clear override."
- This is the safest correction path when you don't know the right value but you know the current value is wrong: clear, wait for the next ETL refresh, see what upstream says.

### 7. Triage "Request a change" tickets that reach the ServiceNow queue

See "Request a change" triage SOP below. KB Article 4 documents the ITSOPS first-line routing decision tree; this article is what you do once a ticket has been categorized as Scholars-superuser-handled.

### 8. Modify the org's structural hierarchy via spec process

- In-app: not editable. Structural hierarchy changes are a code-level change (migration + ETL update), executed by a superuser after the ED record settles.
- Route: file a follow-up PR on the repo with the schema/ETL change. Confirm with the Scholars project lead before merging.

## What even superusers cannot do

| Limitation | Why | Workaround |
|---|---|---|
| Bypass upstream source-of-record systems (name, title, dept, photo, appointment) | Scholars mirrors, doesn't own. Editing in Scholars would be wiped on the next ETL refresh. | Route the user to the upstream office (KB Article 4 decision tree). |
| Resurrect a CWID that ED has marked deleted or retired | The ED row is gone; Scholars' soft-delete is downstream of that. | Contact WCM ITS HR or Identity. Scholars will follow once ED has a row again. |
| Modify someone else's audit history | Audit is tamper-evident (#102). | Append a corrective audit entry; never overwrite. |
| Add publications ReCiter didn't pull | Out of scope — ReCiter is the source. | File a ticket to `{{LIBRARY_REQUEST_EMAIL}}` so library staff can force-accept it in ReCiter; Scholars will pull it on the next refresh. |
| Override the WAF / network gate or change who can sign in | Network policy is on the edge stack, not the app. | Coordinate with the deploy / ops side per #506 Gate A. |
| Make Scholars stop showing someone in another product (ReCiterDB exports, departmental rosters, citation analytics) | Those are downstream consumers of the same upstream data. Scholars' suppression flag does not propagate. | Tell the scholar to contact the other system's owner directly. |

---

## "Request a change" triage SOP

User-filed "Request a change" tickets land in ServiceNow with a category. Server-side routing assigns the right assignment group based on category (per #519). Tickets that route to the Scholars superuser group land in your queue.

Triage steps:

1. **Read the ticket.** Confirm the category was assigned correctly. Categories that should NOT land with you: name / title / degrees (route to ED/Web Directory or OFA), appointments (OFA), photo (WCM ID office), grant data (OSRA or NIH), mentoring relationships (Registrar at `registrar@med.cornell.edu`). If a ticket landed here but the category should have been one of those, reassign with a one-line comment.
2. **Verify identity.** The ticket carries the submitter's CWID (from the authenticated session). The submitter should match the subject of the change — or be a documented authorized representative (e.g. a department admin acting for a scholar with their written request attached).
3. **Decide route:** self-service / handle / escalate.
   - *Self-service*: the user could have done this in `/edit`. Reply with the direct path; do not handle it for them.
   - *Handle*: take the in-app action via `/edit/scholar/<cwid>` or `/edit/publication/<pmid>`. Note the ticket number in the reason field.
   - *Escalate*: privacy/safety/legal issues, name-change-in-progress, anything ambiguous → loop in the Scholars project lead before acting.
4. **Close with a note.** Reference the action taken and the audit-log row id if relevant.

## Slug-request queue SOP

`/edit/slug-requests` shows pending requests with: requested slug, requester CWID, current slug, request date.

For each:
- **Reserved-word collision** (slug is on the denylist) → decline with reason "reserved word."
- **Existing-slug collision** (another scholar already owns this slug) → decline with reason "slug taken." Hard-reject per #497 Option A.
- **Identity-bleed guard** (the slug previously belonged to a different scholar) → decline with reason "previously held by another scholar." The guard is durable; even if the previous holder no longer has the slug, it cannot be reassigned to someone else.
- **Looks fine** → approve. The slug propagates to the user's profile URL immediately; the user gets in-app notification.

If the queue has been quiet for a week, sanity-check that the route is loading correctly — the queue silently stops surfacing items if the alias-rewrite migration is in a weird state.

## Unit-admin grant SOP

When a department wants to onboard their first Owner:

1. Confirm authorization via the Scholars project lead. Owner is a meaningful grant — don't process unsolicited.
2. Navigate to the unit's page → "Manage access" → "Grant access" → pick role (Owner or Curator) → person picker.
3. The person picker queries ED for any WCM staff member by name or CWID. Owners do not have to be Scholars themselves (i.e. doctoral students excluded from public display can still be department admins if their role calls for it).
4. The grantee gets immediate access on next sign-in.
5. Confirm by email to the requester.

## Known data quirks (don't be surprised by these)

| Quirk | Why | What to tell users |
|---|---|---|
| MeSH check-tags (Humans, Adult, Male, Female, etc.) absent from the publication keyword index | ReciterDB filters them upstream — they didn't help author disambiguation. | "Scholars uses content descriptors, not demographic tags. This is intentional." See #292. |
| ReciterAI synopses cover ~3.4% of corpus, way too sparse for snippets | The synopsis ETL is gated; we revisit at ~70%+ coverage. | Don't promise snippet quality based on synopses. |
| Doctoral students hidden from public display by default | Privacy + product-fit decision at launch (#536). | If a doctoral student needs visibility (e.g. they're co-authoring with a PI and want a profile), escalate to project lead — there is no in-app override. |
| Retraction notices + retracted academic articles are auto-filtered (#63) | Both `publicationType IN (Retraction, Erratum)` and articles with `RetractionIn` upstream references are dropped from every read path. | A retracted paper that's still visible is a bug, not a curation decision. File a ticket. |
| "Pre-existing scholars keep their bare slug" (slug policy) | Identity-stability anti-bleed guard. | A new scholar whose preferred name collides with an existing slug must take `-2`, `-3`, etc.; the bare slug is durable. |
| Scholars on `/edit/scholar/<cwid>` for a dormant CWID renders | Superuser-only — surfaces dormant rows. | Don't share this URL with users; they hit a "Not found" on the public route. |
| `/edit` "Hide" / "Show" returns "Please try again" | `scholars_audit.manual_edit_audit` INSERT grant missing (#493). | Verify the DB role has INSERT on that table. Fixed via the bootstrap path #498/#499; re-run if a fresh env hit this. |
| Publication-report data still includes hidden scholars | Suppression is SPS-local — ReCiterDB, departmental rosters, citation analytics draw from the same upstream, not from SPS. | Tell users their "Hide my profile" affects Scholars only. Other systems need their own opt-out. |

## Escalation

- **Production outage**: post in `{{ONCALL_CHANNEL}}` (Teams). On-call rotation maintained per B23.
- **Privacy or safety**: page the Scholars project lead immediately. Do not handle alone.
- **Cross-system data discrepancy** (Scholars says one thing, ED/OFA says another): file a ticket against the source-of-record system; Scholars will follow on the next ETL refresh.

## Need help?

- Anything not covered here: Scholars project lead (Omar PM per #506).
- Architectural / "is this even possible" questions: dev team (Mahender, Sumanth, Mohammad — escalation order matches #506 Gate B).
