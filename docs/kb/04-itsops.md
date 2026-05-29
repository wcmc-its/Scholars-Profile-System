# SOP: Categorizing, routing, and first-line response for Scholars tickets

**Audience:** ITSOPS / Service Desk agents (Tier 1 & Tier 2).
**ServiceNow template:** SOP · **Visibility:** Service Desk.
**Behavior described as of:** `v1.0` (launch).

> **Must be in place before the Scholars → ServiceNow intake integration (#519 / #520) goes live** — this is the routing script for tickets that arrive both from the in-app form and from users emailing/calling the desk.

---

## The one rule that prevents misrouted tickets

Scholars **shows** a profile assembled from other systems; it is **not** where most data is edited. So before routing, ask: *is this something the user fixes themselves, something the owning office fixes at the source, or a Scholars-team item?* Most "my profile is wrong" tickets are **source-data** issues that belong to another office — Scholars just displays the result.

The authoritative who-gets-what mapping is [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md). Use it as the lookup; the tree below is the fast path.

## Routing decision tree

1. **"How do I…" / "where is…" question** (how to hide a paper, edit my overview, request a URL, why don't I see X)?
   → **Answer from KB Article 1** and **close, linking Article 1**. No reassignment. (This is the largest, most deflectable category.)

2. **Self-service fix** — name, email, photo (Web Directory), ORCID (ReCiter), or "this publication isn't mine / one is missing" (Publication Manager)?
   → Point the user to the owning tool (per Article 1) and **close-and-link**. Scholars can't change these and neither can you.

3. **Source-data correction** — wrong/missing title, department, appointment, degree, education, funding, or publication metadata?
   → These normally **self-route** from the in-app *Request a change* form. If one arrives as a generic desk ticket, **reassign** to the matrix's assignment group:
   - Title / dept / appointment / publication metadata → **ASMS / Directory** (`support@med.cornell.edu`)
   - Degrees / education → **Faculty Affairs** (`facultyaffairs@med.cornell.edu`)
   - Funding → **Sponsored Research Admin** (`osra-operations@med.cornell.edu`)
   - Do **not** "fix it in Scholars" — there's nothing to fix there; the copy refreshes from the source.

4. **Scholars-team item** — topic / Impact / synopsis looks wrong (ReciterAI), center membership, "two profiles for one person" (duplicate/identity), or "the page is broken / shows an error"?
   → Reassign to the **Scholars team** (`scholars@weill.cornell.edu`).

5. **New-source fields not yet assigned** — graduate appointment / student mentor-mentee (Jenzabar), postdoc mentee (HR), hospital position (NYP), disclosures (COI)?
   → **Routing TBD** — see matrix §3.3. Until the owning office is named, assign to the **Scholars team** with a "needs routing" note; never guess a queue or drop it.

6. **Login / access / provisioning** ("I can't sign in", "I have no profile and should")?
   → Standard ITS auth/identity flow — **not** a Scholars setting. Profiles are auto-provisioned from appointment data; a missing profile is usually an eligibility/appointment matter, not a Scholars bug.

## First-line response (BreakFix)

- **Acknowledge + categorize** using the tree above.
- **Deflect categories 1 & 2** with the KB link — these resolve without reassignment and are the bulk of volume.
- **Reassign 3 & 4** to the named group; paste the user's description into the request, don't paraphrase away the specifics (PMID, grant ID, the field in question).
- **Never** let the user pick the destination queue — category determines routing (a recipient-tampering guard carried from the in-app form).

## Escalation contacts

- **Scholars team:** `scholars@weill.cornell.edu` — product/display bugs, ReciterAI fields, identity/duplicate, "can't find an answer".
- **Superuser on-call:** staffed for the first 72 hours of each launch wave (see the outreach plan) — for urgent triage, slug-queue, or takedown questions.
- **Source offices:** as in the matrix (Directory/ASMS, Faculty Affairs, OSRA).

## When to close-and-link vs. reassign

- **Close-and-link to Article 1** when the answer is informational or self-service (tree 1 & 2). Most tickets.
- **Reassign** when a source office or the Scholars team must act (tree 3, 4, 5).
- **Escalate to ITS auth** for login/provisioning (tree 6).
