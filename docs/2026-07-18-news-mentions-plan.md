# News Mentions — build plan

Add a "News mentions" feature to the Scholars Profile System: scrape the WCM
Research news feed, attach articles to scholars, review the ambiguous ones in
an admin queue, and surface them on the profile and in the per-scholar `/edit`
view.

Scope confirmed: **build everything now** (scrape + profile section + per-scholar
`/edit` section + by-name approval queue), name detection by **deterministic
name-dictionary scan** (no LLM), queue shows **name + title + department +
likelihood** for each candidate.

All existing paths below are grounded against `origin/master` (this session's
checkout is ~688 commits behind; implement on a fresh branch — see Build order).

## Reuse map (what this clones)

Two existing seams cover almost everything; News is their synthesis.

| Concern | Clone from | Divergence for News |
|---|---|---|
| Scrape paginated Drupal HTML, extract `cwid-([a-z0-9]+)` from VIVO links | `etl/technologies/{scrape,seed,index}.ts` | Incremental crawl (stop at first all-seen page), not 248-page full sweep every run |
| Profile-only table, `status: published\|pending\|rejected`, `source`, `showOnProfile`, never truncated by ETL | `model Honor` | Ingest **upserts and preserves review state** (CTL truncate-rebuilds — News must not, or a re-scrape wipes queue decisions) |
| Profile display section behind a flag + per-scholar hide toggle | `components/profile/technologies-section.tsx` + `lib/api/profile.ts` gating | — |
| Admin approval queue, contested-group single-select, decision route, sibling-reject | `app/edit/honors-queue/*`, `app/api/edit/honor/decision/route.ts`, `lib/edit/honor-queue.ts` | Group key is `articleUrl\|detectedName`; candidates carry a likelihood + title/department |
| 5-place audit registration | `lib/edit/audit.ts` + `scripts/sql/audit-log.sql` | New action `news_mention_update`, entity `news_mention` |

## Data model

One table, `NewsMention` (`@@map("news_mention")`) — article metadata denormalized
per mention. Articles mention few scholars each, so a separate `news_article`
table is not worth it in v1.

```prisma
model NewsMention {
  id            String            @id @default(uuid()) @db.VarChar(64)
  cwid          String            @db.VarChar(32)
  scholar       Scholar           @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  url           String            @db.VarChar(512)  // article URL (dedup key)
  title         String            @db.Text
  publishedAt   DateTime?         @map("published_at") // parsed "July 16, 2026"; NULL if unparseable
  excerpt       String?           @db.Text            // listing excerpt, optional
  thumbnailUrl  String?           @map("thumbnail_url") @db.VarChar(512)
  status        NewsMentionStatus @default(pending)
  source        String            @default("VIVO") @db.VarChar(32) // VIVO | NAME | CURATOR
  detectedName  String?           @map("detected_name") @db.VarChar(255) // the string matched (NAME source)
  likelihood    String?           @db.VarChar(8) // HIGH | MEDIUM | LOW (NAME source only)
  sourceRef     String?           @map("source_ref") @db.VarChar(768) // "<url>|<detectedName>" contested-group key
  showOnProfile Boolean           @default(true) @map("show_on_profile")
  enteredByCwid String?           @map("entered_by_cwid") @db.VarChar(32) // NULL for ETL, set for /edit actions
  createdAt     DateTime          @default(now()) @map("created_at")
  updatedAt     DateTime          @updatedAt @map("updated_at")

  @@unique([cwid, url])
  @@index([cwid, status, showOnProfile])
  @@map("news_mention")
}

enum NewsMentionStatus {
  published  // VIVO-linked (trusted) OR queue-approved -> renders on profile
  pending    // name-match candidate awaiting review
  rejected   // reviewer or scholar said "not this person" -> hidden, terminal
}
```

New migration dir `prisma/migrations/<ts>_add_news_mention/`. Follow the
`20260716162500_add_honor_model` shape.

Status semantics: **VIVO-linked → `published`** (identifier join is trusted, like
CTL). **Name-match → `pending`** (goes to the queue). `showOnProfile` is the
per-mention profile hide; `status=rejected` is the terminal "not me".

## Ingest — `etl/news/`

Mirror `etl/technologies/` file-for-file: `scrape.ts` (fetch + parse), `seed.ts`
(`NewsRow` type + validators, shared by seed and live), `index.ts` (`main()`
importer), `news.json` (checked-in fixture). Plus regenerator
`scripts/scrape-wcm-news.ts`. npm script `etl:news` → `tsx etl/news/index.ts`.

**Crawl (`scrape.ts`):**
1. Fetch listing `https://research.weill.cornell.edu/about-us/news-updates?page=N`,
   N from 0 upward. Regex out article slugs (`/about-us/news-updates/[a-z0-9-]+`),
   title, excerpt, thumbnail. Pin `NEWS_ORIGIN`.
2. **Incremental:** stop paging once a whole page's slugs are all already in
   `news_mention` (new articles land on page 0). Full backfill = a one-shot
   `scripts/scrape-wcm-news.ts --backfill` run, not the weekly job.
   `// ponytail: incremental top-crawl; --backfill for history, cap MAX_LISTING_PAGES`
3. For each **new** slug, fetch the detail page and parse:
   - `publishedAt` — date string (`July 16, 2026`).
   - VIVO cwids — `for href in hrefs: href.match(/cwid-([A-Za-z0-9]+)/)` (identical to CTL's `CWID_RE`). Lowercase.
   - Body text (title + article body, folded via the shared normalize path so mojibake/diacritics don't silently miss — see the mojibake memo).
4. Throw on markup-assumption breaks; never silently yield 0 (CTL discipline).

**Name-dictionary detection (`index.ts`, deterministic, no LLM):**
- Build a name index once per run from `Scholar` (cwid, firstName, lastName,
  primaryTitle, department): a surname→[cwid] map + a "first last"→[cwid] map,
  all normalized/folded.
- For each new article: intersect its tokens with the surname set (cheap gate),
  then for each matched surname gather candidate scholars and score a
  **likelihood**:
  - `HIGH` — "First Last" / "Dr. First Last" adjacent **and** surname unique in the roster.
  - `MEDIUM` — first+last both present but not adjacent, or full match on a surname shared by >1 scholar (all sharers MEDIUM).
  - `LOW` — surname only, first name absent, multiple candidates → all surface as a contested group.
  - Optional corroboration bump: +1 tier if the article text contains the scholar's `department` string. `// ponytail: dept-string contains-check; drop if it adds noise`
- Skip a name candidate if a VIVO-linked mention for the same (cwid, url) already exists (linked wins, no dup pending row).
- `// ponytail: O(scholars × new-articles) surname scan; Aho-Corasick only if the weekly run gets slow`

**Upsert (the load-bearing divergence from CTL):**
- Per (cwid, url): if absent, insert (VIVO→`published`, NAME→`pending`).
- If present, refresh title/date/thumbnail only. **Never** downgrade a
  `published`/`rejected`/`CURATOR` row back to `pending`, and never delete —
  human decisions and articles are permanent. No truncate.
- Record an `etlRun` row `source="News"`. Keep CTL's volume/no-op guards for the insert path.

## Profile display — `components/profile/news-section.tsx`

- `lib/api/profile.ts`: include news mentions `where status=published AND showOnProfile`, `orderBy publishedAt desc`, into `ProfilePayload.news[]`. Gate behind env `NEWS_MENTIONS_SECTION === "on"` **and** the per-scholar `hideNews` section-visibility toggle (mirror `AVAILABLE_TECHNOLOGIES_SECTION` / `hideTechnologies`). Unflagged → `[]`.
- `components/profile/profile-view.tsx`: mount a "News mentions" section when `profile.news.length > 0`, header link "View all WCM research news ↗". Cap ~5 rows then native `<details>` (CTL's `ROW_CAP` pattern). Each row: title (link), date, thumbnail, excerpt.

## Per-scholar `/edit` section — `components/edit/news-edit-card.tsx`

Unlike CTL's locked read-only card, this is interactive (user asked for an
editable section) but bounded — scholars can't add news, only curate what was scraped:
- Lists this scholar's `published` mentions with a per-row show/hide (`showOnProfile`) and a "Not me — remove" action (`status → rejected`).
- Section-level `hideNews` toggle.
- Surfaced when `NEWS_MENTIONS_SECTION` is on and the scholar has ≥1 mention; wire into `app/edit/scholar/[cwid]/page.tsx`, `app/edit/page.tsx`, `components/edit/edit-page.tsx` (same three gates as technologies).
- `pending` (name-match) rows are **not** shown here — approval lives in the admin queue only (mirrors honors: a scholar can't self-approve).

**Write API `app/api/edit/news-mention/route.ts`** — POST `{ action: "hide"|"show"|"reject", id }`, gate `authorizeOverviewWrite` (self or curator), one `$transaction`, `appendAuditRow(tx, { action: "news_mention_update", targetEntityType: "news_mention", fieldsChanged: [...] })`, post-commit `reflectOwnerProfile(cwid)`.

## Admin approval queue

Queue user = **superusers + external comms**. External comms is the existing
`comms_steward` role (`lib/auth/comms-steward.ts`) — despite its docblock's
"method-family" header it has grown into the broad editorial-curation capability
for the comms team, already gating appointment / overview / honors-entity /
methods / unit writes across all scholars, already paired into `EditSession` as
`isCommsSteward`, already a provisioned ED group. So **reuse it** — no new role,
no new LDAP group, no new cdk role wiring. (Contrast honors: its *queue* uses a
separate `honors_curator` because the Research Dean's office ≠ comms; news has no
such split — the approver IS comms.)

**Page `app/edit/news-queue/page.tsx`** — cross-scholar admin page (clone
`app/edit/honors-queue/page.tsx`). Gate `isSuperuser || isCommsSteward` + flag
`NEWS_APPROVAL_QUEUE === "on"` (off → 404). Tabs: **Pending** (working queue),
**Published**, **Rejected**. Loader/grouping in `lib/edit/news-queue.ts`.

- Group pending rows by `sourceRef` (`url|detectedName`). A group with >1
  candidate is **contested** → single-select "this is the one" showing each
  candidate's **name, title, department, likelihood**; a 1-candidate group is a
  plain approve/reject. (This is honors' `HonorQueueGroup` + `contested` logic.)
- Person filter (`faculty|affiliated|other|all`) and sort-by-likelihood reuse the honors controls if cheap; otherwise a flat by-article list. `// ponytail: skip CSV export + group-by-person until asked`

**Decision route `app/api/edit/news-mention/decision/route.ts`** — POST
`{ id, decision: "approve"|"reject" }`. Clone `honor/decision`:
- Gate `isSuperuser || isCommsSteward` (deliberately not `authorizeOverviewWrite` — its `self` leg would let a scholar approve a pending mention on their own profile).
- One `$transaction`: re-read inside txn; 409 if `status !== "pending"`.
- Approve → `published`; **reject all pending siblings sharing `sourceRef`** in the same txn (each its own audit row, one hoisted `ts` + shared `requestId`). Reject → `rejected`.
- `appendAuditRow` action `news_mention_update`; post-commit `reflectOwnerProfile` per affected cwid.

**Subnav:** add a `"news-queue"` tab + `pendingNews` badge to `components/edit/admin-subnav.tsx`.

**Ops dependency (not code):** ensure the external-comms staff are members of the
existing comms-steward ED group (`SCHOLARS_COMMS_STEWARD_GROUP_CN`, e.g.
`ITS:Library:Scholars/comms-steward-role`). If external comms must be a *distinct*
group from the current comms-steward members, that's the only case that needs a
new `lib/auth/news-curator.ts` + its own ED group + cdk wiring — otherwise reuse stands.

## Audit registration (the 5-place 500-trap)

`scholars_audit.manual_edit_audit` is raw SQL, and `appendAuditRow` INSERTs
inside the write txn — an unregistered enum throws MySQL 1265 and rolls back
**every** write (green tests, 500 at runtime). Register the new value in all of:

1. `lib/edit/audit.ts` → `AuditAction` union: add `news_mention_update`.
2. `lib/edit/audit.ts` → `AuditEntityType` union: add `news_mention`.
3. `scripts/sql/audit-log.sql` → `action` ENUM in the `CREATE TABLE` (~L126), appended last.
4. `scripts/sql/audit-log.sql` → `target_entity_type` ENUM in the `CREATE TABLE` (~L82), appended last.
5. `scripts/sql/audit-log.sql` → both idempotent `ALTER TABLE … MODIFY COLUMN` migrations at the bottom (action ~L258 **and** target_entity_type ~L293), appended last to preserve ENUM ordinals.

Then a **real-DB probe with a control** proving an approve/hide write doesn't
throw 1265 (a TS union alone typechecks clean and still 500s). Only
`news_mention_update` is needed — ingest writes directly and is not audited
(CTL ETL isn't either); there is no manual create/delete.

## Flags, scheduling, deploy

- **Flags:** `NEWS_MENTIONS_SECTION` (display) + `NEWS_APPROVAL_QUEUE` (queue). Wire **both per-env in `cdk/lib/app-stack.ts`** (flag parity — local-on/deployed-off is a silent bug), then regenerate the cdk snapshot (`cd cdk && npm test -- -u`, commit only `.snap`). Ships dark until a `cdk deploy Sps-App-<env>`.
- **ETL step:** add `NewsWeekly` to `cdk/lib/etl-stack.ts` (`external: true`, `tier: "continue"` so a WCM outage can't abort the chain) + an entry in `etl/orchestrate.ts` for the local prototype runner. Ships dark until an Sps-Etl deploy.
- **Migration:** apply `add_news_mention` (migration task rides the ETL image, as #1786 did).

## Tests (vitest, run PLAIN not `bash -lc`, `--maxWorkers=4`)

- `etl/news/scrape.test.ts` — against `news.json`: cwid extraction from VIVO href, date parse, name-dictionary hits + HIGH/MEDIUM/LOW likelihood tiers, mojibake-folded name still matches.
- `etl/news/index.test.ts` — **upsert preserves decisions**: seed a `rejected` and a `CURATOR` row, re-run import, assert neither reverts to `pending` (the divergence from CTL — mutation-test it).
- `app/api/edit/news-mention/decision` — approve one contested candidate rejects its siblings; 409 on non-pending.
- Run `vitest` before push (tsc+lint insufficient).

## Build order

0. **Branch:** `git fetch origin`; create the feature branch off fresh
   `origin/master` in a **worktree outside Dropbox** (this is multi-file work and
   the parked canonical checkout must not be switched). Budget the SPS worktree
   setup: `cp -Rc node_modules`, `npx prisma generate`, copy `.env*`.
1. Prisma model + enum + migration; `prisma generate`.
2. Audit registration (5 places) + DB probe — before any write route.
3. `etl/news/` scraper + importer + `news.json` fixture + tests.
4. `lib/api/profile.ts` gating + `news-section.tsx` + mount.
5. Per-scholar `/edit` card + `news-mention/route.ts`.
6. Admin `news-queue` page + `news-queue.ts` loader + `decision/route.ts` + subnav.
7. Flags in `app-stack.ts` + `etl-stack.ts` + `orchestrate.ts` + snapshot regen.
8. Verify: vitest green, then staging deploy + eyeball (local SPS can't visually verify /edit — staging only).

## Ponytail simplifications (and their ceilings)

- **One table, denormalized article metadata** — split `news_article`/`news_mention` only if article-level editing/dedup is needed.
- **Deterministic dictionary match, no LLM** — add Sonnet extraction only if name-variant recall proves too low.
- **Reuse `comms_steward` for the queue** — external comms IS the comms-steward editorial function; no new role/group/cdk. Mint a distinct `news-curator` role only if external comms must be a separate ED group.
- **Incremental top-crawl** — `--backfill` one-shot for history; weekly job never re-fetches 248 pages.
- **No CSV export / no group-by-person in v1** — add if reviewers ask.
