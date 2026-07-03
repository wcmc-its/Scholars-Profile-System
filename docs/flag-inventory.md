# Feature-flag inventory & burn-down (2026-07-02)

Every app-container flag, its per-env value on master, its owning issue, and the
criterion that flips it to prod or kills it. Companion tooling (this PR):

- `scripts/release/flag-parity.mjs` — CI gate (cdk job): every env key consumed in
  code must be wired in cdk or registered in `flag-parity-allowlist.txt`. Also
  `--dump <env>` prints the synthesized app-container env.
- `scripts/release/whats-shipping.sh [prod|staging]` — pre-deploy drift report:
  deployed sha, every commit an image roll ships, migrations, cdk/ drift, and the
  exact env vars a `cdk deploy Sps-App-<env>` would change. **Run it (plus
  `cdk diff`) before every prod deploy** — prod deploys ship accumulated drift,
  never a scoped change.

Value columns are regenerable (`--dump staging` / `--dump prod`); the owner and
exit-criterion columns are curated — update them when a flag lands or dies.
Snapshot below taken at master `0f300bfb`; live task defs verified same day
(staging `sps-app-staging:104`, prod `sps-app-prod:21` — task-def flag values
matched master for both envs; only `OPENSEARCH_NODE` literal→secret pending in prod).

## Drifted flags (staging ≠ prod) — the burn-down queue

Each of these is unreviewed behavioral drift between what we test and what users see.
Exit criteria are the flip/kill conditions; "GAP" = no open issue owns the flip.

### Search relevance / ranking (API-evaluable via `scripts/search-eval/`)

| Flag | staging | prod | Owner | Exit criterion |
|---|---|---|---|---|
| SEARCH_PEOPLE_AREA_BOOST | on | off | #1363 / #1343 | **A/Bs DONE 07-02 + 07-03** (`docs/search-area-boost-ab-2026-07-02.md`, `docs/search-boost-tuning-ab-2026-07-03.md`): ON beats OFF; weight-tuning found 2/1/0.5 relieves the hypertension/alzheimer's regressions at a flat headline (redistribution, not Pareto). Keep staging-on, HOLD prod; #1343 owner soaks 2/1/0.5 (env `SEARCH_AREA_BOOST_W_*`, tunable since #1470) then decides default |
| SEARCH_PEOPLE_FACULTY_PROMINENCE | off | on | #1345 | **RE-EVAL DONE 07-03**: turning ON regresses (0.292→0.285); the diabetes-cluster regression that parked #1345 does NOT reproduce with #1363 active — keep OFF on staging, #1345 resolvable as "keep disabled". Prod still has the legacy ON (inverted drift) |
| SEARCH_PEOPLE_PHRASE_BOOST | on | off | #1344 | **WIRED + A/B DONE 07-03** (#1470): phrase-boost ON = net +0.022 meanMRR, driven by clinical multi-word specialty queries (resistant hypertension, interventional cardiology). Staging-on validated; prod flip after soak |
| SEARCH_MESH_RESOLUTION_FALLBACK | on | off | #1342/#1346/#1348 sweep | Staging soak + gold-set eval → prod flip (resolve-time only, no reindex); lay-term wins additionally need #1258 alias rows |
| SEARCH_MESH_QUERY_NORMALIZATION | on | off | #1342/#1346/#1348 sweep | Same as above |
| SEARCH_ACRONYM_SENSE_GUARD | on | off | #1346 | Same sweep; prod flip after gold-set eval |
| SEARCH_PEOPLE_METHOD_FAMILY | on | off | #824/#819 | Prod people reindex (methodFamily fields) → methods-lens prod go-live bundle |
| SEARCH_PEOPLE_METHOD_FAMILY_TIER | on | off | #824/#819 | Pairs with METHOD_FAMILY prod go-live |
| SEARCH_PEOPLE_METHOD_CONTEXT | on | off | #1119 | PROSE — needs staging soak sign-off; ships with methods-lens bundle |
| SEARCH_PEOPLE_MATCH_AWARE_SNIPPET | on | off | #824 family | Ships with methods bundle (pairs with METHOD_FAMILY) |
| SEARCH_PEOPLE_CONCEPT_GRANT_AXIS | on | off | #921 | Staging soak + grant-admitted-scholar eval; prod = pure flag flip (reuses live fundedPubMeshUi gate) |
| SEARCH_FUNDING_CONCEPT_GRANTS | on | off | #1359 (Tier 2) | Staging A/B of funding-row concept matches → prod |
| SEARCH_PUB_MESH_ONLY_FILTER | on | off | #396 | Prod flip (no reindex prereq) after staging soak |
| SEARCH_PUB_FACET_SPLIT | on | off | #1301 (revived by #1423, staging-on; prod flip rides the #1415 prod image release) | Kill criterion stated in #1301; bottleneck was `matchQueryToTaxonomy`, largely addressed by #1415 perf PRs — re-evaluate then flip or kill |
| SEARCH_SHELL_STREAMING | on | off | #861 | Staging cold/warm TTFB measurement → prod at go-live (flag-off is byte-identical) |
| SEARCH_RESULT_EVIDENCE | on | off | #1464 | UI evidence panel master gate; prod flip rides the evidence bundle below |
| SEARCH_EVIDENCE_ROWS | on | off | #1464 | Same bundle |
| SEARCH_EVIDENCE_REASON_COUNTS | on | off | #1464 | Staging soak done; prod needs people reindex (doc-precomputed methodFamilyCounts/areaCounts, present per #1461) + cdk deploy |
| SEARCH_PEOPLE_CONCEPT_HINT | on | off | #1465 | Prod needs topMeshTerms people reindex (verify present post 07-03 reindex) |

### Methods lens & org surfaces

| Flag | staging | prod | Owner | Exit criterion |
|---|---|---|---|---|
| METHODS_LENS_ENABLED | on | off | #824/#819 | Master render gate; prod go-live = reindex + data-gated flip (whole bundle below rides it) |
| METHODS_LENS_PUB_MODAL, _ENTITY_USAGE, _FAMILY_* (5), _CELL_LINE_ENTITIES, _SENSITIVE_GATE, _TOOL_CONTEXT | on | off | #824/#819 (+#1166/#1168 cell-line v4, #1119 tool-context) | All additionally code-gated on METHODS_LENS_ENABLED — prod values are moot until the master gate flips; flip together at methods go-live |
| ORG_UNIT_METHODS_CHIPS / ORG_UNIT_METHODS_FACET / CENTER_METHODS_FACET | on | off | #824 family | Methods go-live bundle |
| (note) METHODS_LENS_PAGES | on | on | — | ON in prod but dark behind METHODS_LENS_ENABLED=off |

### Centers / profile / edit / ETL-adjacent

| Flag | staging | prod | Owner | Exit criterion |
|---|---|---|---|---|
| CENTER_COLLABORATION_NETWORK (+_GRANT_AXIS) | on | off | #1137 | Staging soak → prod rollout; grant axis is an inert sub-flag, soaks independently |
| CENTER_PROGRAM_PAGES / PROFILE_CENTER_AFFILIATION / UNIT_ADMIN_CENTER_PROXY / EDIT_UNIT_ROSTER_EXPORT | on | off | #1105/#1103/#1104/#1102 (+#1117) | Pure per-env rollout issues (code merged); staging soak → one approval-gated prod App deploy flips all four |
| CLINICAL_TRIALS_SECTION | on | off | #1153 + #1199 | Regular OnCore feed + prod `etl:clinical-trials` backfill; safe-off meanwhile |
| COAUTHOR_HIDDEN_STUDENT_CHIPS | on | off | #1026 (+#1052) | WCGS sign-off (wave3 outreach Q2) → prod flip |
| CORE_PUB_MODAL / CORE_PAGES / CORE_CLAIM_WRITEBACK | on | off | #1239 edge case (mains closed) | Cores engine full-corpus run populates `publication_core` → prod flip (empty table = safe but pointless) |
| PROFILE_FACET_REDESIGN | on | off | #841 | Staging-screenshot sign-off → prod-on; then remove the #829 pill path ~2–4 weeks later |
| PROFILE_EMAIL_RELEASE_GATE | on | off | #1100 | Prod flip when the on-prem email-visibility bridge data flows (TGW path) |
| INTERNAL_VIEWER_NETWORK_SIGNAL | on | off | #866 + #876 | Internal-viewer CIDRs + FA sign-off |
| SCHOLAR_LIST_EXPORT (+_EMAIL) | on | off | #847 | Staging soak → prod flip |
| SELF_EDIT_RECITER_PENDING_HINT | on | off | #1078 | Staging soak → next approval-gated prod deploy |
| GRANT_MATCHER_SUBTOPIC_GRAIN | on | off | #1090 family | envConfig-driven (config.ts), not env-string ternary; funding-relevance eval → enable+tune |
| EDIT_BIOSKETCH_GENERATE | on | off | #1467 | /edit bundle — staging bake → one prod deploy |
| EDIT_CV_EXPORT | on | off | #1467 | /edit bundle |
| SELF_EDIT_OVERVIEW_GENERATE_STREAM | on | off | #1467 | /edit bundle |
| SELF_EDIT_RAIL_RESTRUCTURE | on | off | #1467 | /edit bundle |
| EDIT_DATA_QUALITY_DASHBOARD | on | off | #1467 | /edit bundle |
| REPORTER_MATCH_V2 | on | off | #1468 | Staging match-quality spot-check → flip prod in app+etl stacks (coordinate with the PR-6/7 etl deploy) |
| RECITER_REJECT_SEND | on | off | #1469 | DECISION issue — outward write-back to ReCiter; confirm feedback loop wanted + verify staging write-backs, or keep staging-only |

## Dark-everywhere flags (off/0 both envs) — flip-or-kill queue

| Flag | Owner | Exit criterion / decision |
|---|---|---|
| SEARCH_PEOPLE_CLINICAL_FN | #1466 | **A/B DONE 2026-07-02 — strict win** (clinician-expert medRank 14→9, zero regressions); wired staging-on (#1435), prod flip after soak + prod clinicalSpecialties field verification |
| SEARCH_PEOPLE_CLINICAL | #1372 Track A | INERT (text field empty in index) — kill or backfill decision rides clinical-fn outcome |
| SEARCH_PEOPLE_DIVISION_SHAPE | #1347 | Dark pending A/B of division-shape routing |
| SEARCH_PEOPLE_CONCEPT_PRECOUNT | #1414 | Inverted polarity ("off" = new fast path); #1414 wants code-default flip |
| SEARCH_SUGGEST_MESH_CONCEPT | #878 | Flip staging first for a soak → prod; no data prereq |
| SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB | #967 | ROLLED BACK (drove ~10s broad-concept hang); re-soak only after #1278 wall-time cap |
| SELF_EDIT_GRANT_RECS | #1203 + #1218 | Opportunities ingested per env (prod: 1,121 loaded 2026-07-01) → flip gated on prod image roll |
| SELF_EDIT_REQUEST_CHANGE_SEND | SES doc | SES sender verified + out of sandbox → on (falls back to mailto: meanwhile) |
| SELF_EDIT_ED_ADMINS_IMPORT / SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY | #728 | LDAPS OQ-4 (post-#443, likely unblocked by VPC cutover) / OQ-8a sign-off |
| OVERVIEW_FAITHFULNESS_PASS | #742 | **DELETED** (#1440 sweep) — the #742 validation gate passed without it and it never ran in any env; the env flag + cdk entry are gone. The grounding machinery (`groundOverviewDraft`) stays: the biosketch pass (BIOSKETCH_FAITHFULNESS_PASS) and the validation harness still use it via explicit opts |
| PRESTIGE_AXIS_WEIGHT (=0) | #1294–#1296 | Operational: RE-backfill w/ ReciterAI#276 → etl:dynamodb → search:index:funding → verify → raise weight |

## Flag-shaped items that are NOT in cdk (allowlisted, tracked)

| Key | Owner | Note |
|---|---|---|
| SEARCH_REQUIRE_DISPLAYABLE_AUTHOR | #718 + #807 | Wire cdk ETL+app → reindex → flip; #485 blocker likely OBE after VPC cutover reseeded FGAC |

## Retire-at-launch / cleanup

| Flag | Owner | Action |
|---|---|---|
| PROFILE_CANONICAL (="root" both) | #671 | Fully cut over; flag is rollback lever only — prod smoke of root-canonical done → **remove the flag entirely** |
| SHOW_BETA_BADGE | #506 | Retire at full public launch (set off + deploy; no code revert) |
| COMMS_STEWARD_ENABLED | comms spec §9 | ON both envs but prod allowlist EMPTY (superusers only) — set EA steward CWIDs or wire GROUP_CN post-#443, else the flip confers nothing |

### Retired (flag + dead branch deleted; #1440 sweep)

| Flag | Was | Surviving path |
|---|---|---|
| OVERVIEW_FAITHFULNESS_PASS | off/off (KILL CANDIDATE, #742) | Pass skipped by default; still reachable via explicit `opts.faithfulnessPass` (validation harness / tests). Shared grounding machinery kept — the biosketch pass uses it |
| ACCOUNT_CONSOLE_NAV_RESTRUCTURE | on/on (promoted 2026-06-21, #1204) | Unified account dropdown + console nav is the only path (View→Edit order, "Admin console"/"Funding matcher" labels, account chip in AdminSubnav) |
| SEARCH_PEOPLE_MATCH_PROVENANCE | on/on (graduated 2026-06-03, #733) | People-tab narrower-term "Why this match" provenance always attaches when a topic query resolves (pure additive metadata) |

## Process rules this inventory enforces

1. **No prod cdk deploy without** `scripts/release/whats-shipping.sh prod` + `cdk diff` review — a prod App deploy is a release of everything above, not your change.
2. **No new flag without wiring** — CI (flag-parity step) fails if a consumed env key is neither in cdk nor allowlisted.
3. **No staging-on flag without an owning issue + exit criterion** — the GAP rows above are the current debt; every new flag flip PR should name its rollout issue.
