# SOP: Managing your department, division, or center page

**Audience:** Department, division, and center Owners and Curators (unit administrators, center directors/administrators).
**ServiceNow template:** SOP · **Visibility:** All staff.
**Behavior captured:** 2026-08-01, directly from the live `/edit` console on staging (screenshots below). If a screen looks different, the UI moved again — re-confirm before treating this as current.

---

## The three tiers

- **Owner** — full curation of the unit, plus can grant/revoke **Curator** access to colleagues. Granted by a Superuser (for a department/division) or created automatically as the creator of a center (see below).
- **Curator** — full curation of the unit, no access to grant further.
- **Superuser** — everything an Owner can do, on every unit, plus the handful of structural actions in [What only a Superuser can do](#what-only-a-superuser-can-do) below.

Owner and Curator can both edit description, leadership, roster, and profile-URL requests-in-review; only **Owner** can grant or revoke access.

## Who creates what

- **Departments and coded divisions** (real LDAP N-code divisions) are created by a **Superuser** — these track the official WCM org structure and need the code pre-registered.
- **Centers and institutes** are the informal, no-code path: **any department Owner can create one directly**, no ticket or Superuser needed. The system mints the center's identifier itself.

Contact a Superuser (`scholars@weill.cornell.edu`) to get a coded division registered or a department created; use the tool below for a center.

## Create a center or institute

From **Org units** (`/edit/units`), click **Create a unit**. Choose **Center / institute**, name it, set its URL segment, and pick the parent department. It's usable immediately — no approval step.

![Create a unit form: Center/institute vs Division radio, name, URL segment, parent department, and type](images/unit-create.png)

## Edit your unit's description, website, and leadership

Open your unit from **Org units** (`/edit/units`) or go straight to `/edit/<department|division|center>/<code>`. The attribute rail covers Name, Description, Website, Leadership, Members, Access, Profile URL, Center type, and Retire unit (the last three are Superuser-only for most units — see below).

![Unit edit screen showing the Description field and the full attribute rail](images/unit-detail.png)

**Leadership** sets the director/chief, with an **Interim director** checkbox and a **Mark vacant** option if the role is unfilled:

![Leadership screen: current director shown, Mark vacant button, Interim director checkbox](images/unit-leadership.png)

## Manage your roster

**Members** lists everyone shown on the unit's public page. Search by name to **Add member**, set optional start/end dates per person, or **Remove** someone. **Export CSV** downloads the current roster. Listing someone here does **not** grant them edit access — that's a separate step (below).

![Members screen: add-member search, a roster table with start/end dates and Remove, and an Export CSV link](images/unit-roster.png)

## Grant or revoke access

**Access** (Owners only) is where you name who else can curate the unit. Search by name, choose **Curator** or **Owner**, and **Grant access**.

![Access screen: search box, Curator/Owner radio, and a Grant access button](images/unit-access.png)

## Edit a faculty member's profile on their behalf

Open a member's profile from **Profiles** (`/edit/scholars`) or directly at `/edit/scholar/<cwid>`. You'll see the same editor a scholar sees for their own profile, with a banner confirming *"You are editing [Name]'s profile as an administrator."* Your access here is limited to what a [proxy editor](./01-scholars.md#delegate-editing-to-a-proxy-editor) can do — the Overview and hiding a misattributed publication — not the scholar's other settings.

## Review core-facility publications

If your unit runs a **core facility**, `/edit/core` lists it. Open it to review publications the system suggests used your core: **Confirm** the real ones (they appear on the public core page) and **Reject** false positives. Filter by All / Acknowledged / Co-authored / LLM-flagged, or use the keyboard shortcuts shown on screen (`a` confirm, `r` reject, `u` undo).

![Core facilities queue listing all core facilities with a Review link for each](images/core-facilities-list.png)

![Core publication review screen: a paper with Confirm/Reject, a combined-likelihood score, and the signal that surfaced it](images/core-facility-review.png)

---

## What only a Superuser can do

A few things stay with Superusers even for units you own — don't spend time hunting for these, escalate instead:

| Action | Where an Owner would look | Escalate to |
|---|---|---|
| Create a **department** or a coded (LDAP) **division** | Org units → Create a unit | Superuser (`scholars@weill.cornell.edu`) |
| **Retire** a unit | Unit attribute rail → Retire unit | Superuser |
| Set a unit's **Center type** or **Profile URL** (slug) | Unit attribute rail | Superuser |
| Approve or decline a **pending profile-URL request** from one of your faculty | Queues → Profile URL requests | Superuser (today, every unit's queue is reviewed centrally) |
| Site-wide publication takedown or hiding another scholar's whole profile | — | Superuser |

## Known limitations worth knowing

- **Doctoral students are excluded from public profiles** — no `/scholars/<slug>` page, not in search/browse. Their name may still appear as plain text where a mentor lists them as a mentee or co-author.
- **Listing someone on a roster doesn't grant them anything** — roster membership and edit access (Access tab) are separate, deliberately.
- **A center's own profile-URL is Superuser-set**, same as for individual scholars — you can request one, you can't set it yourself.

## Escalation

- Anything a source office must fix (titles, degrees, funding records): use **Request a change** on the affected profile — same routing as [Article 1](./01-scholars.md#request-a-correction-to-a-wcm-sourced-field), don't hand-edit it.
- Anything in [What only a Superuser can do](#what-only-a-superuser-can-do) above, or a bug you can't resolve: `scholars@weill.cornell.edu`.
