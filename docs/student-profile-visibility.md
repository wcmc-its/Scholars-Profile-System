# Doctoral-student profile visibility (FERPA carve)

**Answers:** *"Can I see student profiles?"* / *"Why don't doctoral students have a profile
page?"* / *"Is there a flag that turns students on?"*

**Status:** Live behavior, both environments. Policy = issue
[#536](https://github.com/wcmc-its/Scholars-Profile-System/issues/536) (CLOSED — "Option B:
hidden at launch" shipped). Last verified on staging **2026-06-12** (evidence below).

---

## TL;DR

- **No — doctoral students have no public profile**, and there is **no feature flag** that
  reveals them. Hiding is a property of the **data** (`scholar.deleted_at` is set on every
  student) enforced by **hardcoded query filters**, not a togglable flag. It behaves
  identically on staging and prod.
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

## The mechanism — `deleted_at` is the load-bearing gate

Every doctoral student carries a **soft-delete**: `scholar.deleted_at` is set (the #536
hide-flag), while `scholar.status` stays `active`. That single data fact is enforced at every
site where a profile link could be generated, because each site filters on `deletedAt: null`:

1. **Profile route → 404.** `lib/url-resolver.ts` (`resolveBySlugOrHistory`,
   `resolveByCwidOrAlias`) resolves only `where: { …, deletedAt: null, status: "active" }`. A
   soft-deleted student never resolves, so `components/profile/profile-view.tsx` calls
   `notFound()` → HTTP 404. (Slug-history and cwid-alias lookups apply the same filter, so an
   old slug/alias can't sneak a student back in.)

2. **People search + autocomplete → excluded at the query layer.** The people index source
   query is `PEOPLE_INDEX_WHERE = { deletedAt: null, status: "active" }`
   (`lib/search-index-docs.ts`). Students never enter the people index, so they don't appear
   in people search, browse, or autocomplete.

3. **Secondary role guard (belt-and-suspenders).** `etl/search-index/index.ts` and
   `profile-view.tsx` additionally call `isPubliclyDisplayed(roleCategory)`
   (`lib/eligibility.ts`), which suppresses the `doctoral_student` and `affiliate_alumni` role
   classes. **See the caveat below — for live data this check is effectively inert; the
   `deleted_at` soft-delete above is what actually does the work.**

### Caveat: the role-name carve does not match the live data

`HIDDEN_DISPLAY_ROLES` in `lib/eligibility.ts` contains the bare values `doctoral_student` and
`affiliate_alumni`. But the ED ETL writes **suffixed** role categories — the live staging data
is `doctoral_student_md`, `doctoral_student_phd`, `doctoral_student_mdphd` (the
`role_category` column is a free `VarChar(32)`). Those suffixed values are **not** in
`HIDDEN_DISPLAY_ROLES`, so `isPubliclyDisplayed("doctoral_student_md")` returns **`true`**.

Consequences:

- The role-based carve is **not** what hides students today. The **`deleted_at` soft-delete is
  the sole load-bearing guarantee** — and it holds, because every student row has it set.
- The **`#847` export `profile_url` blanking** (table above) goes through the *same*
  `isPubliclyDisplayed(roleCategory)` call, so it is inert for suffixed roles for the same
  reason — like the role guard, the blanking actually fires because the soft-deleted student
  never reaches the export's `deletedAt: null` cohort, not because the role name is matched.
- **Latent fragility:** if a student's `deleted_at` were ever cleared while keeping a suffixed
  `doctoral_student_*` role, the role guard would *not* catch them and the profile would
  render. The safe invariant to preserve is "every hidden-role scholar stays soft-deleted,"
  which the ED ETL maintains. (A hardening option is to match `doctoral_student*` by prefix in
  `isPubliclyDisplayed`; not done here — flagged for awareness.)

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

## Verification (staging, 2026-06-12)

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

**Conclusion:** 1,875 doctoral students, all soft-deleted, **zero** in a displayable state;
every tested student route 404s. No flag flip changes this.

### How to re-verify

- **Live route:** `curl -s -o /dev/null -w '%{http_code}\n' https://scholars-staging.weill.cornell.edu/<student-slug>` → expect `404`.
- **Data invariant:** the "displayable hidden role" count must stay **0**:
  `SELECT COUNT(*) FROM scholar WHERE (role_category LIKE 'doctoral%' OR role_category='affiliate_alumni') AND deleted_at IS NULL AND status='active';`
- **Code:** `lib/url-resolver.ts` (resolver `deletedAt: null` filter), `lib/search-index-docs.ts`
  (`PEOPLE_INDEX_WHERE`), `lib/eligibility.ts` (`isPubliclyDisplayed` / `HIDDEN_DISPLAY_ROLES`),
  `components/profile/profile-view.tsx` (`notFound()` call).

---

## Related

- `lib/eligibility.ts` — `PUBLICLY_DISPLAYED_ROLES`, `HIDDEN_DISPLAY_ROLES`, `isPubliclyDisplayed`.
- `docs/kb/01-scholars.md` — user-facing FAQ ("I'm a doctoral student — where's my profile?").
- `docs/outreach/wave3-doctoral-students.md` — the "hidden at launch" comms note + open WCGS privacy question.
- `ADR-005-manual-override-layer.md`, `docs/self-edit-spec.md` — suppression as the urgent (sub-cycle) form of the same FERPA/HIPAA carve.
- Issues: **#536** (the hide policy), **#718** (author-less publication rows), **#847** (export blanks student `profile_url`).
