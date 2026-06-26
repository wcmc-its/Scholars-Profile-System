# SPEC — Scholar → WCM CV generator (/edit Tools section)

**Status:** Draft for review (decisions locked 2026-06-26) · **Branch:** `docs/scholar-cv-generator-spec` (worktree off `origin/master` @ `bce4f527`)
**Research:** 4-agent workflow over CViche + SPS `origin/master`; POPS API probed live 2026-06-26.

---

## 1. Goal

Add a tool to the individual-scholar `/edit` **Tools** section — labelled **"CV (WCM format)"** —
that exports the scholar's structured Scholars data (enriched with POPS for clinical faculty) as a
Word `.docx` in the **WCM faculty CV format**: the same output CViche produces, but built from
clean structured data instead of parsing an arbitrary Word doc.

## 2. Locked decisions

1. **Rendering — FILL the official template `.docx`** (REVISED 2026-06-26; supersedes the original
   "reconstruct in code" decision). A from-scratch reconstruction with the `docx` lib only
   *approximated* the WCM format (paraphrased headings, wrong columns, no instruction box). CViche
   itself achieves fidelity by loading the template and editing it
   (`stage_6_word_template.py:966` `Document(template_path)`), so we do the same: bundle
   `lib/edit/assets/wcm-cv-template.docx`, parse `word/document.xml` (jszip + `@xmldom/xmldom`),
   inject data into its own tables/paragraphs, and re-zip. This inherits the template's exact
   headings, subsections, columns, fonts, and prompts. The original bolding rationale for
   "reconstruct" was wrong — run-level bold works fine when filling the template (the scholar's
   surname is still bolded in each citation). Sections without data keep the template's blank
   prompts for the scholar to complete. Updating to a future WCM template = swap the bundled file.
2. **Research summary (M1) — generate anew** each time via the existing overview/Bedrock path
   (`lib/edit/overview-generator.ts`); inherits its anti-hallucination grounding.
3. **Audience — same as biosketch:** `authorizeOverviewWrite` (self · superuser · granted proxy ·
   org-unit owner/curator).
4. **Rail label — "CV (WCM format)".**

## 3. The honest framing

A **partial pre-fill**, not a finished CV. The WCM template is 23 sections.

- **Research/PhD faculty:** Scholars fills the research spine (bibliography, grants, research
  summary, mentoring, appointments, education, leadership); clinical/service/teaching/honors
  sections are `N/A`.
- **Clinical faculty (have a POPS profile):** POPS additionally fills board certification, residency/
  fellowship training, hospital appointments+affiliation, honors, NPI, and corroborates degrees —
  a much fuller CV.

`N/A` placeholders are emitted for every section lacking data, which is exactly what the WCM
template's own instruction box mandates (*sections must not be deleted; enter "N/A"*). Sell it as
**"pre-fill the WCM CV from your Scholars (and clinical) data, then complete the rest"** — not
"generate my CV."

## 4. What we reuse (why this is small)

| Need | Already in SPS | Evidence |
|---|---|---|
| Emit a `.docx` (with bold runs) | `docx@^9.6.1` already installed; `word-bibliography.ts` builds bold-author Vancouver citations | `package.json`, `lib/api/word-bibliography.ts` |
| Stream a `.docx` download | working route | `app/(public)/scholars/[slug]/co-pubs/export/route.ts` |
| Scholar feedstock | `assembleOverviewFacts()` + `getScholarFullProfileBySlug()` | `lib/edit/overview-facts.ts`, `lib/api/profile.ts` |
| M1 research summary (LLM) | overview generator + Bedrock path + grounding | `lib/edit/overview-generator.ts` |
| Tool authz | `authorizeOverviewWrite` | `lib/edit/overview-authz.ts` |
| Card / route / flag pattern | biosketch tool (`#917`) — the copy/export analog | `components/edit/biosketch-tool.tsx`, `app/api/edit/biosketch/*` |
| Request preamble + download | `readEditRequest`, `editOk`, origin guard, 64KB cap | `lib/edit/request.ts` |

A CV from structured data is **deterministic**, so we skip biosketch's NDJSON streaming,
prompt-versioning, and Prisma persistence. Net new: the template-fill engine (`lib/edit/cv-template.ts`,
OOXML edits via jszip + `@xmldom/xmldom`), the section→data mapping (`lib/edit/cv-export.ts`), the
bundled template asset (`lib/edit/assets/wcm-cv-template.docx` + `outputFileTracingIncludes` so it
ships in the standalone image), a POPS fetch/mapper, a download card, and edit-page registration.

## 5. Coverage matrix — WCM section → source → fill

Order = official template (`wcm_cv_template_faculty_october_2022_final.docx`, matched 1:1 by CViche
`stage_6_word_template.py:972-993`). **S = Scholars, P = POPS (clinical only), L = LLM, NA = `N/A`.**

| # | WCM section | Scholars | POPS enrichment (if `hasClinicalProfile`) | Fill |
|---|---|---|---|---|
| 1 | Header / signature | `publishedName`; Date = today; Signature blank | — | **S** |
| 2 | Personal Data | name; `email` iff visible | `npi_number`, professional suffixes | **S (partial)** |
| 3 | Education — Degrees (B1) | `Education` (degree/inst/year) | `degrees[]` (degree_type/year_obtained/institution) corroborates | **S+P** |
| 4 | Education — Other (B2) | rare | — | **NA** |
| 5 | Postdoctoral Training (C) | **`Education` training rows (ASMS; inconsistent)** | `training[]` supplements (Residency/Fellowship + institution; *no dates*) | **S+P** |
| 6 | Professional Positions (D1/D2/D3) | `Appointment` (WCM/NYP) | **`appointments[]`** (title + institution + term dates) → D2 hospital | **S+P** |
| 7 | Employment Status | — | — | **NA** |
| 8 | Licensure (F1) / **Board Cert (F2)** | — | F1: `npi_number` only. **F2: `board_certifications[]`** (board_name + specialty; *no cert#/dates*) | **P (F2); NA (F1 dates)** |
| 9 | Hospital Affiliation | **primary affiliation (ASMS — confirm loader)** | primary NYP `appointment` | **S+P** |
| 10 | **Honors, Awards (H)** | — (ASMS source unconfirmed) | **`honors_and_awards`** (HTML blob; light parse) | **P** |
| 11 | Society Memberships (I) | — | — | **NA** |
| 12 | Percent Effort | — | — | **NA** |
| 13 | Educational Contributions (K1–K5) | — | — | **NA** |
| 14 | Clinical Practice/Innovation/Leadership (L1–L3) | `clinicalProfileUrl` only | specialties / `problem_procedure` expertise (optional list) | **P (partial) / NA** |
| 15 | **Research Activities — summary (M1)** | `assembleOverviewFacts` | (POPS bio as optional grounding) | **L (generate anew)** |
| 16 | **Research Support — grants (M2A/B/C)** + Patents | `Grant` rows by status; **no `$` amounts**; pending not modeled | — (external grants → RePORTER companion, §9) | **S (grants); NA (patents)** |
| 17 | **Mentoring (N3A/N3B)** | `getMenteesForMentor()` — **FERPA carve** | — | **S** |
| 18 | Institutional Leadership (O) | leadership FK (Chair/Chief/Director); current only | — | **S (partial)** |
| 19 | Administrative / Committees (P) | — | — | **NA** |
| 20 | Extramural Service / Editorial (Q1–Q4) | — | — | **NA** |
| 21 | Invitations to Speak (R) | — | — | **NA** |
| 22 | **Bibliography (S1/S2…)** | full `Publication` corpus; PMID-only → S3 Books/S4 Chapters empty | — | **S (reuse `word-bibliography.ts`, bold author)** |
| 23 | Appendix (T) | — | — | skip |

## 6. POPS enrichment (clinical faculty)

**Source (probed live 2026-06-26, HTTP 200):** `http://pops.weillcornell.org/providerbyshortname/{cwid}.json`
— **cwid lookup confirmed** (our join key; the path also accepts publish_short_name). `providerprofiles/ids.json`
is just 5,869 internal numeric ids — not needed. `providerProfile` has 57 fields; verified mappings:

| POPS field | shape (verified) | → WCM |
|---|---|---|
| `board_certifications[]` | `{board_name, mapped_specialty.name}` — **no cert#, no dates** | F2 |
| `training[]` | `{training_type, institution}` — **no dates**; types incl Residency/Internship/Fellowship/Medical School | C (drop "Medical School" rows; redundant with degrees) |
| `degrees[]` | `{degree_type, year_obtained, institution, is_hidden}` | B1 |
| `appointments[]` | `{title, institution, termstartdate, termenddate, is_hidden}` — **real ISO dates** | D1/D2 + §9 |
| `honors_and_awards` | single HTML string (`<p><strong>date</strong> award</p>`) | H |
| `npi_number` / `has_npi_number` | string | F1 (NPI sub-field) |
| `primary_specialties` / `problem_procedure` | specialty + expertise lists | L (optional) |
| `biography` / `personal_statement` | HTML | optional M1 grounding |

**Mechanism:** fetch-at-generation, **zero-persist** (no new tables/ETL) — one GET keyed by cwid,
only when `Scholar.hasClinicalProfile` is true; handle 404/empty as "no enrichment." Same
enrichment pattern as the RePORTER grants companion (§9).

**Source precedence (POPS supplements, doesn't replace, Scholars-native data):** prefer ASMS-sourced
Scholars data where it exists — **C postdoctoral training** (`Education` training rows) and
**§9 primary affiliation** both have an ASMS source (already in-app + suppression-aware); POPS fills
gaps/corroborates there. POPS is **primary** only for **F2 board certifications** (no ASMS/Scholars
equivalent), NPI, and (tentatively) **H honors**. Merge rule: ASMS rows first, append POPS rows not
already present (dedup by institution+type/year).

**Caveats (build for these):**
- Booleans are **strings** (`'True'`/`'False'`/`'None'`) — coerce.
- Respect row-level **`is_hidden`** (degrees/appointments) → exclude, consistent with our
  suppression-honoring principle.
- Board certs & training carry **no dates** → those columns render blank, not fabricated.
- `honors_and_awards` is **unstructured HTML**. Measured ceiling (live POPS, 2026-06-26): split on
  `<p>` **and `<li>`/`<br>`** — 27% of real entries are `<li>` lists with no `<p>` wrapper and
  otherwise collapse to one cell; strip tags; leading-date→Date extraction is best-effort and fires
  on **~1% of real rows** (dates are mostly trailing / comma-led / ranges) so the Date column is
  normally blank with the year retained inline in the award name; guard against Word-paste CSS junk
  (`Mso…`/`Normal 0 false`) and decode `&bull;`/stray entities; Organization always `N/A`.
  *Empirical basis: 62-profile POPS sample, 11 with honors, 71 rows, 1 dated. See §13.2.*
- **Connectivity — CONFIRMED:** POPS is reachable from outside the WCM network, so the SPS app
  fetches it at generation over the internet (NAT egress); no ETL/proxy needed. (Notable since the
  Sps VPCs cannot reach WCM 10.x internal sources — POPS is the public physician-directory host.)

## 6b. POPS data transparency — preview in /edit (NOT the public profile)

**Requirement (user 2026-06-26):** the POPS-sourced clinical data the CV pulls must be **visible to
the scholar in the `/edit` surface**, with plain-language copy on how it's used, so they can see
what will land in their CV. It must **not** be added to the public Scholars profile.

- **Where:** a read-only "Clinical credentials (from POPS)" preview inside the **CV (WCM format)**
  tool card (default — co-located with where the data is used). Alternative: a standalone "Clinical"
  card in the Tools rail (same data, own panel). Embedded is the lazy default; standalone if you
  want it discoverable on its own.
- **What it shows:** the fetched `PopsEnrichment` — board certifications, residency/fellowship
  training, hospital appointments (with dates), honors, NPI, specialties — each tagged with the CV
  section it feeds (F2 / C / D2·§9 / H / F1).
- **Copy (verbatim intent):** "These clinical credentials come from your WCM physician profile
  (POPS) and are used to fill your CV's board-certification, training, hospital-appointment, and
  honors sections. They're shown here so you can see what will be included — they are **not** added
  to your public Scholars profile."
- **Empty / non-clinical:** scholars without `hasClinicalProfile` (or an empty POPS record) → show
  nothing, or "No WCM physician (POPS) profile found."
- **Mechanism:** a small `GET /api/edit/cv/pops?cwid=` returning the typed `PopsEnrichment` (+ a
  per-field → CV-section map) for display; **same `authorizeOverviewWrite` gating** as the CV tool;
  reuses `fetchPops` (no new data path). **Never rendered under `app/(public)/scholars/...`.**
- **Status:** BUILT 2026-06-26 — `GET /api/edit/cv/pops` (reuses `fetchPops`, `authorizeOverviewWrite`,
  flag-gated, `hasClinicalProfile`-gated) + an embedded `PopsPreview` in `cv-tool.tsx` (consent copy,
  per-field→CV-section tags, renders nothing for non-clinical / empty POPS). Pure grouping helper
  `buildPopsPreviewGroups` unit-tested (`tests/unit/cv-pops-preview.test.ts`). Live endpoint not yet
  exercised through the running server (needs dev-login, same deferral as the POST route).

## 6c. ASMS enrichment (primary affiliation + dated postdoc training) — INVESTIGATED, NOT BUILT

ASMS source schema confirmed by live probe (`etl/asms/probe.ts`, 2026-06-26):

- **`asms.dbo.fc_doctoral_training`** (16,551 rows) — postdoc/doctoral training: `person_id`,
  `doctoral_training_type_id` (Residency/Fellowship/Internship lookup), `institution`, `specialty`,
  **`date_from`/`date_to` + `year_from`/`year_to`**. → WCM §5 Postdoctoral Training **with dates**
  (POPS training has none — so ASMS is the *better* source here).
- **`asms.dbo.wcmc_person.institution_id` → `asms.dbo.wcmc_institution.title`** — primary
  institutional affiliation. Also `fc_nyh_appointment*` (NYP), `fc_npi`. → WCM §9 Hospital Affiliation
  / §6 Positions.

**Gap:** the current ASMS ETL (`etl/asms/index.ts`) imports ONLY degree rows
(`wcmc_person_school`, `grad_year IS NOT NULL`) into `Education`. Training + affiliation are not
imported. ASMS is MSSQL reached by the nightly ETL — **not** reachable from the app at request time,
so (unlike POPS's fetch-at-generation) ASMS data must flow through the ETL into Scholars tables,
then the CV reads it from `ProfilePayload`.

**To use ASMS** (upstream of the CV — own piece of work): (1) extend the ASMS ETL with two queries
(`fc_doctoral_training` + its type lookup; `institution_id`→`wcmc_institution`); (2) schema — a
training model/rows (type, institution, specialty, dates) + a primary-affiliation field/row;
(3) surface both in `ProfilePayload`. Then the CV builder's existing merge points consume them.

**Empirical overlap (measured 2026-06-26, 120 ASMS clinical/NPI providers vs live POPS):** of 70
also in POPS, ASMS had training for 67 (mean 2.13 entries), POPS for 1 (mean 0.01). POPS-only
training = 0; POPS had an institution ASMS lacked in **1/70**. **POPS `training[]` is sparsely
populated — aorlin is the exception, not the rule.** Also 50/120 (42%) of ASMS clinical providers
aren't in POPS at all. Conclusion: ASMS `fc_doctoral_training` is the comprehensive, dated source;
POPS training adds essentially nothing.

**Merge design:**
- **§5 Postdoctoral Training — ASMS-ONLY** (dated, specialty, comprehensive). Do NOT merge POPS
  training — it's near-empty (1/70) and a per-person union is over-engineering for that edge case.
  The currently-shipped code reads POPS training only because ASMS training isn't imported yet;
  once `fc_doctoral_training` lands, **remove the POPS training path from §5**.
- **§9 Hospital Affiliation / §6 Positions — ASMS/Scholars-only** (user-confirmed 2026-06-26: POPS
  has no appointments ASMS doesn't). ASMS primary institution (`institution_id`→`wcmc_institution`)
  + the existing ED/NYP rows in `profile.appointments`. **Drop POPS appointments from the CV too.**
- **Net:** POPS's CV role narrows to board certifications, NPI, honors, practices, expertise,
  specialties, Castle Connolly. Everything dated/structural (training, appointments, affiliation)
  comes from ASMS/Scholars. Full build plan: `docs/cv-asms-enrichment-handoff.md`.

## 7. Architecture / data flow

```
POST /api/edit/cv?cwid=<target>         (mirror biosketch route shape; download response)
  └─ readEditRequest()                  reuse (origin guard, session, 64KB cap)
  └─ authorizeOverviewWrite()           reuse (self|superuser|proxy|org-unit owner)
  └─ flag isCvEnabled() else 404
  └─ assembleOverviewFacts() + profile loaders         reuse (pubs, grants, education, appts, mentees, leadership)
  └─ if hasClinicalProfile: fetchPops(cwid)            NEW (zero-persist; board cert, training, appts, honors, npi)
  └─ M1 = generateResearchSummary(facts)               reuse overview-generator Bedrock path (always regenerate)
  └─ buildWcmCv(facts, pops, summary) -> docx.Document  NEW: reconstruct 23 sections, N/A where empty
         · bibliography reuses word-bibliography.ts (bold author)               reuse
  └─ Packer.toBuffer(doc) -> attachment                reuse pattern
```

M1 adds a single Bedrock call (a few seconds) → the card shows a "Generating…" state; **no NDJSON
streaming needed** for v1 (one short generation). Add streaming later only if it feels slow.

## 8. New & touched files

**New (4):**
- `lib/edit/cv-export.ts` — `buildWcmCv(facts, pops, summary)`: deterministic section mapping →
  WCM layout via `docx` (reuse `word-bibliography.ts` for the bibliography); `N/A` placeholders.
- `lib/edit/pops.ts` — `fetchPops(cwid)`: GET + parse + coerce string-booleans + honor `is_hidden`
  + map to a typed `PopsEnrichment`. Returns null on 404/no-profile/unreachable (never throws into
  the CV path — enrichment is best-effort).
- `app/api/edit/cv/route.ts` — flag → `readEditRequest` → `authorizeOverviewWrite` → assemble →
  POPS → M1 → `buildWcmCv` → `Packer.toBuffer` attachment.
- `components/edit/cv-tool.tsx` — "Download CV (WCM format)" button + a checklist of which sections
  were filled vs left `N/A` (sets expectations honestly).

**Edit (standard registration — same as biosketch):**
- `components/edit/edit-page.tsx` — `AttrKey`, `ATTRIBUTES`, rail order/placement maps
  (SELF/SUPERUSER/RAIL_V2 → group "Tools"), `EditPageProps` flag, `visible` filter, `renderPanel()` case.
- `app/edit/page.tsx` + `app/edit/scholar/[cwid]/page.tsx` — read `isCvEnabled()` and thread the
  boolean (**flag parity — both pages** or it silently ships off, [[feedback_flag_parity_local_vs_deployed]]).
- `cdk/.../app-stack.ts` — wire `EDIT_CV_EXPORT` per-env (staging-first) + a `POPS_BASE_URL` env;
  then **regenerate the cdk snapshot** (`cd cdk && npm ci && npm test -- -u`,
  [[feedback_cdk_appstack_snapshot_regen]]).

**No** Prisma model, **no** versions panel, **no** streaming for v1.

## 9. Grants gap → RePORTER companion

`Grant` rows are WCM-administered only → external/prior-institution NIH grants are missing. A
companion spec (`docs/reporter-grants-matcher-spec.md`, current working tree) backfills these from
NIH RePORTER via the **same fetch-at-generation, zero-persist** pattern as POPS. The CV's Research
Support section sources `Grant` rows in v1 and can layer the RePORTER backfill when that ships.
Still no dollar amounts (neither source exposes them to us).

## 10. Authz, visibility, gating (do not simplify away)

- Reuse `authorizeOverviewWrite` verbatim (keyed on `realCwid`, never the impersonated session).
- **FERPA / mentees:** honor the doctoral-student/mentee visibility carve; don't emit suppressed mentees.
- **Email** only if `emailVisibility` permits.
- **Suppression / `field_override`:** build on `profile.ts` projections so hidden pubs/grants/appts stay hidden.
- **POPS `is_hidden`** rows excluded (above).
- **Internal-only, never on the CV:** `PublicationTopic.score` ([[project_topic_score_is_internal]]),
  per-pub impact score/justification, faculty bibliometrics.

## 11. Scope — v1 vs later

**v1:** download `.docx`; deterministic Scholars fill (ASMS-first); POPS enrichment (board cert /
training / hospital appts+affiliation / honors / NPI / degrees) gated on `hasClinicalProfile`
(egress confirmed, §6); M1 generated anew; reconstruct-in-code renderer; flag `EDIT_CV_EXPORT` staging-first.

**Defer:** RePORTER external-grant backfill (§9) · saved CV versions/history · letting the scholar
paste back the still-empty sections (memberships, service, talks, committees) · PDF variant ·
pending-grant (M2C) · richer honors HTML parsing.

**Won't do (no source anywhere):** society memberships, committees, extramural/editorial service,
invited talks, teaching/courses, patents, grant dollar amounts, books/chapters, employment status.

## 12. One runnable check

`tests/unit/cv-export.test.ts`: build the CV for two fixtures — a research-only scholar and a
clinical scholar (with a POPS payload) — and assert: (a) all 23 WCM headings present **in order**;
(b) every empty section renders the `N/A` placeholder (no silent drop); (c) bibliography contains
the scholar's **bolded** surname; (d) a suppressed publication/mentee and a POPS `is_hidden` row do
**not** appear; (e) the clinical fixture's board certification renders in F2.

## 13. Decisions — RESOLVED 2026-06-26

Resolved by a 3-agent workflow: code grounding in this worktree (4 behind / 7 ahead of
`origin/master` — not stale) + live POPS probe (sample `ano9028`; 62-profile honors sample).

1. **ASMS primary-affiliation loader (§9) — no field exists today; add one (handoff §4/§5).**
   Hospital-affiliation source-of-record in the shipped app is split, and *none* of it is an ASMS
   primary-affiliation field: the `Appointment` table is **ED-sourced only** (`source` ∈
   `ED` / `ED-NYP` / `JENZABAR-GSFACULTY` — `prisma/schema.prisma:149`, `etl/ed/index.ts`), and the
   CV's §9 currently reads **POPS only** (`cv-export.ts:415-425`). The ASMS ETL imports *only* degree
   rows (`etl/asms/index.ts:64-78`, `wcmc_person_school WHERE grad_year IS NOT NULL`);
   `wcmc_person.institution_id` is never selected and no `primaryAffiliation`/Training model exists —
   **identical on `origin/master`, so not stale.** → **Build:** ASMS ETL query
   `wcmc_person.institution_id LEFT JOIN wcmc_institution` (`title`, `abbreviation`; active cwid,
   `institution_id IS NOT NULL AND is_deleted = 0`) → new scalar `Scholar.primaryAffiliation`
   (+ `primaryAffiliationAbbrev`) → `ProfilePayload.primaryAffiliation` → `hospitalAffiliationBody`
   reads it (keep ED-NYP rows for the NYP line; drop the POPS-only §9 path). A 1:1 **scalar**, not an
   `Appointment` row. Render non-WCM affiliations (e.g. Hamad/Qatar) as-is. **Confirm exact column
   names by re-running `etl:asms:probe` at build time** (names rest on the 2026-06-26 probe).

2. **POPS honors (§H) — SHIP the heuristic, not `N/A`; with two required hardenings.** POPS
   `honors_and_awards` is the *only* honors source (ASMS and the Scholars schema carry none — probed)
   so "wait for structured" = §H is `N/A` forever; and the `.docx` is an editable draft, so raw honor
   text beats a blank. Live POPS (62-profile sample + `aorlin`, 2026-06-26): only ~18% of clinical
   faculty have any honors; the per-`<p>` split is clean for the `<p>`-shaped majority; the
   leading-year→Date extraction fires on **~1% of real rows** (dates are overwhelmingly trailing /
   comma-led / ranges) → **Date column normally blank by design, year inline in the award name —
   acceptable.** **Required before §H ships** (cases *below* the stated ceiling): (a) widen the block
   splitter to also break on `<li>` (and `<br>`) — **27% of real entries are `<li>` lists with no
   `<p>`** and currently collapse every honor into one cell (`pops.ts:87-102`); (b) drop
   Microsoft-Word paste noise (`Mso…`/`Normal 0 false` dumps) and extend `decodeEntities` to cover
   `&bull;`/stray entities. Organization column stays `N/A`. Add a test fixture over the real failure
   cases (POPS ids 1142 Word-junk, 1902/4182 `<li>`-collapse, 1522 `&bull;`).

3. **Clinical expertise (§L) — keep the shipped list, not `N/A`.** Already shipped (commit
   `7f6793f3`, `cv-export.ts:435-465`): specialties + named practices + `problem_procedure` expertise.
   For an actively-practicing, board-certified clinician a factual labeled list is strictly better
   than an `N/A` that implies no clinical activity; §L already degrades to `N/A` for research-only
   faculty (POPS fetched only when `hasClinicalProfile` — `route.ts:153`). Accepted limit: POPS feeds
   **L1 only** (no L2 Clinical Innovation / L3 Clinical Leadership source) — keep the §5 grade
   "P (partial)". Non-blocking refinements: (a) filter `practice_type === "Location"` rows out of
   "Clinical Practice" (department rows redundant with §9 Hospital Affiliation); (b) emit "Areas of
   expertise" *above* the "Clinical Practice" subheading so it doesn't read as nested under it.

---

### Appendix — research provenance
- WCM CV format: CViche `src/unified_pipeline/stage_6_word_template.py` (+ `stage_5c/5d/4_5`),
  template `key_files/wcm_cv_template_faculty_october_2022_final.docx`, sample `Output_2100_Mocco_wcm.docx`.
- POPS API (probed 2026-06-26, HTTP 200): `providerbyshortname/{cwid|shortname}.json` (cwid verified),
  `providerprofiles/ids.json` (5,869 numeric ids). Sample `aorlin` (cwid `ano9028`).
- SPS data model: `lib/edit/overview-facts.ts`, `lib/api/profile.ts`, `prisma/schema.prisma`.
- Tools pattern + authz: `components/edit/edit-page.tsx`, `lib/edit/overview-authz.ts`, biosketch (`#917`).
- Existing docx: `lib/api/word-bibliography.ts`, `co-pubs/export/route.ts`, `docx@^9.6.1`.
- Grants companion: `docs/reporter-grants-matcher-spec.md`.
