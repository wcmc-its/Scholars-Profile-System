# Funding-evidence honesty — iteration handoff

Grounded against `origin/master` @ `194e9bd1`, 2026-07-15 (00:2x UTC). Everything below was probed live, not recalled. **Re-derive every table before building on it** — this subsystem's handoffs rot, and this whole session existed because the last "it's fine, it soaked" claim was false.

## 0. The one rule this thread keeps teaching

**A flag can activate correctly and the card can still lie. Verify what the UI CLAIMS, not that the mechanism fired.**

Twice in two sessions the same shape bit us: a recall feature was switched on, the mechanism demonstrably worked (grants surfaced by concept — they do), and nobody read the sentence printed above the grants. The concept axis is real and wanted. What was wrong was the *count and its caption*. A deploy is verified when the claim on the page is true, not when the query returns rows.

Corollary, stated by the flag's own history and now binding: **"soaked on staging with no complaint" is not a precision check.** `SEARCH_FUNDING_CONCEPT_GRANTS` was held "until the precision spot-check passes"; that check had never been run when the flag was first flipped prod-on. Running it took one curl and found a false public number in the first result.

## 1. What shipped this session

| PR | What | State |
|---|---|---|
| #1725 | Sponsor CARD (`artifact-lead`): a concept block may only lead with a grant the concept ADMITTED — filter the block on a per-row `matchedConcept` the route already emitted | merged |
| #1731 | `SEARCH_FUNDING_CONCEPT_GRANTS` back to prod-OFF (staging-on) — the count it enabled was false | merged + **deployed to prod** (task-def `:35`) |
| #1735 | The People-card funding row: `grantMatchTaggedCount` (a count) replaces `grantMatchTagged` (a boolean); the row PARTITIONS into "N tagged <Concept> · M mention '<query>'" | merged, **staging-verified live** |

Two distinct surfaces, same root cause (the funding query is a text-OR-concept union):

- **Sponsor card** (behind `SPONSOR_MATCH`) — grants are the ARTIFACT; the fix is a per-row FILTER (drop text-only grants from a concept block). #1725.
- **Public People card** (`SEARCH_FUNDING_CONCEPT_GRANTS`) — grants are a COUNT + caption; the fix is a partition of the count. #1735.

Do not conflate them: the People-card row is legitimately "grants matching your search", so it must show the mention grants (as a labelled second clause), not hide them.

## 2. Live-verified facts (probed, not assumed)

**Staging (`194e9bd1`, flag ON):** search hit for `stt2007` / "antibody-drug conjugate" now returns `grantMatchCount: 5, grantMatchTaggedCount: 1` (old `grantMatchTagged` is gone → `null`). So the card renders **"1 of 23 grants tagged Immunoconjugates · 4 mention 'antibody-drug conjugate'"** — 1 + 4 = 5, partitioned and true. #1735 is real on a real index.

**Prod right now:**
- app task-def `sps-app-prod:35`, image `a5376a0e` (pushed 17:57 EDT).
- `SEARCH_FUNDING_CONCEPT_GRANTS = off`. So the public funding row reads `mention "<query>"` — correct. The false "N tagged" count is NOT in prod.
- prod image **has #1725** (sponsor card grant fix) but **lacks #1735** — moot while the flag is off (with it off, `grantMatchTaggedCount` is always 0, row reads "mention", byte-identical to pre-change).
- `SPONSOR_MATCH = on` in prod. The console env-gate is open; whether it is publicly REACHABLE depends on an SSO/dev-role check not verified here — test the actual console before any public-exposure claim.
- **Prod pubs index is NOT reindexed for #1722** — `/api/search/key-paper` returns no `role`. #1722's authorship role does not render in prod yet.

## 3. The verification recipe, so nobody re-invents it

Both card fetches hit PUBLIC routes — no SSO needed to test the evidence layer:
- `/api/search?q=` → hits carry `grantMatchCount` / `grantMatchTaggedCount` (People-card funding row inputs).
- `/api/scholar/{cwid}/grants?q=&descriptorUis=&label=` → the grant records.
- `/api/search/key-paper?cwid=&q=&descriptorUis=&label=&exclude=` → the papers.

Force `curl -4`. Real MeSH UIs come from the local MariaDB (`SELECT descriptor_ui,name FROM mesh_descriptor WHERE name IN (…)`; `DATABASE_URL` is in the repo `.env`, NOT `.env.local`). Do NOT guess UIs.

**Two traps that will hand you a false negative:**
1. **Empty `q` short-circuits `/api/scholar/{cwid}/grants`** → `{grants:[], total:0, strength:null}`. That is "never queried", not "nothing matched". To test the concept axis alone, pass a NONSENSE token (`q=zqxjklmwrp`) plus the real `descriptorUis`, not an empty `q`.
2. **The SSO-gated sponsor console** (`POST /api/edit/sponsor-match`): needs the `__Secure-sps_session` cookie **AND an `Origin:` header**, else it 200s with `{ok:false, error:"cross_origin"}` (CSRF, reads like a bad cookie). The POST is RETAINED (#6d, officers see each other's) → `DELETE {submissionId}` your test row.

## 4. Remaining work in this vein, ranked

### 4a. Re-flip `SEARCH_FUNDING_CONCEPT_GRANTS` in prod — the direct continuation
This is why #1735 exists. The count is now honest; the flag is safe to re-enable. Sequence, and do not skip a step:
1. **Eyeball the mixed line on the staging CONSOLE / People card** (rendered, not just the API field). API is verified (§2); the rendered card is not — the last four defects were rendering defects.
2. **Prod image must contain #1735.** `a5376a0e` does not. A prod image release (`deploy.yml -f env=prod`) is required first; it also carries #1714/#1722/#1735 — coordinate.
3. `cdk deploy Sps-App-prod` to flip the flag on (the diff is one env var — see §5).
4. **Re-run the §3 probe against PROD** and read the rendered row. The bug was `grantMatchCount` captioned "tagged"; confirm prod now shows `N tagged · M mention` and the numbers sum.
Blocking dependency: **#1732's fix (this) in the prod image**. Tracking: reopen the rollout intent or file a fresh "re-flip" issue — #1732 is CLOSED (the fix), the flip is a separate rollout step.

### 4b. Prod pubs reindex for #1722 (authorship role)
Prod is un-reindexed (§2). The nightly `search:index` does a full alias-swap rebuild, so the role lands automatically on the next nightly ONCE the prod ETL image carries #1722's `lib/search-index-docs.ts`. Verify the prod ETL image vintage, then either wait for the nightly or run a one-off (recipe: copy the `TaskSearchIndexNightly` step's network config, `npm run search:index:publications`, on `sps-etl-prod`). Verify with `/api/search/key-paper` returning `role`.

### 4c. #1699 — sponsor console visual reskin
Retitled this session to the real remaining gap: the Scholars visual skin (blocked on DESIGN sign-off, not data) plus the still-absent `caveat`/"show anyway" (contract produces no `caveat` — verified 0/410 candidates). Everything else in its old table has shipped. Do not re-litigate the table.

### 4d. #1440 — flag debt
Once `SEARCH_FUNDING_CONCEPT_GRANTS` has re-flipped and soaked in prod, the flag becomes unconditional and then deletable. Not before — it is the only kill-switch for this behavior.

### 4e. Not built, by design — do not "fix"
- **Sponsor card "also supports <other concept>"** — destroyed by the `exclude` de-dup on purpose; restoring it repeats a paper under several concepts on the PUBLIC card. A real cross-reference would be a much larger piece (compute, for each shown pmid, the other concepts it belongs to, over an already-de-duped list).
- **Killing the concept axis to "fix" the count** — the recall gain is real and wanted. The axis admits grants the text arm misses and removes none. Only the count/caption were ever wrong, and they are fixed.

## 5. The prod flag deploy, verified end-to-end (reusable)
`cdk deploy --exclusively Sps-App-prod -c env=prod` — NEVER `-c <env>Account` (inlines literal ARNs → huge no-op churn). The honest diff is **synthesized-vs-deployed task-def env**, read from the templates: for the flag flip it was **129 vars in, 129 out, exactly ONE real change**. `NEXT_ISR_CACHE_BUCKET` looks like a removal only if you filter the template to string values — it is a CFN `Ref` to the same bucket; not a change. Verify the flip by BEHAVIOR (the §3 prod probe), not the deploy log — a `cdk deploy` exit 0 has lied here before.

## 6. Verification status — be honest
| | |
|---|---|
| Full vitest | 7,230 passing (`usage-summary.test.ts` fails to IMPORT `@aws-sdk/client-athena` in a stale-symlink worktree; green in CI) |
| #1735 new tests | mixed-set card test confirmed RED against the pre-fix card, green with it |
| typecheck / eslint | clean on every touched file |
| Staging (API layer) | #1735 field live: `grantMatchTaggedCount:1` for the reproduction case |
| Staging (RENDERED card) | **NOT seen** — SSO-gated; the API field is verified, the pixels are not |
| Prod | flag off (correct); #1735 not in image (moot); #1722 role not reindexed |
