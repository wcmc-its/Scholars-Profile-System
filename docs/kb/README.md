# Scholars ServiceNow KB articles

Source drafts for the ServiceNow Knowledge Base articles that support the Scholars Profile System (`scholars.weill.cornell.edu`). Tracked in **#506 Gate D3** (folded in from closed #534).

Two task-based articles, one per audience, each walking every discrete action that audience can take — with a screenshot per task, captured directly from the live UI rather than described from the spec. (Superuser-only and Service Desk material was retired from this KB pass: it added a third and fourth audience with no UI of its own to document — see the escalation sections inside each article instead.)

The **public / visitor FAQ is not in the KB** — it lives on the Scholars site itself (`/about`, linked from the footer "Help & support").

| # | File | Audience | SN template | Visibility |
|---|---|---|---|---|
| 1 | [`01-scholars.md`](./01-scholars.md) | Scholars (faculty / postdocs / fellows / doctoral students) | HowTo | All staff |
| 2 | [`02-dept-admins.md`](./02-dept-admins.md) | Department, division, and center Owners/Curators | SOP | All staff |

## Publishing checklist (#506 D3 acceptance)

- [x] Both articles pasted into ServiceNow with the template indicated — **2026-08-04**. Field-mapped HTML source + the referenced screenshots are archived at `~/Dropbox/Projects/Scholars-Profile-System/2026-08-04-servicenow-kb-articles/` (one folder per article: Short title / Meta / Introduction / Pre-requisites / Procedures, plus an `images/` folder and a `README.txt` with the paste/image-upload steps).
- [ ] Both articles reviewed by the responsible office (library/Scholars team) — separate from the paste above, not yet confirmed.
- [x] Article 1 deep-links to in-app entry points (e.g. "Request a custom URL" → the actual request flow).
- [ ] Screenshots re-captured before publish if the UI has moved since 2026-08-01/03 (see each article's "Behavior captured" line) — `docs/kb/images/`.

## Shared references

- Correction routing (who each correction type goes to): [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md) (#514) — the single source for assignment groups; **don't restate destinations in an article, link this.**
- Public help surface: `/about` (and `/about/methodology`).
- Launch-window outreach the KB supports: [`../outreach/`](../outreach/) (#506 D5).
