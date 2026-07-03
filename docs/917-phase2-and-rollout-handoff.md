# Handoff — #917 next steps (rollout #1154 + Phase 2)

**Written:** 2026-06-19. **Prereq read:** this supersedes the Phase-1 plan in
`docs/917-pub-modal-methods-section-handoff.md` (now banner-marked SUPERSEDED).

## Where things stand

- **#917 Phase 1 (families) = DONE.** Shipped AC-complete in **#938** (`78e2a2db`,
  2026-06-12): `resolveMethodFamilies` (`lib/api/publication-detail.ts`, bounded
  author-scoped lookup, #800/#801-gated, cross-author de-duped) + `MethodsSection`
  (`components/publication/publication-modal.tsx`, below MeSH, omit-when-empty) +
  tests. All 6 families ACs met + ticked on #917.
- **PR #1154 MERGED** (squash `00255974`, master CI green build+cdk). Added the
  default-off **`METHODS_LENS_PUB_MODAL`** per-surface flag (composing
  `isMethodsLensEnabled()`); `app-stack.ts` wired `staging:"on" / prod:"off"`. App +
  cdk-snapshot only — no migration/ETL/reindex.
- The locked "reverse-table rebuild" decision was **stale-checkout-blind** and was
  NOT built (redundant vs the shipped bounded lookup; would collide with #1119's
  `etl/tools/*`). Issue + handoff + memory corrected.

---

## STEP 1 (do first) — roll out #1154 on staging

**Why it's urgent-ish:** the flag defaults OFF and the new env var isn't live until a
cdk deploy (a CD image-roll does NOT add env keys). So **the modal Methods section is
now DARK on staging** — a regression vs before #1154 (it was live via
`METHODS_LENS_ENABLED`). The deploy restores it.

**Do:** `cdk deploy --exclusively Sps-App-staging` from a **fresh-master worktree**.
`reciter` creds can do this (staging App stack).
- Recipe (per memory): branch off fresh `origin/master`; `-c env=staging` ONLY (NO
  `-c stagingAccount` — the live stack is env-agnostic; passing it spams the diff with
  `Ref AWS::AccountId`→literal-ARN noise); `--exclusively` (skips Sps-Network drift);
  `--require-approval never`. The CFN snapshot is already refreshed + committed (#1154),
  but if you touch app-stack again, `npx jest app-stack -u` first.
- **Confirm the `cdk diff` shows ONLY the `METHODS_LENS_PUB_MODAL` env-var add** on the
  app container (`containerDefinitions[0]` is the otel sidecar — the app is a later
  index; don't be fooled). Nothing else should change.

**Verify after deploy:** on `scholars-staging`, open a publication modal for a known
multi-author paper with attributed families → the "Methods" section renders the family
chips (links to Method pages). (`METHODS_LENS_ENABLED` is already staging-on, so only
the new flag was gating it.)

**Prod:** stays dark — gated methods-lens go-live. The prod App stack is behind master,
so any prod deploy needs a full `cdk diff` review first (it'll batch other pending env
flags + IAM — see `project_prod_app_deploy_image_skew`).

---

## STEP 2 — #917 Phase 2 (tools + per-tool context): the real remaining feature

This is what #917 is now narrowed to. **Blocked on #1119/PR #1122** — confirm its state
before starting (`gh pr view 1122`).

**Scope (from the #917 thread):** under each family in the modal Methods section,
surface the per-pmid **tools** (#794) and their per-paper **`context`** snippet (the
ReciterAI DDB `TOOL#` `context` field — "how this tool was used in *this* paper"),
#800/#801-gated the same way families are.

**Hard prereqs / gotchas:**
- **Confirm `ScholarTool.pmids` is actually populated.** It was **empty** in #1060's
  environment — if still sparse, tools-per-pmid is low-value; re-scope with the issue
  author before building.
- **Reuse #1119's infra, don't fork it.** #1119 (PR #1122) builds the tool-context
  extraction (`etl/tools/tool-context.ts`, `scholar_family.exemplar_contexts`,
  `scholar_tool.sample_context`, flag `METHODS_LENS_TOOL_CONTEXT`). Phase 2 should read
  that, not author a parallel ETL change. Per-pmid context is discarded at rollup today
  (`etl/dynamodb/scholar-tool-mapper.ts:119` keeps only the first `sampleContext`).
- **Data layer:** extend `resolveMethodFamilies` (or a sibling `resolveMethodTools`) in
  `lib/api/publication-detail.ts` using the SAME bounded author-scoped pattern
  (`publication_author`@pmid → `scholar_tool`@`cwid IN` → in-JS `pmids` membership). Do
  NOT add a reverse table — the bounded lookup already satisfies the "no unbounded scan"
  AC.
- **UI:** tools as a sub-list under each family in `MethodsSection` ("on expand"), with
  the context snippet as plain text. Gate behind `METHODS_LENS_PUB_MODAL` (+ likely
  `METHODS_LENS_TOOL_CONTEXT` for the snippet text).

---

## Cross-cutting gotchas (cost real time this session)

- **Stale canonical checkout** (`docs/spotlight-pipeline`, ~200 behind master). Read/Grep
  read THAT tree. ALWAYS re-ground via `git show origin/master:<path>` or a fresh-master
  worktree — and **before planning any feature, check `git log origin/master` / the issue
  thread for whether it already shipped** (this is exactly what bit the #917 Phase-1
  plan: #938 was invisible on the stale branch).
- **Worktree `node_modules` symlink** (from canonical) lacks master's newer deps — e.g.
  #1137 added `vis-network`/`vis-data`, so `tsc` flags `center-collaboration-tab.tsx`
  with module-not-found. That's DEP-SKEW, not a real error (deps are in master's
  `package.json`; CI `npm ci` resolves; no test imports it). Filter those out.
- **`edit-page.test.tsx` "loadable headshot … (4 of 4)"** fails LOCALLY (`currentTarget`
  undefined) even on pristine `origin/master` — jsdom-env-only, master CI green. Not a
  regression; don't chase it.
- **Local branch `feat/917-pub-modal-methods`** remains (remote deleted on merge; local
  branch deletion is barred by the git-safety rule). Harmless; user can `git branch -D`
  it. Same for `integration/verify-955-batch` from the prior session.
- **Master is extremely active** (moved 21 commits mid-session). Rebase onto fresh
  `origin/master` and re-run the FULL suite before any merge (the #954 trap).
