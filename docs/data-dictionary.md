# Data dictionary

**Audience.** Operators, ITS colleagues, and analysts answering *"what does this field
mean, and where does it come from?"*

**Authoritative source.** The schema itself — [`prisma/schema.prisma`](../prisma/schema.prisma)
— is the source of truth for shape (columns, types, indexes, FKs) and carries inline `///`
docs on most fields. This dictionary is the human-readable companion: it groups the tables
by domain and, crucially, records each table's **source of record (SOR)** — the upstream
system that owns the data — because that's what determines who to ask when a value looks wrong.

> The single most important fact for triage: **almost every table is ETL-managed** (rebuilt
> from an upstream source) **except the manual-override layer**, which is human-entered and
> ETL-immune. If a value is wrong, the first question is always: *is this an ETL table
> (fix the source / re-run ETL) or a manual-override table (a person set it)?*

---

## Source-of-record legend

| SOR | System | Connector / ETL | Refresh |
|---|---|---|---|
| **ED** | WCM Enterprise Directory (LDAPS) | [`lib/sources/ldap.ts`](../lib/sources/ldap.ts), `etl/ed` | nightly |
| **ASMS** | ASMS (MS SQL) | [`lib/sources/mssql-asms.ts`](../lib/sources/mssql-asms.ts) | nightly |
| **InfoEd** | InfoEd grants (MS SQL) | [`lib/sources/mssql-infoed.ts`](../lib/sources/mssql-infoed.ts) | nightly |
| **COI** | COI Portal (MySQL) | [`lib/sources/mysql-coi.ts`](../lib/sources/mysql-coi.ts) | nightly |
| **Jenzabar** | Graduate School (MS SQL) | [`lib/sources/mssql-jenzabar.ts`](../lib/sources/mssql-jenzabar.ts) | per spec |
| **ReCiter** | ReciterDB (MariaDB) — publications | [`lib/sources/reciterdb.ts`](../lib/sources/reciterdb.ts) | weekly |
| **ReciterAI** | DynamoDB + S3 — topics/scores/spotlight | `etl/dynamodb`, `etl/spotlight`, `etl/hierarchy` | weekly / annual |
| **RePORTER/NSF** | NIH RePORTER + NSF APIs | `etl/reporter`, `etl/nsf`, `etl/nih-profile` | nightly/weekly |
| **NLM** | NLM MeSH XML release | `etl/mesh-descriptors` | annual |
| **Manual** | Human-entered (manual-override layer / curation) | `/api/edit/*`, seeds | on edit |
| **Internal** | Computed/coordination by SPS itself | various ETL | per job |

Conventions across nearly every table: `source` column records the SOR string;
`lastRefreshedAt` / `refreshedAt` records the last ETL touch; `@map` gives the snake_case
DB column name. FKs reference `scholar.cwid` (CWID-canonical). Soft delete is
`scholar.deleted_at` (60-day retention before hard delete).

---

## 1. Core identity & profile

| Table | SOR | Purpose & key fields |
|---|---|---|
| **`scholar`** (`Scholar`) | ED (+ Manual for `overview`/`slug`) | One row per actively-affiliated WCM scholar; **PK = `cwid`**. `preferredName`, `fullName`, `postnominal` (degree string), `primaryTitle`, `primaryDepartment`, `email`, `headshotUrl`, `overview` (manual-editable bio), `slug` (unique URL key), `status` (`active`/`suppressed`), `roleCategory` (eligibility carve), `deptCode`/`divCode` (org-unit FKs), `hasClinicalProfile`/`clinicalProfileUrl` (weillcornell.org link), `postdoctoralMentorCwid`, `orcid`, `deletedAt` (soft delete). |
| **`appointment`** (`Appointment`) | ED | Titles/affiliations; `isPrimary`, `isInterim`, `startDate`/`endDate` (NULL end = current). `externalId` = ED appointment ID (#352 reconcile key). |
| **`education`** (`Education`) | ASMS | Degrees/training: `degree`, `institution`, `year`, `field`. |
| **`person_nih_profile`** (`PersonNihProfile`) | RePORTER | Maps a scholar to NIH RePORTER PI `nihProfileId` for the "View NIH portfolio" link. Composite PK `(cwid, nihProfileId)`; one `isPreferred` row per scholar; `resolutionSource` = `grant_join`/`name_match`. |
| **`cwid_alias`** (`CwidAlias`) | ED (replacement_cwid) | Old→current CWID redirects; auto-populated when ED reports a replacement. |
| **`slug_history`** (`SlugHistory`) | Internal | Every former slug → current scholar, for 301 redirects. |

## 2. Mentoring (disjoint populations, unioned at read time)

| Table | SOR | Purpose |
|---|---|---|
| **`phd_mentor_relationship`** (`PhdMentorRelationship`) | Jenzabar | PhD thesis advisor↔advisee (ADVISOR_TYPE='MAJSP'). Truncate-and-rebuild; **no FK to Scholar** (mentees may be alumni). |
| **`postdoc_mentor_relationship`** (`PostdocMentorRelationship`) | ED (SOR role records) | Postdoc↔reporting-manager edges, incl. expired; date-ranged chips. No FK to Scholar. |
| **`student_phd_program`** (`StudentPhdProgram`) | ED | One PhD-program record per CWID (`program`, `programCode`, `expectedGradYear`, `status`, `exitReason`). |

## 3. Publications

| Table | SOR | Purpose & notable fields |
|---|---|---|
| **`publication`** (`Publication`) | ReCiter (+ ReciterAI for impact/topic/synopsis) | Global, **PK = `pmid`**. `title`, `authorsString` (pre-rendered, truncated) / `fullAuthorsString` (Word export), `journal`/`journalAbbrev`, `year`, `doi`/`pmcid`, `citationCount`, `meshTerms` (JSON), `abstract`. ReciterAI-sourced: `synopsis` (plain-language), `impactScore` (0–100 global), `impactJustification`, `topTopicId`. |
| **`publication_author`** (`PublicationAuthor`) | ReCiter | Scholar↔publication join; `cwid` **nullable** (non-WCM authors render as plain text). `position`, `isFirst`/`isLast`/`isPenultimate`, `isConfirmed`. |
| **`publication_topic`** (`PublicationTopic`) | ReciterAI | Per (`pmid`, `cwid`, `parentTopicId`) triple from DynamoDB TOPIC# rows. `score` (parent-topic relevance — **internal-only, never surfaced**), `primarySubtopicId`/`subtopicIds` (embedded JSON, no FK), `rationale`, `authorPosition`. |
| **`publication_score`** (`PublicationScore`) | ReciterAI | Per (`cwid`, `pmid`) score projection. |
| **`grant_publication`** (`GrantPublication`) | RePORTER + ReCiter | Materialized grant↔publication join; `sourceReporter`/`sourceReciterdb` confidence flags. |

## 4. Funding

| Table | SOR | Purpose & notable fields |
|---|---|---|
| **`grant`** (`Grant`) | InfoEd (+ RePORTER/NSF enrichment) | `title`, `role` (PI/Co-I/…), `startDate`/`endDate`, `awardNumber`. Structured sponsor fields (`primeSponsor`/`directSponsor` + `*Raw`, `isSubaward`), NIH-derived `mechanism`/`nihIc`. Enrichment: `abstract`+`abstractSource`, `keywords`+`meshDescriptorUis` (search signals), `applId` (RePORTER deep-link). |

## 5. Topics & taxonomy

| Table | SOR | Purpose |
|---|---|---|
| **`topic`** (`Topic`) | ReciterAI | Parent topic catalog (~67 rows), 1:1 from `TAXONOMY#`. `label`, `description`, `displayThreshold` (tiering on /topics). |
| **`subtopic`** (`Subtopic`) | ReciterAI (hierarchy.json on S3) | Subtopic catalog. **IDs are NOT stable across annual recomputes** — never persist as a FK elsewhere (D-06). `displayName`/`shortDescription` are LOCKED UI-only fields. |
| **`topic_assignment`** (`TopicAssignment`) | ReciterAI | Per (`cwid`, `topic`) assignment + `score`. |
| **`mesh_descriptor`** (`MeshDescriptor`) | NLM | MeSH catalog, PK = `descriptorUi`. `entryTerms`/`treeNumbers` (JSON), `scopeNote`, `localPubCoverage` (computed daily). |
| **`mesh_curated_topic_anchor`** (`MeshCuratedTopicAnchor`) | Manual + Internal | Anchors a MeSH descriptor to ReciterAI parent topics; `confidence` = `curated` (hand-authored CSV) / `derived` (ETL). |
| **`spotlight`** (`Spotlight`) | ReciterAI (spotlight.json on S3) | Home-page "Selected research" cards; full-replacement per publish. `papers` JSON, LOCKED UI fields. See [`spotlight-runbook.md`](./spotlight-runbook.md). |

## 6. Org units

| Table | SOR | Purpose |
|---|---|---|
| **`department`** (`Department`) | ED (+ Manual `category`/leadership) | PK = `code` (stable LDAP org-unit code). `name`, `slug`, `category` (browse bucket, hand-curated, ETL-preserved), `chairCwid`, `scholarCount`. |
| **`division`** (`Division`) | ED (+ Manual) | PK = `code`; `deptCode` FK. `chiefCwid`, `slug` (disambiguated by deptCode). |
| **`center`** (`Center`) | Manual / seed | Cross-disciplinary centers & institutes. PK = `code`. `centerType` (center/institute badge), `directorCwid`, `leaderInterim`, `sortOrder`. Manually owned — no ETL writes it. |
| **`center_membership`** (`CenterMembership`) | Manual | Per-scholar center membership; composite PK `(centerCode, cwid)`. |
| **`division_membership`** (`DivisionMembership`) | Manual | Roster for *manually-created* divisions (`Division.source='manual'`); LDAP division membership stays on `Scholar.divCode`. |

## 7. Manual-override layer (ADR-005) — ETL-immune

The human-entered layer. The ETL **never** writes these; they merge into responses at read
time, so edits survive every rebuild. Change history lives in the separate B03 audit log,
not in these tables. See [`ADR-005`](./ADR-005-manual-override-layer.md) and
[`access-control-rbac.md`](./access-control-rbac.md).

| Table | Purpose |
|---|---|
| **`field_override`** (`FieldOverride`) | Per (`entityType`, `entityId`, `fieldName`) scalar override (e.g. `overview`, `slug`). DB-enforced slug uniqueness via a `slug_guard` generated column. |
| **`suppression`** (`Suppression`) | Hides an entity, or one contributor on a record. Revocable, never deleted (`revokedAt IS NULL` = active). No FK (can outlive a hard-deleted target). |
| **`unit_admin`** (`UnitAdmin`) | Per-unit RBAC grant: (`entityType`, `entityId`, `cwid`, `role`). `role` = `owner`/`curator`; `grantedBy` = actor. Inserted on grant, **hard-deleted** on revoke (B03 audits both). |
| **`slug_request`** (`SlugRequest`) | Approval queue for personalized slugs (#497). `status` = pending/approved/rejected/superseded/withdrawn. |
| **`request_change_rate_limit`** (`RequestChangeRateLimit`) | Per-(cwid, UTC hour) fixed-window counter for "Request a change" abuse control. |

> The B03 audit log (`scholars_audit.manual_edit_audit`) is deliberately **not** a Prisma
> model — it lives in a separate database with an INSERT-only grant. See
> [`b03-audit-log.md`](./b03-audit-log.md).

## 8. Disclosures, feedback, and operational tables

| Table | SOR | Purpose |
|---|---|---|
| **`coi_activity`** (`CoiActivity`) | COI | Conflict-of-interest disclosures (`entity`, `activityType`, `value`, `activityGroup`). |
| **`feedback_submission`** (`FeedbackSubmission`) | Manual (site visitors) | General-feedback badge submissions (#538). Anonymous-by-default; `mode` (contextual/generic) is load-bearing for analysis — segment by it before aggregating. See [`feedback-badge-spec.md`](./feedback-badge-spec.md). |
| **`etl_run`** (`EtlRun`) | Internal | Per-source run log: `source`, `startedAt`/`completedAt`, `status`, `rowsProcessed`, `errorMessage`. The data-freshness audit table — query it to answer "when did X last refresh?" |
| **`etl_state`** (`EtlState`) | Internal | Single-row cross-ETL coordination; `lastTopicRebuildAt` drives the reciter→dynamodb "topics updating" placeholder. |
| **`completeness_snapshot`** (`CompletenessSnapshot`) | Internal | Weekly profile-completeness snapshot; `belowThreshold` wires to a health alarm. |

## Enums

| Enum | Values |
|---|---|
| `EntityType` | `scholar`, `publication`, `grant`, `education`, `appointment`, `department`, `division`, `center` |
| `UnitRole` | `owner`, `curator` |
| `SlugRequestStatus` | `pending`, `approved`, `rejected`, `superseded`, `withdrawn` |
| `FeedbackMode` | `contextual`, `generic` |
| `FeedbackPurpose` | `lookup_person`, `lookup_topic`, `browse_unit`, `research_story`, `evaluate_scholars`, `other` |
| `FeedbackTaskSuccess` | `yes_completely`, `mostly`, `partially`, `no`, `not_looking` |
| `FeedbackRole` | `wcm_faculty`, `wcm_trainee`, `wcm_staff`, `external_researcher`, `journalist`, `patient_or_public`, `prefer_not_say`, `other` |

## Notes & gotchas

- **`PublicationTopic.score` is internal-only** — per-topic relevance for ranking math;
  never surface it as a "Topic: NN" display. Only `Publication.impactScore` renders inline.
- **Subtopic / spotlight IDs are not stable across annual recomputes** — never persist as a
  cross-table FK (D-06).
- **`@db.Text` JSON fields** (`meshTerms`, `keywords`, `subtopicIds`, `papers`, …) are
  JSON-typed MariaDB columns; treat as opaque arrays/objects per the inline schema docs.
- **Profile URLs (slugs)** — a scholar's slug is `Scholar.slug`; the *canonical* public URL is
  governed by `PROFILE_CANONICAL` (#671, [`lib/profile-url.ts`](../lib/profile-url.ts)): default
  `scholars` → `/scholars/<slug>` canonical with the root `/<slug>` 308-aliasing to it; `root` →
  `/<slug>` canonical with `/scholars/<slug>` 308-ing to it (mid-migration to the shorter root
  form). On-page links always use the root form (`profilePath`); `canonicalProfilePath` drives
  rel=canonical / OG / JSON-LD / sitemap / redirect targets. The slug itself is **auto-derived**
  from ED `preferredName` (`deriveSlug`, [`lib/slug.ts`](../lib/slug.ts)); a collision takes a
  numeric suffix (`-2`, `-3`) in CWID-creation order and the incumbent is never renamed. The four
  tables interlock: a **`field_override(slug)`** row is the *pin* — a superuser override (or an
  approved `slug_request`) writes it, and on write `reconcileScholarSlug` updates `Scholar.slug`
  and records the prior value in **`slug_history`** so the old URL keeps permanent-redirecting.
  Routing reads only `Scholar.slug` + `slug_history`, never the override row (single source of
  truth). The ED ETL skips re-minting any cwid carrying a `field_override(slug)` (#497 §5.2), so a
  name change can't clobber a curated URL. Scholar self-serve requests (the **`slug_request`**
  queue, reviewed at `/edit/slug-requests`) are gated behind `SELF_EDIT_SLUG_REQUEST` (off at
  launch); the superuser direct override is always available. Reserved single-segment words
  (`RESERVED_SLUGS`) can't be taken. Custom slugs are **policy-constrained to be name-based** (a
  variant of the scholar's own name), enforced by **review only** — `validateRequestedSlug` checks
  format/length/reserved/numeric/profanity/collision but **not** name-derivation; custom-slug
  requests arrive as ServiceNow tickets and are actualized via the superuser override. Full design:
  [`ADR-005`](./ADR-005-manual-override-layer.md), [`slug-personalization-spec.md`](./slug-personalization-spec.md).
- This dictionary covers the **public/runtime model** (Aurora). The B03 audit schema is
  documented separately; upstream source schemas (ReciterDB, InfoEd, etc.) are owned by
  those systems.

---

*Generated from `prisma/schema.prisma` (1,304 lines, 35 models + 7 enums) on 2026-05-28.
When the schema changes, update the affected row here; the schema's inline `///` docs
remain the field-level source of truth.*
