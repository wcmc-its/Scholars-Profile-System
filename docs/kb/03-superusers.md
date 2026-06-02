# SOP: Operating Scholars — what superusers can do that nobody else can

**Audience:** Scholars superusers + library curators.
**ServiceNow template:** SOP · **Visibility: RESTRICTED — superuser group + ITSOPS only.** Do not publish to all staff.
**Behavior described as of:** `v1.0` (launch). Slug-request, suppression/takedown, and unit-curation UI are iterating — re-confirm against the live site.

Superuser access is granted via the WCM ED group `ITS:Library:Scholars/superuser-role` (membership = person DNs in the group's `member`). Everything below is gated on that role; ordinary scholars and unit Owners/Curators cannot do any of it.

---

## 1. Request triage

Most correction requests route themselves to the owning office through the in-app **Request a change** flow — you don't touch those. What lands in the **Scholars-team** queue (per [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md)) is the residual you *do* own:

- ReciterAI-computed fields (topic / Impact / synopsis looks wrong)
- Center membership
- Whole-profile duplicate / identity ("two profiles for one person")
- Technical / display problems
- General "can't find an answer"

For source-data items that reach you by mistake (a title, appointment, degree, funding, or publication-metadata fix), **reassign** to the matrix's assignment group rather than fixing in Scholars — the copy would be overwritten.

## 2. Profile-URL (slug) management

A scholar's profile is served at `/scholars/<slug>`. Slugs are **auto-derived** from the preferred name (lowercased, accents stripped, spaces → hyphens). When two scholars derive the same slug, the later arrival gets a numeric suffix (`jane-smith-2`) **in CWID-creation order, and the incumbent keeps the bare form** — so a `-2` is a collision marker, not a ranking. That's a common scholar question you can field directly.

**Set a slug directly — your everyday tool.** From a scholar's `/edit` → **Profile URL** card you can set a custom slug (superuser-only). On save it takes effect **immediately**: the new address resolves and the old one **301-redirects** to it automatically (both the short `/<slug>` and the longer `/scholars/<slug>` forms keep working). The override also *pins* the slug, so a later preferred-name change in the directory won't overwrite it. Slugs already in use, or reserved words (site sections like `about`, `search`, `topics`), are rejected. This is how you fulfil a vetted #160 vanity request today.

**Slug-request queue.** A scholar-facing self-serve flow — the scholar proposes a slug, you approve/decline it at **`/edit/slug-requests`** (AdminSubnav → URL requests) — exists but is **gated behind `SELF_EDIT_SLUG_REQUEST` and off at launch.** Until it's enabled, custom-URL requests reach you through the Scholars team and you fulfil them with the direct override above. When the queue is on:

- Each row shows requester, current → requested slug, and the requester's optional note.
- **Approve** or **Decline…**. A decline **requires a note** — the requester sees it.
- **Collisions and reserved words are hard-rejected by design** (Option A): the row is flagged and Approve is disabled. There is no swap/transfer in v1 — decline it and tell the requester to choose another. This guards against identity bleed (one person's URL silently pointing at another).
- After you decide, the row leaves the queue and the requester is notified.

## 3. Unit-admin grants and revocations (#540)

Three tiers: **Superuser** (you) → **Owner** (a department/division/center admin: curate + grant Curators) → **Curator** (curate only, no further grants).

- Pre-create **Owner** grants per unit before that unit's Wave 1 outreach goes out — the center-admin and pilot-dept-admin emails name the grantee.
- Owners grant Curators themselves via "Manage access" in their edit view; you don't have to.
- **Structural hierarchy** (which divisions roll up to which department) stays with you — Owners can't change it.
- Revoke a grant when an admin changes role; access is directory-dependent, so confirm the person's standing before granting.

## 4. Suppression and site-wide takedown

- **Scholars hide their own** publications and their own profile — that's self-service, not your action.
- **Site-wide publication removal** (the publication disappears across the whole site) is a **superuser** action and **requires an audit reason** — a retraction notice, compliance reference, or ticket link. Restorable, also with a reason.
- **Admin profile-hide** (hiding another scholar's whole profile) is a superuser action and **requires a reason** for the audit log. The scholar sees "hidden by a site administrator" and cannot un-hide it themselves.
- Every edit writes an audit row; the audit log is tamper-evident by design. Don't route around it.

## 5. Known data limitations (so you can answer, not escalate)

- **Doctoral students are hidden at launch** (#536): no public profile page (their `/scholars/<slug>` 404s for non-superusers — but **you** can still reach `/edit/scholar/<cwid>`), excluded from search/browse, but their name shows as plain text where a mentor lists them as a mentee or as a co-author.
- **Dormant / soft-deleted scholars** surface for superusers — a soft-deleted CWID 404s for the public but you can open it via `/edit/scholar/<cwid>`.
- **Empty author position = middle author** — expected, not a bug; first/last rollups use the recorded position, not a derived rank.
- **The per-topic relevance score is internal** — never surfaced to users; don't promise to "show the match score."
- **Synopsis coverage is sparse** (a small fraction of the corpus) — a missing one-line synopsis is coverage, not breakage.
- **MeSH check-tags** (Humans, Male, Female, Adult, …) are filtered upstream by design — they're absent from topics on purpose.
- **Impact is global, publication-level, 0–100, not author-relative** — the same publication shows the same Impact on every profile.

---

## Escalation

- Code / data-pipeline bugs you can't resolve: the Scholars team (`scholars@weill.cornell.edu`) / engineering.
- Anything requiring a source-system change: route via the matrix, don't hand-edit.
- Access / provisioning: standard ITS auth — it's structural, not a Scholars setting.
