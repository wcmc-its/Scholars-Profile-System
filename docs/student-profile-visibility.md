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
| Relational mentions (PI's PhD-mentee list, co-author chips, the **Mentoring-activity** search facet) | Name may render as **plain text only** — never a clickable/searchable profile link. See [The Mentoring-activity facet](#the-mentoring-activity-facet-search). |
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

### The role-name carve now prefix-matches the live data (hardened in #1026)

`HIDDEN_DISPLAY_ROLES` in `lib/eligibility.ts` holds the bare values `doctoral_student` and
`affiliate_alumni`, but the ED ETL writes **suffixed** role categories — the live data is
`doctoral_student_md`, `doctoral_student_phd`, `doctoral_student_mdphd` (the `role_category`
column is a free `VarChar(32)`). Those suffixed values were **not** in `HIDDEN_DISPLAY_ROLES`, so
`isPubliclyDisplayed("doctoral_student_md")` historically returned **`true`** (fail-open).

**Fixed in #1026:** `isPubliclyDisplayed` now treats any `doctoral_student*` role as hidden by
prefix, so the suffixed students correctly resolve non-displayable. This was a prerequisite for
the non-linked co-author chips (below) — without it a surfaced student chip would have linked to
a 404 profile — and it incidentally closes the same fail-open in the `#847` export `profile_url`
blanking. Notes:

- `deleted_at` remains the **primary** load-bearing gate (every student row has it set); the
  role-prefix check is now a correct belt-and-suspenders rather than a fail-open. The safe
  invariant is still "every hidden-role scholar stays soft-deleted," which the ED ETL maintains.
- `affiliate_alumni` stays exact-match — alumni are soft-deleted by the ED ETL, so the
  `deleted_at` gate already covers them; no suffixed alumni roles are written.

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

### The Mentoring-activity facet (search)

The Publications tab carries a **Mentoring activity** facet
(`?mentoringProgram=md|mdphd|phd|postdoc|ecr`) that narrows the result set to publications
co-authored by a known WCM mentor and one of their mentees (`lib/api/mentoring-pmids.ts`, applied
as a `post_filter` in `searchPublications`). The mentees are the same enrolled-student population
hidden everywhere else:

- **#1026 surfaces the mentee as a non-linked chip.** Historically `fetchWcmAuthorsForPmids`
  filtered `scholar: { deletedAt: null, status: "active" }` (`lib/api/topics.ts`), dropping the
  soft-deleted mentee from the chip row — so under "MD mentee" a co-pub looked like an ordinary
  mentor publication and the facet appeared not to work. **#1026** includes soft-deleted *active*
  doctoral students in that hydration and renders them via the existing `#536` non-linked chip
  path (name + headshot, **no profile link, no navigating popover, never faceted/searchable** —
  enforced by the prefix-hardened `isPubliclyDisplayed` above). Site-wide (search, topic feeds,
  methods pages, home spotlight). Gated behind `COAUTHOR_HIDDEN_STUDENT_CHIPS`, **default-off**,
  enabled per-environment only after the WCGS question in
  `docs/outreach/wave3-doctoral-students.md` (Q2). With the flag off, behavior is byte-identical
  (every hidden-class scholar has `deleted_at` set, so the relaxed hydration matches no one new).
- **The mentee's name also appears as plain text elsewhere**, consistent with the
  relational-mention carve above: in the publication detail modal's full PubMed byline
  (`fullAuthorsString`) and on the mentor's co-pubs page
  (`/scholars/<slug>/co-pubs/<menteeCwid>`, rendered as a `<span>`, never a link).

The **export** of this facet was a separate bug (**#1025**): the CSV / Word export silently
dropped the mentoring (and department) filter and returned the full corpus. It now matches the
live result set; its authorship rows still exclude soft-deleted mentees via the same
`deletedAt: null` cohort as the byline.

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
- Issues: **#536** (the hide policy), **#718** (author-less publication rows), **#847** (export blanks student `profile_url`), **#1025** (publications export now honors the Mentoring-activity + Department filters), **#1026** (surface the mentee as plain text on Mentoring-activity search rows).
