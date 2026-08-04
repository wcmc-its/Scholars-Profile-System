# HowTo: Manage your Scholars profile

**Audience:** Faculty, postdocs, fellows, and doctoral students at WCM.
**ServiceNow template:** HowTo · **Visibility:** All staff.
**Behavior captured:** 2026-08-01, directly from the live `/edit` console on staging (screenshots below), cross-checked 2026-08-03 against the public `/about` page and a live clinical-faculty profile for sections a non-clinical account doesn't show (clinical trials, news mentions, licensable technologies). If a screen looks different, the UI moved again — re-confirm before treating this as current.

---

## Where your profile data comes from

Scholars **does not store a profile you fill out.** It assembles your profile from systems that already hold your information — the Web Directory, faculty records, your PubMed publications, your NIH funding — and shows a copy. So:

- You **don't enter** publications, titles, or appointments. They're pulled in for you.
- You **can't fix most fields inside Scholars**, because the copy would be overwritten on the next refresh. You fix them **at the source** — every read-only field has a **Request a change** button that tells you exactly where.
- What you *do* control is a real, and growing, set of tools — this article walks through each one.

Two system names recur: **ReCiter** decides which publications are yours (author disambiguation). **ReciterAI** derives what a publication is about and how notable it is (topics, the Impact score). Different systems, different jobs.

Sign in at **`scholars.weill.cornell.edu/edit`** with your WCM credentials. Your public profile is at **`scholars.weill.cornell.edu/<your-url>`**.

![The /edit home screen — the left rail groups everything into Yours to edit, From WCM records, Tools, and Settings](images/scholar-home.png)

The left rail has four groups: **Yours to edit** (fully yours), **From WCM records** (sourced elsewhere, but you can hide items or request a fix), **Tools** (generate documents from your Scholars data), and **Settings**.

---

## Write or AI-draft your Overview

**`/edit` → Overview.** The short narrative at the top of your public profile. Type directly, or click **Draft with AI** to generate a starting draft from your publications — pick person (third/first), tone, length, and how many emphases to weave in, then edit before saving. Saves publish immediately.

![Overview editor with the Draft with AI panel expanded](images/scholar-overview.png)

## Choose your Highlights

**`/edit` → Highlights.** Highlights are the publications featured at the top of your profile. By default ReciterAI auto-picks your top first-/senior-author work by impact and recency. Flip **Choosing highlights automatically** off to hand-pick up to 3 — a manual set stays fixed and won't shift as the automatic ranking updates.

![Highlights screen with automatic selection on, one paper picked, and a manual override toggle](images/scholar-highlights.png)

## Add an Honor or Distinction

**`/edit` → Honors & Distinctions.** For academy memberships, investigatorships, and prizes — nothing WCM's feeds carry. Click **Add an honor**, fill in the award and year; these show only on your public profile.

![Honors and Distinctions list with an existing entry and an Add an honor button](images/scholar-honors.png)

## Publications: hide one, or flag it as not yours

**`/edit` → Publications.** Every paper ReCiter attributes to you, sourced from PubMed/Scopus/OpenAlex.

- **Hide** removes it from your public profile only — it doesn't touch PubMed, ReCiter, or internal reports.
- **Not mine?** tells ReCiter's attribution model it got this one wrong. Only use this for papers that genuinely aren't yours — marking your own work "not mine" feeds a false signal back into the algorithm. If a paper *is* yours but you'd rather not show it, use Hide instead.

![Publications list with Hide and "Not mine?" actions on each row](images/scholar-publications.png)

## Positions, education, and funding: hide a row, or request a source fix

**`/edit` → Positions & appointments / Education / Funding.** Each of these is **Locked — managed at its source**, with two independent controls:

- **Hide** — display-only, removes the entry from your public profile without touching the underlying record.
- **Request a change** — routes the correction to the office that owns it (see below).

Historical (past) appointments are hidden by default; a **Show on profile** button reveals one. Additional positions the directory feed doesn't carry (internal leadership roles, appointments at other institutions) can be added by hand under **Additional positions** — these show only on your public profile, never in center/department rollups or search.

![Positions & appointments screen: current appointment with Hide + Request a change, a historical appointment with Show on profile, and an Add a position form](images/scholar-appointments.png)

Funding works the same way — hide your row on a grant (it doesn't affect the award's other investigators, and can take up to a day to clear search) or request a change if the record itself is wrong.

![Funding screen showing a grant with Hide and Request a change](images/scholar-funding.png)

## Clinical research and trials

If you run or participate in clinical trials, they appear in a **Clinical research** section on your public profile — one line per trial, with your role (PI, Co-I, Sub-I), title, phase, sponsor, and current accrual status; a linked NCT number goes straight to its `clinicaltrials.gov` listing, and completed/closed trials collapse under a separate count so open studies aren't buried. This is sourced entirely from **OnCore** (WCM's clinical trial management system), refreshed nightly — not from ReCiter, so it doesn't go through publication attribution at all.

**There's no hide/edit control for this in `/edit`.** A wrong or missing trial is corrected directly at the OnCore source, not routed through Request a change. Contact your OnCore study team or research administration.

If you're WCM clinical faculty, you may also see a separate **Clinical profile →** link in your profile sidebar, pointing to `weillcornell.org` — that's the patient-facing physician directory (POPS), a different system entirely from Scholars.

## Mentees: add one, or hide a derived one

**`/edit` → Mentees.** Two independent lists:

- **Added by you** — click **Add a mentee**. CWID is optional: enter it to link their profile, show their photo, and surface papers you co-authored; leave it blank and they're listed as plain text.
- **From training records** (Jenzabar / Employee Central) — hide one to remove it from your public profile; hiding is display-only.

![The Add a mentee form: optional CWID, name, program/role, and year completed](images/scholar-mentees-add-form.png)

## News mentions: hide one, or flag it as not you

If WCM's Research news site (`research.weill.cornell.edu`) has published an article that mentions you, it can surface in a **News mentions** section on your profile — this section only appears once you have at least one. Refreshed weekly. You can **Hide** one you'd rather not show, or use **Not me** if the article was matched to the wrong person; either is display-only and reversible. A wrong article *text* itself is corrected at the news site, not in Scholars.

## Request a correction to a WCM-sourced field

Any read-only field (Name & Title, Email, Photo, degrees, ORCID, and more) carries a **Request a change** button. It opens a picker that routes you automatically — you never choose the destination:

![The Request a change dialog listing name, title, department, email, degrees, and ORCID, each routed to its owning office](images/scholar-request-a-change.png)

Full routing detail lives in [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md) — this article won't restate it since it changes independently of the UI.

> **Don't reject a paper just because you'd rather not show it.** See [Publications](#publications-hide-one-or-flag-it-as-not-yours) above.

## Control who sees your profile

**`/edit` → Visibility.** Two levels:

- **Hide my profile** — removes your whole profile from the public site and search. Your name may still appear in the WCM directory and on co-authors' pages. Reversible any time.
- **Sections** — hide individual sections (Mentoring, Education, Funding, Centers, Postdoctoral Mentor, Clinical research, Methods & Tools) while keeping the rest of your profile visible. Hidden sections stay searchable internally — nothing is deleted.

![Profile visibility screen: whole-profile hide plus seven per-section toggles](images/scholar-visibility.png)

## Delegate editing to a proxy editor

**`/edit` → Profile editors.** Authorize a specific person (searched by name in the WCM directory) to edit your overview and hide misattributed publications on your behalf — nothing else. Remove them any time. Separately, administrators of a department or division you belong to have this same limited access automatically (you can't add or remove that route here).

![Profile editors screen: an Add a proxy editor search box](images/scholar-proxy-editors.png)

## Request a personalized profile URL

**`/edit` → Profile URL.** Your public profile has a short, stable address — `scholars.weill.cornell.edu/<your-url>`, generated from your preferred name. This is now a **self-service request**, not an email/ticket: type the address you want, optionally add a note for the reviewer, and submit. A Scholars administrator reviews every request before it takes effect.

- Requests must be a variation of your own name (optionally with a middle initial or fuller form) — not a research area or other handle. Non-name-based requests are declined.
- Your older address keeps redirecting once a new one is approved, so existing links never break.

![Profile URL screen: current address, a requested-address field, and a Request this URL button](images/scholar-profile-url.png)

## Generate an NIH biosketch draft

**`/edit` → NIH biosketch** (under Tools). Pick an artifact (Contributions to Science or Personal Statement), tune the number of contributions, optionally steer emphasis and add instructions, then **Generate biosketch contributions**. It drafts from your Scholars publications, topics, methods, and grants.

**This is a starting point, not a finished submission.** The tool says so directly: *"Rewrite this in your own voice before submitting to NIH... review and rewrite every line in your own voice, and verify every claim against your work, before you copy it into a submission."*

![NIH biosketch tool: artifact picker, contribution controls, and the AI-disclosure warning](images/scholar-biosketch.png)

## Export your CV in WCM format

**`/edit` → CV (WCM format)** (under Tools). Click **Download CV (WCM format)** for a pre-filled `.docx` in the official WCM faculty CV template — every section and subsection in order, populated where Scholars has the data and left as a blank prompt where it doesn't. **This is a starting point, not a finished CV** — complete the "complete by hand" sections before using it.

![CV tool: download button plus the section-by-section outline of what's pre-filled vs. left for you](images/scholar-cv.png)

## What you still can't touch

**Conflicts of Interest** (`/edit` → Conflicts of Interest) is entirely read-only — disclosures come from the Weill Research Gateway. Use **Request a change** to correct one at its source; there's nothing to hide or edit here.

**Available technologies** — if you hold a licensable invention, it shows on your profile with a link to its public listing on `innovation.weill.cornell.edu`. Sourced weekly from the WCM Center for Technology Licensing (CTL); there's no hide/edit control here — email `enterpriseinnovation@med.cornell.edu` for a correction.

---

## FAQ appendix

**A publication is missing from my profile.**
ReCiter decides which PubMed papers are yours. A missing paper is usually an attribution gap — claim it in **Publication Manager**, not in Scholars. Only **PubMed-indexed** publications are ingested; books, non-indexed conference papers, and similar won't appear, and that's expected.

**The author order on a publication looks wrong.**
Author order comes from the publication's PubMed record. If PubMed itself is wrong, use **Request a change** on the publication.

**A retracted article (or an erratum) is showing on my profile.**
Scholars works to exclude retractions and errata. If you see one, use **Request a change** and it'll be removed.

**My research topics look off / I want to edit them.**
Topics are derived automatically by ReciterAI from your publications — you don't hand-edit them, and they update as your publications do. If one looks clearly wrong, use **Request a change**.

**What is the "Impact" number on a publication?**
A 0–100 signal from ReciterAI reflecting how notable a *publication* is — it's **global**, the same on everyone's profile, and **not** a ranking of you relative to other authors. Some publications don't have one yet; that's coverage, not a judgment.

**I'm a doctoral student — where's my profile?**
Doctoral students don't have public profile pages and don't appear in search or browse. Your name may still appear as plain text where a mentor lists you as a mentee or co-author.

**My change isn't showing up.**
Edits you make directly in Scholars (overview, highlights, hide/show, visibility) apply right away. Source-data corrections and profile-URL requests take however long the owning office/reviewer needs — there's no instant overwrite, by design.

---

## Get help

- Use **Request a change** in `/edit` for anything you can't fix yourself — it routes automatically.
- General questions: the public help page at `scholars.weill.cornell.edu/about`.
- If you're stuck, contact the Service Desk.
