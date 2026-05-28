# KB Article 2 — Department Administrators

**Audience:** Deans' offices, department chairs, division chiefs, center directors, and the designated administrators granted Owner or Curator roles on a unit
**ServiceNow template:** SOP
**Working title:** *What you can and can't change about your department, division, or center page in Scholars*
**Owner:** Scholars project / library curation group
**Visibility:** Restricted to identified dept-admin distribution + Scholars superusers + ITSOPS (not general WCM, because the curation UI is not visible to everyone)
**Review cadence:** Every 6 months; verify `{{LAUNCH_DATE}}` references and that the 3-tier RBAC model (#358) matches what shipped.

---

## Variables to fill in before publishing

- `{{LAUNCH_DATE}}` — public launch date.
- `{{OFA_CONTACT}}` — Office of Faculty Affairs intake.
- `{{CURATION_REQUEST_FORM}}` — the ServiceNow form or email to request a new informal subunit + initial Owner grant. Confirm with the Scholars project lead.

---

## What this article covers

Your department, division, or center has a page on Scholars (e.g. `scholars.weill.cornell.edu/departments/medicine`, `/divisions/cardiology`, `/centers/some-center`). Most of what appears on that page is derived from underlying systems of record — appointments come from OFA, scholar membership comes from the Enterprise Directory (ED), publications come from ReCiter, and so on. A curation layer sits on top: you can promote certain items, suppress others, and create informal subunits, **but you cannot rewrite the underlying data from Scholars**.

This article is the SOP for the curation layer: what you can do, in which role, and what you have to route elsewhere.

## When does my unit page become public?

On **`{{LAUNCH_DATE}}`**, Scholars becomes publicly accessible. Before that date, the site is restricted to the WCM network; after that date, your unit page is visible to anyone on the internet.

Curation changes you make take effect immediately on the live page after launch. Before launch, you can preview your work on the WCM-network-restricted staging environment.

## The three roles

| Role | Granted by | Scope |
|---|---|---|
| **Superuser** | Scholars project lead (library group `ITS:Library:Scholars/superuser-role`) | Org-wide. Can do everything in this article plus what's in KB Article 3. |
| **Owner** | Superuser, or another Owner of the same subtree | Within one unit's subtree (the unit + all its child units). Can manage curation **and** grant Owner or Curator access to others on the same subtree. |
| **Curator** | Superuser, or an Owner of the subtree | Within one unit's subtree. Can manage curation. Cannot grant roles. Cannot create informal subunits. |

A Department Chair is typically granted Owner on their department's subtree; a division administrator is typically granted Curator on their division. Hand off Owner status when you leave a role — Scholars superusers will not assume that for you.

---

## What you CAN change in Scholars (Owner or Curator)

| What | How | Notes |
|---|---|---|
| Promote a publication to your unit's Highlights | Unit page → "Manage highlights" → pick from the curated pool | Promoted publications surface on the unit page above the algorithmic feed. |
| Promote a scholar to your unit's Featured Scholars | Unit page → "Manage featured scholars" → select | Featured scholars render on the unit landing area; ordering you choose is honored. |
| Promote a topic to your unit's Topic Highlights | Unit page → "Manage topic highlights" → select | Same model: editorial spotlight over algorithmic. |
| Reorder any of the above | Drag-and-drop in the manage view | Order persists. |
| Suppress an item from the unit page | Item row → "Hide on this unit page" | Affects unit page display only. The scholar's profile, the publication, etc. are not affected elsewhere. |
| Adjust the unit page's "About" text | Unit page → "Edit about" | Plain text. Goes live immediately. |

## What ONLY Owners can do (not Curators)

| What | How | Notes |
|---|---|---|
| Grant Owner or Curator access to another person | Unit page → "Manage access" → "Grant access" | You can only grant within your subtree; ED-resolved person picker (any WCM staff, not just scholars). |
| Revoke Owner or Curator access | Unit page → "Manage access" → "Revoke" on the row | Single-row revoke; no cascade. The revoked person loses access immediately. |
| Create an informal subunit | Unit page → "Create subunit" | For informal groupings — centers, programs, working groups, labs — that don't have a formal CSID in ED. You name it, attach the relevant scholars, and a Scholars page is created in your subtree. You are the initial Owner. |
| Manage membership of an informal subunit | Subunit page → "Manage members" | Informal subunits are scholar-list-based; formal subunits come from ED and are not member-editable here. |

## What you CANNOT change in Scholars

These are structural or upstream and need a different route.

| Field / change | Source of record | How to update |
|---|---|---|
| The canonical name of your unit | Enterprise Directory (Web Directory) | Update via the Web Directory editor or work with WCM ITS HR. Scholars reflects the change on the next overnight refresh. |
| The formal parent-child hierarchy (e.g. moving a division to a different department) | Enterprise Directory | A personnel/organizational action; not a Scholars change. Coordinate with the Scholars project lead — there is a spec process for structural changes that a superuser executes after the ED record settles. |
| Faculty appointment to your unit (adding or removing a member) | Office of Faculty Affairs | Contact OFA at `{{OFA_CONTACT}}`. Once OFA updates the appointment, ED follows, and Scholars reflects the change on the next refresh. |
| Trainee membership (postdocs, fellows, doctoral students) | Office of Postdoctoral Affairs / Graduate School / GME / the Registrar | Different upstream system per role category. Contact the appropriate office; Scholars does not own the roster. |
| An individual scholar's profile content (overview, photo, etc.) | The scholar themselves (or the relevant upstream system) | Scholars own their own profiles via `/edit`. Department admins cannot override another person's profile. If a scholar's profile is causing a problem on your unit page, contact the scholar; if there's a content-policy issue, escalate to a Scholars superuser. |
| Citation counts, impact scores, topic assignments | Derived algorithmically | Not editable. The `/docs` page explains the methodology. |
| Custom URLs (slugs) for individual scholars | Scholars self-service + superuser approval | Scholars request their own slugs via `/edit`. Department admins do not approve these. |

## When to route to a superuser vs. handle it yourself

- **You want to change who has Owner access in your subtree** → you can do it yourself (if you're an Owner).
- **You want to give someone Owner access outside your subtree** → superuser.
- **You want to change the formal hierarchy of your unit** → superuser, after the ED record is updated.
- **You want to suppress a scholar from your unit page who shouldn't appear at all on Scholars** → that's not a unit-page concern; tell the scholar about the `/edit` "Hide my profile" option, or escalate to a superuser if there's a policy issue.
- **A grant or publication on your unit page is clearly wrong** → suppress it on your unit page; in parallel, file a "Request a change" so the underlying data gets fixed.

## FAQ

**Q: I'm a department chair and I want my COO to manage curation. How?**
A: Grant your COO Owner (if they need to also grant access to others) or Curator (if curation is enough). Both roles can manage highlights; only Owner can re-grant.

**Q: What if my entire division is renamed?**
A: That's an ED change. Work with WCM ITS / HR to update the directory record. Scholars picks up the new name on the next nightly refresh. The URL slug may or may not change depending on how the rename was handled — coordinate with a Scholars superuser if you care about URL stability.

**Q: An emeritus faculty member's appointment is still showing on our unit page. How do I remove it?**
A: Two options. (1) Suppress it on the unit page — Owner / Curator can hide the appointment row. (2) Have OFA terminate the appointment in the official record — that's the durable fix, and Scholars will follow on the next refresh.

**Q: I created an informal subunit and now I want to delete it.**
A: Contact a Scholars superuser. Informal subunit deletion is intentionally not self-service to prevent accidental loss of curation history.

**Q: One of my scholars hid their profile entirely. They still show up in our unit-page member count.**
A: A scholar's "Hide my profile" affects their *profile page*. They continue to appear in counts on unit pages because they remain an active member of the unit per ED. If a scholar wants to be removed from the unit roster, that's an ED / OFA change, not a Scholars change.

**Q: Can I see who else has Owner / Curator access to my subtree?**
A: Yes — "Manage access" lists all active grants on the subtree, with grant dates and grantor.

---

## Need help?

- **Curation issues** (something I should be able to do but can't): contact a Scholars superuser via the WCM Service Desk; reference KB Article 2.
- **A request for a new informal subunit + initial Owner grant** (you don't have access yet to a unit page): `{{CURATION_REQUEST_FORM}}`.
- **Faculty appointment changes**: OFA, not Scholars.
- **Anything else you can't categorize**: WCM Service Desk; they route via the decision tree in KB Article 4.
