# PLAN — Request-a-change server mailer (Phase 2, #160)

**Status:** DRAFT — awaiting go. Branches off `master` (`faa705d`), NOT the
current `fix-search-index-throughput-485` branch.
**Implements:** `docs/self-edit-request-change-modal.md` § 5 (Phase 2 delta).
**Phase 1** (Apollo modal + structured `mailto:`) shipped in **#494** and stays
as the graceful fallback.

## Decisions locked (2026-05-26)

1. **Full Phase 2, shippable dark.** Build app + endpoint + audit + CDK
   `ses:SendEmail`/identity + env flag. Live once ops verify the SES identity
   and exit the sandbox; until then the dialog keeps the Phase-1 `mailto:`.
2. **Defer receipt.** Ship send + confirmation + audit. The opt-out receipt
   checkbox + actor-email resolution are a fast-follow (§ Deferred).
3. **Send first, audit best-effort.** Resolve route → send → then append the B03
   row best-effort (log on failure, like the post-commit search reflection). The
   request succeeds even where the **#493** `scholars_audit` INSERT grant is
   still unapplied; mail is never lost to an audit-permission gap.

## Architecture: how "dark" works without client flag plumbing

The dialog **always** POSTs to `/api/edit/request-change` on a `route` submit.
The endpoint is the single switch:

- flag off **or** SES unconfigured → `editError(503, "send_disabled")`
- send fails → `editError(502, "send_failed")`
- success → `editOk({ sent: true })`

The client treats **any non-2xx** as "fall back to the Phase-1 `mailto:`" and
shows the existing confirmation banner. So nothing about the client behavior
changes until the endpoint starts returning 200 — no server→client flag prop,
no dead UI. When the flag flips on, the same modal silently becomes a real send
with a "Request sent." toast instead of the "your mail client should have
opened" banner.

## Tasks (single PR unless noted)

### T1 — Mailer abstraction `lib/edit/mailer.ts` (new)
- `sendMail({ to, cc?, subject, text }): Promise<{ messageId: string }>`.
- Wraps `@aws-sdk/client-sesv2` `SendEmailCommand` (`Content.Simple`,
  `Destination.ToAddresses`/`CcAddresses`). Lazy-instantiate one `SESv2Client`
  (region from `AWS_REGION`/`AWS_DEFAULT_REGION`).
- `isMailerConfigured()` — `SELF_EDIT_REQUEST_CHANGE_SEND === "on"` AND
  `SCHOLARS_MAIL_FROM` set. Sender from `SCHOLARS_MAIL_FROM`
  (`no-reply-scholars@weill.cornell.edu`, SPEC § 11.3).
- **Header-injection guard:** CRLF-strip `subject` and every recipient before
  building the command (mirrors the client `sanitize`). Body text is the only
  multi-line field and is the message body, not a header.
- New dep: `@aws-sdk/client-sesv2@^3` (matches the existing `@aws-sdk/*` ^3.x).

### T2 — Server route resolution `lib/edit/request-change.ts` (new)
- `resolveRequestChange(attribute, issueId)` → reads the **server-trusted**
  `REQUEST_A_CHANGE` config (already exported from `lib/edit/request-a-change.ts`).
  - `route` → `{ kind: "send", to, cc?, office, sourceSystem }`
  - `explain` w/ `fallbackEmail` → `{ kind: "send", to: fallbackEmail, ... }`
  - `self-service` / pure `explain` → `{ kind: "no-send" }` (endpoint 400s —
    these never reach Submit in the UI; defense in depth)
  - unknown attribute/issue → `{ kind: "no-send" }`
- `composeBody({ issueLabel, itemLabel, sourceSystem, detail, actorCwid })` →
  the exact structured body from SPEC § 3.4 (Issue/Item/Source + detail +
  signature line), CRLF-sanitized. Subject = `Scholars profile correction — {attributeLabel}`.
- The client never names the recipient; the server maps `issueId`→address.

### T3 — Endpoint `app/api/edit/request-change/route.ts` (new)
Mirrors `app/api/edit/suppress/route.ts`:
1. `readEditRequest` → session/body/requestId.
2. Validate body `{ attribute, issueId, itemId?, detail?, targetCwid? }`
   (types + lengths; `detail` optional string; cap `detail` length, e.g. 4000).
3. `targetCwid` defaults to `session.cwid`; **authorize** the actor may act on
   it via `lib/edit/authz` (self ⇒ allow, superuser ⇒ allow, else `403`).
   Re-uses the existing gate — no new capability (SPEC § 6).
4. `resolveRequestChange` → if `no-send`, `editError(400, "not_routable")`.
5. `if (!isMailerConfigured()) return editError(503, "send_disabled")`.
6. `try { sendMail(...) } catch → logEditFailure + editError(502, "send_failed")`.
7. **Best-effort audit** (decision 3): `appendAuditRow` in its own try/catch
   (NOT wrapping the send); on failure log `request_change_audit_failed` and
   continue. Action `"request_change"`; `targetEntityType` = **always `scholar`,
   `targetEntityId` = the target cwid** (build refinement: keeps "all changes to
   scholar X" queryable and avoids the pmid/externalId-vs-cwid mismatch — the
   attribute + item live in `afterValues`);
   `afterValues = { attribute, issue_id, office, to, source_system, item_id, message_id }`;
   `fieldsChanged: null`.
8. `editOk({ sent: true })`.

### T4 — Audit action `lib/edit/audit.ts` + SQL ENUM
> **Build note:** `manual_edit_audit` is a **raw-SQL table** in the
> `scholars_audit` schema (accessed via `$executeRaw`), **not** a Prisma model —
> so there is **no Prisma migration**. Just the TS type + the `audit-log.sql`
> ALTER.
- Extend `AuditAction` with `"request_change"`.
- `scripts/sql/audit-log.sql`: add `request_change` to BOTH the `CREATE TABLE`
  `action` ENUM and the idempotent `MODIFY COLUMN` block (same file that carries
  the #493 INSERT grant).

### T5 — Client flip `components/edit/request-a-change-dialog.tsx`
- On `route`/fallback Submit: `await fetch("/api/edit/request-change", { POST,
  json: { attribute, issueId, itemLabel→itemId?, detail, targetCwid } })`.
  - 2xx → success state: "Request sent." (replaces the "mail client should have
    opened" copy with a sent confirmation; banner stays `role="status"`).
  - non-2xx / network error → **fall back** to the existing `mailto:` + the
    Phase-1 banner (no regression where the flag is off).
- Submit button shows a pending state while the request is in flight; guard
  double-submit.
- `targetCwid` plumbed from the page (self ⇒ `cwid`, superuser ⇒ the edited
  scholar's cwid — already in scope where the dialog is mounted).
- Keep `buildMailto`/`sanitize` (now the fallback path).

### T6 — CDK `cdk/lib/app-stack.ts` (+ snapshot/assertion tests)
- Add **one** scoped `iam.PolicyStatement` to the task role:
  `ses:SendEmail`, `Resource:` the verified-identity ARN
  (`arn:aws:ses:<region>:<acct>:identity/no-reply-scholars@weill.cornell.edu`)
  — NOT `*`. Honors the existing tight-scoping + the IAM regression-guard test.
- Add `SELF_EDIT_REQUEST_CHANGE_SEND` + `SCHOLARS_MAIL_FROM` to the task-def
  `environment:` (config-driven; default flag off both envs initially).
- Update `cdk/test/app-stack.test.ts` snapshot + add a synth-time assertion that
  the SES statement is identity-scoped, not `Resource: *` (per
  `feedback_synth_time_guards_for_deploy_only_validation`).
- **No `ses.EmailIdentity` construct** (build refinement): a no-reply mailbox
  can't complete email-link verification, and the real path is a DKIM/domain
  identity owned in **WCM DNS** (not ours to create in CDK). Instead the grant is
  `Resource: …:identity/*` **conditioned on `ses:FromAddress`** — tighter than a
  single ARN and independent of email-vs-domain verification — and the identity
  is verified out-of-band per `docs/ses-sender-verification.md`. Scope was
  asserted in the test as: single `ses:SendEmail`, From-condition present,
  resource contains `:identity/` and is not bare `*`.

### T7 — Tests (`vitest`, run before push — `feedback_run_vitest_before_push`)

| Area | Assertion |
|---|---|
| `resolveRequestChange` route | `(education, education-wrong)` → send to `ofa@`, source ASMS |
| `resolveRequestChange` cc | `(funding, funding-wrong)` → to `osra-operations@`, cc `scholars@` |
| `resolveRequestChange` no-send | a `self-service` and a pure `explain` issue → `no-send` |
| `resolveRequestChange` fallback | `(funding, funding-active-expired)` → send to `osra-operations@` |
| `composeBody` | structured Issue/Item/Source + signature; `detail` blank → "(no additional detail provided)" |
| header injection | CRLF in `detail`/`itemLabel`/subject stripped before the SES command |
| endpoint 503 | flag off / no `SCHOLARS_MAIL_FROM` → 503 `send_disabled`, no send call |
| endpoint 400 | a `self-service` issueId → `not_routable` |
| endpoint 403 | non-superuser actor with a foreign `targetCwid` |
| endpoint 200 | mailer mocked → 200 `{sent:true}`, `sendMail` called with resolved recipient |
| audit best-effort | `appendAuditRow` throws → endpoint still 200 (logged), send not rolled back |
| client fallback | fetch 503 → dialog uses `mailto:` + Phase-1 banner (no regression) |
| client sent | fetch 200 → "Request sent." confirmation |

## Threat model delta (vs SPEC § 6)
- **Recipient tampering — closed server-side.** Client sends only
  `attribute`+`issueId`; the server maps to the address from in-code config.
  Client-supplied addresses are impossible.
- **Header injection — Phase-2 surface.** CRLF-strip subject + recipients in
  `mailer.ts` (T1); `text` body cannot inject headers in SESv2 Simple content.
- **Spam / volume — partially open.** Rate limiting is **out of scope this PR**
  (see Deferred); the endpoint requires a valid `/edit` session, so it is not
  anonymous. Documented limitation.
- **Authz — unchanged.** `/edit` gate re-used; request-change grants no new
  capability (sends mail to a fixed office, writes no profile data).

## Rollout / ops (the steps I cannot do in code)
1. Verify `no-reply-scholars@weill.cornell.edu` in SES (DKIM CNAMEs in WCM DNS,
   or email-link verify) in **both** SPS accounts/regions.
2. Open the AWS **sandbox-exit** support request for SES production access.
3. Deploy AppStack (IAM + identity + env, flag still off).
4. Apply the `audit-log.sql` ENUM `ALTER` + confirm the **#493** INSERT grant.
5. Flip `SELF_EDIT_REQUEST_CHANGE_SEND=on` (staging → prod) to go live.

I will produce a short ops checklist doc (`docs/ses-sender-verification.md`) with
the exact identity ARN + DNS records for whoever runs steps 1–2.

## Deferred (fast-follow, explicitly not in this PR)
- **Receipt:** opt-out checkbox + actor-email resolution (ED/LDAP or Scholar
  record) + CC/second send. (Decision 2.)
- **Rate limiting:** per-cwid window on the endpoint (SPEC § 5 abuse controls).
- **ServiceNow ticketing:** still email-only (`project_self_edit_feedback_routing`).

## Runnable audit (lands with this PR; needs the #493 grant + ENUM alter)
```sql
-- request-change submissions in the last 7 days
SELECT actor_cwid, target_entity_type, target_entity_id,
       JSON_EXTRACT(after_values, '$.office')  AS office,
       JSON_EXTRACT(after_values, '$.issue_id') AS issue,
       created_at
FROM scholars_audit.manual_edit_audit
WHERE action = 'request_change'
  AND created_at >= NOW() - INTERVAL 7 DAY
ORDER BY created_at DESC;
```

## Files
| File | Change |
|---|---|
| `lib/edit/mailer.ts` | **new** — SESv2 send + `isMailerConfigured` + CRLF guard |
| `lib/edit/request-change.ts` | **new** — server route resolution + body compose |
| `app/api/edit/request-change/route.ts` | **new** — endpoint (mirrors suppress) |
| `lib/edit/audit.ts` | `AuditAction` += `request_change` |
| `prisma/schema.prisma` + migration | `action` ENUM += `request_change` (offline) |
| `scripts/sql/audit-log.sql` | append ENUM `ALTER` |
| `components/edit/request-a-change-dialog.tsx` | route-submit → fetch; mailto fallback |
| `cdk/lib/app-stack.ts` | SES IAM statement + identity + env vars |
| `cdk/test/app-stack.test.ts` (+ snapshot) | SES-scope assertion + snapshot update |
| `docs/ses-sender-verification.md` | **new** — ops verification checklist |
| `tests/unit/request-change*.test.ts(x)` | **new** — T7 suite |
```
