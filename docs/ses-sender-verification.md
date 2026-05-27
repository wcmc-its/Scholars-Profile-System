# SES sender verification — "Request a change" server mailer (#160 Phase 2)

**Audience:** the SPS operator / AWS account admin. These are the out-of-band
steps the code cannot perform. Until they are complete and the flag is flipped,
the mailer is **dormant**: `POST /api/edit/request-change` returns `503
send_disabled` and the `/edit` "Request a change" modal falls back to the
Phase-1 client `mailto:` (#494) — no user-visible change.

The application side (endpoint, mailer, audit, IAM grant, env vars) is already
deployed by AppStack. What remains is verifying the sender, leaving the SES
sandbox, and flipping one env var.

| Item          | Value                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender (From) | `no-reply-scholars@weill.cornell.edu`                                                                                                          |
| Flag env var  | `SELF_EDIT_REQUEST_CHANGE_SEND` (ships `off`)                                                                                                  |
| From env var  | `SCHOLARS_MAIL_FROM` (ships `no-reply-scholars@weill.cornell.edu`)                                                                             |
| IAM grant     | task role `sps-task-<env>-ses`: `ses:SendEmail`, `Resource: …:identity/*`, conditioned `ses:FromAddress = no-reply-scholars@weill.cornell.edu` |
| Region        | the AppStack region (`SES` must be enabled there)                                                                                              |

## 1. Verify the sender identity (DKIM / domain)

Do **not** use email-address verification — `no-reply-scholars@…` is an
unattended mailbox and cannot click a verification link. Verify the **domain**
(or a subdomain) with DKIM instead:

1. In SES → **Verified identities** → _Create identity_ → **Domain**
   (`weill.cornell.edu`, or a dedicated subdomain such as
   `scholars.weill.cornell.edu` if central IT prefers to scope it).
2. SES issues **three DKIM CNAME records**. File these with WCM central DNS
   (they own `weill.cornell.edu`). Verification completes when the CNAMEs
   resolve — typically minutes to a few hours.
3. (Recommended) add the SES **MAIL FROM** subdomain records for SPF/DMARC
   alignment if WCM enforces DMARC.

> The IAM grant already allows any identity ARN in the account (`identity/*`)
> **conditioned on the From address**, so it works whether you verify the bare
> email or the whole domain — no infra change is needed when you pick the method.

## 2. Leave the SES sandbox

A new SES account is sandboxed (can only send to verified addresses, low quota).
Open an AWS Support **"Request production access"** case for SES in the AppStack
region. State: transactional profile-correction emails to WCM offices
(`support@`, `ofa@`, `osra-operations@`), low volume, with the verified domain
identity. Approval is usually < 24h.

## 3. Confirm the audit dependency (#493)

The endpoint writes a **best-effort** `request_change` B03 audit row _after_ the
send, so a missing grant never loses an email — but to capture the audit trail,
apply both for each environment:

1. The ENUM extension (idempotent) from `scripts/sql/audit-log.sql`:
   ```sql
   ALTER TABLE `scholars_audit`.`manual_edit_audit`
     MODIFY COLUMN `action`
       ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change')
       NOT NULL;
   ```
2. The app DB role's `INSERT` grant on `scholars_audit.manual_edit_audit`
   (the same #493 grant that Hide/Show needs). Verify with
   `SHOW GRANTS FOR '<app_user>'@'<host>';`.

If the grant is absent you'll see `request_change_audit_failed` log lines while
mail still sends — that is the designed degradation, not an outage.

## 4. Go live

1. Set `SELF_EDIT_REQUEST_CHANGE_SEND=off → "on"` in `cdk/lib/app-stack.ts`
   (the app task-def `environment`) and deploy AppStack — **staging first**.
2. On staging, submit a `route` request from `/edit` (e.g. Education → "a
   degree… is wrong") and confirm the office receives it and the modal shows
   **"Request sent."** (not the `mailto:` fallback copy).
3. Verify the audit row:
   ```sql
   SELECT actor_cwid, target_entity_id,
          JSON_EXTRACT(after_values,'$.office')   AS office,
          JSON_EXTRACT(after_values,'$.issue_id') AS issue,
          created_at
   FROM scholars_audit.manual_edit_audit
   WHERE action = 'request_change'
     AND created_at >= NOW() - INTERVAL 1 DAY
   ORDER BY created_at DESC;
   ```
4. Repeat the flag flip + deploy for prod (the prod env reviewer gate applies).

## Rollback

Set the flag back to `off` and deploy — instantly reverts every surface to the
Phase-1 `mailto:` with no code change. The IAM grant and env scaffolding can
stay in place (harmless while the flag is off).
