# SAML SP wiring + staging/prod rollout — debrief

**Date:** 2026-05-23
**Scope:** Issues #466 (SAML SP env wiring) and #100 (B01 SSO session cookie), plus the staging/prod ECS deploys to make SP-initiated login work end-to-end.
**Status at time of writing (2026-05-23):** Code is complete and correct (PRs below). Staging and prod are deployed with the SAML + session config. **One open blocker:** the ECS execution roles cannot fetch the newly-added `session-cookie-secret` at runtime despite a verifiably-correct IAM grant — *(diagnosed below as an IAM authorization-cache / eventual-consistency pathology; this diagnosis was **wrong** — see RESOLUTION).*

---

## RESOLUTION (2026-05-24) — the blocker was a secret-name gotcha, not IAM

**Both services are now `running=1` (staging `sps-app-staging:16`, prod `sps-app-prod:7`).** The "IAM eventual-consistency / self-heal" diagnosis below is **superseded** and was incorrect: the grant had been stable >24h and tasks were still failing on a fixed ~13-min cadence, which eventual consistency (seconds–minutes) cannot explain.

**Real root cause:** the Secrets Manager secret **name** `scholars/<env>/session-cookie-secret` ends in the token **`secret` — exactly 6 characters.** Secrets Manager's ARN parser mistakes a trailing `-` + 6 chars for the random ARN suffix, so the **suffix-less ARN is unresolvable**. CDK's `Secret.fromSecretNameV2().secretArn` injects exactly that suffix-less ARN into the ECS task-def `valueFrom`; for this one secret it can't resolve, so `GetSecretValue` fails at task start — surfacing as **AccessDenied** under the scoped exec role (the misparsed resource matches no grant) and as **ResourceNotFound** under broad creds. The other 8 secrets work because none ends in a 6-char token.

**Proof (data-plane probes, throwaway role + broad creds):**
- broad creds, suffix-less ARN `…/session-cookie-secret` → **ResourceNotFoundException**; control `…/db/app-rw` (2-char tail) → resolves fine.
- `-??????` grant, request `session-cookie-secret` by **full ARN** or **friendly name** → ALLOWED; by **suffix-less ARN** → DENIED.
- Perfect correlation across all 9 secrets: only the 6-char tail (`secret`) fails (rw/ro=2, app/key=3, cert=4, token=5, reciter=7 all work).
- `aws iam simulate-principal-policy` returns a **false** `allowed` (naive string match; doesn't model Secrets Manager resolution) — which is what misled the original diagnosis.

**Fix:** renamed the secret `scholars/<env>/session-cookie-secret` → `scholars/<env>/session-cookie-key` (3-char tail) in `SecretsStack` + `AppStack` (the app env var stays `SESSION_COOKIE_SECRET`; only the SM resource name changed). Per env: deploy `Sps-Secrets-<env>` (creates the new stub, retains the old secret), seed the new secret, deploy `Sps-App-<env> --exclusively`. After deploy the suffix-less ARN resolves and the exec role's existing `-??????` grant authorizes it like every other secret.

**Note:** the manual `sps-session-secret-unstick` policies added below were ineffective anyway — they grant `…session-cookie-secret-*`, and a `-*` pattern can't match a suffix-less request ARN that has no trailing `-`.

---

## TL;DR

- The app reads a pile of config from env/secrets that the ECS task definitions never provided. We wired it stack by stack.
- SAML SP integration **works end-to-end** — a real prod login authenticated against the WCM IdP and passed `validateSamlResponse`; it only 500'd at the final session-mint step because `SESSION_COOKIE_SECRET` wasn't wired (now fixed in code).
- Several AWS deploy gotchas bit us (OIDC provider reuse, empty prod ECR, `--exclusively` to dodge a NetworkStack resolver collision, intermittent local DNS blips, and finally a stuck IAM grant after policy churn).
- **The registered SP is the prod one** (`entityID` and `ACS` both `scholars.weill.cornell.edu/...`). Prod needs **no WCM change**; staging needs WCM to add the staging ACS to the SP.

---

## PRs shipped

| PR | What | State |
|----|------|-------|
| #467 | Wire the `SAML_*` config env into AppStack (`SAML_IDP_*`, `SAML_SP_*`, `SAML_CWID_ATTRIBUTE`; `SAML_IDP_CERT` as a secret) | **merged** |
| #468 | Wire `SAML_SP_CERT` (so `/api/auth/saml/metadata` stops 503ing) | **merged** |
| #469 | Staging announces the **registered prod** SP entityID (fix "Metadata not found") | **merged** |
| #470 | Wire `SESSION_COOKIE_SECRET` into AppStack | **open, correct, mergeable** |

---

## Current deployed state

| | Staging | Prod |
|---|---|---|
| App task def | `sps-app-staging:15` | `sps-app-prod:6` |
| desiredCount / running | 1 / **0** (blocked on IAM grant) | 1 / **0** (blocked on IAM grant) |
| `/api/auth/saml/login` | 302 → IdP (signed) ✅ | 302 → IdP (signed) ✅ |
| `/api/auth/saml/metadata` | 200 + cert nodes ✅ | 200 + cert nodes ✅ |
| Full login round-trip | ⛔ needs WCM to add staging ACS **and** IAM grant to converge | ⛔ needs IAM grant to converge (no WCM change) |
| Public DNS | `scholars-staging.weill.cornell.edu` → NXDOMAIN | `scholars.weill.cornell.edu` → NXDOMAIN |
| CloudFront | `d58uwodr6ov7g.cloudfront.net` (E17NRWINXLP3B3), alias + ACM cert ✅ | `dboe1z46whvts.cloudfront.net` (E28NKDFXC7K2ZL), alias + ACM cert ✅ |

Endpoint checks were run via `curl --resolve <host>:443:<cloudfront-ip>` (no DNS needed) and a real browser login via a local `/etc/hosts` mapping.

---

## The chain of issues (chronological)

### 1. `SAML_*` config env never injected (#466 → #467)
- **Symptom:** `GET /api/auth/saml/login` → `503 {"error":"SAML SP is not configured"}`.
- **Cause:** `getSamlEnv()` (`lib/auth/config.ts`) `requireEnv`s `SAML_IDP_CERT`, `SAML_IDP_SSO_URL`, `SAML_SP_ENTITY_ID`, `SAML_SP_ACS_URL`; AppStack injected only `SAML_SP_PRIVATE_KEY`.
- **Fix:** AppStack injects the IdP coords (constants — shared prod IdP), per-env SP entityID/ACS (from `SpsEnvConfig`), `SAML_CWID_ATTRIBUTE=CWID`, and `SAML_IDP_CERT` as a Secrets Manager secret.

### 2. `/api/auth/saml/metadata` 503 (#466 → #468)
- **Symptom:** `/login` worked after #467 but `/metadata` still 503'd.
- **Cause:** node-saml `generateServiceProviderMetadata` **throws** when the SP private key is configured but no public cert is supplied (`metadata.js`: *"Missing decryptionCert / publicCert while generating metadata for ... service provider"*). `SAML_SP_CERT` was never wired.
- **Fix:** inject `SAML_SP_CERT` from a new `scholars/saml-sp/<env>/cert` secret. Chosen as a **secret** (not a committed asset) after checking ReCiter-Publication-Manager's precedent — it reads SP cert/key/idp-cert from `config/certs/`, but that dir is **gitignored**; certs are provisioned out-of-band, never committed. SPS's out-of-band store is Secrets Manager.

### 3. "Metadata not found" at the IdP (#466 → #469)
- **Symptom:** staging login reached the IdP, which errored: *"Unable to locate metadata for `https://scholars-staging.weill.cornell.edu/api/auth/saml/metadata`."*
- **Cause:** WCM registered a **single** SP — the **prod** entityID `https://scholars.weill.cornell.edu/api/auth/saml/metadata` (tied to the filed cert). The "no separate staging registration" note means the staging-host entityID is **not** registered.
- **Fix:** staging announces the **prod** entityID as its `SAML_SP_ENTITY_ID` (verified by decoding the live AuthnRequest `Issuer`), while keeping the **staging** ACS so the response would return to staging.

### 4. IdP returns the response to the prod ACS (staging blocker — WCM-side)
- **Symptom:** after #469, staging login authenticated, then the browser landed on `https://scholars.weill.cornell.edu/api/auth/saml/callback` (the **prod** host) and stalled (prod doesn't resolve).
- **Cause:** SimpleSAMLphp uses the SP's **registered** ACS when the request's `AssertionConsumerServiceURL` isn't in the SP metadata. The registered SP lists only the **prod** ACS.
- **Fix (WCM-side, not code):** add `https://scholars-staging.weill.cornell.edu/api/auth/saml/callback` (HTTP-POST) as a second `AssertionConsumerService` on the SP. **Prod needs nothing** — its ACS is the registered one.

### 5. `SESSION_COOKIE_SECRET` never wired (#100 → #470)
- **Symptom:** a real **prod** login completed the full SAML round-trip (IdP recognized the SP, authenticated, POSTed back, `validateSamlResponse` **passed**) and then 500'd. Log: `Error: B01 SSO: required environment variable SESSION_COOKIE_SECRET is not set` at `.../api/auth/saml/callback/route.js`.
- **Cause:** `getSessionConfig()` `requireEnv`s `SESSION_COOKIE_SECRET`; AppStack never injected it and SecretsStack had no stub. The `/edit` middleware **fails safe** (catches the throw, redirects to login), so it surfaced only at the callback's session-mint step — i.e. after a fully successful SAML round-trip. **This is the proof the SAML work is correct.**
- **Fix:** new `scholars/<env>/session-cookie-secret` stub + AppStack injection (9th consumer ARN). Seeded with a random ≥32-char value.

### 6. Deploy mechanics (the long tail)
See **Deploy gotchas** below — OIDC provider reuse, empty prod ECR, circuit-breaker rollbacks, IAM grant churn, and the still-open IAM propagation pathology.

---

## WCM IdP / SAML facts (confirmed this session)

- **IdP is a SimpleSAMLphp proxy:** `login-proxy.weill.cornell.edu`. Source of truth = IdP metadata `https://login-proxy.weill.cornell.edu/idp/saml2/idp/metadata.php`.
- `SAML_IDP_ENTITY_ID` = `https://login-proxy.weill.cornell.edu/idp`
- `SAML_IDP_SSO_URL` = `https://login-proxy.weill.cornell.edu/idp/profile/SAML2/Redirect/SSO`
- **IdP signing certs (rollover pair, both published):**
  - 2016 cert, CN `login-proxy.weill.cornell.edu`, expires **2026-08-19**
  - 2026 successor, expires 2036-03-27
  - Both concatenated into `SAML_IDP_CERT` → the 2026-08-19 rollover is a no-op. (`parseIdpCert` accepts multiple PEM blocks.)
- **CWID attribute:** the assertion carries a `CWID` attribute (bare cwid, e.g. `paa2013`, **not** the `@med.cornell.edu` eppn). `SAML_CWID_ATTRIBUTE=CWID`. (Also available as `urn:oid:0.9.2342.19200300.100.1.1`.) Confirmed against a live assertion.
- **AuthnResponse signing:** left at default `false` (assertion-only signing required).
- **Registered SP = prod:** entityID `https://scholars.weill.cornell.edu/api/auth/saml/metadata`, ACS `https://scholars.weill.cornell.edu/api/auth/saml/callback`. Tied to the SP cert filed with WCM (CN `scholars.weill.cornell.edu`, SHA-256 `91:A1:86:0F:B8:66:16:B8:3D:DB:C0:C1:C9:C4:4C:F2:30:0B:D5:64:DC:B1:43:04:2A:53:A4:F4:2A:E2:68:90`, valid 2026-05-20 → 2029-05-19).
- **SP keypair reused for staging** (per decision): the prod private key (Secrets Manager, real, modulus-matched to the prod cert) and the prod public cert serve both envs.

---

## Secrets inventory (Secrets Manager, account 665083158573, us-east-1)

App execution role consumes **9** secrets (asserted in `cdk/test/app-stack.test.ts`):

| Secret name | Injected as | Seeded? |
|---|---|---|
| `scholars/<env>/db/app-rw` | `DATABASE_URL` | ✅ |
| `scholars/<env>/db/app-ro` | `DATABASE_URL_RO` | ✅ |
| `scholars/<env>/opensearch/app` | `OPENSEARCH_USER/PASS` | ✅ |
| `scholars/<env>/revalidate-token` | `SCHOLARS_REVALIDATE_TOKEN` | ✅ |
| `scholars/<env>/session-cookie-secret` | `SESSION_COOKIE_SECRET` | ✅ (random 64-char, both envs) |
| `scholars/saml-sp/<env>/private-key` | `SAML_SP_PRIVATE_KEY` | ✅ (prod key reused for staging) |
| `scholars/<env>/etl/reciter` | `SCHOLARS_RECITERDB_*` | ✅ |
| `scholars/<env>/saml/idp-cert` | `SAML_IDP_CERT` | ✅ (both rollover PEMs) |
| `scholars/saml-sp/<env>/cert` | `SAML_SP_CERT` | ✅ (prod public cert, both envs) |

Naming convention: env-first `scholars/<env>/...`. The SAML SP keypair is the documented exception (`scholars/saml-sp/<env>/...`) because the prod private key was pre-staged and CDK imports its existing ARN.

**Seeding discipline:** mandatory ECS secrets must be seeded **before** the AppStack deploy, or the task can't start (`ResourceInitializationError`). IdP cert + SP cert are public; the session secret is generated random. Never echo secret values — seed from a temp file via `--secret-string file://…`, then truncate the file (`printf '' > file`).

---

## Deploy gotchas & lessons (reusable)

1. **GitHub OIDC provider is account-level — prod must reuse staging's.**
   `cdk deploy Sps-App-prod` fails with `EntityAlreadyExistsException: Provider with url https://token.actions.githubusercontent.com already exists` unless you pass:
   `-c githubOidcProviderArn=arn:aws:iam::665083158573:oidc-provider/token.actions.githubusercontent.com`

2. **Always deploy AppStack `--exclusively`.**
   A plain `cdk deploy Sps-App-<env>` pulls in the **NetworkStack** dependency, which tries to **create** 3 `WcmResolverRuleAssociation`s that are already **manually** associated to the VPC → `ResourceInUseException` → rollback. `--exclusively` deploys only AppStack against the existing NetworkStack exports.

3. **Prod ECR (`scholars-app-prod`) was empty.**
   Prod had been dormant (desiredCount=0) and `deploy.yml` only pushes the staging image. Bumping prod to desiredCount>0 → every task `CannotPullContainerError ... :latest: not found` → circuit-breaker rollback. Fix = bootstrap the image (env-agnostic 12-factor build):
   ```bash
   REG=665083158573.dkr.ecr.us-east-1.amazonaws.com
   aws ecr get-login-password | docker login --username AWS --password-stdin "$REG"
   docker pull "${REG}/scholars-app-staging:latest"
   docker tag  "${REG}/scholars-app-staging:latest" "${REG}/scholars-app-prod:latest"
   docker push "${REG}/scholars-app-prod:latest"
   ```
   Brace `${REG}:latest` — the Bash tool runs zsh, where unbraced `$VAR:latest` triggers the `:l` modifier and mangles the tag.

4. **Intermittent local DNS blips during `cdk deploy` monitoring.**
   `getaddrinfo ENOTFOUND cloudformation.us-east-1.amazonaws.com` killed the CLI **monitoring** several times. The CloudFormation update **proceeds server-side** regardless; re-verify with `aws cloudformation describe-stacks` + `aws ecs describe-services` rather than trusting the CLI exit.

5. **ECS deployment circuit breaker + IAM grant timing = churn trap.** ← the big one
   When you add a secret to a task def **and** the grant to the execution role in the **same** deploy, CFN may launch the new tasks before the IAM grant is effective → `AccessDeniedException` on secret fetch → 10 failures → circuit breaker → **rollback** (which *removes* the grant and resets the propagation clock). Repeating this re-poisons convergence.
   - Mitigations that help: deploy the grant at `desiredCount=0` first (no task launch), let it settle, then scale up via a **pure** `desired-count` change (no task-def change → no new deployment → no circuit breaker → retries without rollback).
   - **Do not** churn the same inline policy repeatedly.

6. **`/api/health` is shallow** (`{ok:true}`, no DB) — so an ECS task is "healthy" on process start even if the DB/LDAP aren't provisioned. The SAML round-trip (login→callback→session mint) also doesn't need the DB; only `/edit` page render does.

---

## The open issue: stuck IAM authorization for `session-cookie-secret`  — ⚠️ SUPERSEDED (see RESOLUTION at top; this was a wrong diagnosis)

**Symptom:** both `sps-task-exec-staging` and `sps-task-exec-prod` get, on task start:
```
ResourceInitializationError: ... GetSecretValue ... AccessDeniedException:
User: .../sps-task-exec-<env>/<task> is not authorized to perform: secretsmanager:GetSecretValue
on resource: .../secret:scholars/<env>/session-cookie-secret
because no identity-based policy allows the secretsmanager:GetSecretValue action
```
…persisting **1+ hour** after the grant went stable.

**Everything verified correct** (see table in "Current state" intro). Notably:
- The deployed exec-role inline policy grants both `…session-cookie-secret` and `…session-cookie-secret-??????`; a fresh extra inline policy grants `…session-cookie-secret-*`.
- `aws iam simulate-principal-policy` returns **`allowed`** for both the full and partial ARN.
- `aws secretsmanager get-secret-value` with broad creds (`user/reciter`) **succeeds** — the secret is healthy; not an SCP/account block.
- Secret ARN base **byte-matches** the grant; no resource policy; no permissions boundary; VPC endpoint policy is allow-all.

**Conclusion:** control-plane (simulator/policy doc) says *allowed*; data-plane (runtime authorization) says *denied*. This is an IAM eventual-consistency / authorization-cache pathology, almost certainly poisoned by ~6 rapid rewrites of the exec-role inline policy (deploy → rollback → step1 → step2 → rollback → scale). The other 8 secrets work because their grants settled hours earlier.

**Current mitigation:** churn stopped; both services at `desiredCount=1` via **pure scale** → ECS retries with backoff and **self-heals** the instant IAM converges (no rollback, no further churn). No action needed for it to recover; it just needs time.

**If still denying after ~1 hour of stable policy:** treat as an AWS-side anomaly (support case). A last-resort manual unstick (detach/reattach or recreate the exec role's inline policy) risks more churn.

---

## Verification recipes

```bash
# Hit a host that has no public DNS yet, through CloudFront, with correct SNI/TLS (no /etc/hosts):
H=scholars.weill.cornell.edu; CFIP=$(dig +short dboe1z46whvts.cloudfront.net A | head -1)
curl -sS --resolve $H:443:$CFIP "https://$H/api/auth/saml/metadata" -D - -o /tmp/m.out
curl -sS --resolve $H:443:$CFIP "https://$H/api/auth/saml/login?return=%2Fedit" -D - -o /dev/null  # 302 → IdP

# Browser login before DNS lands (any CloudFront edge IP works via SNI):
#   ! echo "<cloudfront-ip> scholars.weill.cornell.edu" | sudo tee -a /etc/hosts
#   ! sudo sed -i '' '/scholars.weill.cornell.edu/d' /etc/hosts   # cleanup

# Decode the AuthnRequest Issuer + ACS from the /login redirect:
python3 - "$LOCATION_HEADER" <<'PY'
import sys,urllib.parse as u,base64,zlib,re
q=u.parse_qs(u.urlparse(sys.argv[1]).query); xml=zlib.decompress(base64.b64decode(q['SAMLRequest'][0]),-15).decode()
print(re.search(r'Issuer[^>]*>([^<]+)<',xml).group(1)); print(re.search(r'AssertionConsumerServiceURL="([^"]+)"',xml).group(1))
PY

# Is a GetSecretValue grant actually effective? (control-plane view)
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::665083158573:role/sps-task-exec-<env> \
  --action-names secretsmanager:GetSecretValue --resource-arns "$(aws secretsmanager describe-secret --secret-id scholars/<env>/session-cookie-secret --query ARN --output text)"

# Why did a task fail to start? (the real reason)
aws ecs describe-tasks --cluster sps-cluster-<env> \
  --tasks $(aws ecs list-tasks --cluster sps-cluster-<env> --desired-status STOPPED --query 'taskArns[-1]' --output text) \
  --query 'tasks[0].stoppedReason' --output text

# Pull the IdP signing certs into a concatenated PEM (for SAML_IDP_CERT):
curl -sS https://login-proxy.weill.cornell.edu/idp/saml2/idp/metadata.php > /tmp/idp.xml
# extract each <ds:X509Certificate> under a signing KeyDescriptor, wrap as PEM, concatenate
```

---

## Outstanding / next steps

1. **IAM convergence** — wait for the exec-role grants to converge; the services self-heal to `running=1`. (Open blocker.)
2. **Test prod login** once prod is `running=1`: browser login via `/etc/hosts` → `scholars.weill.cornell.edu/edit`. Prod's ACS is registered, so the round-trip should complete (session minted, redirect to `/edit`). Confirm via absence of `saml_callback_failed` in `/aws/ecs/sps-app-prod` logs.
3. **WCM:** add the **staging** ACS (`https://scholars-staging.weill.cornell.edu/api/auth/saml/callback`, HTTP-POST) as a second `AssertionConsumerService` on the SP. Then staging login completes too.
4. **DNS:** request the app-CNAMEs (separate WCM DNS ticket, not the SAML contact):
   - `scholars-staging.weill.cornell.edu` → `d58uwodr6ov7g.cloudfront.net`
   - `scholars.weill.cornell.edu` → `dboe1z46whvts.cloudfront.net`
5. **Merge #470** when ready.
6. **2026-08-05 / 2026-08-26:** IdP cert rollover housekeeping per `docs/saml-sp.md §2` (the SP already trusts both certs, so it's a no-op + cleanup).

## Cleanup / drift to reconcile

- **Manual `sps-session-secret-unstick` inline policies** added to `sps-task-exec-staging` and `sps-task-exec-prod` — these are drift (not in CDK). Remove once the CDK grant converges:
  `aws iam delete-role-policy --role-name sps-task-exec-<env> --policy-name sps-session-secret-unstick`
- **Prod `desiredCount`** is at 1 via out-of-band `aws ecs update-service` (CFN thinks 0). Reconcile with a `cdk deploy Sps-App-prod -c appDesiredCount=<n>` once stable, or scale prod back to 0 for pre-launch (it's burning a Fargate task only when a task actually runs — failed task placements don't bill).
- **Staging** likewise scaled out-of-band to 1.
