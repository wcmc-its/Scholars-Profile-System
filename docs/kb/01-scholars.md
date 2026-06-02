# HowTo: What you can and can't change about your Scholars profile

**Audience:** Faculty, postdocs, fellows, and doctoral students at WCM.
**ServiceNow template:** HowTo · **Visibility:** All staff.
**Behavior described as of:** `v1.0` (launch). The slug-request, suppression, and overview-editing UI are still iterating — re-confirm against the live site if a screen looks different.

---

## The one thing to understand first

Scholars **does not store a profile you fill out.** It assembles your profile from systems that already hold your information — the Web Directory, faculty records, your PubMed publications, your NIH funding — and shows a copy. So:

- You **don't enter** publications, titles, or appointments. They're pulled in for you.
- You **can't fix most fields inside Scholars**, because the copy would be overwritten on the next refresh. You fix them **at the source**, and Scholars gives you the path to each source.
- What you *do* control is a small, deliberate set, below.

Two system names recur: **ReCiter** decides which publications are yours (author disambiguation). **ReciterAI** derives what a publication is about and how notable it is (topics, the Impact score, the one-line synopsis). Different systems, different jobs.

---

## View your profile

Sign in at **`scholars.weill.cornell.edu/edit`** with your WCM credentials. Your public profile is at `scholars.weill.cornell.edu/scholars/<your-url>`.

## What you can change in Scholars directly

| You can | Where | Notes |
|---|---|---|
| Edit your **overview** | `/edit` → Overview | The short narrative at the top of your profile. |
| **Hide / show** individual publications | `/edit` → Publications | Display-only and **reversible**. It removes the paper from *your profile only* — it changes nothing in PubMed or ReCiter. |
| **Hide your entire profile** | `/edit` → Visibility | One click; reversible any time. Use this if you'd rather not appear publicly at all. |
| **Get a custom profile URL** | Ask the Scholars team | A superuser can set a custom web address for you; your existing `/scholars/<url>` keeps working (it redirects). An in-app self-serve request flow is rolling out — see [Your profile URL](#your-profile-url) below. |
| **Request a change** to anything else | "Request a change" on any field | Routes to the office that owns the field (see below). |

## What you can't change here — and where it *does* get changed

These come from WCM systems of record. Fixing them in Scholars wouldn't hold; correct them at the source. Use **Request a change** on the field and Scholars routes it to the right office automatically.

| Field | System of record | How it's corrected |
|---|---|---|
| Name, email, photo | Web Directory (Enterprise Directory) | Self-service in the Web Directory. |
| Title, department, division | Enterprise Directory | Request a change → routes to the Directory / ASMS team. |
| Degrees, post-nominals, education | Faculty Affairs (ASMS) | Request a change → Faculty Affairs. |
| Appointments (titles, dates) | Faculty Affairs via the Directory | Request a change → Directory / ASMS team. |
| Funding / grants | InfoEd (federal abstracts via NIH RePORTER) | Request a change → Office of Sponsored Research Administration. |
| ORCID | ReCiter | Self-service in ReCiter. |
| Whether a publication is yours | PubMed + ReCiter | **Not by hiding** — see the FAQ. Correct attribution in Publication Manager. |

> **Don't reject a paper just because you'd rather not show it.** If a paper *is* yours but you don't want it on your profile, **hide** it (above). Only mark a paper "not mine" / reject it in Publication Manager when it genuinely isn't yours — rejecting your own work feeds a false signal back into the attribution algorithm.

---

## Your profile URL

Your public profile has a short, stable web address — `scholars.weill.cornell.edu/<your-url>` (e.g. `scholars.weill.cornell.edu/jane-smith`). The longer `/scholars/<your-url>` form works too and leads to the same page, so existing links keep working.

- **It's generated for you** from your preferred name in the Web Directory — lowercased, accents removed, spaces turned into hyphens (e.g. *Mary-Anne O'Brien* → `mary-anne-obrien`). You don't set it.
- **A number on the end** (`jane-smith-2`) just means someone already had the name-based address when your profile was created. The first profile keeps the plain form; later namesakes are numbered in creation order. It isn't a ranking.
- **It's stable.** If your preferred name changes — or an administrator gives you a custom address — the old address keeps working and redirects to the new one, so existing links and citations don't break.
- **Want a custom address?** Ask the Scholars team (use **Request a change**, or email scholars@weill.cornell.edu) and a superuser can set it for you. A self-serve flow — you propose an address, an administrator approves it — is rolling out. A few addresses are reserved because they match site sections (like `/about` or `/search`) and can't be used.

---

## FAQ appendix

**A publication is missing from my profile.**
ReCiter decides which PubMed papers are yours. A missing paper is usually an attribution gap — claim it in **Publication Manager**, not in Scholars. Note: only **PubMed-indexed** publications are ingested; books, non-indexed conference papers, and similar won't appear, and that's expected.

**The author order on a publication looks wrong.**
Author order comes from the publication's PubMed record. Scholars shows it as recorded. If PubMed itself is wrong, use **Request a change** (publication metadata) and it routes to the team that can submit a correction.

**A retracted article (or an erratum) is showing on my profile.**
Scholars works to exclude retractions and errata from display. If you see one, use **Request a change** and we'll remove it.

**My research topics look off / I want to edit them.**
Topics are derived automatically by ReciterAI from your publications — you don't hand-edit them, and they update as your publications do. The per-topic relevance number the system uses internally is never shown to you or the public. If a topic looks clearly wrong, use **Request a change** (it routes to the Scholars team).

**What is the "Impact" number on a publication?**
It's a 0–100 signal from ReciterAI reflecting how notable a *publication* is — it is **global**, the same on everyone's profile, and **not** a ranking of you relative to other authors. It's computed, not editable. Some publications don't have one yet; that's coverage, not a judgment.

**I'm a doctoral student — where's my profile?**
At launch, Scholars is a faculty-and-research-staff directory, so doctoral students don't have public profile pages and don't appear in search or browse. Your name may still appear (as plain text, not a clickable profile) where a mentor lists you as a PhD mentee or where you're a co-author. Whether trainee profiles are added later is a separate, future decision.

**My change isn't showing up.**
Edits you make in Scholars (overview, hide/show) apply right away. Source-data corrections take however long the owning office and the next data refresh need — there's no instant overwrite, by design.

---

## Get help

- Use **Request a change** in `/edit` for anything you can't fix yourself — it routes automatically.
- General questions: the public help page at `scholars.weill.cornell.edu/about`.
- If you're stuck, contact the Service Desk; they have a routing SOP for Scholars.
