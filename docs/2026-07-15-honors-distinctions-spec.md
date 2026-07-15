# Spec: Honors & Distinctions in SPS (HHMI Investigator and beyond)

Status: proposal / decision-first
Date: 2026-07-15
Origin: senior-researcher request — "HHMI funding is not listed; two of our faculty are HHMI Investigators."

## The finding that motivates this spec

SPS lists grants from exactly two sources, both stamped in `grant.source`:

- **InfoEd** — WCM-OSR-administered sponsored-program awards (`etl/infoed`). The primary source.
- **NIH RePORTER** — NIH federal awards for confirmed eRA-Commons profiles (`etl/reporter-grants`). A supplement.

An **HHMI Investigator appointment is neither**. HHMI directly employs the investigator and funds the lab; it is not a sponsored-program award administered by WCM's Office of Sponsored Research, so it never enters InfoEd, and it is not an NIH award, so RePORTER never carries it. The lone `HHMI` reference in the codebase (`lib/sponsor-lookup.ts`) is a display dictionary (name/URL/category) for sponsors that already appear in grant data — it cannot cause an HHMI record to appear.

Conclusion: the researcher's "HHMI funding is missing" is a **category error, not a bug**. It is missing because SPS has no surface for it. HHMI Investigator status is best understood as an **honor/distinction** (a prestigious appointment that comes with funding), not a grant.

And it is not unique: **NAS/NAM membership, endowed/named chairs, and major prizes (Lasker, Breakthrough, HHMI, etc.) are all equally invisible in SPS today.** There is no honors model, no honors section, nothing.

## The decision this spec exists to make

**Do we go acquire HHMI (and honors generally) as data, and if so, how much do we build?**

Three options, cheapest first. The recommendation is to start at Option A and only escalate on real demand.

### Option A — Use what already exists: `ProfileAppointment` (zero code)

`ProfileAppointment` (model already in `prisma/schema.prisma`, edited on `/edit`, issue #1568) is a self-asserted / curator-entered store with a free-text `title` + `organization` and `category ∈ {WCM_LEADERSHIP, EXTERNAL}`. A curator can enter today:

> title: "Investigator" · organization: "Howard Hughes Medical Institute" · category: EXTERNAL

This renders on the scholar's profile immediately, no pipeline, no schema change.

**The one hard limit:** `ProfileAppointment` is **profile-only by construction** — the center/department/division/search serializers never read it (this is deliberate: it is structurally wipe-safe and can never leak onto a third-party or aggregate page). So it satisfies *"show that a faculty member is an HHMI Investigator on their profile"* but **not** *"HHMI shows up on the department page / in search / in a roster of honors."*

Also: it is an appointment, not an honor. It sits in the profile's appointments/positions area, not a dedicated "Honors" block. For HHMI that reads acceptably; for a one-time prize (e.g. "Lasker Award, 2021") it is a semantic stretch.

Use Option A if the goal is only *"reflect these two people's HHMI status on their profiles."* It is already possible; the action item is curatorial (enter the two rows), not engineering.

### Option B — A first-class Honors & Distinctions surface (the real feature)

Build this **only if** there is stakeholder demand for honors as a *browsable / aggregate / filterable* dimension — e.g. "show all NAS members in the department," "faculty honors on the unit page," "filter search by honor." If the demand is just "put HHMI on a couple of profiles," Option B is over-building; stop at A.

Scope of Option B is specified below.

### Option C — Scheduled roster detection with an LLM, into a review queue

Worth building **only after Option B exists**, and **only if proactive detection has real value** (Comms wants to catch new awards, not wait for a curator to notice). A weekly-or-slower job pulls 2–3 authoritative rosters (HHMI, NAS, NAM), an LLM matches/classifies/filters, and candidates land in a **human-approved queue — never auto-published**. The open-web crawler variant is rejected. Full pipeline, model, and edge cases in the *Option C specification* section below.

## Recommendation

1. **Now:** Option A. Enter the two HHMI Investigator rows as `EXTERNAL` `ProfileAppointment`s (curatorial). Reply to the researcher that HHMI Investigator status is an appointment/honor, not an OSR/NIH grant, so it will not appear in the grants list by design — but it can be shown on the profile today.
2. **If leadership wants honors as a first-class, aggregate-visible dimension:** build Option B as specified below. Frame it honestly as *"add an honors surface,"* where HHMI is entry #1 — not *"go get HHMI data."*
3. **Only if proactive detection has value (Comms wants to catch new awards), and only after B ships:** add the **scoped** Option C — a scheduled LLM pass over 2–3 authoritative rosters into a human-approved review queue. Not the open-web crawler (rejected in Option C).
4. **Do not** build an HHMI-specific funding feed, and do not make HHMI appear in the grants list — that would misrepresent employment/appointment as a sponsored award.

The rest of this document specifies Options B and C.

## Option B specification — Honors & Distinctions

### Data model

New model `Honor` (proposed), `@@map("honor")`:

| Field | Type | Notes |
|---|---|---|
| `id` | String @id uuid | |
| `cwid` | String | FK → `Scholar.cwid`, `onDelete: Cascade` |
| `category` | enum `HonorCategory` | controlled — see below |
| `name` | String (VarChar 255) | the honor itself, e.g. "Investigator", "Member", "Lasker Award for Basic Medical Research" |
| `organization` | String (VarChar 255) | conferring body, e.g. "Howard Hughes Medical Institute", "National Academy of Sciences" |
| `year` | Int? | year conferred; null when ongoing/unknown |
| `endYear` | Int? | for term-limited honors (e.g. an HHMI Investigator term); null = current/lifetime |
| `showOnProfile` | Boolean @default(true) | curator can hide without deleting |
| `sortOrder` | Int @default(0) | manual ordering within category |
| `source` | String @default("CURATOR") | CURATOR \| SELF \| <feed-name>; who/what entered it |
| `enteredByCwid` | String | audit |
| `createdAt` / `updatedAt` | DateTime | |

`enum HonorCategory` (start minimal; extend only when a real honor doesn't fit):

- `ACADEMY_MEMBERSHIP` — NAS, NAM, AAAS fellow, etc.
- `INVESTIGATORSHIP` — HHMI Investigator, Pew Scholar, etc. (honor + funding)
- `NAMED_CHAIR` — endowed/named professorship
- `PRIZE` — Lasker, Breakthrough, named lectureships, society awards
- `OTHER` — free-tail; a real honor that doesn't fit is a signal to add a category, not to overload `OTHER`

Do **not** add speculative fields (citation text, monetary amount, URL) until a surface actually renders them. `year`/`endYear` are the only temporal fields because the UI below renders a year.

### Sourcing

- **Primary: curator/self entry** on `/edit`, mirroring `ProfileAppointment`'s edit card exactly (add/edit/delete/reorder, `showOnProfile` toggle, `source = SELF|CURATOR`). This is the whole ingest for v1.
- **No automated feed in v1.** If added later (Option C), each feed writes `source = "<feed-name>"` and must key on a stable identifier, never a name — and a feed row must never silently overwrite a curator row (curator edits win; see edge cases).

### UI

**Profile (required):** a new "Honors & Distinctions" section, grouped by category in the enum order above, each row `name` · `organization` · `year` (or `year–endYear`, or "since year" when `endYear` is null and `year` set). Reuse the profile section chrome; do not invent new chrome (mockup-is-the-spec: match the existing profile section styling, e.g. the grants/appointments sections).

**Aggregate visibility (the reason Option B exists over A) — explicit and opt-in per surface:**

- Unlike `ProfileAppointment`, `Honor` rows *may* surface on department/division/center pages and search — but only where a serializer explicitly reads them. Default `showOnProfile=false` semantics do **not** imply aggregate visibility; add a per-surface read deliberately, one surface at a time, so a curator's private note can't leak.
- v1 aggregate surface: **none by default.** Ship the profile section first. Add the department "Honors" rollup (and/or a search facet) as a *separate, later* increment once the profile data exists and is trusted. State this cap explicitly rather than wiring every surface at once.

### Edge cases (test table)

| Case | Expected |
|---|---|
| HHMI Investigator, ongoing | `year` set, `endYear` null → renders "since <year>" (or just org+name if year unknown) |
| Term-limited investigatorship that ended | `year`+`endYear` set → renders "year–endYear"; still shown (historical honor) |
| Curator hides a row (`showOnProfile=false`) | absent from profile AND every aggregate surface |
| Honor with no year | renders name · organization, no year fragment (no "undefined") |
| Scholar deleted | `Honor` rows cascade-deleted |
| Duplicate entry (same name+org+cwid) | UI warns on save; not a DB uniqueness constraint (a person can hold the same prize twice in different years — key includes year) |
| Feed row (future) vs existing curator row | curator `source` row is never overwritten by a feed; feed insert is skipped when a curator row with same (cwid, name, organization) exists |
| Category doesn't fit | goes to `OTHER`; a recurring `OTHER` value is a signal to add an enum member |

### Audit SQL (once populated)

```sql
-- Honors coverage by category
SELECT category, COUNT(*) AS n, COUNT(DISTINCT cwid) AS scholars
FROM honor WHERE show_on_profile = 1
GROUP BY category ORDER BY n DESC;

-- HHMI Investigators specifically
SELECT s.full_name, h.name, h.organization, h.year, h.end_year
FROM honor h JOIN scholar s ON s.cwid = h.cwid
WHERE h.organization LIKE '%Howard Hughes%'
ORDER BY s.full_name;
```

### Out of scope (Option B v1)

- The scheduled roster detection (Option C) — it is a *separate, later* increment that depends on B, not part of B v1. Manual curator/self entry is B's entire ingest.
- The open-web award crawler — rejected outright (see Option C).
- Any aggregate surface beyond the profile section (department rollup, search facet) — deliberately deferred to a follow-up increment.
- Monetary amounts, citation text, external links on honor rows.
- Migrating existing `ProfileAppointment` HHMI-style rows into `Honor` — leave them; the two models coexist (appointment = position held; honor = distinction conferred).

## Option C specification — scheduled roster detection

Build only after Option B ships and only if proactive detection is wanted (see Recommendation). Two versions of "C" exist; this section builds the tractable one and explicitly rejects the other.

### The reframe (why the LLM is the easy half)

An LLM does **not** discover awards — give it no source and it invents plausible ones straight onto a public profile. Retrieval must come from a defined source; the LLM's job is **match, classify, extract, filter**:

- normalize the award name and `organization`,
- classify into a `HonorCategory`,
- extract `year` / `endYear`,
- judge "is this senior enough to surface" (the prestige filter).

This is the same shape as the grant-recs honorific/prize filter already in the codebase (pollution 63%→0) — reuse that pattern rather than inventing one. The LLM is cheap here regardless (SPS has no sub-Sonnet model, but the honors volume is tiny, so cost is a non-issue).

### Scoped pipeline (the version to build)

Weekly-or-slower Step Functions job (reuse the CTL-technologies cadence pattern), per source:

1. **Fetch a small set of authoritative, structured rosters — not the open web.** Start with the three that publish clean member lists: **HHMI Investigators, NAS, NAM.** Each source is its own adapter; add one at a time.
2. **Candidate-match to WCM scholars by a stable identity signal, never by name string.** Name-only matching is SPS's recurring failure mode; a wrong match publishes a false honor on a *public* profile — worse than a miss. Use ReCiter-style disambiguation / a stable id, and attach a `matchConfidence` + the evidence used.
3. **LLM pass** does the match adjudication + classify + extract + prestige filter (above).
4. **Write to a review queue, never to a live `Honor` row.** Candidates land as `pending`; nothing surfaces on any profile until a human approves.
5. **Curator approves/rejects** in an `/edit` (admin) review surface; approval materializes an `Honor` row with `source = "<feed-name>"`. Rejection is remembered so the same candidate doesn't re-queue every run.

### The version to NOT build

An open-ended crawler that discovers arbitrary awards across the web (news, press releases, society pages) and auto-writes them. **Rejected:** unbounded source-maintenance (every site breaks independently), and an LLM "finding" awards from noisy text is a hallucination/false-attribution hazard on public profiles. The scoped rosters above cover the high-value population without either risk.

### Data model addition for the queue

New model `HonorCandidate` (proposed), `@@map("honor_candidate")`:

| Field | Type | Notes |
|---|---|---|
| `id` | String @id uuid | |
| `cwid` | String? | matched scholar; null when the match is unresolved (still queued for a human to attribute) |
| `sourceFeed` | String | e.g. "hhmi-roster", "nas-members" |
| `sourceRef` | String | stable id/url on the source for de-dup and re-fetch |
| `rawName` / `rawOrganization` | String | as seen on the source |
| `proposedCategory` | enum `HonorCategory` | LLM classification |
| `proposedYear` / `proposedEndYear` | Int? | LLM extraction |
| `matchConfidence` | Float | 0–1; low-confidence rows sort to the top of review |
| `matchEvidence` | String | why this cwid (the identity signals used) — auditable, not a bare score |
| `status` | enum | `pending` \| `approved` \| `rejected` |
| `reviewedByCwid` | String? | audit |
| `createdAt` / `updatedAt` | DateTime | |

De-dup key is `(sourceFeed, sourceRef)` — a candidate already `approved` or `rejected` never re-queues. No name-based uniqueness.

### Edge cases (queue-specific, additive to Option B's table)

| Case | Expected |
|---|---|
| Source lists a person with no confident WCM match | queued with `cwid=null`, `status=pending`; a human attributes or rejects — never auto-dropped, never auto-guessed |
| Same investigator re-appears next run | matched by `(sourceFeed, sourceRef)`; if already approved/rejected, skipped (no duplicate queue row) |
| Approved candidate | materializes one `Honor` row, `source="<feed>"`; candidate marked `approved` |
| A later feed run would overwrite a curator-edited `Honor` | never overwrites; curator rows win (Option B rule) |
| Run completes but the roster fetch returned 0 rows | job is **not** "healthy" — emit a `candidates_found` metric and alarm on 0, because a green Step Functions run is not evidence the step produced anything |
| LLM prestige-filter drops a real senior award | logged (dropped-candidate audit), so the filter can be tuned; never silently discarded |

### Audit SQL (queue health)

```sql
-- Review backlog by source and status
SELECT source_feed, status, COUNT(*) AS n
FROM honor_candidate GROUP BY source_feed, status ORDER BY source_feed, status;

-- Unattributed candidates awaiting a human (cwid unresolved)
SELECT source_feed, raw_name, raw_organization, match_confidence
FROM honor_candidate WHERE status = 'pending' AND cwid IS NULL
ORDER BY match_confidence ASC;
```

## Empirical confirmation still open

The data-model conclusion (HHMI can't appear as a grant) is verified against `origin/master`. Not yet confirmed empirically for the named faculty: whether each is an active WCM scholar in SPS at all (one may be primarily affiliated elsewhere), whether they carry any grants, and that nothing is HHMI-sourced. A read-only prod probe is drafted and ready (`scholar`/`grant` join, name-matched) if the empirical row-level confirmation is wanted before replying to the researcher.

## Appendix: target honors allowlist (seed)

**This is a proposed seed, not the source of truth.** WCM Faculty Affairs / the Dean's office almost certainly already maintains a distinguished-faculty-honors list (for the annual report and press). Ratify against *theirs*; the list below is a starting point to prune/extend. The allowlist is finite and slow-moving, which is the argument for curator-picks-from-a-controlled-list over open-ended LLM judgment — the Option C prestige filter should be **bounded by this allowlist**, not free to invent "senior."

"Roster ✓" = the conferring body publishes a member/recipient list, making the honor an Option C automation candidate. Others are manual entry (Option B) only. ⚠ = early-career honor; whether "senior" includes these is a WCM policy call that sets the prestige threshold.

### `ACADEMY_MEMBERSHIP` — elected, lifetime (strongest signals)

| Honor | Roster |
|---|---|
| National Academy of Sciences (NAS) | ✓ |
| National Academy of Medicine (NAM) | ✓ |
| National Academy of Engineering (NAE) — bioengineering | ✓ |
| American Academy of Arts & Sciences | ✓ |
| American Philosophical Society | ✓ |
| National Academy of Inventors — Fellow | ✓ |
| AAAS Fellow | ✓ |
| Association of American Physicians (AAP) | partial |
| American Society for Clinical Investigation (ASCI) | partial |
| Fellow of the Royal Society / foreign national academies (intl. faculty) | ✓ |

### `PRIZE` — pinnacle prizes

| Honor | Roster |
|---|---|
| Nobel Prize (Medicine, Chemistry) | ✓ |
| Lasker Award | ✓ |
| Breakthrough Prize in Life Sciences | ✓ |
| Canada Gairdner International Award | ✓ |
| MacArthur Fellowship | ✓ |
| National Medal of Science | ✓ |
| Wolf / Shaw / Kavli Prize | ✓ |
| Warren Alpert Foundation Prize | ✓ |
| Louisa Gross Horwitz Prize | ✓ |
| Gruber / Vilcek Prize · Sabin Gold Medal | partial |

### `INVESTIGATORSHIP` — honor + funding

| Honor | Roster |
|---|---|
| HHMI Investigator (the origin request) | ✓ |
| HHMI Freeman Hrabowski / Faculty Scholar | ✓ |
| Chan Zuckerberg Biohub Investigator | ✓ |
| Allen Distinguished Investigator | ✓ |
| PECASE | ✓ |
| Pew Biomedical Scholar ⚠ | ✓ |
| Searle Scholar ⚠ | ✓ |
| Sloan Research Fellowship ⚠ | ✓ |
| Packard Fellowship ⚠ | ✓ |
| Damon Runyon / Burroughs Wellcome ⚠ | ✓ |

### `NAMED_CHAIR` — endowed/named professorships

Internal to WCM; no external roster. Sourced from appointment data (ED / `ProfileAppointment`), not an Option C feed. The category exists so a curator can surface a named chair on the profile.

### Two open policy decisions

1. **Where is the "senior" line?** Academy membership + pinnacle prizes are unambiguous; the ⚠ early-career fellowships are prestigious but early. Include or exclude sets the prestige-filter threshold.
2. **Adopt WCM Faculty Affairs' existing list** as the authoritative allowlist and reconcile this seed against it before any build.
