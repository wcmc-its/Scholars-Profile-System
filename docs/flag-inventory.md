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
Snapshot below regenerated **2026-07-10** at master `afc4d1e6` from the `--dump`
diff (previous snapshot 2026-07-02 at `0f300bfb`, task defs staging `:104` /
prod `:21`). The 2026-07-05/07 launch flips were spot-verified against the live
prod task def (`sps-app-prod:29`) during the 2026-07-09/10 backlog triage.

## Drifted flags (staging ≠ prod) — the burn-down queue

Each of these is unreviewed behavioral drift between what we test and what users see.
Exit criteria are the flip/kill conditions; "GAP" = no open issue owns the flip.
This is the full `--dump staging` vs `--dump prod` diff (app container) plus the
two etl-stack drifts — everything else converged in the 2026-07-05/07 flips below.

| Flag | staging | prod | Owner | Exit criterion |
|---|---|---|---|---|
| SEARCH_PEOPLE_FACULTY_PROMINENCE | off | on | #1345 | **RE-EVAL DONE 07-03**: turning ON regresses (0.292→0.285); the diabetes-cluster regression that parked #1345 does NOT reproduce with #1363 active — keep OFF on staging, #1345 resolvable as "keep disabled". Prod still has the legacy ON (**inverted drift** — resolution is a prod flip to off) |
| SEARCH_MESH_RESOLUTION_FALLBACK | on | off | #1342/#1346/#1348 sweep | Staging soak + gold-set eval → prod flip (resolve-time only, no reindex); lay-term wins additionally need #1258 alias rows. (The rest of the sweep — QUERY_NORMALIZATION, ACRONYM_SENSE_GUARD — flipped prod-on 07-07) |
| SEARCH_FUNDING_CONCEPT_GRANTS | on | off | #1359 (Tier 2) | Staging A/B of funding-row concept matches → prod |
| CENTER_COLLABORATION_GRANT_AXIS | on | off | #1137 Phase 2 | Grant-axis staging soak → prod flip (app-only; the base COLLABORATION_NETWORK flipped prod-on 07-05) |
| CORE_PUB_MODAL / CORE_PAGES / CORE_CLAIM_WRITEBACK | on | off | #1239 edge case (mains closed) | Cores engine full-corpus run populates `publication_core` → prod flip (empty table = safe but pointless) |
| PROFILE_EMAIL_RELEASE_GATE | on | off | #1100 | Prod flip when the on-prem email-visibility bridge data flows (TGW path) |
| GRANT_MATCHER_SUBTOPIC_GRAIN | on | off | #1090 family | envConfig-driven (`config.ts` `grantMatcherSubtopicGrain`), not env-string ternary; funding-relevance eval → enable+tune |
| REPORTER_MATCH_V2 | on | off | #1468 | Staging match-quality spot-check → flip prod in app+etl stacks (both stacks carry a copy) |
| RECITER_REJECT_SEND (**etl-stack** copy) | on | off | #1469 | The app-side copy flipped prod-on 2026-07-05 (launch batch 2) — `/api/edit/reject` write-back is live. The remaining #1469 decision covers only the ETL `etl:reciter-refresh` scanner env (etl-stack) |
| AVAILABLE_TECHNOLOGIES_SECTION | on | off | GAP (CTL rollout; code merged #1594/#1596/#1602) | Blocked on CTL contact/attribution sign-off → prod flip |
| SPONSOR_MATCH | on | off | GAP (code merged #1607) | Rides the CTL technologies rollout |

## Converged since the 2026-07-02 snapshot (launch flag-parity + go-lives)

Value columns above no longer list these — they are `on` in **both** envs, verified
in the deployed prod task def (`sps-app-prod:29`). History lives in the closed
owning issues; dates from the cdk flip annotations.

| Prod flip | Flags |
|---|---|
| 2026-07-05 (parity batches 1–2 + methods go-live, #506/#962/#1481) | SEARCH_PEOPLE_METHOD_FAMILY (+_TIER), SEARCH_PEOPLE_METHOD_CONTEXT, SEARCH_PEOPLE_MATCH_AWARE_SNIPPET, SEARCH_PEOPLE_CONCEPT_GRANT_AXIS, SEARCH_PUB_FACET_SPLIT, SEARCH_RESULT_EVIDENCE, SEARCH_EVIDENCE_ROWS, SEARCH_EVIDENCE_REASON_COUNTS, SEARCH_PEOPLE_CONCEPT_HINT, SEARCH_PEOPLE_CLINICAL_FN, METHODS_LENS_ENABLED + sub-bundle (PUB_MODAL, ENTITY_USAGE, FAMILY_*, CELL_LINE_ENTITIES, SENSITIVE_GATE, TOOL_CONTEXT), ORG_UNIT_METHODS_CHIPS/_FACET, CENTER_METHODS_FACET, CENTER_COLLABORATION_NETWORK, CENTER_PROGRAM_PAGES, PROFILE_CENTER_AFFILIATION, UNIT_ADMIN_CENTER_PROXY, EDIT_UNIT_ROSTER_EXPORT, SCHOLAR_LIST_EXPORT, SELF_EDIT_RECITER_PENDING_HINT, EDIT_BIOSKETCH_GENERATE, EDIT_CV_EXPORT, SELF_EDIT_OVERVIEW_GENERATE_STREAM, SELF_EDIT_RAIL_RESTRUCTURE, EDIT_DATA_QUALITY_DASHBOARD, RECITER_REJECT_SEND (app-side) |
| 2026-07-07 (parity batch 3 + singles) | SEARCH_PEOPLE_AREA_BOOST, SEARCH_PEOPLE_PHRASE_BOOST, SEARCH_MESH_QUERY_NORMALIZATION, SEARCH_ACRONYM_SENSE_GUARD, SEARCH_PUB_MESH_ONLY_FILTER, SEARCH_SHELL_STREAMING, CLINICAL_TRIALS_SECTION, COAUTHOR_HIDDEN_STUDENT_CHIPS, PROFILE_FACET_REDESIGN, INTERNAL_VIEWER_NETWORK_SIGNAL, SCHOLAR_LIST_EXPORT_EMAIL |

## Dark-everywhere flags (off/0 both envs) — flip-or-kill queue

| Flag | Owner | Exit criterion / decision |
|---|---|---|
| SEARCH_PEOPLE_DIVISION_SHAPE | #1347 | Dark pending A/B of division-shape routing |
| SEARCH_PEOPLE_CONCEPT_PRECOUNT | #1414 | Inverted polarity ("off" = new fast path); #1414 wants code-default flip |
| SEARCH_SUGGEST_MESH_CONCEPT | #878 | Flip staging first for a soak → prod; no data prereq |
| SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB | #967 | ROLLED BACK (drove ~10s broad-concept hang); re-soak only after #1278 wall-time cap |
| SELF_EDIT_GRANT_RECS | #1203 + #1218 | Opportunities ingested per env (prod: 1,121 loaded 2026-07-01) → flip gated on prod image roll |
| SELF_EDIT_REQUEST_CHANGE_SEND | SES doc | SES sender verified + out of sandbox → on (falls back to mailto: meanwhile) |
| SELF_EDIT_ED_ADMINS_IMPORT | #728 | **No longer dark**: the operative etl-stack copy is `on` in both envs (importer writes enabled; the app-stack copy is documentation-only, `off`) |
| SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY | #728 | OQ-8a stakeholder sign-off → flip (removes parent-dept Owner create path) |
| OVERVIEW_FAITHFULNESS_PASS | #742 | **DELETED** (#1440 sweep) — the #742 validation gate passed without it and it never ran in any env; the env flag + cdk entry are gone. The grounding machinery (`groundOverviewDraft`) stays: the biosketch pass (BIOSKETCH_FAITHFULNESS_PASS) and the validation harness still use it via explicit opts |
| PRESTIGE_AXIS_WEIGHT (=0) | #1294–#1296 | Operational: RE-backfill w/ ReciterAI#276 → etl:dynamodb → search:index:funding → verify → raise weight |

## Flag-shaped items that are NOT in cdk (allowlisted, tracked)

| Key | Owner | Note |
|---|---|---|
| SEARCH_REQUIRE_DISPLAYABLE_AUTHOR | #718 + #807 | Wire cdk ETL+app → reindex → flip; #485 blocker CLOSED 2026-07-10 (mooted by the shared-VPC domain recreate) |

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
