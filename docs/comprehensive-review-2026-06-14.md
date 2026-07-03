# Comprehensive Review — Scholars Profile System

**Date:** 2026-06-14
**Reviewer:** multi-agent code review (25 finder agents + adversarial verifiers + synthesis)
**Scope (as requested — "review everything"):**
1. **Merged-master work** — the 331 files / +31K −2.8K merged into `origin/master` (`f6305d52`) across the ~82 commits since this branch diverged at `5cac2795`. Reviewed via `git diff 5cac2795..origin/master` (the working tree is the stale branch, 82 commits behind).
2. **Untracked working tree** — 10 spec docs, 5 HTML mockups, 1 new test.
3. **Stale branch** `feat/edit-superuser-parity` — 5 commits, supersession + delete-safety check.

**Headline:** No critical or high-severity *security* defects survived adversarial verification. Code health is fundamentally sound; the security-sensitive issues all **fail closed** and the riskiest behaviours are **dark behind off-by-default flags** in prod. The real findings cluster into three themes (below). The single largest non-code risk is **documentation drift** — a set of specs describe shipped work as pending and, in one case, actively misdescribe a shipped security boundary.

Verified finding counts (post-adversarial-verification, refuted dropped): **3 medium, 16 low, 4 info** code findings + **39** spec/doc findings, plus the `coi-gap` engine (§5, all low after verification).

## Tracking (issues filed 2026-06-14)

| Finding | Issue | PR |
|---|---|---|
| import-copubs empty-export floor guard | [#984](https://github.com/wcmc-its/Scholars-Profile-System/issues/984) | **[#992](https://github.com/wcmc-its/Scholars-Profile-System/pull/992)** ✅ |
| methods-lens tier change / ISR staleness | [#985](https://github.com/wcmc-its/Scholars-Profile-System/issues/985) | **[#993](https://github.com/wcmc-its/Scholars-Profile-System/pull/993)** ✅ |
| comms_steward parity reconciliation (4 asymmetries) | [#986](https://github.com/wcmc-its/Scholars-Profile-System/issues/986) | — |
| Decision: comms_steward suppression/takedown scope | [#987](https://github.com/wcmc-its/Scholars-Profile-System/issues/987) | — |
| coi-gap incremental ETL deletion blind spot | [#988](https://github.com/wcmc-its/Scholars-Profile-System/issues/988) | — |
| methods-lens scholarCount over-count / dup chips | [#989](https://github.com/wcmc-its/Scholars-Profile-System/issues/989) | — |
| Docs: reconcile stale specs / dead test | [#990](https://github.com/wcmc-its/Scholars-Profile-System/issues/990) | — |
| Low cleanup batch (13 items) | [#991](https://github.com/wcmc-its/Scholars-Profile-System/issues/991) | — |
| VIVO runbook account guard | comment on [#945](https://github.com/wcmc-its/Scholars-Profile-System/issues/945) | — |

The two `high` fixes (#984/#985) are implemented in PRs #992/#993 (review-only, not merged).

---

## 1. Branch verdict — `feat/edit-superuser-parity` is safe to delete

**Fully superseded: YES. Safe to delete: YES** — after salvaging one doc.

All 36 changed files were classified by content-hash against `origin/master`:
- 12 files are **byte-identical** to master.
- 23 code/test files differ, but in **every** case master holds the **newer, superseding** version (HEAD-vs-master diffstat is 368 insertions / **1351 deletions** — master has strictly more). The branch's "additions" are older predecessor fragments master rewrote: `coi-gap-card.tsx` (branch = old binary dismiss/restore; master = full 3-way #944/#953), `highlights-card.tsx` (branch = `startManual/revertToAi`; master = 529-line auto/savedManual + superuser parity), `lib/edit/authz.ts` (branch lacks `ed_locked`, which is in 10 master files), the `#906` center-facet predecessor, the `#887` COI S3 import bridge.
- `package.json`: the branch is strictly **behind** (missing the email-visibility, steward-names, mentoring-bridge, family-review scripts master has). It introduces no script master lacks.
- The only three identifiers not on master (`setDismissedFlag`, `startManual`, `revertToAi`) are exactly the old internal names the successors replaced — **no feature is lost.**

**The one non-superseded artifact:** `docs/student-profile-visibility.md` (added in HEAD commit `f637556c`, never merged). It is **accurate and useful** (verified against master): the FERPA framing is sound, and its central caveat — that `HIDDEN_DISPLAY_ROLES` uses an exact `Set.has()` so the live **suffixed** values (`doctoral_student_md/phd/mdphd`) don't match, leaving `deleted_at` as the sole load-bearing gate — remains true today.

> **Action:** preserve/relocate `docs/student-profile-visibility.md` (cherry-pick `f637556c`, or just that file), then delete the branch. One nit in the doc: the `#847` export `profile_url` blanking uses the *same* `isPubliclyDisplayed(roleCategory)` call the doc itself flags as inert for suffixed roles — add a one-line note that, like the role guard, the blanking relies on `deleted_at` to actually fire.

---

## 2. Cross-cutting themes & top risks (synthesis)

**Overall assessment:** *Not structural rot — the predictable seams of fast parallel feature work.* The security-sensitive defects fail closed; the team's architectural instincts are good (the email-visibility uncacheable-reveal island and the sibling-ETL floor guards show the right patterns already exist). The dominant problem is **uneven application of a decision made in one place and not propagated everywhere**: a multi-PR role-parity rollout left five surface-by-surface asymmetries; one ETL importer never got its siblings' safety guard; one cache-invalidation hook is missing on a visibility write. Almost every fix is small and localized.

### Themes
1. **Comms_steward / superuser-parity widened unevenly.** `lib/edit/authz.ts` + `edit-page.tsx` were widened, but some routes, props, nav tabs, and copy strings still assume self-only or superuser-only → broken/leaky role surfaces.
2. **Visibility-control vs edge-caching seam.** Viewer-dependent or revocable values served through path-cached/ISR surfaces. The methods-lens tier change doesn't invalidate the 6h-ISR `/methods` pages; the *draft* email-visibility spec would have re-introduced a cache leak (the shipped code got it right).
3. **ETL full-refresh importers inconsistent on destructive-write safety.** `import-copubs` lacks the empty-export floor guard its three siblings have; `import-citing` uses a non-transactional delete+create unlike `import-aoc`.
4. **Specs pervasively stale vs shipped code** (see §4) — the duplicate-work / "check if already done" failure mode, plus one security-boundary mis-description.
5. **Latent data-integrity assumptions that hold only for current data** (A2 1:1 label↔family_id, lowercase snake_case supercategory, a backfill `--limit` that's silently ignored on writes) — none active today, none documented as load-bearing.

### Top risks (ranked)
| # | Sev | Risk | Status |
|---|-----|------|--------|
| 1 | **high** | `import-copubs.ts` can **silently wipe the entire `mentee_copublication` table** on a 0-row S3 artifact (delete-stale runs after a no-op upsert; only a `console.warn`, no floor guard / `--allow-empty`, unlike all 3 siblings). | Flag-gated import-then-flip; becomes live the moment a steady-state re-import hits a bad/empty/wrong-key export. **Fix promptly.** |
| 2 | **high** | Methods-lens **tier change does not invalidate the 6h-ISR `/methods` page cache** → a freshly-hidden (suppressed/`#801`-sensitive) family stays publicly reachable up to 6h via the static shell. | Dark in prod (`METHODS_LENS_PAGES` off). **Must close before that surface goes live.** |
| 3 | medium | comms_steward shipped with **full publication takedown/suppression-lift parity** — the exact compliance-adjacent power the spec's §3/§6/§7 said to *deny* — with the spec's "Open confirm before PR B" caveat never recorded as resolved. | Dark (`COMMS_STEWARD_ENABLED`). **Operator-confirm before flipping.** |
| 4 | medium | Overview generator on `/edit/scholar/[cwid]` reads the **viewer's own** pubs/funding/draft-history (source GETs are session-self-keyed), and the source picker is inert. Saved draft is correctly grounded on the target (no content leak). | Dark (`SELF_EDIT_OVERVIEW_GENERATE`). |
| 5 | medium | COI-gap is **rendered + interactive for comms_steward but all three write routes (dismiss/feedback/restore) 403** `not_self`. The route denial is **intended** (spec: COI must be denied at the route, not just the UI); the bug is the UI surfaces controls. Fails closed. | Dark (`SELF_EDIT_COI_GAP_HINT` + `COMMS_STEWARD_ENABLED`). |
| 6 | medium | **Pervasive stale specs** labeled "awaiting approval / no code written" + resolved decisions framed as open, incl. a security boundary. | Doc hygiene — see §4. |
| 7 | medium | **VIVO cleanup runbook** issues irreversible AWS deletes with **no account/profile guard** in the runnable commands (multi-account env, live shell creds). | Add pre-flight `sts get-caller-identity` assert before handing to operator. |

### Integration concerns
- The comms_steward + parity work spanned #963/#964 (authz), #836/#877/#881 (COI-gap), #742/#765 (overview), #941/#977 (nav). Widening was applied **surface-by-surface, not through one capability gate** → five asymmetries that only appear when the roles combine (COI-gap routes never widened; overview GETs session-keyed; CoiCard self-only copy/href; Profiles tab missing on `/edit` + `/edit/units`; the spec-prescribed single capability object was made additive instead of replacing `superuserSurfaces`). **Reconcile these together against `lib/edit/authz.ts` as the single source of truth before the flags flip.**
- Any new viewer-dependent / revocable visibility signal must follow the **email-visibility pattern** (uncacheable island / explicit invalidation). The methods tier route is the outstanding instance.
- Normalize the bridge importers (`#443/#926/#930/#933/#938`) to one safe full-refresh pattern (pre-delete empty floor + `--allow-empty` + transactional swap).

---

## 3. Code findings by dimension (merged-master)

> Severity shown as `claimed→adjusted` where the verifier re-rated. `verdict=confirmed` = adversarially verified against current `origin/master`. `verdict=unverified` = low/info (not sent to adversarial verify).

### edit-surface (5)
- **`medium→low` · integration · confirmed** — COI-gap interactive for comms_steward but all three routes (dismiss/feedback/restore) 403 `not_self`. (Top-risk #5; corroborated + refined by §5 coi-gap engine review.) Loader `app/edit/scholar/[cwid]/page.tsx:167` includes COI-gap for `isCommsSteward`; card renders full 3-way buttons (childMode collapses to `superuser`); the routes authorize only `isGenuineSelf || isGenuineSuperuser`. **Fix direction settled: hide it in the UI** — drop `isCommsSteward` from the `includeCoiGap` gate. The route 403 is **intended and correct** (the comms-steward spec mandates COI be denied at the route, not just the UI), so do *not* widen the routes. (Highlights/Publications/Overview/reject were deliberately widened; COI-gap deliberately is not — the asymmetry is in the UI gate, not the routes.)
- **`medium` · integration · confirmed** — Overview generator on superuser/comms_steward surface loads the **viewer's** pubs/funding/draft-history; source picker inert. (Top-risk #4.) `edit-page.tsx:573` widened `generateEnabled` to `isSuperuserLike`, but `OverviewCard` never receives `mode`, and `source-options`/`generations` GETs are `loadOverviewSourceOptions(session.cwid)` (the superuser's own cwid). Saved draft *is* correctly grounded on the target. **Fix:** either revert to self-only, or thread the target cwid + add `entityId` to the two GET routes authorized by `authorizeOverviewWrite`.
- **`low` · integration** — `CoiCard` "Review suggestions" bridge fires in superuser mode with hardcoded `/edit?attr=coi-gap` href (the *superuser's* own page) + self-only "Visible only to you" copy. Root cause: a stale `edit-page.tsx` comment ("unmatchedPubmedCoi is [] for superuser") is no longer true. **Fix:** point `suggestionsHref` at `${basePath}?attr=coi-gap` and pass `childMode` to reframe copy.
- **`low` · integration** — comms_steward **loses the Profiles tab** on `/edit` self-edit surface (and `/edit/units`) but gets it on `/edit/scholars` + `/edit/methods` → inconsistent unified nav. **Fix:** pass `profilesTab={commsSteward || canBrowseProfiles}` in `app/edit/page.tsx` + `app/edit/units/page.tsx`.
- **`low` · quality** — center-roster inline-edit per-row write queue reverts the **whole row** snapshot on a partial failure, dropping a sibling field's optimistic value. Edge case; reconciles on reload. **Fix:** revert only the failed field's keys.

### auth-authz-security (3)
- **`low` · quality** — comms_steward grants **full publication takedown parity** (`authorizeSuppress`/`authorizeRevoke` short-circuit on `isCommsSteward`, incl. whole-publication `contributorCwid===null` takedown + lifting *any* scholar's suppression), contradicting the spec's least-privilege §3/§6/§7. Dark + documented as a decision → not a bug, but a deliberate blast-radius increase whose "Open confirm before PR B" caveat was never resolved. (Top-risk #3.) **Fix:** operator-confirm before `COMMS_STEWARD_ENABLED` in prod, or carve suppression out to superuser-only.
- **`low` · security** — Overview generator surfaces a target's `#801`-**sensitive** method families to any authorized non-owner editor (`loadScholarMethodFamilies` ignores the sensitivity gate; docstring says "owner-facing" but authz now admits superuser/comms_steward editing *anyone*). `#800` suppression overlay *is* applied; `#801` sensitivity carve is not. Mitigated: trusted internal viewers under `#866`, reviewed before save, flag-gated. **Fix:** reconcile the docstring's owner-only assumption with the widened authz, or apply the `#801` filter when `realCwid != target`.
- **`info` · quality** — `IMPERSONATION_TTL` captured at module load despite "read at call time" docstring. No prod impact (8h cookie `exp` is the hard cap); only the documented test affordance is false. **Fix:** read inside `impersonationActive`, or correct the docstring.

### methods-lens (2)
- **`medium` · integration · confirmed** — Tier change (suppress/sensitive) doesn't invalidate the 6h-ISR `/methods` pages → freshly-hidden family publicly reachable up to 6h. (Top-risk #2.) Every `/methods` route is `revalidate=21600`; the tier route has **zero** `revalidatePath`/CloudFront purge. The verifier explicitly tested and **rejected** the "Next 15 deopts DB routes to ƒ" hypothesis — it does not apply here (no dynamic API in these routes). **Fix:** `revalidatePath` + CloudFront purge on the tier route (the `#961` await-in-request pattern), or switch `/methods` pages to `force-dynamic` (data layer is already per-request overlay-gated) until purge-on-edit is wired. Document the invalidation contract next to the "never cached" claim in `methods-overlay.ts`.
- **`low` · data-integrity** — `aggregatePublicFamiliesForUnit`/`buildFamilyRoster` `scholarCount` can **over-count** because `groupBy(['supercategory','familyLabel'])._count.cwid` is NOT the table's unique key (`@@unique([cwid, familyId])`). Latent: depends on A2 ever emitting two `family_id`s for one scholar sharing a `(label,supercategory)`. Same shape → duplicate per-row chips (consumers `slice(0,3)` without dedup by `value`). **Fix:** count distinct cwids, or collapse dup rows in the mapper, or add an ETL data-health counter.

### search (1)
- **`low` · a11y** — `#298` concept-fallback SR announcement uses an **SSR-mounted** `aria-live` region that appears together with its text → polite live regions reliably announce only content mutating *after* the region exists; many SR/browser pairs won't announce the simultaneous insert. **Fix:** render a persistent empty live region higher in the tree and write the count on swap, or verify with VoiceOver+NVDA.

### org-units-rosters (4)
- **`low` · correctness** — `browse.ts` external-leader name fallback omits the `cwid===chairCwid` guard `departments.ts` enforces → browse card could show a stale external name the detail page wouldn't. Tiny blast radius (one entry, jos7021). **Fix:** mirror the guard.
- **`low` · bug** — Filtered roster deep-link doesn't restore `?page=` on mount (`department-faculty-client.tsx:70` writes `page` but the mount-seed effect never reads it). **Fix:** seed `fetchPage` from `?page=`.
- **`low` · correctness** — Members-API `METHOD_KEY_RE = /^[a-z0-9_]+::.+$/` hard-requires lowercase snake_case supercategory, but the column is a free `VarChar(128)` ("Open set; guard, don't hard-enum"). A future non-lowercase supercategory would be offered in the facet but 400 on select. **Fix:** loosen to `/^[^:]+::.+$/`.
- **`info` · data-integrity** — Curated dept names: both **N1220 (Dermatology)** and **N1360 (Ophthalmology)** labeled "Englander" — a copy/paste-error smell. CREATE-only columns, so a wrong seed persists. **Action:** confirm with Communications; if wrong, fix seed + re-run the backfill.

### mentoring-bridge (3)
- **`high→medium` · data-integrity · confirmed** — `import-copubs.ts` lacks the empty-export floor guard → 0-row artifact **wipes the entire `mentee_copublication` table**. (Top-risk #1.) Siblings `import-aoc`/`import-copub-list`/`import-citing` all have this guard; this oldest importer was never retrofitted. **Fix:** add `--allow-empty` parse + `if (!dryRun && rows.length===0 && !allowEmpty) throw` *before* the delete-stale.
- **`low` · data-integrity** — `import-citing` is a **non-transactional** `deleteMany`+`createMany` (unlike `import-aoc`'s `$transaction`). On a steady-state re-import, once the first batch commits, the existence probe returns true so cited papers transiently render "cited by 0" instead of "temporarily unavailable" for the ~seconds of ~340 inserts. **Fix:** wrap in `$transaction`, or flip the flag off first.
- **`low` · correctness** — Mentor co-pub rollup `menteeCount` can over-count mentees whose every co-pub is fully suppressed (count from pre-suppression `copublicationCount`, list from post-suppression). `publicationCount` is correct. **Fix:** derive `menteeCount` from mentees with ≥1 entry after suppression.

### profile-visibility (1)
- **`low` · data-integrity** — Email-export audit `row_count` splits the serialized CSV on `\r\n`; an RFC-4180 quoted cell with an embedded newline over-counts. Audit-only (no PII/row impact); embedded newlines in ED identity fields improbable. **Fix:** count rows from the data, not the CSV string.

### data-layer (2)
- **`low` · correctness** — Unit-curation backfill `--limit` is **silently ignored on a real run**: it samples `take: limit` candidates but then `updateMany({ where: { source:'seed' }})` updates **all** seed centers; the inline comment ("we still constrain to exactly the sampled codes") is factually wrong. Tiny blast radius (8 centers, one-shot). Untested (only dry-run exercises `--limit`). **Fix:** `where: { code: { in: sampledCodes }}`, or drop `--limit` + fix the comment + add a non-dry-run test.
- **`info` · data-integrity** — Two migration pairs share timestamps (`20260612140000`, `20260612160000`). NOT a hazard (lexicographic suffix breaks the tie deterministically; all four are independent additive statements). Hygiene note only.

### cdk-infra (2)
- **`info` · quality** — ETL S3-grant test **title is stale** ("spotlight + tools + ed + mentoring") but the assertion correctly includes `citations/*` and matches the policy. Title/comment only. **Fix:** update the title.
- **`low` · quality** — Edge test **doesn't assert the allowed-methods set** for the new `/api/units/*/*/members` behavior (it's in the order list + count but not the GET-only loop like `/api/profile/*`). Wiring is correct (`ALLOW_GET_HEAD_OPTIONS`, plain `allViewer`); only the regression test is missing. **Fix:** add it to the `byPath` GET-only loop.

### api-routes (0)
No findings (routes covered cleanly; the route-level issues surfaced under edit-surface / coi-gap).

---

## 4. Spec & doc findings (untracked working tree) — 39 findings

**The dominant theme: these specs describe shipped work as pending, and several frame already-resolved decisions as open** — the exact duplicate-work / "check if already done before planning" failure mode. Recommended blanket action: **add a `Status: Implemented (#PR)` provenance header to each shipped spec** (or mark superseded), and **discard the stale drafts that are behind a committed version.**

### coi-gap-feedback-spec.md — DIVERGES (mostly shipped, then extended)
- **`high` · mismatch** — §4 claims "`/dismiss` route is removed" but it **ships intact** with its own test and has **no remaining caller** (dead code — the cleanup the spec called for, never executed). **Fix:** delete the route + test in a follow-up, or correct the spec.
- **`high` · completeness** — Spec omits the **entire shipped `#953` surface** (Medium "lower-confidence" expander, "Reviewed" history with Undo, tier partitioning in `edit-context.ts`). An implementer reading only this doc builds a materially smaller feature. **Fix:** mark superseded-by-#953 / add a banner.
- **`medium` · spec-quality** — §6 export SQL: precision formula inconsistent with §1, redundant `OR status='acknowledged'`, MySQL-specific `SUM(boolean)` with dialect unstated. **Fix:** pin buckets to `feedback_reason`, state MariaDB.
- **`low`** ×2 — stale line-number anchors; under-specified `will_disclose↔restore` round-trip (acknowledged counts *intent*, not confirmed disclosure — worth a caveat for the methods paper).

### email-visibility-spec.md — DIVERGES (the untracked draft is a STALER predecessor of the committed spec)
- **`high` · mismatch** — The untracked draft is an **earlier version of the spec already committed on master**; the committed version added a "⚠️ Cache-safety gate" section the draft lacks. That omission makes the draft **internally wrong**: its Table A / `lib/api/profile.ts` touch-point tells an implementer to bake viewer-dependent `institution` emails into the **CloudFront path-cached loader** → a cache leak. Shipped code correctly bakes only `public` emails + reveals `institution` via the uncacheable island. **Fix:** discard the untracked draft or overwrite with `git show origin/master:docs/email-visibility-spec.md`.
- **`medium`** ×2 — over-specifies LDAP fetch paths (committed spec scoped to `EdFacultyEntry` only); §A on-network institution-email mechanism inconsistent without the reveal island.
- **`low`** ×2 — audit SQL references a `status='active'` column to confirm against schema (hide-mechanism is `deleted_at`); export §B doesn't name the third flag (`SCHOLAR_LIST_EXPORT_EMAIL`).
- **`info`** — fail-closed parsing + ≤50 cap are well-specified and match shipped (positive).

### comms-steward specs (two) — methods MATCHES; profile-editing DIVERGES-FROM-OWN-RECOMMENDATION
- **`high` · consistency** — **Profile-editing spec contradicts itself on field scope, and the rejected option is what shipped.** Body (§3/§4c/§6/§7) argues least-privilege (suppression/takedown ❌); §3b "CONFIRMED SCOPE" grants superuser-parity-minus-governance *including* suppression — which is what shipped. So §3/§6/§7 don't just rot, they **describe a security boundary that was deliberately not built.** (Ties to top-risk #3.) **Fix:** rewrite §3/§4c/§6/§7 to match §3b + shipped; mark the least-privilege table as the rejected alternative.
- **`medium`** ×2 — both specs' status headers say "awaiting approval / no code written" though shipped (#963/#964, #889/#900/#951/#958); §9 "Open decisions for you" lists already-made decisions.
- **`low`** ×3 — `superuserSurfaces`-replacement was built additively, not as the prescribed capability object; ED-name bridge script names differ from shipped (`etl:ed:export-steward-names`); the EditMode "new mode vs reuse superuser" tension resolved as a hybrid in code but left unresolved in prose.
- **`info`** — methods-visibility spec is exemplary (runnable §14 audit SQL, full §13 edge-case matrix) — use it as the template to bring the profile-editing spec up to.

### Org-unit & center facet/curation specs (three)
- **`high` · mismatch** — `center-program-membership-facets-issue.md` is **stale: Gaps B (per-row badge) and C (membership-type facet) already ship** (`center-members-client.tsx` + `centers.ts`, via #911). **Fix:** strike B/C as DONE; narrow to the only open scope (staging/prod data backfill + the still-missing membership-type search-index key — verified absent).
- **`medium` · mismatch** — `org-unit-curation-spec.md` §6c/§7 treat **Joel Stein as a CWID-resolvable chair**, but shipped code handles him as an **external (non-WCM) leader** with no `field_override`. **Fix:** move Stein to the external-leader carve-out.
- **`low`** ×3 + **`info`** ×1 — three centers' blank/recruiting directors not affirmed as intentional; compact-name proposals never reconciled to shipped values; methods-facet §B file-pointer wrong (logic is in `lib/api/unit-members.ts`, not the route); deselect/clear-all UX unspecified; cross-spec name-axis vs method-axis confirmed consistent.

### overview-generator + role-aware-nav + VIVO runbook (three)
- **`medium` · security** — **VIVO runbook destructive AWS deletes carry no account/profile guard.** (Top-risk #7.) **Fix:** mandatory pre-flight `aws sts get-caller-identity` assert == 665083158573 + `kubectl config current-context` assert before any delete.
- **`low`** ×4 — nav spec status line stale (#941 shipped); shipped code *exceeds* nav spec (the `/edit→/edit/methods` redirect §4c deferred is already built); overview spec uses "bio" but shipped copy says "overview"; runbook claims "restorable" with no restore-rehearsal/verification step.
- **`info`** ×3 — overview §9 draft-history question resolved opposite the spec's lean (persisted, not session-only); VIVO prod-edge open question gates Phase 3 (track on #945); no cross-spec contradictions.

### Mockups (5) — all MATCH their shipped components
- **`low` · security** — two methods-lens mockups pull **Tabler icons from jsdelivr CDN** (unpinned, no SRI); the app ships lucide-react. Acceptable for throwaway mockups; add SRI or a note if committed.
- **`info`** ×3 — overview mockup is an in-app fragment (no standalone styling); highlights mockup rows lack a `:focus-visible` ring (mockup-only); highlights selection correctly backed by `aria-selected` (not color-only — positive).

### Untracked test — `supercategory-family-layout-link.test.tsx` — DEAD/SUPERSEDED
- **`medium` · quality** ×2 — The file is **byte-for-byte identical** to the version committed by #956, and master already has a **strict superset** (#960 grew it 2→5 tests with `#879` definition coverage). Committing the on-disk copy would **delete 3 passing tests AND cause a tsc type regression** (its `familyMeta` fixture omits the now-required `definition`/`definitionSource` fields). **Action: do NOT commit — discard it; it vanishes on rebase.**

---

## 5. coi-gap engine review

**Verdict: the engine is fundamentally healthy.** The matcher/suppression/tier logic is sound and the routes are correctly locked down. Specifically verified clean:
- **No co-author false-positive leak.** Production never suppresses person-names on shape alone. The byline roster cross-check (`matchesCoAuthor`) fires only on explicit initial-form names with a byline-confirmed surname+initial, skips scholar-attributed clauses, exempts gazetteer orgs, and deliberately ignores the bare "Given Surname" shape so founder/eponymous orgs (`Carl Zeiss`, `Leon Levy`) stay surfaced. The `B. Braun`/`C. R. Bard` initial-form-org collision is a narrow, documented, accepted residual.
- **No tier leak.** Only an exact `High` tier reaches the nagging `unmatchedPubmedCoi` surface; Medium goes to the opt-in expander; active/reviewed partition is mutually exclusive (any `new` source ⇒ always active, never reviewed).
- **No IDOR / cross-scholar write hole.** All three routes enforce genuine-self-or-genuine-superuser and **refuse impersonation** (IS-1). Unique key, idempotency, and audit actions (`coi_gap_feedback`/`coi_gap_dismiss`/`coi_gap_restore`) all line up with the ENUM.

Three findings (all low after verification):
- **`medium→low` · integration · confirmed** — comms_steward sees the actionable COI-gap card but **all three** write routes (dismiss + feedback + restore) 403 their actions. This is the **same** issue the edit-surface review found, with two additions: (a) it spans `dismiss` too (not just feedback/restore), and (b) **the verifier resolved the fix direction** — the comms-steward spec is explicit that "COI must be denied at the route, **not just hidden in the UI**," so the routes' 403 is the **intended, correct** defense. The bug is purely that the UI surfaces interactive controls the backend rightly refuses (the slug field, also out-of-scope, IS correctly hidden by `attrsForMode`; coi-gap is the lone case where the route denies but the UI still shows controls). **Correct fix is unambiguous: drop `session.isCommsSteward` from the `includeCoiGap` gate** in `app/edit/scholar/[cwid]/page.tsx:167` — do *not* widen the routes. Severity low: gated behind two independent dark flags (`COMMS_STEWARD_ENABLED` + `SELF_EDIT_COI_GAP_HINT`, the latter off in *both* staging and prod pending FA/Compliance/GC sign-off), non-destructive, no authz bypass.
- **`medium→low` · data-integrity · uncertain** — Incremental ETL **deletion blind spot.** The reviewer's specific mechanism ("un-confirm flips `isConfirmed` to false") was **refuted** by the verifier — an un-claim *deletes* the `publication_author` row (the reciter ETL is delete-and-reinsert; nothing ever writes `isConfirmed:false`). But the **underlying concern is real**: `affectedCwids` builds the incremental work set from `lastRefreshedAt > watermark` scans, which **cannot detect a shrunk confirmed-set via row deletion** (upstream un-claim, PMID-orphan cascade) or a *deleted* `publication_conflict_statement`. So a stale High gap from a now-deleted authorship keeps nagging until a `--full` recompute — and **CDK confirms the nightly `etl:coi-gap` runs incremental with no scheduled `--full` backstop.** Self-heals on any `--full`; no corruption/exposure. **Fix:** detect deletions (e.g. union in scholars whose persisted candidate cites a PMID no longer in their confirmed set), or schedule a periodic `--full`. *(The reviewer's proposed `isConfirmed`-filter fix would not work — it scans for rows that don't exist.)*
- **`low` · data-integrity** — A reopened (`resolved→new`) candidate **retains its stale `feedbackReason`/`reviewedAt`** (the ETL reopen `update` writes `status` but doesn't clear the reason, unlike the `/restore` route). Not user-visible today (active rows never expose `reason` to the client; the row correctly re-nags). Audit-hygiene only: the next `beforeValues` reports a non-null reason for a `new` row. **Fix:** clear `feedbackReason` in the reopen branch.

> Net new distinct issues from this dimension: the ETL deletion blind spot and the reopen-feedbackReason hygiene gap (both low). The comms_steward COI view/act mismatch is the same issue already counted under §3 edit-surface — but its **fix direction is now settled** (hide in UI; the route denial is correct and intended).

---

## 6. Recommended actions (prioritized)

**Before any of these flags flip on in prod:**
1. **`import-copubs` floor guard** (top-risk #1) — one-line fix; highest blast radius. *(Live-impacting on next bad re-import even today.)*
2. **Methods-lens tier-change cache invalidation** (top-risk #2) — `revalidatePath` + CloudFront purge, or `force-dynamic` the `/methods` pages. *(Blocks `METHODS_LENS_PAGES` go-live.)*
3. **Reconcile the comms_steward parity asymmetries together** against `lib/edit/authz.ts` — hide the COI-gap card from stewards (drop `isCommsSteward` from `includeCoiGap`; routes correctly deny), overview GET target-awareness, CoiCard href/copy, Profiles tab. *(Blocks `COMMS_STEWARD_ENABLED` + overview-generator go-live.)*
4. **Operator-confirm the comms_steward suppression/takedown scope** (top-risk #3) and record the decision against the spec's "Open confirm before PR B" caveat.
5. **VIVO runbook account-guard** before handing to the named operator.

**Doc hygiene (low individual severity, high aggregate trust drag):**
6. Add `Status: Implemented (#PR)` headers to the shipped specs; discard the stale email-visibility draft; strike the done Gaps B/C; fix the comms-steward profile-editing spec's self-contradiction.
7. Discard the dead untracked test; salvage `docs/student-profile-visibility.md`, then delete the stale branch.

**Opportunistic (low):** the deep-link `?page=` restore, members-API regex, browse external-leader guard, mentee count-vs-suppression, import-citing transactionality, the data-layer `--limit` no-op, the two cdk test-coverage/title nits.
