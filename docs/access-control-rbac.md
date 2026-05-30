# Access control, RBAC & break-glass

**Audience.** Operators and ITS colleagues answering *"who can edit a profile / a unit /
prod data? who can deploy? how do we get in during an incident?"*

SPS has **three independent authorization layers**. Confusing them is the most common
mistake, so this doc separates them explicitly:

1. **Application RBAC** — who can read/edit *content* (profiles, units). SAML + Enterprise
   Directory + per-unit roles. *This is the layer most "who can change this?" questions are about.*
2. **AWS IAM** — what the *infrastructure principals* (ECS tasks, the deploy pipeline) can do.
3. **Database roles** — what each *DB connection* can do (read vs write vs audit-insert).

Plus **break-glass** — the emergency-access and kill-switch procedures.

> Sources: [`lib/edit/authz.ts`](../lib/edit/authz.ts) (the application predicates),
> [`lib/auth/`](../lib/auth/) (session + superuser), [`ADR-005` Amendment 1](./ADR-005-manual-override-layer.md)
> (unit RBAC), [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) (IAM + secrets),
> [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) (deploy gate + kill switch),
> [`saml-sp.md`](./saml-sp.md) (SSO).

---

## Layer 1 — Application RBAC (who can edit content)

### Identity (authentication)

- **Public read** requires **no login** — all `/scholars`, `/topics`, `/departments`,
  `/centers`, `/search` pages are anonymous.
- **Editing** requires **WCM SSO via SAML 2.0** (`login-proxy.weill.cornell.edu`). The
  session cookie is HttpOnly, Secure, SameSite=Lax, scoped to the host. There is never a
  token in a URL. `middleware.ts` gates `/edit/*` and `/api/edit/*`; an unauthenticated hit
  redirects to SSO. Session ≈ 8 h. See [`saml-sp.md`](./saml-sp.md).

### The roles

| Role | Source of truth | Re-checked | Can do |
|---|---|---|---|
| **Self** | `session.cwid == target.cwid` | per request | Edit *own* `overview`; hide *own* scholar / grant / education / appointment; hide *self* as a contributor on a publication; revoke a suppression *they* created. |
| **Superuser** | Enterprise Directory group `ITS:Library:Scholars/superuser-role` (LDAPS lookup of the group's `member` list, keyed on session CWID) | **every `/edit/*` GET and `/api/edit/*` POST** — never cached in the session | Everything: edit any field incl. `slug`, suppress/revoke anything (incl. whole-publication takedown), grant/revoke any unit role, view suppressed data on the superuser GET pages. |
| **Unit Owner** | a `unit_admin` row (`role=owner`) for the unit | per POST | Edit the unit (`description`, leadership, roster) **and manage access** (grant/revoke `owner`/`curator`) within the owned subtree; proxy-edit scholars whose LDAP-primary unit is in scope. |
| **Unit Curator** | a `unit_admin` row (`role=curator`) | per POST | Edit the unit **only**. Cannot delegate (cannot grant any role) — the load-bearing line that stops a curator self-escalating. |

Key properties:

- **Superuser is an SSO group; unit roles are data-derived `unit_admin` rows, not SSO
  groups.** Both are re-evaluated on every request, never cached into the session.
- **Fail-closed:** a directory error *denies*, never grants. So an Enterprise Directory
  outage blocks all editing rather than risking privilege escalation (`superuser_check_failed`
  is logged). Losing the superuser group takes effect on the user's *next* `/edit/*` request.
- **`owner` subsumes `curator`** (an owner needs no separate curator row).

### Unit RBAC scope rules (ADR-005 Amendment 1 § A1.2)

The per-unit predicates live in [`lib/edit/authz.ts`](../lib/edit/authz.ts):

- **Cascade:** a **department**-level grant cascades to that department's **divisions**; a
  division-level grant does **not** cascade upward. (`getEffectiveUnitRole` resolves the
  effective role by checking the unit *and* its parent department in one query.)
- **Authority ≤ own role:** you can only grant a role you hold. `canGrant` distinguishes two
  denials for triage — `scope_violation` (no role on the target subtree at all) vs
  `authority_violation` (in scope but only a curator, so cannot delegate). Owner→owner is a
  deliberately permitted widening.
- **Manage-access requires Owner:** `canManageAccess` — granting/revoking a `unit_admin` row
  needs Owner (or Superuser). A Curator can edit but never delegate.
- **Proxy edit (T3):** an Owner/Curator may proxy-edit a scholar's `overview` (and per-author
  publication hide) **iff the scholar's LDAP-primary `deptCode`/`divCode` is in the actor's
  subtree** — read from the LDAP-authoritative `Scholar` columns, never `field_override`-able.
  **Roster membership never confers profile-edit rights** (`canProxyEdit` → `proxy_target_not_in_unit`
  otherwise). This prevents adding someone to a roster as a backdoor to editing their profile.
- **Grant provenance:** `unit_admin.grantedBy` records the actor whose role + scope made the
  grant legal; grants are inserted, revokes **hard-delete** the row — both audited in B03.

### Field-level rules worth memorizing

| Action | Who |
|---|---|
| Edit `overview` (bio) | Self only (a superuser does **not** inherit it — broad admin field-editing is deferred), or an in-scope unit Owner/Curator via proxy. |
| Edit `slug` (vanity URL) | **Superuser only.** A scholar *requests* a slug ([`slug-personalization-spec.md`](./slug-personalization-spec.md)); a superuser approves/sets it. |
| Hide whole publication (retraction/takedown) | **Superuser only.** |
| Hide self as a contributor | The contributor themselves. |
| Grant/revoke a unit role | Owner (within subtree) or Superuser. |

### Defense in depth (beyond the role check)

Every `/api/edit/*` POST must additionally be **`application/json` AND same-origin**
(`verifyRequestOrigin` — `Sec-Fetch-Site` primary, `Origin`/`Host` fallback). A cross-site
HTML form can't satisfy both, so this is CSRF defense on top of SameSite=Lax. Every 403
emits one `edit_authz_denied` line → the `sps-edit-authz-denied-${env}` alarm fires on
sustained denials (a predicate regression or probing). See [`logging-reference.md`](./logging-reference.md).

### Where edits land (and the audit)

Edits write to the **manual-override layer** (`field_override`, `suppression`, `unit_admin`
— [`ADR-005`](./ADR-005-manual-override-layer.md)), which the ETL never touches. Every
successful write appends a tamper-evident row, **in the same transaction**, to the separate
`scholars_audit` database — "who changed what, when, before/after" — see
[`b03-audit-log.md`](./b03-audit-log.md).

## Layer 2 — AWS IAM (infrastructure principals)

The ECS service runs under **two roles**, split so an app-process compromise gains nothing
extra (`PRODUCTION_ADDENDUM.md § Role split`, [`ADR-008` threat model](./ADR-008-infrastructure-as-code.md)):

| Role | Assumed by | Permissions |
|---|---|---|
| **`sps-task-exec-${env}`** (task-execution) | ECS itself, at task start | Pull the image (ECR, scoped to the SPS repo), inject the **exactly-enumerated** secret ARNs (`secretsmanager:GetSecretValue`), write the two log groups. No `*` resource on any non-auth statement. |
| **`sps-task-${env}`** (task role) | the running app code | **Zero attached permissions** (plus the narrow `xray:PutTraceSegments`/`PutTelemetryRecords` for tracing). App code calls no AWS API; it sees secrets only as env vars injected by the *execution* role. A test asserts zero `secretsmanager:*` on this role. |

| Pipeline principal | Trust / scope |
|---|---|
| **`sps-deploy-${env}`** (GitHub Actions OIDC) | No long-lived keys. Trust pinned by OIDC sub-claim: **prod admits only `refs/heads/master`**; staging admits any ref in the repo. Permissions scoped to AppStack resources: ECR push, `ecs:RunTask` on the migration/bootstrap task families, `ecs:UpdateService`/`DescribeServices` on the SPS service, `iam:PassRole` on the two task roles (conditioned to `ecs-tasks.amazonaws.com`). |
| **`sps-migrate-${env}`** task | Runs `prisma migrate deploy` with the writer DSN; one-shot per deploy. |
| **`sps-db-bootstrap`** task (#493) | Runs as the least-priv `sps_bootstrap` DB user (never master) to provision + verify the `scholars_audit` schema and the app role's INSERT-only grant, *before* migrate, fail-closed. |

**Human AWS access:** `cdk deploy`, `cdk diff`, secret-value provisioning, and account
operations are owned by the **account holder** and run with their AWS credentials (live in
the operator's shell env from `~/.zshrc`); `cdk deploy` is never run autonomously. The
prod-deploy human gate is in Layer 2.5 below.

### 2.5 — The deploy gate (who can ship to prod)

- **Push to `master` auto-deploys staging only.** Prod is **`workflow_dispatch`-only** —
  someone manually runs `Actions → Deploy` with `env=prod`, `branch=master`. (Consequence:
  prod can silently lag master — the "old UI" trap; diagnose via prod ECR `:latest` vs
  master HEAD.)
- The prod run then **pauses for required-reviewer approval** — the `prod` GitHub
  Environment has a required reviewer (`paulalbert1`); the run sits in *Awaiting approval*
  until they click *Approve and deploy*. The OIDC sub-claim (master-only) is the AWS-side
  belt to that braces. See [`DEPLOY-RUNBOOK.md § Normal path`](./DEPLOY-RUNBOOK.md).
- ⚠️ The `gh api -X PUT .../environments/<name>` call **full-replaces** the environment
  config — always re-send `deployment_branch_policy` or it wipes the master-only branch
  policy.

## Layer 3 — Database roles

Distinct DSN secrets enforce least privilege at the connection level
(`PRODUCTION_ADDENDUM.md § Secrets`):

| Secret / role | Used by | Privilege |
|---|---|---|
| `scholars/db/app-ro` | App reads (`db.read`, server components, most routes) | read-only (reader endpoint) |
| `scholars/db/app-rw` | `/api/edit*` writes + the migration task | read/write (writer endpoint) + INSERT-only on `scholars_audit.manual_edit_audit` |
| `scholars/db/etl` | ETL task family | read/write (writer) for ETL-managed tables |
| `scholars/db/bootstrap` (`sps_bootstrap`) | the db-bootstrap task only | least-priv: create the audit schema + grant, nothing else |

`npm run audit:db-writes` (CI-gated) proves no write path uses the read client. The
**audit DB is separate** with an **INSERT-only** grant for the app role (no UPDATE/DELETE) —
that separation is load-bearing for #102 tamper-evidence; a missing grant fails the deploy
loud-and-early rather than breaking edits at runtime (the #493 class). DB credentials rotate
via the Secrets Manager RDS rotation Lambda; OpenSearch + revalidate-token rotate quarterly
on a calendar.

## Break-glass & emergency access

| Situation | Action | Doc |
|---|---|---|
| **Active data damage** (runaway ETL, exploited credential) | **Kill switch:** `aws ecs update-service --cluster sps-cluster-${env} --service sps-app-${env} --desired-count 0` — drains in ~30 s; site returns CloudFront 503. Restore by setting count back to 1 (staging) / 2 (prod). Killing prod is a P0; notify active operators first. | [`DEPLOY-RUNBOOK.md § Kill switch`](./DEPLOY-RUNBOOK.md) |
| **Bad image, 5xx, circuit-breaker didn't catch it** | **Operator-driven rollback:** repoint ECR `:latest` to the prior good SHA, `--force-new-deployment`. Do **not** re-run the workflow from an old commit (re-runs migrations). | [`DEPLOY-RUNBOOK.md § Emergency procedures`](./DEPLOY-RUNBOOK.md) |
| **Deploy pipeline broken, must ship out-of-band** | Operator runs the deploy pipeline manually with their AWS creds — db-bootstrap + verify-grants + migration tasks **must** each exit 0 before the service rolls (ordering is load-bearing). | [`DEPLOY-RUNBOOK.md § The deploy pipeline contract`](./DEPLOY-RUNBOOK.md) |
| **Bad migration** | No rollback — fix forward with an additive migration. Never `prisma migrate resolve --rolled-back` against live traffic. | [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), [`PRODUCTION_ADDENDUM.md § Rollback`](./PRODUCTION_ADDENDUM.md) |
| **Annual ETL stuck at the approval gate** | `aws stepfunctions send-task-success --task-token <token> --task-output '{}'` to release; 7-day cap auto-fails. | [`PRODUCTION_ADDENDUM.md § Manual-approval gate`](./PRODUCTION_ADDENDUM.md) |
| **Lost editing access during an incident** | There is **no application-layer break-glass that bypasses SSO/Enterprise Directory** — recovery is to restore directory/SAML reachability (fail-closed by design). Grant emergency superuser by adding the CWID to `ITS:Library:Scholars/superuser-role` in Enterprise Directory. | [`saml-sp.md`](./saml-sp.md), [`ed-superuser-group`](./PRODUCTION_ADDENDUM.md) |

**Local dev access** (for reproducing an edit-flow bug off-prod): there is no built-in
dev-login; recreate the uncommitted `app/api/auth/dev-login` route + `.env.local`. Procedure
in the operator's notes (project memory `project_sps_local_edit_dev_login`); never ship a
dev-login route to a deployed environment.

## Quick-reference: "Can X do Y?"

| Question | Answer |
|---|---|
| Can a logged-in scholar edit their own bio? | Yes (self). |
| Can they change their own URL slug? | No — they *request* it; a superuser sets it. |
| Can a department Owner edit a faculty member's bio? | Only if that faculty member's **LDAP-primary** dept/division is in the Owner's subtree (proxy edit), not just because they're on a roster. |
| Can a Curator add another Curator? | No — only Owners (or Superusers) grant roles. |
| Can the running app code read a Secrets Manager secret it wasn't started with? | No — the task role has zero secret access. |
| Can a feature branch deploy to prod? | No — prod OIDC admits only `refs/heads/master`, and a human must approve. |
| What happens to editing if Enterprise Directory is down? | All editing is denied (fail-closed); public reads are unaffected. |

## Known gaps

- **No formal access-recertification cadence** for the superuser group / unit_admin grants
  is documented yet (review who holds `unit_admin` rows and superuser-group membership on a
  schedule — candidate follow-on).
- **No standing emergency superuser** — emergency elevation is via the Enterprise Directory
  group, which depends on directory reachability.
- **Break-glass is intentionally minimal** — by design there is no SSO-bypass path; this is
  a security property, not a gap, but operators should know it before an incident.
