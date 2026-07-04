# SPS cutover item 3 — `useSharedVpc` export-lock deploy strategy (RESOLVED design)

**Date:** 2026-06-30 · **Grounded on:** `origin/master` @ `09ce498d`.
**Supersedes** the item-3 section of `docs/cutover-decouple-increments-2026-06-30.md`, whose first-draft mechanism (flip the inherent VPC/SG/ALB locks in one `cdk deploy --all`) was **rejected** — `--all` is sequential producer-first, so Network replaces its SGs while App/Data/Etl still import them → `Export … in use`.

**Method:** a definitive cross-stack export-edge inventory on `origin/master`, then a 3-approach design panel, each adversarially verified against the sequential producer-first CFN model. Result:

| Approach | Avoids lock? | Flag-off byte-identical? | Score | Verdict |
|---|---|---|---|---|
| **C — decouple-then-flip (by-id/by-name + pins)** | **YES** (only one) | no (inherent) | **8** | **Recommended spine** |
| A — structural SG-ownership relocation | partial | yes | 6 | Grafts into C (resolves C's SG feasibility) |
| B — blue-green new-export-names | partial | yes | 6 | Contributed the compute-tier + teardown corrections |

---

> **✅ STATUS (2026-07-01):** All six open questions resolved (§ bottom). Byte-identity ruling below = accept reviewed deltas → **Approach C proceeds.** Exact edit surface + resolutions live in the companion **`docs/cutover-item3-implementation-map-2026-06-30.md`** (implementation source of truth; this doc is the design rationale).

## ✅ RESOLVED — the gating decision: "14 snapshots byte-identical" is NOT a hard rule

**Ruling (Paul, 2026-07-01):** reviewed wiring-only per-pass deltas are ACCEPTED (zero resource replacement, physical ids unchanged) → Approach C proceeds. Original analysis retained below for rationale.

### (original) is "14 snapshots byte-identical" a hard rule?

Every lock-free, single-flag approach **forfeits the pristine flag-off byte-identity** that #1373/#1378/inc-2/inc-4 held. This is *inherent*, not a design miss: to avoid the lock you must remove the import edge **before** the flip, so the decouple must be visible in the flag-off template. Gating the decouple on `useSharedVpc` itself puts the sever *at* the flip → the exact producer-first lock returns.

- **If a reviewable wiring-only delta per increment is acceptable** (zero resource replacement, physical ids unchanged, no data touch — just export-removal + config/SSM-read + pins): **proceed with C.** Each increment regenerates its snapshots with a bounded, reviewed diff.
- **If "14 snapshots unchanged" is non-negotiable:** C is disqualified, and you're left with A/B's per-stack hand-ordered sequences that **do not survive `--all`** and are operator-fragile (a single wrong `cdk deploy --all` at flip time reintroduces the lock).

**This needs an explicit ruling before any item-3 code.** Recommendation: accept reviewed wiring-only deltas — the resulting end-state ("consumers always treat the VPC/SGs as external") is the correct shared-VPC posture anyway, and C's per-pass diffs are each independently reviewable at the prod gate.

*(There is a byte-identity-preserving variant — gate each edge behind an off-by-default flag flipped consumer-side before `useSharedVpc`, the inc-2 model — but it requires SSM two-value indirection to point at the standalone resource during the intermediate, plus `addDependency`, trading pristine snapshots for more mechanism + an ordering race. Only pursue it if the ruling above is "hard gate.")*

---

## Definitive export-edge inventory (origin/master)

Producer-first deploy order (`cdk/bin/sps-infra.ts`): **Network → Data → App → Etl → Observability**, Edge after App. CFN blocks changing/removing an export while a not-yet-updated consumer still imports it.

**Edges that BLOCK the flip (value changes / export removed on flip):**

| # | Edge | Producer → Consumer(s) | Why it blocks | Cleared by |
|---|---|---|---|---|
| 1 | `ExportsOutputRefVpc*` | Net → Data, App | VPC → `fromVpcAttributes`; export removed | **item 3** (consumers read `cfg.sharedVpc` ids) |
| 2 | `ExportsOutputRefVpc*Subnet*` | Net → Data, App, Etl | subnets → config literals; removed | **item 3** (`resolveTierSubnets`) |
| 3 | `ExportsOutputRefAppSecurityGroup` | Net → Data, App | SG **replaces** in imported VPC; value changes | **item 3** (SG by-id) |
| 4 | `ExportsOutputRefEtlSecurityGroup` | Net → Data, App, Etl | SG replaces | **item 3** (SG by-id) |
| 5 | `ExportsOutputRefAlbSecurityGroup` | Net → App (sole) | SG replaces | **item 3** (SG by-id) |
| 6 | `Sps-App-<env>-InternalAlbSecurityGroupId` (named) | App → Etl (sole) | internal-ALB SG replaces | **item 3** (SSM/config) |
| 7 | `Sps-App-<env>-InternalAlbDns` (named) | App → Etl (sole, `SCHOLARS_BASE_URL`) | ALB replaces | **item 3** (SSM) |
| 8 | `…FnGetAttPublicAlb…DNSName` | App → Edge (sole, CF origin) | ALB replaces | **item 3** (`HttpOrigin(ssm dns)`) |
| 9 | `…FnGetAttPublicAlb…LoadBalancerFullName` | App → Obs (sole, metrics) | ALB replaces | **inc-2** (✅ CODED, branch HEAD `c6df4cd3`; merge as P0b) |
| 10 | `…FnGetAttPublicTargetGroup…FullName` | App → Obs (sole, metrics) | TG replaces (VpcId immutable) | **inc-2** (✅ CODED, `c6df4cd3`; merge as P0b) |
| 15 | `Sps-Data-<env>-OpenSearchDomainEndpoint` (named) | Data → App, Etl | fresh domain → new endpoint | **#1380** (openSearchNodeFromSecret, OPEN PR) |
| 16 | `ExportsOutputRefAuroraCluster` | Data → Obs (sole, metric dim) | inc-4 = new cluster | **inc-2** (coded, unmerged) |
| 17 | `ExportsOutputRefOpenSearchDomain` | Data → Obs (sole, metric dim) | fresh domain | **inc-2** (coded, unmerged) |

**Edges that do NOT block (stable — no VpcId / not VPC-bound):** `ExportsOutputRefEcsCluster` (+ service/name — `AWS::ECS::Cluster` has no VpcId; Service network-config is an in-place update) #11; ETL ECR ARN #12; App log-group #13; deploy-role ARN #14; ETL failure-topic ARN #18. Leave as handles.

> **✅ inc-2 scope gap CLOSED (was stale ~4 min):** edges **9 and 10** (public-ALB + target-group *full-name* metrics → Observability) were flagged as uncovered at inc-2 snapshot `dc23099a`, but branch HEAD `c6df4cd3` already adds `publicAlbFullName`/`publicTargetGroupFullName` config + an `albMetric` helper under `observabilityMetricsByName` (all-four-or-throw guard). **Decision: EXTEND inc-2 (not item-3 SSM)** — same stack/flag, no ordering race, byte-identical flag-off. Item 3 references, does not re-implement. ⚠️ inc-2 branch is dirty (unrelated search-UI commits + a doc deletion, unpushed) → **re-cut just the 3 CDK commits (`62da3492`/`dc23099a`/`c6df4cd3`) off fresh `origin/master`** before PR'ing P0b.

---

## Recommended mechanism — Approach C (decouple-then-flip), with A/B grafts

**Core idea:** make the flip deploy carry **zero in-use cross-stack exports for any resource that changes value**, by doing all the rewiring in decouple passes that land **before** the flip while `useSharedVpc` is still false. Because those passes run flag-off against the *current* resources, they **replace nothing** — they only rewire imports → by-id/by-name/config/SSM reads. `Stack.exportValue` pins keep the (now-unused) producer exports alive so dropping a consumer's import never forces a producer to delete an in-use export. Then a **separate flip pass** sets the flag: resources replace, but no importer holds their exports → free to change. **`useSharedVpc` stays a single atomic flag** (honors the campaign invariant; B's phase-enum is avoided).

**Why C wins the panel:**
- It's the **only** approach that fully avoids the lock, and the proof is **ordering-independent at the flip** (after the decouple passes, every value-changing export has zero importers).
- It **never requires `cdk deploy --all`** — every pass is a discrete, independently-reviewable `--exclusively` deploy with a bounded diff, which is far better for the prod reviewer gate.
- A tripped on its *own* `InternalAlbSecurityGroupId` removal (producer-first); B couldn't express the intermediate `dual` state as a single flag and mis-scoped the compute tier. C sidesteps both by doing everything flag-off first.

**Grafts from A and B (adopt these into C):**
1. **SG ownership (from A + the "SG-ownership = OUR CALL" decision):** the 3 CDK-created SGs are the only ids that aren't already static config (VPC id + subnet ids + AZs are *already* `cfg.sharedVpc.*`). **Pre-provision the app/etl/alb SGs out-of-band in the shared VPC (or a dedicated `Sps-SharedSg-<env>` stack) and put their ids in `cfg.sharedVpc.{appSgId,etlSgId,albSgId}`** (option 2). Then every stack imports them via `SecurityGroup.fromSecurityGroupId(config)` — no Ref export, no SSM, deterministic, and the shared-VPC team owns the base ingress rules (minimizing the rule-relocation churn). *Fallback (option 3):* keep SGs CDK-owned, Network writes ids to SSM, consumers `valueForStringParameter` — **but** this reintroduces a deploy-ordering race (`valueForStringParameter` is not a CDK dependency) that must be pinned with explicit `stack.addDependency(networkStack)`. **Option 2 is the recommended, decisive choice.**
2. **Compute-tier reality (from B):** an `awsvpc` ECS task lives in exactly ONE VPC — there is **no true blue-green for compute**. Only Aurora + OpenSearch are genuinely "alongside" (snapshot-restore + fresh domain). The ECS service moves **in-place** onto the shared subnets/SG at the flip; the public/internal ALBs replace. Compute rollback = flip back to the retained standalone VPC/SGs. State this in the runbook so the reversibility story isn't oversold.
3. **VPC/subnet teardown retention (from B's correction):** the VPC/subnet auto-exports are removed cleanly *only* once no consumer references them; if any old resource still sits on standalone subnets during a transitional deploy, give those exports the same `exportValue` retention as the SGs (two-deploy dance) so a producer-first Network update never drops an in-use subnet export.

---

## Deploy sequence (per env — staging soaked, then prod reviewer-gated)

Each pass is its own PR + `cdk deploy --exclusively`, days apart; the estate runs on old resources between passes.

**Prerequisites (land + DEPLOY to the target env first — merge is not enough):**
- **P0a #1380** (openSearchNodeFromSecret) → edge 15 gone. *(OPEN PR — merge + deploy.)*
- **P0b inc-2** (observabilityMetricsByName) → edges 16, 17 gone. **Extend inc-2 to cover edges 9, 10** (App→Obs ALB/TG full-name metrics) or have item-3 absorb them. *(coded, unmerged.)*
- inc-4 code (Aurora FromSnapshot) can land here; its data path executes only at the flip.

**Item-3 decouple passes (flag OFF, zero replacement):**
1. **Producer publish + pin.** Pre-provision the 3 shared SGs (option 2, **with default allow-all egress**) and add their ids to config (`cfg.sharedVpc.{appSgId,etlSgId,albSgId}`); add `exportValue` pins for the **6 load-bearing exports = 5 Network (edges 1-5: VPC, subnets, app/etl/alb SG refs) + 1 App (edge 8: public-ALB DNSName)** — edges 6/7 are NAMED CfnOutputs, no pin needed; App writes internal-ALB SG-id + internal-ALB DNS + public-ALB DNS to SSM. Deploy Network, then App. Exports still emitted (pinned), values unchanged.
2. **Consumer repoint.** Data/App/Etl read VPC via `fromVpcAttributes(config)`, subnets via `resolveTierSubnets`, SGs via `fromSecurityGroupId(config)`; Etl reads internal-ALB DNS+SG-id via SSM; Edge swaps `LoadBalancerV2Origin(handle)` → `HttpOrigin(ssm dns)`. Deploy Data, App, Etl, Edge in **any order** (none import the pinned exports anymore). Still flag-off, still zero replacement. **Now every value-changing export has zero importers.**

**The flip pass:**
3. **Set `useSharedVpc=true` + `auroraSnapshotIdentifier`** (clears `assertCutoverGate`). **The snapshot id MUST come from a write-freeze snapshot verified per the [Data-preservation gate](#data-preservation-gate--authoritative-write-safety-blocks-cutover) below — a stale snapshot silently loses authoritative writes.** `cdk deploy` producer-first: Network imports the shared VPC + SGs; Data restores snapshot-Aurora + fresh OpenSearch alongside; App replaces both ALBs + moves the ECS service in-place; Etl/Edge already read the new ids from config/SSM. **No "export in use" at any stack.** Then complete the §6 operator prereqs (appRwGranteeHost regrant → 10.46.160.%, DSN/endpoint reseed).
4. **Cleanup (post-verify):** remove the `exportValue` pins.

**Rollback:** before pass 3 — trivial (passes 1–2 replaced nothing). At pass 3 — data tier reversible by construction (restored cluster/domain stand up alongside; nothing destroyed); flip back to `useSharedVpc=false` and the flag-agnostic pass-2 code re-resolves to the standalone ids. Main non-reversible cost = ALB DNS / CloudFront-origin churn (mitigated: Edge reads DNS from SSM → repoint by rewriting the param).

---

## MANDATORY proof gate — cloned-stack staging dry-run

The lock is a **deploy-time** behavior, **invisible to `cdk synth` / snapshot CI** (green CI is not evidence). Before prod, prove the sequence on cloned stacks:

1. Deploy the full `Sps-*` stack set into a sandbox account/region at `useSharedVpc=false` with stand-in snapshot-restored datastores.
2. Run the exact P0 → pass-1 → pass-2 → pass-3 sequence. **Before each producer pass**, run `aws cloudformation list-imports --export-name <name>` for every App/Data/Network export and require **zero importers** (the whole point — a non-zero count predicts the lock).
3. Confirm no stack enters `UPDATE_ROLLBACK` with an "Export … in use" reason.
4. Post-flip functional canary: `app_rw` auth succeeds (no MySQL 1410 from a stale `appRwGranteeHost`), Edge origin resolves to the new ALB, Etl reaches the new internal ALB, and **`chm2042` (Mason) publicationCount > 0** after reindex.

---

## Data-preservation gate — authoritative-write safety (BLOCKS cutover)

The snapshot-restore (inc-4) is the **only** step that can silently destroy authoritative data. A DB snapshot is a **complete point-in-time copy** of the whole cluster, so the full dataset transfers — but any write that lands **after** the snapshot instant and before cutover is lost. Most SPS data has an external system-of-record (PubMed, RePORTER, InfoEd, ED, Scopus…) and the nightly ETL rebuilds it, so a loss there is recoverable by re-running. The **app-authored / app-SOR data is irreplaceable** — it lives only in this DB and no ETL rebuilds it:

- **center membership** — the one field whose system-of-record IS this app.
- the hand-curated **org-unit** + **methods/tools overlay** tables (the exact set the `#1032 backup:curated` job already dumps — use that manifest as the authoritative list so the two never drift).
- `scholars_audit.manual_edit_audit` (manual-edit provenance).

**Required safeguards — all three, before any prod cutover, and on staging too if it carries live authoritative edits:**

1. **Write-freeze → snapshot-at-freeze.** Freeze app writes *before* taking the snapshot that feeds `auroraSnapshotIdentifier`, and stay frozen until safeguard 2 passes. The snapshot must be taken **at** the freeze point (not earlier) so zero authoritative writes fall in the gap. *(Freeze mechanism to confirm: temporary revoke of `app_rw` INSERT/UPDATE/DELETE, or an app read-only/maintenance flag — needs a decision; the app's exact read-only capability is unverified.)*

2. **Post-restore verification — block cutover on any mismatch.** Before traffic cuts to the restored cluster, compare the app-SOR tables live-vs-restored and **refuse to proceed on any diff.** MariaDB-native content check, not just row count:

   ```sql
   -- Run against BOTH the live cluster and the restored cluster; diff the outputs.
   -- Table set = the #1032 backup:curated manifest
   --             + the center-membership table + scholars_audit.manual_edit_audit.
   CHECKSUM TABLE
     scholars.<center_membership_table>,
     scholars.<curated_org_unit_table>,
     scholars.<methods_tools_overlay_table>,
     scholars_audit.manual_edit_audit;

   -- Fast row-count pre-check:
   SELECT table_schema, table_name, table_rows
   FROM information_schema.tables
   WHERE (table_schema = 'scholars'       AND table_name IN (/* curated set */))
      OR (table_schema = 'scholars_audit' AND table_name = 'manual_edit_audit');
   ```
   Any `CHECKSUM` divergence live-vs-restored = a write landed after the snapshot = **abort, re-snapshot at a fresh freeze.** Resolve the `<…>` names from the `backup:curated` config — **do not hard-code a guessed list.**

3. **Snapshot freshness is NOT gate-enforceable.** `assertCutoverGate` can only check that `auroraSnapshotIdentifier` is *set*, not that it is *fresh / post-freeze* (synth has no DB access). A stale id passes the gate and loses data — so freshness is a **runbook responsibility**, enforced by safeguard 2, not by code.

**Reversibility backstop:** the restore stands up **alongside** the live cluster (nothing destroyed), so a failed verification or a bad cutover rolls back by flipping `useSharedVpc=false` — the original cluster, with every authoritative write, is untouched and retained.

---

## ✅ Open questions — ALL RESOLVED (2026-07-01)

Full edit surface + evidence in `docs/cutover-item3-implementation-map-2026-06-30.md`.

1. **Byte-identity ruling:** ✅ **accept reviewed wiring-only deltas** → Approach C proceeds.
2. **SG ownership:** ✅ **Option 2** — shared-VPC team pre-provisions the app/etl/alb SGs out-of-band; ids arrive as `cfg.sharedVpc.{appSgId,etlSgId,albSgId}` (fields do NOT exist yet — added in pass 1). ⚠️ **The out-of-band SGs MUST be created with default allow-all egress** — `fromSecurityGroupId` emits no egress, so allow-all outbound (`network-stack.ts:133/139/145`) vanishes on the switch and app/ETL lose all outbound. This is the only functional break.
3. **Prod change-control:** ✅ **per-stack `--exclusively`** (C's model). No mandated `--all`.
4. **Inter-SG ingress:** ✅ **nothing drops on ingress** — all app/etl/alb receiver rules are L1 id-keyed `CfnSecurityGroupIngress` / peer-only `addIngressRule`, surviving import even at `mutable:false`; no self-referential rules. Only egress breaks (see #2). Keep `mutable:true` for forward-safety only.
5. **CF↔ALB origin:** ✅ exactly **3 props** on `HttpOrigin(ssmDns)` — `HTTP_ONLY`, `httpPort:80`, `customHeaders:{"X-Origin-Verify": originVerifyToken}` (`edge-stack.ts:239-244`). That header IS the entire origin-protection (ALB default-denies 403; only the matching-secret rule forwards, `app-stack.ts:2352-2383`) — dropping it opens the raw ALB DNS. No prefix-list/SG to reproduce; leave all timeouts unset.
6. **inc-2 extension:** ✅ **EXTEND inc-2's by-name pattern** (not item-3 SSM). Already coded (`c6df4cd3`); merge as P0b.

### Values nailed down (were UNVERIFIED)

- **`appRwGranteeHost` → `10.46.160.%`** (app2 /24 = `10.46.160.0/24`; `config.ts:125-126,689`). Active config still `10.20.%`(staging)/`%`(prod) — correct, `useSharedVpc` off.
- **#1380 OpenSearch secret** = `scholars/<env>/opensearch/{app,etl}`, key **`node`** = `https://<new-domain-endpoint>` — reseed at flip; `openSearchNodeFromSecret` OFF until backfilled (`app-stack.ts:239-242`, `secrets-stack.ts:130/136`).
- **Subnet-export pins bounded at ≤4** — 2-AZ VPC × (public+private) (`network-stack.ts:76-83`). **Load-bearing pins = 5 Network (edges 1-5) + 1 App (edge 8)**; edges 6/7 are NAMED CfnOutputs, never auto-deleted → no pin. Exact `ExportsOutputRefVpc*Subnet*` logical-id list = one `cdk synth Sps-Network-<env> | grep ExportsOutputRef` at pass-1 in a fresh-`origin/master` worktree (a stale synth here would lie).
