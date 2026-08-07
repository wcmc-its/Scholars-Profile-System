# Doctoral-student profile visibility (FERPA carve)

**Answers:** *"Can I see student profiles?"* / *"Why don't doctoral students have a profile
page?"* / *"Is there a flag that turns students on?"*

**Status:** Live behavior, both environments. Policy = issue
[#536](https://github.com/wcmc-its/Scholars-Profile-System/issues/536) (CLOSED — "Option B:
hidden at launch" shipped). Last verified on staging **2026-06-12** (evidence below).

---

## TL;DR

- **No — doctoral students have no public profile**, and there is **no feature flag** that
  reveals them. Hiding is enforced by **hardcoded query filters**, not a togglable flag.
- ⚠️ **The two environments hide them by different mechanisms.** On **staging**, every student
  is soft-deleted (`scholar.deleted_at` set) *and* carries a suffixed role, so `deleted_at`
  does the work. On **prod**, 690 students carry the bare `doctoral_student` with
  `deleted_at IS NULL`, so the **role carve is the only gate** — and it failed open on display
  labels until #2202. This doc asserted "identical on staging and prod" until 2026-08-05; it
  was wrong, and the wrongness is why 684 students were published by name. **Verify this carve
  against prod data shape; a staging pass proves nothing.**
- The flag people reach for — `SEARCH_REQUIRE_DISPLAYABLE_AUTHOR` — is **off**, but it does
  **not** govern profile visibility. It only affects whether a student's *publication* rows
  are kept in the publications search index (issue
  [#718](https://github.com/wcmc-its/Scholars-Profile-System/issues/718)). See
  [Publications are a separate question](#publications-are-a-separate-question).
- To view or manage a specific student, superusers use `/edit`, not the public profile route.

---

## Why — the FERPA-driven activities

Scholars launches as a **faculty-and-research-staff** directory. Doctoral students are an
**enrolled-student population**, and a public, search-indexed profile page assembled from
their enrollment / program data is exactly the kind of disclosure the **Family Educational
Rights and Privacy Act (FERPA, 20 U.S.C. § 1232g)** governs: publishing education-record-derived
information (enrollment status, program, advisor relationship) to directed public traffic
without student consent. WCM's launch decision (#536, "Option B") is therefore to treat
doctoral students as a **hidden identity class** — kept off every directed-traffic surface —
rather than to publish thin or opt-out-gated student pages.

This is the same compliance bucket that makes **suppression** an urgent, sub-cycle operation
elsewhere in the system: ADR-005 names "retraction, FERPA/HIPAA exposure, harassment" as the
trigger cases that cannot tolerate a stale edge cache (`ADR-005-manual-override-layer.md`
§ search urgency). Student hiding is the *standing* form of that same FERPA concern, applied
to a whole population at the data layer.

**FERPA-driven activities, concretely:**

| Activity | What FERPA requires here |
|---|---|
| Public profile route (`/[slug]`, `/scholars/by-cwid/[cwid]`) | Students must `404`, not render. |
| People search + autocomplete | Students must not be indexed or suggested. |
| `/browse`, algorithmic home, Top-scholars chip row | Students must not be surfaced or ranked. |
| Internal-only scholar-list CSV export | Doctoral-student `profile_url` is blanked (`#847`). |
| Relational mentions (PI's PhD-mentee list, co-author chips) | Name may render as **plain text only** — never a clickable/searchable profile link. |
| Suppression of an *already-public* scholar later flagged FERPA/HIPAA | Sub-cycle removal from search + CDN invalidation (ADR-005, self-edit-spec). |

> Open compliance question carried in `docs/outreach/wave3-doctoral-students.md` (Q2): whether
> WCGS wants the plain-text mentee / co-author mentions addressed explicitly. Names there are
> visible but non-linked and non-searchable.

---

## The mechanism — `deleted_at` is the load-bearing gate **on staging only**

> **Correction, 2026-08-05 (#2202).** Everything below this heading was measured on
> **staging** and does **not** hold in production. On staging every doctoral student
> carries a *suffixed* role (`doctoral_student_md` etc.) **and** a soft-delete, so
> `deleted_at` does all the work and the role guard is inert. **On prod, 690 students
> carry the bare `doctoral_student` with `deleted_at IS NULL`** — the exact inverse.
> There, the role guard is the *only* gate, and it was failing open on display labels,
> publishing 684 students by name on public unit rosters. Read the staging census in
> "Verification" as a staging fact, never as an invariant: prod violates it 690 times.
> A fix validated on staging proves almost nothing about this carve.

Every doctoral student carries a **soft-delete**: `scholar.deleted_at` is set (the #536
hide-flag), while `scholar.status` stays `active`. That single data fact is enforced at every
site where a profile link could be generated, because each site filters on `deletedAt: null`:

1. **Profile route → 404.** `lib/url-resolver.ts` (`resolveBySlugOrHistory`,
   `resolveByCwidOrAlias`) resolves `where: { …, deletedAt: null, status: "active",
   ...publicRoleWhere() }` and then re-checks the RAW `role_category` through
   `isPubliclyDisplayed`. **Since #2268 the carve lives in the resolver**, not only at render
   in `components/profile/profile-view.tsx` — both resolvers feed anonymous routes that
   `permanentRedirect()`, and slugs are name-derived, so a resolved row left the building as a
   student's NAME in the `Location` header before any render-time guard ran. A hidden student
   now returns `not-found`, identical to a slug/CWID that never existed, so `/scholars/[slug]`,
   `/[slug]` and `/scholars/by-cwid/[cwid]` all 404 with no existence oracle. (Slug-history and
   cwid-alias lookups apply both layers too, so an old slug/alias can't sneak a student back
   in; the `/scholars/{slug}/co-pubs*` child routes carry the same pair.)

2. **People search + autocomplete → excluded at the query layer.** The people index source
   query is `PEOPLE_INDEX_WHERE` (`lib/search-index-docs.ts`). **Since #2202 it carries the
   role carve too**, not just `{ deletedAt: null, status: "active" }` — because the
   soft-delete half alone left a hole: `buildScholarOps` (`lib/edit/search-suppression.ts`)
   re-indexes whatever passes this clause, so an /edit reflect on a *prod* student (bare
   role, no soft-delete) would have put them back into the people index.

3. **The role guard — belt-and-suspenders on staging, the SOLE gate on prod.**
   `etl/search-index/index.ts` and `profile-view.tsx` call `isPubliclyDisplayed(roleCategory)`
   (`lib/eligibility.ts`), which suppresses `doctoral_student*` (prefix) and
   `affiliate_alumni`. It is inert on staging only because everything there is also
   soft-deleted. **Do not treat it as redundant.** Since #2202 it also **fails closed** on any
   unrecognized value, so feeding it a humanized label de-links a row instead of leaking one.

### Caveat (RESOLVED — kept because the reasoning here was wrong twice)

This section used to say the suffixed roles (`doctoral_student_md` / `_phd` / `_mdphd`) escaped
`HIDDEN_DISPLAY_ROLES`, and concluded that the `deleted_at` soft-delete was therefore "the sole
load-bearing guarantee." Both halves have since been overtaken:

- **#1026** replaced the exact-match check with a `doctoral_student*` **prefix** match, so every
  suffixed variant is caught. The predicate is no longer inert on role name.
- **#2202** disproved the conclusion. "Soft-delete is the sole guarantee" was a *staging*
  observation. Prod has 690 students with `deleted_at IS NULL`, so the role guard is the only
  thing standing between them and a public profile link — and it was being handed a display
  label (`"Doctoral student"`), which it did not recognize and therefore let through.

The invariant to preserve is **not** "every hidden-role scholar stays soft-deleted" — prod has
never satisfied it. It is: **the role carve must hold on its own, with no help from
`deleted_at`.** Two mechanisms enforce that now: `isPubliclyDisplayed` fails closed on anything
it does not recognize, and `PEOPLE_INDEX_WHERE` carries the carve in the query itself
(`HIDDEN_ROLE_CATEGORIES`). Never pass `formatRoleCategory` output to an eligibility predicate;
the loaders carry `roleCategoryRaw` alongside the label for exactly this reason.

Note the **#847** export `profile_url` blanking reads the same predicate, so it inherits both.

---

## Publications are a separate question

Hiding a *student's profile* does **not** drop the *publications* they co-authored. By default
their papers remain in the publications search index; only the **author line** is filtered (a
soft-deleted author is removed from the rendered byline). A paper whose *only* WCM authors are
soft-deleted students therefore persists as an **author-less row** — issue #718.

The lever for that is `SEARCH_REQUIRE_DISPLAYABLE_AUTHOR`
(`isRequireDisplayableAuthorEnabled()`, `lib/search-index-docs.ts`):

- **Default `off`**, and **not wired into the CDK app-stack** for either environment — it is
  operator-set in the search-index ETL env and applied via reindex-then-flip.
- When `on`, `buildPublicationDoc` drops a publication whose displayable WCM author set is
  empty (with a keep-rule exception for `affiliate_alumni`, so alumni papers are retained).
- It does **nothing** to profile visibility. Flipping it on does not reveal any student; it
  only removes author-less publication rows from search.

So: *student profiles* are hidden unconditionally (data + hardcoded filters); *student
publications* are governed by a flag that is currently off.

---

## Verification (staging, 2026-06-12) — **staging-only; prod contradicts it**

Read-only query against the staging Aurora DB (one-off `ecs run-task` on `sps-etl-staging`,
see `project_sps_prod_db_readonly_query`) and live `curl` against
`scholars-staging.weill.cornell.edu`:

```text
Role breakdown (hidden classes):                    all soft_deleted=1
  doctoral_student_md     1236   (642 suppressed + 594 active)
  doctoral_student_phd     495
  doctoral_student_mdphd   144
  ────────────────────────────
  total                   1875   — every row has deleted_at set

Hidden-role scholars in a *displayable* state
  (deleted_at IS NULL AND status='active'):            0

Live routes:
  GET /aisha-ahmad-al-hammadi            → 404   (doctoral_student_md, aaa4003)
  GET /scholars/by-cwid/aaa4003          → 404
  GET /abdulla-a-al-hashmi               → 404   (doctoral_student_md, aaa4004)
  GET /            (control, faculty home)→ 200
```

**Conclusion (staging):** 1,875 doctoral students, all soft-deleted, **zero** in a displayable
state; every tested student route 404s. No flag flip changes this.

**Prod, 2026-08-05 (#2202):** the same query returns **690**, not 0 — bare `doctoral_student`,
`deleted_at IS NULL`, `status='active'`. The displayable-hidden-role invariant below is a
staging property, not a system property. Run it against **both** environments or it will
mislead you.

### How to re-verify

- **Live route:** `curl -s -o /dev/null -w '%{http_code}\n' https://scholars-staging.weill.cornell.edu/<student-slug>` → expect `404`.
- **Data invariant:** the "displayable hidden role" count must stay **0**:
  `SELECT COUNT(*) FROM scholar WHERE (role_category LIKE 'doctoral%' OR role_category='affiliate_alumni') AND deleted_at IS NULL AND status='active';`
- **Code:** `lib/url-resolver.ts` (resolver `deletedAt: null` filter), `lib/search-index-docs.ts`
  (`PEOPLE_INDEX_WHERE`), `lib/eligibility.ts` (`isPubliclyDisplayed` / `HIDDEN_ROLE_CATEGORIES`),
  `components/profile/profile-view.tsx` (`notFound()` call).

---

## Related

- `lib/eligibility.ts` — `PUBLICLY_DISPLAYED_ROLES`, `HIDDEN_ROLE_CATEGORIES`, `isPubliclyDisplayed`.
- `docs/kb/01-scholars.md` — user-facing FAQ ("I'm a doctoral student — where's my profile?").
- `docs/outreach/wave3-doctoral-students.md` — the "hidden at launch" comms note + open WCGS privacy question.
- `ADR-005-manual-override-layer.md`, `docs/self-edit-spec.md` — suppression as the urgent (sub-cycle) form of the same FERPA/HIPAA carve.
- Issues: **#536** (the hide policy), **#718** (author-less publication rows), **#847** (export blanks student `profile_url`).
