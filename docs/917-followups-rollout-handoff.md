# NIH Biosketch round-2 follow-ups + history grant — rollout handoff

Four **review-only** PRs from 2026-06-21. Nothing is merged. The biosketch feature stays gated
`EDIT_BIOSKETCH_GENERATE` (staging-on / prod-off) throughout. Built off fresh `origin/master` in the
worktree `~/worktrees/sps-biosketch`.

## The four PRs

| PR | Branch | What | Base | CI |
|----|--------|------|------|----|
| [#1190](https://github.com/wcmc-its/Scholars-Profile-System/pull/1190) | `feat/biosketch-debug-payload` | **B** — superuser "View prompt & payload" debug endpoint | `master` | ✅ build + cdk |
| [#1191](https://github.com/wcmc-its/Scholars-Profile-System/pull/1191) | `feat/biosketch-titles-v7` | **C** — per-contribution titles via prompt **v7** (new default) | `master` | ✅ build + cdk |
| [#1192](https://github.com/wcmc-its/Scholars-Profile-System/pull/1192) | `feat/biosketch-progress-stream` | **A** — NDJSON generation progress bar | **`feat/biosketch-titles-v7`** (stacked on C) | local-green only* |
| [#1193](https://github.com/wcmc-its/Scholars-Profile-System/pull/1193) | `chore/app-ro-audit-grant` | history grant — `app_ro` SELECT on the audit table, codified into the master seeder | `master` | ✅ build + cdk |

\* **A's `build`/`cdk` jobs do not run yet** — `ci.yml` triggers only on PRs targeting `master`, and
A is stacked on C. They run the moment A is retargeted to master (step 3 below). A's code is fully
validated locally (`tsc` + `eslint` + `vitest`, incl. the editOkStream contract, generator
`onProgress`, cross-chunk reader, progress component).

Each PR passed an adversarial diff-review workflow before opening (**0 blockers each**); all findings
were applied. The reviews caught real issues: a MEDIUM in C (unnumbered v7 output torn in two), a
convention/dep issue in A (standalone `@radix-ui` import), and a MEDIUM in the grant (table-not-found
on a fresh/DR deploy).

---

## Merge order (dependency graph)

```
B (#1190) ──────────────► master      (independent — merge anytime)
grant (#1193) ──────────► master      (independent — merge anytime; see deploy caveat)
C (#1191) ──► A (#1192)               (A is stacked on C; C must merge first)
```

### Step 1 — Merge B (#1190)
Independent, smallest, CI green. No deploy nuance: it's a new route + a superuser-gated button that
come live with the next CD image roll.

### Step 2 — Merge C (#1191)
Independent of B; CI green. **Must precede A.** C makes **v7 the default** prompt version — see the
"Activate v7 on staging" deploy note below (a `cdk deploy`, not just the image roll).

### Step 3 — Retarget + merge A (#1192)
**After C merges:**
```bash
gh pr edit 1192 --base master      # retarget off the now-merged C branch
```
This triggers A's `build`/`cdk` jobs for the first time. Wait for green, review, merge. (If GitHub
shows conflicts after C merges, rebase: `git -C ~/worktrees/sps-biosketch checkout feat/biosketch-progress-stream && git rebase origin/master && git push --force-with-lease`.)

### Step 4 — Merge the grant (#1193)
Independent; CI green. **But read the deploy ordering caveat below before merging** — staging
`deploy.yml` auto-runs on push-to-master, and the grant has a sequencing requirement with
`verify-grants`.

---

## Deploy / activation (operator), per env — staging first

The CD image roll (`deploy.yml`) ships **code**; it does **not** change task-def env vars or issue DB
grants. Those need an explicit `cdk deploy`.

### Activate v7 on staging (for C)
The compiled default is now v7, but the live task-def env var `BIOSKETCH_PROMPT_VERSION_DEFAULT` is
still `"v6"` from the last cdk deploy and **overrides** the compiled default. To make v7 live:
```bash
# from a fresh-master worktree, env=staging only (NOT -c stagingAccount), --exclusively
cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never
# refresh the CFN snapshot if app-stack changed:  npx jest app-stack -u
```
Rollback lever (no image roll): set `BIOSKETCH_PROMPT_VERSION_DEFAULT="v6"` + redeploy.
(B and A are code-only — they go live with the CD image roll, no cdk env change needed.)

### Issue the history grant on staging (for #1193) — ORDERING MATTERS
The verify-grants golden now **requires** `app_ro`'s audit SELECT, and `verify-grants` runs
**fails-closed** in the image-roll pipeline. The grant is issued only by the DataStack seeder
(Revision bumped 3→4). So **run the DataStack deploy BEFORE the image-roll deploy carries the new
golden:**
```bash
cdk deploy --exclusively Sps-Data-staging -c env=staging --require-approval never
```
If the image roll runs first, `verify-grants` reports `MISSING [scholars_audit.manual_edit_audit SELECT]`
and the service is **not** rolled (recoverable: deploy DataStack, re-run). Same paired-edit coupling
as ADR-009 Phase 3.

---

## Staging verification (SSO render-verify on scholars-staging; superuser-impersonate)

- **B** — on `/edit?attr=biosketch` (or `/edit/scholar/<cwid>?attr=biosketch`) as a superuser, the
  **"View prompt & payload"** button appears and downloads a JSON of the system/user prompt + FACTS.
  Confirm a non-superuser (comms steward) does NOT see it.
- **C** — generate a Contributions biosketch: each contribution shows a **title heading**; the `.txt`
  export has `N. <title>` then the body; an **older history row still renders** (backward-compat).
- **A** — during the ~60–90s generation, a **progress bar advances through phases** (Drafting →
  Fact-checking → Selecting publications → Linking sources) with an elapsed timer, then the result
  renders. **Re-verify CloudFront NDJSON pass-through** here — the streamed `content-type` is now
  `application/x-ndjson`; watch the network response stream incrementally (not a 504/idle stall).
- **#1193** — `/edit/scholar/<cwid>/history` (and `/edit/center/<code>/history`) show **audit rows**
  instead of the "unavailable" notice.

---

## Prod rollout (gated — separate, later)

All of the above is staging-first. Prod is a distinct gated step (do not bundle with staging):
1. Roll a fresh prod image, then `cdk deploy Sps-App-prod` to push the env vars (v7 default).
2. `cdk deploy Sps-Data-prod` (issues the grant on prod) **before** the prod image-roll carries the
   golden — same ordering caveat.
3. Flip `EDIT_BIOSKETCH_GENERATE` to on for prod when the feature itself is approved for prod (it's
   off there today).
4. Render-verify the same checklist on prod.

---

## Gotchas / notes for the next session

- **A is stacked** — never merge A before C; retarget to master after C (step 3). Don't base any new
  PR on A's branch.
- **Grant ordering** — `cdk deploy Sps-Data-<env>` BEFORE the image-roll that carries the verify
  golden, every env.
- **data-stack snapshot** — the grant Lambda's code is content-hashed into
  `cdk/test/__snapshots__/data-stack.test.ts.snap` (no hash normalization). Any future change to
  `cdk/lambda/db-bootstrap-seed/*` MUST regenerate it: `cd cdk && npx jest data-stack -u` (needs
  `cd cdk && npm ci` first). Hand-editing the hash is not possible.
- **Worktree state** — `~/worktrees/sps-biosketch` now has `cdk/node_modules` and
  `cdk/lambda/db-bootstrap-seed/node_modules` installed (for the snapshot regen). Harmless
  (git-ignored); remove if you want to reclaim space.
- **Master DB facts** — master user is `scholars_admin` (auto-generated secret `auroraMasterSecret`);
  the cluster is private (`publiclyAccessible: false`), no bastion, ECS Exec off — which is why the
  grant goes through the seeder, not a manual mysql session.
- The original spec is `docs/917-biosketch-followups-handoff.md` (PR #1188); the v6 baseline is
  `docs/overview-generator-v6-biosketch-handoff.md`.
