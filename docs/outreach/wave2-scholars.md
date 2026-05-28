# Outreach — Wave 2, Scholars

**Audience:** All publicly-displayed WCM scholars at launch — full-time faculty (assistant / associate / full, including endowed and named chairs), affiliated faculty, **emeritus faculty**, postdoctoral fellows, and clinical & research fellows.

> **Pending scope decision** (see "Open questions" below): doctoral students. Treat this draft as covering everyone above; carve out doctoral students once #536 lands.

**Channels and senders** (same body text in each):
- **Full-time, affiliated, and emeritus faculty:** dean's office cascade. Service mailboxes don't reach faculty inboxes reliably at WCM; signed by the dean or a senior designee. Emeritus go through the same dean send — same body, same signature, no separate carve-out.
- **Postdocs:** Office of Postdoctoral Affairs (OPA) newsletter or direct email from the OPA director.
- **Fellows:** GME for clinical fellows; fellowship program directors for research fellows. Decentralized — multiple sub-sends with the same body.

**Send date:** Approximately two weeks before `{{LAUNCH_DATE}}`.
**Length cap:** 250 words in the email body; everything else is linked.

---

## Variables to fill in before sending

- `{{LAUNCH_DATE}}` — public launch date (set when WAF + CAB clear)
- `{{SENDER_NAME}}` — the dean, OPA director, GME representative, or program director the channel chooses
- `{{KB_ARTICLE_1_URL}}` — ServiceNow URL for KB Article 1 once it's published
- `{{PROFILE_DEEP_LINK}}` — *optional* per-recipient deep link via mail-merge (open question in #506 D5). If we do mail-merge, replace the generic site link with `scholars.weill.cornell.edu/scholars/{{slug}}`.

---

## Subject line (pick one)

- *Your Scholars profile goes public on {{LAUNCH_DATE}} — take a look*
- *Scholars launches {{LAUNCH_DATE}} — review your profile*
- *Action requested: review your Scholars profile before {{LAUNCH_DATE}}*

Recommended: the first. Specific, not alarming, signals action without demanding it.

---

## Email body

> **Subject:** Your Scholars profile goes public on {{LAUNCH_DATE}} — take a look

Dear colleagues,

On **{{LAUNCH_DATE}}**, the Scholars Profile System (`scholars.weill.cornell.edu`) becomes publicly accessible. Until then, the site is restricted to the WCM network — but on that date, your profile will be visible to anyone on the internet, including search engines.

We've already built a profile for you from the Enterprise Directory, the Office of Faculty Affairs, ReCiter, and other systems of record. Most of it should be accurate. Please take a few minutes to look it over before launch.

**What you can change yourself, in Scholars:**

- Your professional overview (free-text "About" section)
- Hide a publication, grant, appointment, or education entry from your profile
- Request a custom URL (e.g. `scholars.weill.cornell.edu/jsmith`)
- Hide your entire profile from public view, if you prefer not to appear at all

**What you can't change in Scholars** — name, title, degrees, department, photo, and your list of publications — comes from upstream systems. Scholars mirrors them; it isn't the source of truth. To correct any of those, use the **"Request a change"** button in Scholars and we'll route it to the right office.

**To review your profile:** sign in at `scholars.weill.cornell.edu/edit` with your CWID.

Full details on what is and isn't editable: {{KB_ARTICLE_1_URL}}.

If something is wrong and you need help beyond the "Request a change" form, contact the WCM Service Desk.

— {{SENDER_NAME}}

---

## Notes for whoever sends this

The body text above is the canonical version. It works for faculty, postdocs, and fellows without modification — the salutation ("Dear colleagues") and the CAN/CAN'T framing read the same regardless of role category.

- **Do not modify the can / can't framing.** The single most common Scholars ticket today is "why can't I change my title in Scholars" — that confusion is what this paragraph is designed to head off. Keep the boundary explicit.
- **Do not promise that all corrections will be resolved before launch.** Some routing destinations (OFA, ED) have their own SLAs we don't control. Scholars will reflect upstream corrections on the next overnight refresh after they're made.
- **If you want to add a school-specific or program-specific paragraph** (e.g. a contact for departmental questions inside your school; a postdoc-specific note about mentor visibility), add it between "To review your profile" and the KB article link. Keep it to two sentences.
- **Filter the emeritus list against decedent records before sending.** Emeritus distributions are particularly likely to include addresses of faculty who have passed away. Coordinate with the dean's office or department on the list before the send goes out — a "your profile goes public" notice to a deceased person's address is a meaningful pain point and worth a small amount of friction to prevent.
- **Personalization with a profile deep link** is open in #506 D5 — if you choose per-recipient mail-merge, replace the generic site link with the recipient's profile URL.

## What this message intentionally does not contain

- A list of all data sources. KB Article 1 has that. The email is for action, not reference.
- Prominent treatment of the "Hide my profile" option. It is mentioned at the bottom of the CAN list so users who need it can find it, but it is not in the subject line and not the headline. Surfacing it more aggressively would invite opt-outs from people who would otherwise engage with their profile.
- Marketing copy. This is internal-facing. Recipients resent product launches that read like product launches.
- Role-specific framing (e.g. "as a postdoctoral fellow…"). Tested both ways during drafting; the neutral "colleagues" frame is what survived. If a sending office wants to add a one-sentence role-specific opener, the body still works.

## Response handling

The first 72 hours after Wave 2 sends are the highest-volume support window. Per #506 D5, a Scholars superuser is on-call for inbound during that window, and Service Desk has KB Article 4 (the ITSOPS routing SOP). Expected inbound categories, in rough order of volume:

1. "I can't sign in" — Service Desk handles, routes to ITS Identity if needed
2. "My publication list is wrong" — direct to `/edit` (hide), or "Request a change" → library
3. "My title / department is wrong" — direct to OFA (faculty) / program office (trainees)
4. "I don't want a profile" — direct to `/edit` → "Hide my profile"; only escalate to a Scholars superuser if the user can't sign in or the toggle isn't working
5. "I want a custom URL" — direct to `/edit` → slug request
6. "My mentor / mentee relationship is wrong" *(postdoc-specific, expected volume bump)* — direct to "Request a change" → Registrar routing

If any single category exceeds the expected volume meaningfully, that's a signal we got the can / can't framing wrong somewhere — pause subsequent waves, fix the language, then resume.

## Open questions before send

1. **Doctoral students.** Pending the #536 decision on whether doctoral students are publicly displayed at launch. If hidden by default (the recommended Option B in #536), they should not receive this email — they receive a separate, shorter message explaining their visibility status (`wave3-doctoral-students.md`). If publicly displayed, they fold into this Wave 2 send with the body unchanged and a Grad School channel.
2. **Channels for fellows.** GME handles clinical fellowships; research fellows often have program-director-specific channels. The send is decentralized across multiple program coordinators. Confirm OPA / GME / Grad School each agree to relay the body without modification.
3. **Profile deep-link mail-merge** (#506 D5 open question) — applies equally across the audience but is highest-value for faculty (largest population). Decide as a single yes/no, not per-audience.
