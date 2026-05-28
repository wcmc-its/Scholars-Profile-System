# KB Article 1 — Scholars

**Audience:** Faculty, postdocs, fellows, doctoral students
**ServiceNow template:** HowTo
**Working title:** *What you can and can't change about your Scholars profile*
**Owner:** Scholars project / library curation group
**Visibility:** All WCM
**Review cadence:** Every 6 months; check for `{{LAUNCH_DATE}}` references, `vN.N.N` pins on the iterating UI sections (slug-request, suppression), and any office-routing changes.

---

## Variables to fill in before publishing

- `{{LAUNCH_DATE}}` — the date Scholars becomes publicly accessible at `scholars.weill.cornell.edu`. Set when WAF (#502) and CAB (Gate E in #506) clear.
- `{{LIBRARY_REQUEST_EMAIL}}` — the address Service Desk routes ReCiter / publication corrections to. Confirm with library.
- `{{OFA_CONTACT}}` — Office of Faculty Affairs intake (email or ServiceNow form name). Confirm with OFA.

---

## What Scholars is

The Scholars Profile System (`scholars.weill.cornell.edu`) is a public-facing site showcasing the research, scholarship, and clinical work of WCM faculty, postdocs, fellows, and doctoral students. Most of what appears on your profile is pulled automatically from systems you already use — the Enterprise Directory (ED), the Office of Faculty Affairs, ReCiter (the publication-disambiguation system), HR, and others. Scholars itself does not store the canonical version of most fields; it mirrors them.

**This article explains where the boundary is** — what you can change yourself in Scholars, and what you need to change elsewhere (and how to get there).

## When does my profile become public?

**On `{{LAUNCH_DATE}}`, Scholars becomes publicly accessible** at `scholars.weill.cornell.edu`. Before that date, the site is restricted to the WCM network. After that date, anyone on the internet — including search engines — can view profiles.

If you want to review or adjust your profile before it becomes public, do so before `{{LAUNCH_DATE}}`. You can still make changes after launch; they just take effect on a live page.

---

## What you CAN change yourself in Scholars

Sign in at `scholars.weill.cornell.edu/edit` with your CWID. You can:

| What | How | Notes |
|---|---|---|
| Your professional overview (the free-text "About" section) | `/edit` → Overview panel | Plain text. Becomes visible on your profile immediately. |
| Hide a publication from your profile | `/edit` → Publications → "Hide" on the row | Hides on your Scholars page only. Does not remove it from PubMed or from ReCiter. |
| Hide a grant from your profile | `/edit` → Funding → "Hide" on the row | Hides only the row keyed to you (the grant continues to appear on co-investigators' profiles unless they also hide it). |
| Hide an appointment or education entry from your profile | `/edit` → Appointments / Education → "Hide" on the row | One restriction: your primary chair appointment cannot be hidden — it is required to render a coherent profile. |
| Restore an item you previously hid | `/edit` → switch to "Hidden" view → "Show" | Reversible at any time. |
| Request a custom URL (vanity slug) | `/edit` → Profile URL → "Request a custom URL" | Reviewed by Scholars superusers. Some requests are declined automatically (reserved words, collisions with an existing scholar's slug). You will receive a decision in-app. |
| Request a correction to anything else | `/edit` → "Request a change" button on any field | This is how everything in the next section gets fixed. |
| Hide your entire profile from public view | `/edit` → Profile visibility → "Hide my profile" | Your profile becomes invisible on Scholars — it won't appear in search, won't be browseable, and direct links return "Not found." You can restore it at any time from the same place. **This affects Scholars only**: you continue to appear in publication reports, departmental rosters, citation analytics, and other institutional data systems that draw from the same upstream records. See the FAQ for details. |

## What you CANNOT change in Scholars (and where you change it instead)

Scholars mirrors these fields from their source-of-record system. Editing them in Scholars is not possible because Scholars is not the source of truth.

| Field | Source of record | How to update |
|---|---|---|
| Name, preferred name | Enterprise Directory (Web Directory) | WCM Web Directory editor (the directory UI you may know from the maroon clinical profile editor). If you are a faculty member who does not see your name reflected correctly on the directory, contact your department coordinator or HR. |
| Degrees, post-nominal credentials (MD, PhD, etc.) | Enterprise Directory | Same as above — update via the Web Directory editor or HR. Scholars will pick up the change on the next overnight refresh. |
| Title (Assistant Professor, Associate Professor, etc.) | Office of Faculty Affairs | Contact OFA at `{{OFA_CONTACT}}`. |
| Primary department, division, or center | Office of Faculty Affairs / Enterprise Directory | Title-and-appointment changes are an OFA process; departmental moves are a personnel action. Do not file these through Scholars. |
| Photo | HR / WCM ID office | Replace via the WCM ID office. Scholars pulls the current photo on each refresh. |
| Publications list — add a publication ReCiter missed | ReCiter (the disambiguation engine) | Use the "Request a change" form in `/edit`, category **Publications**, and describe the missing publication (PMID, DOI, or full citation). This routes to `{{LIBRARY_REQUEST_EMAIL}}` for the library / ReCiter team to evaluate. |
| Publications list — remove a publication that isn't yours (false positive) | ReCiter | You can hide it directly in `/edit`. The library will also re-train ReCiter over time. |
| Authorship position, co-authors | Derived from PubMed metadata | If the underlying PubMed record is wrong, correct it at the publisher / NLM; otherwise, file a "Request a change." |
| Topics / research areas on your profile | Generated algorithmically by ReciterAI from your publications | Not directly editable. As your publication record evolves, topics shift automatically. If a topic looks clearly wrong, file a "Request a change" with examples and the library will review. |
| "Impact" score, citation counts | Derived from publication metadata | Not editable. See the in-app `/docs` page on what "Impact" means. |
| Funding amounts, project periods, NIH numbers | RePORTER (NIH) and institutional grants systems | Not editable in Scholars. RePORTER corrections happen with NIH. Institutional grant data corrections route through the Office of Sponsored Research Administration (OSRA) or your departmental grants administrator. |
| Education history (degrees-earned, schools attended) | Enterprise Directory | Update via Web Directory / HR. You can hide individual rows in Scholars but the underlying record is upstream. |
| Mentoring relationships (PhD mentees, postdoc mentees) | Registrar's office (training-program records) | Contact the Registrar at `registrar@med.cornell.edu` for record corrections. You can also flag a missing or misattributed mentee via "Request a change" in `/edit` and we'll route it to the Registrar on your behalf. |

## FAQ

**Q: A publication of mine is missing.**
A: Use `/edit` → "Request a change" → Publications, and include the PMID or DOI. Library staff will check whether the paper is in PubMed (a precondition), whether ReCiter scored it below the confidence threshold, and whether it needs to be force-accepted.

**Q: A publication that isn't mine is on my profile.**
A: Hide it directly in `/edit` → Publications → "Hide." This is the supported path. You don't need to file a ticket.

**Q: A retracted paper appears on my profile.**
A: Retraction notices and the underlying retracted papers are filtered from display automatically — you should not see them on your profile. If one is still showing, file a "Request a change" with the PMID and we'll correct it.

**Q: My photo is wrong / out of date.**
A: Photo replacements happen at the WCM ID office. Scholars will refresh on the next nightly pull after the ID office updates the record.

**Q: My title says "Assistant Professor" but I was promoted.**
A: Title is OFA's record. Once OFA updates the appointment, Scholars will reflect it on the next refresh.

**Q: How do I get a custom URL like `scholars.weill.cornell.edu/jsmith` instead of the numbered default?**
A: Sign in to `/edit` → Profile URL → "Request a custom URL." Requests are reviewed by Scholars superusers. There is a reserved-word list (e.g. `admin`, `about`, `search`), and you cannot take a slug another scholar already holds. You will get a decision in-app.

**Q: Can I make my profile private?**
A: Yes. Sign in at `/edit` and use "Hide my profile" to remove it from public view. Your profile won't appear in search, won't be browseable, and direct links to it will return "Not found." You can restore it at any time from the same place.

**What "hide my profile" does not do:** it does not remove you from publication reports, departmental rosters, faculty directories, citation analytics, or any other institutional data system. Those products draw from the same underlying records (ED, OFA, ReCiter, NIH RePORTER, the Registrar) and have their own visibility rules — Scholars cannot change them. If you need to be removed from another system as well, contact that system directly.

If you only want to hide a specific item — one publication, one grant — use the row-level Hide on that item instead; your profile stays visible.

**Q: How often does Scholars refresh from upstream systems?**
A: Overnight, for most data sources. Some derived signals (topics, impact) recompute on a weekly cadence. A correction you make in ED or OFA will typically appear on Scholars the next morning; a correction to a publication score may take up to a week.

**Q: I made a change in ED / OFA / HR. How do I know Scholars picked it up?**
A: Check your profile the next morning. If it still hasn't updated after 48 hours, file a "Request a change" and we'll investigate the sync.

**Q: I see something on Scholars that I think is a privacy issue.**
A: File a "Request a change" with category "Privacy" — these are triaged immediately by the Scholars team.

---

## Need help?

- For things you can change yourself: `scholars.weill.cornell.edu/edit`
- For things you can't: `scholars.weill.cornell.edu/edit` → "Request a change" on the relevant field
- For account access issues (can't sign in): contact the WCM Service Desk

Service Desk will route specific data corrections to the right office on your behalf if you contact them directly, but the in-app "Request a change" form is faster — it pre-attaches your CWID, the field, and the context.
