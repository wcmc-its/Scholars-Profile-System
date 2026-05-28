# docs/ADR-005 — Manual-override layer

**Status:** Accepted
**Date:** 2026-05-16
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —
**Amendments:** [Amendment 1 (2026-05-27) — org-unit curation & three-tier access model](#amendment-1-2026-05-27--org-unit-curation-entity-type-extension-and-three-tier-access-model) — **Accepted** · [Amendment 2 (2026-05-27) — slug override reconcile-on-write & hard-delete prohibition](#amendment-2-2026-05-27--slug-override-reconcile-on-write-d5-and-the-scholar-hard-delete-prohibition) — **Accepted**
**Tracks:** [#29](https://github.com/wcmc-its/Scholars-Profile-System/issues/29) (slug override), [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) (suppression), [#358](https://github.com/wcmc-its/Scholars-Profile-System/issues/358) (org-unit curation — Amendment 1), [#497](https://github.com/wcmc-its/Scholars-Profile-System/issues/497) (slug personalization — Amendment 2)
**Gates:** B01–B03 ([#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100)/[#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101)/[#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102)) — self-edit auth, authorization, and audit

---

## Context

The Scholars Profile System renders entirely from MySQL data that a nightly/weekly ETL chain rebuilds from upstream systems (ED/LDAP, ASMS, InfoEd, ReCiter, ReCiterAI). Per [ADR-001](./ADR-001-runtime-dal-vs-etl-transform.md) the runtime is read-only over MySQL and OpenSearch; the ETL is the only writer.

Three planned capabilities need to put **human-entered** data into that picture:

- **Self-edit** — the writer feature behind B01–B03 (#100–102): a scholar corrects their own profile.
- **Slug override** (#29) — a curator pins a profile URL slug instead of accepting the name-derived one.
- **Suppression** (#160) — a record, or one contributor on a record, is hidden from public display.

All three collide with the same fact: the ETL rebuilds its tables on every run, and for most entities that means **deleting and re-creating rows with fresh surrogate keys**. `etl/asms` truncates the whole `education` table; `etl/infoed` truncates the whole `grant` table; `etl/ed` deletes and re-creates `appointment` rows per scholar. A manual edit written into those tables is erased on the next run. Only `scholar` and `publication` are stable — `etl/ed` updates `scholar` rows in place by `cwid`, and `etl/reciter` upserts `publication` rows by `pmid`.

One piece of this already exists. **Scholar-level suppression is built on the read side today**: `Scholar.status` (`'active' | 'suppressed'`, indexed via `@@index([status])`) is filtered by ~20 `lib/api/*` read functions, by `lib/url-resolver.ts`, and by the `etl/search-index` document builder — a `status='suppressed'` scholar already drops out of every page, listing, and the search index. What is missing is the *write* path to set it and the per-suppression metadata #160 requires (`reason`, `created-by`). Slug/center/chief curation also exist as file-based overrides ([ADR-002](./ADR-002-division-chiefs.md), [ADR-003](./ADR-003-center-membership.md)), and `Department.category` is preserved by the ED ETL rather than overwritten. None of this is a general mechanism, and none covers publication/grant/education/appointment.

This ADR decides how manual data is stored and applied so it survives the ETL. It does **not** decide self-edit's UI or editable-field set, or the broader slug policy of #29; see [Non-goals](#non-goals).

*Terminology:* "override" denotes read-time **precedence** over ETL-projected data. For a self-edited field with no ETL source, the manual layer is simply that field's only source — nothing is overridden, but it takes precedence by the same mechanism.

## Decision

Manual data lives in **two new tables that the ETL never writes**, keyed on **stable entity identifiers**, and is **merged into responses at read time**. The manual layer is the single source of truth; the ETL-managed tables are not mutated to carry it — with one named, derived exception (`Scholar.status`, below).

### Two tables

```prisma
enum EntityType {
  scholar
  publication
  grant
  education
  appointment
}

/// Manual scalar-field overrides applied over ETL-managed data at read time.
/// One row per (entity, field): the current value, mutated in place.
/// Change history is the B03 audit log's responsibility, not this table's.
model FieldOverride {
  id         String     @id @default(uuid()) @db.VarChar(64)
  entityType EntityType @map("entity_type")
  entityId   String     @map("entity_id")   @db.VarChar(64)  // Scholar.cwid for v1
  fieldName  String     @map("field_name")  @db.VarChar(64)  // 'slug' | fields from the self-edit SPEC
  value      String     @db.Text                            // scalar text; structured values — see Non-goals
  actorCwid  String     @map("actor_cwid")  @db.VarChar(32)
  createdAt  DateTime   @default(now()) @map("created_at")
  updatedAt  DateTime   @updatedAt        @map("updated_at")

  @@unique([entityType, entityId, fieldName])
  @@map("field_override")
}

/// Manual suppression of an entity, or of one contributor on a record.
/// Revocable: a target is suppressed iff a row exists with revokedAt IS NULL.
model Suppression {
  id              String     @id @default(uuid()) @db.VarChar(64)
  entityType      EntityType @map("entity_type")
  entityId        String     @map("entity_id")        @db.VarChar(64)  // stable identifier — see § Keying
  contributorCwid String?    @map("contributor_cwid") @db.VarChar(32)  // NULL = whole entity; CWID = one author/investigator
  reason          String     @db.Text
  createdBy       String     @map("created_by")       @db.VarChar(32)
  createdAt       DateTime   @default(now())          @map("created_at")
  revokedBy       String?    @map("revoked_by")       @db.VarChar(32)
  revokedAt       DateTime?  @map("revoked_at")

  @@index([entityType, entityId])
  @@map("suppression")
}
```

Two tables rather than one generic table because the shapes genuinely differ: a field override is a **current value** (mutable, one per `(entity, field)`, upserted); a suppression is a **revocable event** (`reason`, `contributor_cwid` granularity, soft-revoke). `field_override` therefore carries a `@@unique` on `(entityType, entityId, fieldName)`; `suppression` carries no uniqueness — re-suppressing after a revoke is legitimate, so a target is "suppressed" iff **any** matching row has `revokedAt IS NULL`.

`entityType` is a Prisma `enum`, not a bare string, so a typo (`'scholars'`, `'Scholar'`) is a compile error rather than a silently-unread row. Appending a value later is an online, backwards-compatible `ALTER` — compatible with the additive-only migration policy.

Neither table has a foreign key to the entity tables. That is deliberate: a slug override must be settable for a scholar whose ED record has not yet arrived (#29's reservation case), and a suppression must outlive a hard-deleted publication. They reference entities by stable identifier only.

Both tables are new — a purely additive migration, compatible with [`PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy) (B09 #108).

### Keying and v1 entity scope

The manual layer can only target an entity by an identifier that survives an ETL rebuild. Of the five entity types in #160, only two qualify today:

| Entity | `entity_id` | ETL write mechanic | ETL-stable? | v1 |
|---|---|---|---|---|
| Scholar | `scholar.cwid` | `etl/ed` — `update`/`create` in place by `cwid` | ✅ natural PK | ✅ supported |
| Publication | `publication.pmid` | `etl/reciter` — `upsert` by `pmid` | ✅ natural PK | ✅ supported |
| (Publication, author) | `pmid` + `contributorCwid` | both natural keys | ✅ | ✅ supported |
| Grant | `grant.id` (uuid) | `etl/infoed` — `deleteMany()` + `createMany` | ❌ PK regenerated every run | ⛔ blocked |
| (Grant, investigator) | `grant.id` + cwid | grant PK unstable | ❌ | ⛔ blocked |
| Education | `education.id` (uuid) | `etl/asms` — global `deleteMany()` + `createMany` | ❌ PK regenerated every run | ⛔ blocked |
| Appointment | `appointment.id` (uuid) | `etl/ed` — `deleteMany({cwid,source})` + `createMany` | ❌ PK regenerated every run | ⛔ blocked |

**v1 ships suppression and field override for Scholar, Publication, and the (Publication, author) pair.** Grant, Education, and Appointment have no identifier that survives their ETL — every row gets a new `uuid()` on each run, so a suppression keyed on the surrogate `id` is silently undone on the next run.

Unblocking them is a **prerequisite ETL refactor, not part of this ADR's mechanism**: each of `etl/infoed`, `etl/asms`, and `etl/ed` must give its rows a deterministic, run-stable identifier and `upsert` on it instead of truncate-and-recreate. `Grant` is the cheapest — it already has `externalId` (the InfoEd ID); adding `@unique` to it and switching `etl/infoed` to upsert is the likely shape. `Education` and `Appointment` have no natural key and need one designed. This refactor is an ETL-orchestration change and should land **before B08** (#107) freezes the ETL into Step Functions. It is tracked as a follow-up issue; until it lands, Grant/Education/Appointment suppression is out of scope.

### Scholar suppression and the `Scholar.status` projection

Scholar suppression is a partial exception, because the read enforcement already exists. The `suppression` table is the source of truth for **every** entity type including `scholar` — it is where `reason`, `created-by`, and revocation live, which a bare enum cannot hold. But for `entityType='scholar'`, the write path **additionally sets `Scholar.status`** (`'suppressed'` / `'active'`) in the same transaction.

`Scholar.status` is therefore a **denormalized projection** of the `suppression` table, not a competing mechanism. The reason to keep it: ~20 `lib/api/*` read functions, `lib/url-resolver.ts`, and `etl/search-index` already filter `status='active'`. Re-plumbing all of them to join the `suppression` table — changing working, tested code — is needless regression risk immediately before launch. Writing one extra column in the same transaction is not. There is exactly one writer of `status` for suppression purposes (the manual-layer write path) and the ETL writes neither table nor column, so the projection cannot drift except by the regression guarded below. That single-writer claim is guarded *asymmetrically* — the regression test below covers the ETL, and the branded `Merged<T>` types (§ Consequences) cover the read side — but a future **app-layer** write to `status` (a maintenance script, or a developer reaching for the Prisma column directly) is caught by neither. In v1 that rests on convention and PR review, since no code outside the manual-layer write path has any reason to set `status`; the airtight version — a branded *write* type mirroring the read-side discipline, or the DAL wrapper noted in § Consequences — is scoped post-launch.

Consequence: **scholar suppression's read side is already complete** (Aurora reads, URL resolution, and the search index all honour `status`). Only the write path is new. Publication suppression, by contrast, needs both a new read-merge and a new build-time search filter.

Two invariants make the projection sound:

- **`Scholar.status` is manual-only.** No ETL writes it — verified 2026-05-16 across all eight scholar write sites (six ETL, two seed): `etl/ed`'s scholar `update` writes profile fields (name, titles, department, email, …) and `status` is not among them; `create` relies on the column `@default('active')`. v1 locks this with a regression test (run the ED scholar-update against a `status='suppressed'` fixture, assert it survives) and a line in the **Schema migration checklist** of [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) — "no ETL scholar `create`/`update` payload writes `Scholar.status`". If an ETL ever adds `status` to a scholar payload, suppressed scholars silently un-suppress — the drift audit query below is the detection net.
- **Revoke is synchronous and deterministic.** Revoking a suppression sets `status='active'` in the *same transaction* as the revoke — gated on no other un-revoked `suppression` row remaining for that scholar. There is no prior status to restore: `status`'s domain is `{active, suppressed}` and nothing produces any other value (departed/inactive scholars are carried by the orthogonal `deletedAt`, which revoke does not touch). So revoke needs no `previous_status` snapshot — the pre-suppression state is always `active`.

### Publication suppression: per-author rows and derived visibility

A self-editing scholar hides a publication from a single action on their own profile. Rather than the write path choosing whole-publication vs per-author suppression at click time, it **always writes a per-author row** (`contributorCwid = self`), and publication visibility is **derived** at read time: a publication is shown iff at least one displayed author remains — a displayed author being a confirmed, site-visible WCM-scholar authorship — after per-author suppressions are applied.

The sole-author case is then the degenerate one: the only displayed WCM author hides the publication, zero displayed authors remain, and it is hidden site-wide. This derivation self-heals — if ReCiter later attributes the publication to a new WCM co-author it reappears on its own, and if several co-authors hide it over time it goes dark exactly when the last one does. Neither is true of a static whole-publication row written at first click.

An explicit whole-publication suppression (`contributorCwid = NULL`) is reserved for the **editorial / superuser** case — a retraction or compliance takedown — independent of authorship. So a publication is hidden iff *either* an explicit whole-publication suppression exists *or* it has zero displayed authors.

### Where the merge happens

The manual layer is applied at **two points**, matching the system's two read surfaces:

- **Aurora read path (`lib/api/*`): query-time.** Entity-read functions apply `field_override` values and filter `suppression` before returning. Immediate and reversible with no rebuild — the answer to #160's open question ("Lean: query time"). Scholar suppression is already enforced here via the `status` filter; publication suppression and all field overrides are new query-time merges.
- **OpenSearch (`etl/search-index`): build-time.** The index builder already excludes rows at document-build time (`status: 'active'`, `NEVER_DISPLAY_TYPES`); scholar suppression rides that filter unchanged. Publication suppression and field overrides are applied in the same place when building the People / Publications / Funding documents.

Build-time alone means an OpenSearch change lags by up to one ETL cycle (~24h). That is acceptable for self-edit field changes — a corrected bio tolerates the lag. It is **not** acceptable for suppression: its trigger cases are retractions, FERPA/HIPAA exposure, and harassment vectors, where "still visible in search for 24h" is the exact failure the feature exists to prevent. The suppression write path therefore also issues an immediate targeted OpenSearch write — see the failure model below.

**One read-path exception.** The self-edit surface (`/api/edit*`, `/edit/*`) reads a scholar's *own* record with the suppression filter **off**. A scholar who has self-suppressed must still be able to load their edit page and lift the suppression; if the edit surface reused the normal `status`-filtered read it would lock them out of their own profile.

### Write-path failure model

A self-edit or suppression action is **one MySQL transaction**:

1. Upsert the `field_override` row, or insert (suppress) or soft-revoke the `suppression` row.
2. For a scholar suppression or its revoke, also set `Scholar.status` (`'suppressed'` on suppress; `'active'` on revoke, when no other un-revoked suppression remains).
3. Insert one B03 audit row capturing the before/after diff.

`field_override` / `suppression` are in the application schema; the B03 audit table is in a **separate schema on the same Aurora cluster**, so a single MySQL transaction spans both. (If B03 is ever relocated off-cluster — e.g. to CloudWatch or a separate audit store — this atomicity breaks; the manual-layer write must then be authoritative and the audit write retried. Flagged for whoever scopes B03.)

OpenSearch cannot join a MySQL transaction, so search reflection is layered:

1. **Fast path** — after the transaction commits, the write path issues a targeted OpenSearch write. The shape depends on the action: a whole-entity *suppress* is a document delete; a per-contributor suppress or revoke is a document update in place; a whole-entity *revoke* is a **re-add** — the document is reconstructed from Aurora and upserted, because the index has no document to mutate. Near-instant in the normal case; best-effort.
2. **Durable guarantee** — a short-interval reconciler worker brings the live `scholars` index into line with the `suppression` table, **in both directions**: it deletes the index document for any target newly suppressed, and — symmetrically — reconstructs the document from Aurora and upserts it for any target whose suppression was revoked (*table says `active`, index has no document → rebuild from Aurora and upsert*). The re-add is the heavier direction and is explicitly in the worker's contract, not just deletion. Because the `suppression` table is committed *inside* the MySQL transaction, it already **is** the durable work queue — no separate outbox table is needed. This worker, not the fast-path write, is the contract: **v1 targets a reconciliation lag of ≤ 5 minutes, with an operational alarm when the lag — the age of the oldest `suppression` write, an insert or a revoke, not yet reflected in the index — exceeds 15 minutes.** That bound is what makes the urgency split sound, durably, even if the fast-path write is lost to a process crash or an OpenSearch outage.
3. **Full backstop** — the nightly `etl/search-index` rebuild reconciles the entire index from Aurora.

For **suppression**, all three layers apply: its trigger cases (retraction, FERPA/HIPAA exposure, harassment) make a *durable, sub-cycle* staleness bound mandatory — "best-effort" alone would degrade to the ~24h lag the urgency split exists to prevent. For **self-edit field changes**, the nightly rebuild alone suffices; no fast-path write or reconciler entry is needed.

### ETL precedence and the slug exception

Because the manual-layer tables are separate, the ETL's `deleteMany`/`createMany`/`upsert` on the entity tables **never touches them** — the manual layer survives the ETL by construction, with no ETL change needed for persistence.

Three ETL touch-points remain:

1. **`etl/search-index`** reads both tables to apply build-time exclusion and overrides.
2. **`etl/ed` slug minting** — the one place the ETL *reads* the manual layer. `Scholar.slug` is ETL-written, `@unique`, and routing-critical. Before `deriveSlug`/`nextAvailableSlug`/`maybeUpdatedSlug` run, `etl/ed` must consult `field_override` where `entityType='scholar' AND fieldName='slug'`: an override wins unconditionally, is never re-minted, and other scholars' collision resolution must route around it. This matches #29's stated precedence rule.
3. **No ETL writes `Scholar.status`** — the manual-only invariant from *§ Scholar suppression and the `Scholar.status` projection*. This is what lets the projection survive ETL runs. It is an omission rule (ETLs simply never include `status` in a scholar payload), not a conditional — `status` is a pure manual flag with no upstream signal behind it, so no ETL has any reason to write it. Locked by the regression test and PR-checklist line described in that section.

### Relationship to the B03 audit log

The manual-layer tables and the B03 audit log (#102) are different artefacts and must not be conflated:

| | `field_override` / `suppression` | B03 audit table |
|---|---|---|
| Holds | current/active manual state | append-only change history |
| Mutability | `field_override` upserted; `suppression` soft-revoked | insert-only, never updated or deleted |
| App-role grant | `INSERT` + `UPDATE` | `INSERT` only |
| Schema | application schema | separate schema, same Aurora cluster |

The `createdBy`/`createdAt` columns on the manual-layer tables are operational breadcrumbs; B03 is the real audit trail (#160 explicitly defers change history to it).

### Slug freezing at launch

#28 (scholar name source → LDAP `displayName`) is **closed** — the name-source change has landed, so this ADR addresses only steady-state slug behaviour; `maybeUpdatedSlug`'s re-mint-on-name-change is unchanged.

The remaining one-shot URL-stability lever is **launch itself** — the point at which slugs first become public, indexed, and citeable. A `scripts/backfills/{date}-freeze-launch-slugs.ts` script can snapshot every active scholar's current slug into a `field_override(scholar, cwid, 'slug', …)` row before the domain goes public, freezing launch-day URLs against later name-change re-mints. This ADR only provides the mechanism that makes that a one-line backfill; whether to run it, and whether to keep the overrides permanently (full stickiness) or prune them, is a #29 policy decision. It interacts with B14 (#113, the VIVO redirect map).

The script is one-shot and idempotent-safe: it **inserts** with skip-on-conflict against `field_override`'s `(entityType, entityId, fieldName)` unique key and never upserts, so an accidental re-run cannot clobber a slug a curator overrode between launch and the re-run.

## Consequences

### Positive

- **The manual layer survives the ETL with zero ETL changes for persistence.** Separation does the work.
- **Reservation and hard-delete survival come free** — no FK to the entity tables.
- **One pattern serves #29, #160, and self-edit**; one additive migration unblocks all three.
- **Scholar suppression's read side already exists** — Aurora, URL resolver, and search index all honour `status`. v1 builds only the write path, which materially de-risks the #160 slice even if the rest slips.
- **Immediate and reversible** on the Aurora path; suppression is immediate in search too, via the targeted write.

### Negative / accepted

- **Read-path discipline is the real long-term cost, and a CI grep is only a backstop.** A grep catches `prisma.scholar.findUnique` in `app/` but not the subtle regressions — a new aggregation that counts suppressed rows, a facet that does not filter, an export that bypasses the helper. The primary mechanism is the **type system**: `lib/api/*` entity-read functions return a *branded* post-merge type (e.g. `Merged<Scholar>`) that only the merge helpers can construct; a raw Prisma result does not satisfy it, so a read path that skips the merge fails to compile. The ~6 files that currently bypass `lib/api/*` with direct `prisma` calls (`co-pubs` pages and exports, `search/page.tsx` facet reads, `sitemap.ts`) are routed through `lib/api/*` or the helpers. The airtight end state — a DAL wrapper that makes `prisma.scholar.*` physically unreachable outside the manual-layer module — is larger, overlaps ADR-001's DAL boundary, and is scoped as separate work; branded types are the v1 mechanism, the grep is the cheap backstop.
- **Grant / Education / Appointment suppression is deferred** behind the ETL stable-key refactor. v1 covers Scholar, Publication, and (Publication, author).
- **`Scholar.status` is a denormalized projection** — a small, bounded, single-writer consistency surface, held safe by the manual-only invariant (no ETL writes it) and its regression test, with the drift audit query as the detection net.
- **Derived counts and facets must honour the merge** — #160 requires People counts, topic/center publication counts, and author/investigator lists to reflect suppression. The merge helpers must make every aggregate, not just the primary listing, easy to get right. The **per-author** publication model raises this cost specifically: because whole-publication visibility is *derived* (shown iff ≥ 1 displayed author remains), a publication count cannot be a flat `COUNT(*) … WHERE NOT suppressed` — each candidate row must first have per-author suppression applied and the displayed-author predicate evaluated before it is counted, so aggregates carry more work than a single whole-row suppression boolean would. The self-healing property (§ Publication suppression) is worth that cost; it is still a real cost the merge helpers must absorb.

### Operational implications

- The two tables are prod data; they ride into staging with the prod snapshot (B13 #112). Per-environment scoping is not built (see Non-goals).
- A suppression row can outlive a hard-deleted target; harmless but accumulating — see the cleanup query below.
- **Gating risk.** B01–B03, #29, and #160 all depend on this foundation; if the ADR slips, they slip with it. The only "cheaper" interim paths are the in-row anti-patterns this ADR rejects — with one genuine exception: scholar suppression is already read-enforced via `status`, so that one slice is independently and cheaply shippable. There is no cheaper interim path for self-edit or for publication suppression.

## Edge cases

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | Self-edit a scholar bio, then `etl/ed` runs | Override survives — `field_override` is untouched by the ETL; the read-merge re-applies it. |
| 2 | Suppress a publication, then `etl/reciter` runs | Survives — keyed on `pmid`, separate table. |
| 3 | Suppress an appointment, then `etl/ed` runs | **Not supported in v1** — `appointment` rows are `deleteMany` + `createMany`'d with new `uuid()`s. Blocked pending the stable-key refactor. |
| 4 | Suppress an education entry, then `etl/asms` runs | **Not supported in v1** — `etl/asms` truncates the whole `education` table. Same blocker as #3. |
| 5 | Slug override set; `etl/ed` re-mints slug after a name change | Override wins — `etl/ed` reads `field_override(fieldName='slug')` before `maybeUpdatedSlug`; no re-mint. |
| 6 | Slug override set for a CWID **not yet in the directory** | Stored fine — no FK to `scholar`; `etl/ed` applies it when the row is created. Satisfies #29's reservation case. |
| 7 | Slug override collides with another scholar's derived slug | The write path validates against `scholar.slug @unique` and rejects, or triggers #29's swap flow. Validation hook is in scope here; the swap UX is #29 follow-up. |
| 8 | A suppressed publication's PMID is removed from the ReCiter source | `etl/reciter` orphan-cleanup hard-deletes the `publication` row; the `suppression` row dangles harmlessly (no FK). Cleaned by the audit query below. |
| 9 | Suppress author X on publication P; X is a scholar with their own profile | Only `(publication=P, contributorCwid=X)` is hidden — X's profile and other publications are unaffected. |
| 10 | Suppress a scholar | `suppression` row inserted **and** `Scholar.status='suppressed'` set in one transaction; existing `status` filters (`lib/api/*`, URL resolver, `etl/search-index`) enforce it; the fast-path OpenSearch delete plus the reconciler make search immediate-and-durable. |
| 11 | Revoke a scholar suppression | The revoke transaction sets `status='active'` — gated on no other un-revoked `suppression` row remaining for the scholar. Synchronous; no wait for an ETL run. `deletedAt` is untouched, so a departed-and-suppressed scholar stays hidden via `deletedAt`. |
| 12 | Any ETL runs after a scholar is suppressed | `status` preserved — no ETL writes `Scholar.status` (the manual-only invariant). The regression test guards it; the drift audit query is the detection net if it ever regresses. |
| 13 | Fast-path OpenSearch write fails after the MySQL commit | The reconciler worker applies it within its interval (minutes); Aurora reads were already correct at commit. Bounded and durable — not a 24h degradation. |
| 14 | Self-edit during the reciter→dynamodb consistency window (B19 #118) | Independent — `field_override` does not touch `publication`/`publication_topic`. |
| 15 | Sole displayed WCM author hides their own publication | Self-edit writes a per-author row; zero displayed authors remain, so the publication is hidden site-wide (derived). Self-applied — the scholar can revoke it and the publication reappears. |
| 16 | One author of a co-authored publication hides it | Self-edit writes a per-author row; that author drops off the publication's displayed author list everywhere it renders; the publication is kept for the remaining displayed authors. |

## Audit queries

```sql
-- Suppression rows whose target publication no longer exists (edge case 8 — periodic cleanup).
SELECT s.* FROM suppression s
LEFT JOIN publication p ON p.pmid = s.entity_id
WHERE s.entity_type = 'publication' AND s.revoked_at IS NULL AND p.pmid IS NULL;

-- Slug overrides that collide with a different scholar's current slug (edge case 7).
SELECT fo.entity_id AS override_for_cwid, fo.value AS override_slug, sc.cwid AS colliding_scholar
FROM field_override fo
JOIN scholar sc ON sc.slug = fo.value AND sc.cwid <> fo.entity_id
WHERE fo.entity_type = 'scholar' AND fo.field_name = 'slug';

-- Projection drift: scholars whose status disagrees with the suppression table (edge case 11).
SELECT sc.cwid, sc.status,
       EXISTS (SELECT 1 FROM suppression s
               WHERE s.entity_type = 'scholar' AND s.entity_id = sc.cwid
                 AND s.contributor_cwid IS NULL AND s.revoked_at IS NULL) AS table_suppressed
FROM scholar sc
HAVING (sc.status = 'suppressed') <> table_suppressed;

-- Reconciler health (search-side): scholar CWIDs that MUST NOT have a document in
-- the live `scholars` OpenSearch index. The MySQL half of a cross-store check — a
-- monitoring job queries the index for each cwid below; any hit is a reconciler miss
-- (the fast-path write was lost AND the reconciler has not yet caught up). Pairs with
-- the projection-drift query above, which covers the Aurora side.
SELECT s.entity_id AS suppressed_cwid, MIN(s.created_at) AS suppressed_since
FROM suppression s
WHERE s.entity_type = 'scholar' AND s.contributor_cwid IS NULL
  AND s.revoked_at IS NULL
GROUP BY s.entity_id;
```

## Alternatives considered

**In-row override columns as the primary store** (e.g. a `slug_override` column on `Scholar`, an `is_suppressed` boolean per entity table — one of #29's two floated options). Rejected as the *source of truth*: every ETL `create`/`update` payload would then have to be hand-audited to never overwrite each such column, which is fragile and easy to regress. `Scholar.status` refines rather than contradicts this: it is an in-row flag that works — but only because v1 uses it as a **derived projection** of the authoritative `suppression` table, with an ETL guard, never as the primary store. The rule is "in-row is acceptable as a guarded projection, never as the source of truth."

**Fully migrating scholar suppression into the `suppression` table now**, retiring the `status` filters. Rejected for v1: it means changing ~20 working, tested read filters immediately before launch — regression risk with no functional gain, since the projection approach already makes the table the single source of truth. Worth revisiting post-launch once the read paths are consolidated behind the merge helpers.

**One generic EAV table** for overrides and suppression together. Rejected: suppression needs `contributor_cwid`, `reason`, and revocation columns a field override never uses, and a field override needs an upsert-unique key a suppression must not have.

**ETL-time enforcement** (the ETL bakes overrides and suppression into the entity tables on each run). Rejected: changes would not take effect until the next ETL run, every ETL step would have to know about the manual layer, and a missed run would resurrect suppressed data. This is the direct answer to #160's "query time, ETL time, or both" — query time for Aurora, build time for the OpenSearch projection only.

**File-based curation** (the `data/division-chiefs.txt` pattern of ADR-002/003). Retained for low-volume admin curation; unworkable for a runtime feature where faculty edit their own profiles through a UI.

## Non-goals

- **Broad admin field-editing** — editing arbitrary scholars' fields via the `scholars-admins` tier (B02 #101) is a deferred fast-follow. **Suppression is carved out:** superuser suppression ships in v1 alongside self-edit suppression, because the deceased and FERPA/compliance cases cannot be self-served (a dead scholar cannot log in). v1 therefore needs the `scholars-admins` group claim on the SSO session and a "superuser may suppress any v1-supported entity" predicate — a scoped slice of B02, not its full admin-edit surface.
- **The self-edit editable-field set** — owned by the self-edit SPEC. This ADR provides the `field_override` mechanism; the SPEC enumerates valid `fieldName`s (at minimum `slug`).
- **Per-field validation** — each editable field's validation lives in the write-path code the self-edit SPEC owns (the slug validator, for instance, checks `scholar.slug @unique`). This ADR provides storage and precedence, not a generic validation framework.
- **Structured (non-scalar) `field_override` values** — v1 `value` is `Text`, sufficient for slug and bio. A field needing structured data (e.g. a curated affiliations list) will need a documented JSON-in-`Text` convention or a `value_type` discriminator; deferred until such a field exists.
- **The rest of #29's slug policy** — stickiness rules, the numeric-suffix scheme, slug release/tombstones. This ADR covers only override storage and ETL precedence.
- **The B03 audit log internals** (#102), and the **admin UI** for managing suppressions and overrides (deferred by #160 and #29 to follow-up issues).
- **Manually-created records** — rows the ETL never produced (e.g. an appointment the directory missed). A known future shape needing an `origin` discriminator so the ETL's `deleteMany` is scoped to `origin='etl'`. Not decided here.
- **Per-environment suppression scoping** (#160 open question) — not built; staging inherits prod suppressions via snapshot restore.

## Open questions

1. **Self-edit field set** — **Resolved (2026-05-17).** [`self-edit-spec.md`](./self-edit-spec.md) § "The v1 editable-field set" enumerates the `field_override.fieldName` domain as `{ 'overview', 'slug' }`. This ADR is Accepted on that basis.
2. **Stable-key refactor scheduling** — Grant/Education/Appointment suppression is blocked on it, and it should precede B08 (#107). Filed as #352; confirm it is scheduled before the ETL freeze.

## Implementation

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Add `EntityType` enum, `FieldOverride`, and `Suppression` models. |
| `prisma/migrations/{ts}_add_manual_override_layer/` | Additive migration creating the enum and both tables. |
| `lib/api/manual-layer.ts` *(new)* | `applyFieldOverrides()`, `filterSuppressed()`, `filterSuppressedContributors()`, `isSuppressed()`, and the branded `Merged<T>` post-merge types. |
| `lib/api/*.ts` (`profile`, `scholars`, `publication-detail`, `topics`, `departments`, `divisions`, `centers`, `home`, `browse`, `popover-context`, …) | Return branded merged types; call the merge helpers in every entity-read path; route the ~6 direct-`prisma` bypass files through them. |
| `etl/ed/index.ts`, `lib/slug.ts` | Slug minting consults `field_override` (`fieldName='slug'`); regression test asserting an ED scholar-update preserves an existing `Scholar.status='suppressed'`. |
| `etl/search-index/index.ts` | Apply publication suppression exclusion and field overrides when building documents. |
| `etl/search-index/` reconciler *(new scheduled job)* | Short-interval worker reconciling the live `scholars` index against the `suppression` table — the durable search-staleness guarantee. |
| `app/api/edit/*` *(future — B01–B03)* | Write path: the MySQL transaction (manual-layer row + `Scholar.status` for a scholar suppress/revoke + B03 audit row); the fast-path targeted OpenSearch write. |
| `scripts/backfills/{date}-freeze-launch-slugs.ts` *(launch)* | Snapshot active scholar slugs into `field_override` — see § Slug freezing. |
| `etl/infoed`, `etl/asms`, `etl/ed` *(follow-up issue)* | Stable-key refactor for Grant / Education / Appointment. |

## References

- [`self-edit-spec.md`](./self-edit-spec.md) — the self-edit feature SPEC: enumerates the `field_override.fieldName` domain (resolving Open Question #1) and owns the write path, surfaces, authorization, and per-field validation built on this layer.
- [#29](https://github.com/wcmc-its/Scholars-Profile-System/issues/29) — slug policy review; [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) — suppression controls; [#28](https://github.com/wcmc-its/Scholars-Profile-System/issues/28) — scholar name source (closed).
- [ADR-001](./ADR-001-runtime-dal-vs-etl-transform.md) — runtime DAL is MySQL + OpenSearch; the `/api/edit` Phase 7 OpenSearch-write pattern.
- [ADR-002](./ADR-002-division-chiefs.md), [ADR-003](./ADR-003-center-membership.md) — the existing file-based manual-curation precedent.
- [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) — § Schema migration policy (additive-only); § `/api/edit` (B03 audit log).
- B01 #100 / B02 #101 / B03 #102 — self-edit auth, authorization, audit; gated by this ADR.
- B08 #107 — Step Functions ETL orchestration; the stable-key refactor should precede it. B09 #108 — migration pipeline. B13 #112 — staging. B14 #113 — VIVO redirect map.

---

## Amendment 1 (2026-05-27) — Org-unit curation: entity-type extension and three-tier access model

**Status:** Accepted
**Date:** 2026-05-27 (ratified 2026-05-28)
**Implementation:** [#540](https://github.com/wcmc-its/Scholars-Profile-System/issues/540)
**Amends:** § Two tables (enum extension), § Keying and v1 entity scope (units qualify with no stable-key prerequisite), § Non-goals ("Manually-created records" — closed). Authoritative source for the org-unit access model that [`unit-curation-spec.md`](./unit-curation-spec.md) (#358) consumes.
**Driver:** The base ADR's actor model is binary — a scholar edits their own record; a `scholars-admins` **superuser** does everything else (§ Non-goals, "Broad admin field-editing"). Org-unit curation needs an actor *between* those two: the person who maintains a department's page and its faculty is, in the institution's words, "never the Chair — usually some admin." A 2026-05-27 design review ratified (A1.2) a three-tier, per-unit access model to fill that gap without making every grant flow through a site-wide superuser. This amendment is **additive**: no base-ADR mechanism (the two tables, the read-merge, the write-path failure model, the search reflection layers) changes.

### A1.1 Storage extensions

`EntityType` gains `department`, `division`, `center` — the online, backwards-compatible `ALTER` the base ADR's § Two tables anticipates. Unlike Grant/Education/Appointment (blocked behind the #352 stable-key refactor), all three unit tables key on a `code` primary key that survives every ETL run, so **units qualify for the manual layer with no stable-key prerequisite**.

The `origin` discriminator the base ADR deferred (§ Non-goals, "Manually-created records") is **already shipped, not a new column**: `Department`, `Division`, and `Center` carry a `source` column, and `etl/ed`'s orphan sweep is already `source='ED'`-scoped (`etl/ed/index.ts`), so a `source='manual'` unit is invisible to the sweep by construction. This amendment *uses* it; it does not add it.

Two new tables, both **ETL-never-written and foreign-key-free** in the base ADR's style:

```prisma
enum EntityType {
  scholar
  publication
  grant
  education
  appointment
  department   // + Amendment 1
  division     // + Amendment 1
  center       // + Amendment 1
}

/// The role a person holds on one unit. Data-derived (a UnitAdmin row), NOT an
/// SSO group — so it needs no new B02 group plumbing. `owner` strictly subsumes
/// `curator`; a person holds at most one role per unit (the @@unique below).
enum UnitRole {
  owner    // edit the unit + proxy-edit its faculty + MANAGE ACCESS (grant/revoke owner|curator) within this unit's subtree + create informal no-code subunits in own department
  curator  // edit the unit + proxy-edit its faculty; NO access management
}

/// A per-unit access grant. Inserted on grant, HARD-DELETED on revoke (B03
/// audits both — an access grant is crisply present or absent, no soft-revoke).
model UnitAdmin {
  id         String     @id @default(uuid()) @db.VarChar(64)
  entityType EntityType @map("entity_type")                   // department | division | center
  entityId   String     @map("entity_id")  @db.VarChar(64)    // the unit `code`
  cwid       String     @db.VarChar(32)                       // grantee — a WCM person (LDAP), NOT necessarily a Scholar
  role       UnitRole
  grantedBy  String     @map("granted_by") @db.VarChar(32)    // grantor cwid; a historical breadcrumb, NOT a live FK (see A1.3 T5)
  createdAt  DateTime   @default(now())    @map("created_at")

  @@unique([entityType, entityId, cwid])                      // one role per person per unit
  @@index([cwid])                                             // "what do I administer?" — the scoped-roster query
  @@map("unit_admin")
}

/// The manual roster of a manually-created (`source='manual'`) division — the
/// pre-adoption membership of a division LDAP does not carry yet. Mirrors
/// CenterMembership exactly; no FK to Scholar (a listed person may have no row).
model DivisionMembership {
  divisionCode    String   @map("division_code")    @db.VarChar(64)
  cwid            String   @db.VarChar(32)
  source          String   @db.VarChar(16)                    // 'manual-ui' | 'file' | ...
  lastRefreshedAt DateTime @map("last_refreshed_at")

  @@id([divisionCode, cwid])
  @@map("division_membership")
}
```

`@@unique([entityType, entityId, cwid])` enforces one role per person per unit: granting `curator` to someone who already holds `owner` is a no-op upgrade/downgrade on the same row, never two competing rows. Proxy profile editing adds **no** table — it reuses the base ADR's `field_override(scholar, cwid, 'overview')` and per-author `suppression`, widening only the authorized-actor set (A1.5).

### A1.2 Three-tier access model

| Tier | Scope | Powers |
|---|---|---|
| **Superuser** | global / site-wide (SSO `scholars-admins`) | Everything below, anywhere, **plus** the sole structural levers: set/clear a unit `slug` (routing-critical), retire a unit, `centerType`, create a **coded** LDAP division or a new department. The root of trust — every Owner chain terminates at a Superuser grant. |
| **Owner** | one unit; cascades to child divisions | Edit the unit (`description`, leadership) + proxy-edit its LDAP-primary faculty + **manage access** (grant/revoke `owner` or `curator`) within the owned subtree + **create an informal, no-code subunit** under their own department and curate its roster. **No** structural levers. |
| **Curator** | one unit; cascades to child divisions | Edit the unit + proxy-edit its LDAP-primary faculty. **No** access management, **no** structural levers. |

This **renames the base ADR / spec vocabulary** to remove a collision: what the base ADR and earlier `unit-curation-spec.md` drafts called "curator" (the site-wide tier) is here **Superuser**; "unit admin" (the per-unit editor) is here **Curator**; **Owner** is new.

Two cross-cutting rules bound all delegation (textbook RBAC least-privilege):

1. **Grant authority ≤ the grantor's own role.** A Curator grants nothing. An Owner grants `owner` or `curator` — never a structural power, which no role below Superuser holds. Only a Superuser grants structural powers, and only a Superuser exists site-wide. (An Owner *may* grant `owner` — see A1.3 T1/T4 and A1.4 for why owner→owner is permitted rather than owner→curator-only.)
2. **Grant scope ⊆ the grantor's own scope.** An Owner's grants apply only within the subtree they own — their unit, and (for a department Owner) that department's divisions via the dept→division cascade. A grant targeting a sibling unit, a parent, or anything outside the subtree is `403`.

Role membership is **data-derived** and **re-checked per POST** through B02's predicate machinery — there is **no new SSO group**. The predicate for a session `S` acting on unit `U`:

```
isSuperuser(S)            := S.session.isSuperuser                         // SSO scholars-admins (B02)
ownerOf(S, U)             := ∃ UnitAdmin(role=owner, U, S.cwid)
                             ∨ (U.kind = division ∧ ∃ UnitAdmin(role=owner, department=U.deptCode, S.cwid))
curatorOf(S, U)           := ownerOf(S, U) ∨ ∃ UnitAdmin(role=curator, U, S.cwid) ∨ (division cascade as above)

canEditUnit(S, U)         := isSuperuser(S) ∨ curatorOf(S, U)
canManageAccess(S, U)     := isSuperuser(S) ∨ ownerOf(S, U)
canGrant(S, role, V)      := isSuperuser(S) ∨ (ownerOf(S, V) ∧ role ∈ {owner, curator})
canStructural(S, U)       := isSuperuser(S)                                 // slug, retire, centerType, coded-division/dept create
canCreateInformalSubunit(S, deptD) := isSuperuser(S) ∨ ownerOf(S, deptD)
```

`canGrant` is the load-bearing line: because it requires `ownerOf(S, V)` and `ownerOf` only holds inside the subtree, rules (1) and (2) are enforced by one predicate. A department-level grant cascades down; a division-level grant never cascades up.

### A1.3 Threat model

In scope — privilege management within the unit tree. Authentication (B01 SSO), audit-log integrity (B03), and session freshness (B02 re-checks `isSuperuser` per POST) are inherited from the base gates and **out of scope** here, as is the integrity of LDAP's department/division tree itself (system-of-record, not ours to defend).

| # | Threat | Mitigation |
|---|---|---|
| **T1** | **Privilege escalation by delegation** — an Owner mints access wider or higher than their own. | `canGrant` requires `ownerOf(S, V)` (scope ⊆ own) and caps `role ∈ {owner, curator}` (authority ≤ own — structural powers are unreachable). An out-of-subtree or structural grant is `403 edit_authz_denied`. Every Owner chain roots at a Superuser, so no authority is created from nothing. |
| **T2** | **Scope widening** — an Owner grants themselves or a confederate a *parent* or *sibling* unit. | Same `ownerOf(S, V)` gate: a division Owner cannot grant on the parent department (no upward cascade); a department Owner cannot grant on a sibling department (different subtree). |
| **T3** | **Capture-via-roster** — an Owner adds an arbitrary scholar to a center/division roster to gain proxy-edit rights over them. | Proxy-edit scope keys **only** on the scholar's LDAP-primary `deptCode`/`divCode` *columns* (never `field_override`-able, never roster-derived). Roster membership is a listing, never authority. (Restates the base spec; load-bearing here because Owners can now both manage rosters and proxy-edit.) |
| **T4** | **Peer-revoke griefing** — two Owners of the same unit revoke each other. | **Accepted risk.** Revoke is symmetric (`canManageAccess`), so peers can revoke peers; this is a social/trust matter within one department, and the Superuser is an always-available backstop to re-appoint. The alternative (only-the-grantor-may-revoke) was rejected — it creates revoke deadlocks when the grantor leaves. |
| **T5** | **Orphaned / dangling grants** on revoke. | Revoke **hard-deletes one row only**; it does **not** cascade to, or re-attribute, grants that person previously made. `grantedBy` is a historical breadcrumb (like the base ADR's `createdBy`), **not** a live foreign key — a grant whose `grantedBy` now points to a revoked person is still valid. No cascade, no re-attribution rewrite, no `previous_role` snapshot. (A1.4 alternative D.) |
| **T6** | **Grantee-identity confusion** — a mistyped or guessed CWID grants access to the wrong or a non-existent person. | The grant UI resolves the grantee by **directory name search** (A1.5), so the operator selects a real LDAP person and never types a raw CWID; a non-person cannot be selected. Validation moves to selection time — the base spec's "unknown CWID → 400" guard becomes "you can only pick a directory entry." |
| **T7** | **Lockout** — a unit ends with zero Owners and nobody can manage it. | **Accepted, no guard.** A Superuser can always grant a fresh Owner, so "zero Owners" is recoverable, not a lockout. A "cannot remove the last Owner" guard was rejected (A1.4 E) as state for no benefit. Self-revoke is blocked in the UI as a footgun guard only, not a security control. |

### A1.4 Alternatives considered

- **A — Strict Superuser-only grants (the base ADR / early-spec binary).** Every `unit_admin` granted only by a `scholars-admins` Superuser; no Owner tier. Rejected: makes the Superuser a bottleneck for large departments (Medicine has 11 divisions), exactly the friction #358 exists to remove. Kept as the *fallback* if the Owner tier is descoped for a first slice.
- **B — Bounded depth-delegation without explicit roles.** A single "admin" grant that may delegate only to strictly-lower units. Rejected in favour of explicit `UnitRole`: roles are self-documenting in the access map (audit query B), make "who can manage access" a column rather than a graph computation, and cleanly express co-ownership.
- **C — Owner→curator only (no owner→owner).** Owners appoint Curators but only a Superuser appoints Owners. Rejected per the 2026-05-27 decision: a large department must be able to stand up a division Owner without routing through a Superuser. Accepted cost: owner→owner reintroduces T1/T4, mitigated above. (This is the one place this amendment deliberately widens delegation beyond strict least-privilege, with eyes open.)
- **D — Re-attribution or cascade-revoke on Owner removal.** On revoking an Owner, either auto-revoke everything they granted or rewrite those rows' `grantedBy` to the actor. Rejected: complexity and surprising bulk side-effects from a single revoke. `grantedBy`-as-history + Superuser backstop (T5) is simpler and safe.
- **E — "Cannot remove the last Owner" guard.** Rejected: the Superuser backstop makes zero-Owner recoverable (T7), so the guard adds state and edge-case handling for no real protection.
- **F — A new SSO group per unit role.** Rejected: would need B02 group plumbing per unit (thousands of groups) and a provisioning path WCM ITS does not offer. Data-derived `UnitAdmin` rows need none.

### A1.5 Downstream requirements (enforceable)

These are requirements on the implementing code, not soft guidance:

1. **The grant/edit predicate MUST implement A1.2 exactly** — `ownerOf` includes the dept→division cascade; `canGrant` rejects any `role`/`V` failing scope-⊆-own or authority-≤-own with `403` and a `edit_authz_denied` telemetry event `{ actor_cwid, target_entity_type, target_entity_id, role, path, reason }` (B02). The predicate keys on `role` and `entityType`, never on the HTTP verb or `op`.
2. **Structural actions MUST gate on `isSuperuser` alone** — `slug`, retire (`suppression` of a unit), `centerType`, coded-division creation, department creation. An Owner reaching these is `403`, not a silent no-op.
3. **A directory people-search endpoint is REQUIRED and is new** — the grant UI resolves a grantee by name, so an internal endpoint MUST take a name fragment and return `[{ cwid, displayName, title, dept }]` from the **WCM enterprise directory (LDAP/ED), not the scholars corpus**, requesting **minimal attributes only** (no `weillCornellEduDOB` or other PII). The base spec assumed a known CWID; this is the one genuinely new interface the access model adds.
4. **The grantee need NOT be a Scholar.** Owners and Curators are commonly administrative staff with no profile. `UnitAdmin.cwid` references a WCM person by LDAP identity; the "must be an active scholar" phrasing in earlier drafts is corrected. (The proxy-edit *target* must still be a faculty Scholar — that is a separate predicate.)
5. **Revoke MUST hard-delete exactly one row** and MUST NOT cascade or re-attribute (T5). B03 audits the delete.
6. **Every write remains one MySQL transaction** per the base ADR's write-path failure model (validate → write `unit_admin`/unit/membership row(s) → one B03 row → rollback on any failure). Unit curation has no FERPA/retraction urgency, so it uses the **nightly `etl/search-index` rebuild as its only search path** — no fast-path OpenSearch write, no reconciler entry (contrast suppression).

The `UnitAdmin` / `DivisionMembership` tables are a purely additive migration, compatible with the additive-only policy (§ Two tables). The base ADR's branded-`Merged<T>` read discipline and the single-writer `Scholar.status` invariant are untouched.

---

## Amendment 2 (2026-05-27) — slug-override reconcile-on-write (D5) and the Scholar hard-delete prohibition

**Status:** Accepted
**Date:** 2026-05-27
**Amends:** § ETL precedence and the slug exception (the slug override now *also drives routing*, not only ETL re-mint precedence), and Edge cases #5/#7 (mechanism made concrete). Authoritative source for the slug-routing decision that [`slug-personalization-spec.md`](./slug-personalization-spec.md) (#497) consumes.
**Driver:** The base ADR shipped the slug-override *storage* (the `field_override(scholar, cwid, 'slug')` row) and the ETL *re-mint precedence* (Edge case #5: the ED ETL reads the override before `maybeUpdatedSlug` and never re-mints a pinned slug). A 2026-05-27 trace confirmed a gap the base ADR did not close: the override was **write-only**. `Scholar.slug`, `slug_history`, and every read path (`lib/url-resolver.ts`, the profile reads, the sitemap, the canonical-URL metadata) key off `Scholar.slug` and **never read `field_override`**, so a pinned slug `brandon-swed` while `Scholar.slug='brandon-swed-2'` left `/scholars/brandon-swed` returning 404 and the canonical URL wrong. This amendment decides how a slug override becomes routable. It is **additive**: no base-ADR mechanism (the two tables, the read-merge, the write-path failure model) changes.

### A2.1 Decision D5 — reconcile on write (Option B)

**Writing or clearing a `field_override(scholar, cwid, 'slug')` row mutates `Scholar.slug` and `slug_history` in the same transaction; the `field_override` row remains the *pin* the ETL checks.** Concretely:

- **Set an override.** After the `field_override` upsert + collision validation, the write path sets `Scholar.slug` to the override value and writes the prior slug to `slug_history` (`{ old_slug: prior, current_cwid: cwid }`) — all in the one MySQL transaction that already carries the override upsert and the B03 audit row. The `Scholar.slug @unique` index and the `slug_guard` UNIQUE index both guard and fail the transaction closed on any collision the application check missed.
- **Clear an override.** After deleting the `field_override` row, the write path reconciles `Scholar.slug` back to the **name-derived** slug — `nextAvailableSlug(deriveSlug(preferredName), <other live scholars' slugs>)` — writing the old pinned slug to `slug_history`. Clearing the pin therefore returns the scholar to the derived slug **immediately**, not on the next ETL run.
- **The pin still gates the ETL** (base ADR Edge case #5, unchanged): `etl/ed` loads the set of pinned cwids once per run and `maybeUpdatedSlug` skips re-mint entirely for a pinned scholar, so a name change touches neither `Scholar.slug` nor `slug_history` nor the override.

The shared primitive is `reconcileScholarSlug(tx, cwid, newSlug)` in `lib/slug.ts`: read the current `Scholar.slug`; if unchanged, no-op; else upsert `slug_history` and update `Scholar.slug`. Both `/api/edit` slug paths and the ETL's `maybeUpdatedSlug` call it — one implementation, no duplication.

**Rejected — Option A (resolver fork):** make every read path (`resolveBySlugOrHistory`, the profile reads, the sitemap, the canonical-URL metadata) consult `field_override(slug)` and overlay it on `Scholar.slug`. Rejected because it scatters override-awareness across every slug-consuming surface — a new read path that forgets the overlay silently serves the wrong URL, the exact regression class the branded-`Merged<T>` discipline exists to prevent, but for routing rather than fields. Option B keeps `Scholar.slug` the single canonical key every read path already trusts; the override layer reconciles *into* it on write and **zero read paths change** (the point of Option B).

This makes `Scholar.slug` a *partially manual-driven* column — the one place a `field_override` value is reflected back into an ETL-managed column rather than merged only at read time. It is sound for the same reason `Scholar.status` is (§ Scholar suppression): there is exactly one app-layer writer that reconciles it from the manual layer (the `/api/edit` slug paths), and the ETL's only slug writer (`maybeUpdatedSlug`) defers to the pin. The asymmetry with the read-time `overview` override is deliberate — `slug` is routing-critical and `@unique`, so it must live in the indexed canonical column the resolver keys on, not be overlaid per-request.

### A2.2 Reserved-word denylist

`RESERVED_SLUGS` (`lib/slug.ts`, re-exported from `lib/edit/validators.ts`) enumerates every current and reserved-future top-level route segment plus the `/scholars/*` sub-segments a slug must not shadow. Enforced two ways: a *derived* slug landing on a reserved word takes the numeric floor (`about` → `about-2`, via `nextAvailableSlug`); a *requested or override* slug equal to a reserved word is rejected (`validateSlugFormat` → `error: "reserved"`). This guards the PR-2 root-alias catch-all route (`/<slug>`) against a scholar slug shadowing a real route word.

### A2.3 Downstream requirement (enforceable) — Scholar hard-delete is prohibited in app code

`SlugHistory.current` has `onDelete: Cascade` to `Scholar`. **Hard-deleting a `Scholar` row therefore cascades away its `slug_history` rows and frees those slugs for reuse — an identity-bleed vector**: a slug that 301-redirected to scholar A could later be minted for, or overridden onto, scholar B, so an old citation URL silently resolves to the wrong person.

The system's deliberate disappearance mechanism is **soft delete** — `Scholar.deletedAt` (departed) and `Scholar.status='suppressed'` (manual takedown). Both keep the row, and thus its `slug_history`, intact; the read paths already filter on both, so a soft-deleted scholar's slugs neither resolve nor 301 to a live profile, yet remain *reserved* against reuse.

**Requirement:** application code MUST NOT hard-delete a `Scholar` row. Removal from public view is always a soft delete (`deletedAt` / `status`). This is a convention guarded by PR review and the threat model (#497 §7), not a DB constraint — `onDelete: Cascade` is retained because it is correct for the legitimate operational case (a true data-erasure run, e.g. a GDPR/right-to-be-forgotten action, deliberately *should* take the history with it). The prohibition is on routine app-layer deletion, not on that out-of-band administrative path.
