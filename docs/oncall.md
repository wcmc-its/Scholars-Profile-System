# On-call routing

The operator runbook for the SPS alerting path. Companion to [`docs/SLOs.md`](./SLOs.md) (alarm catalog + SLO policy), [`docs/PRODUCTION_ADDENDUM.md` § ObservabilityStack](./PRODUCTION_ADDENDUM.md#observabilitystack) (resource catalog), [`docs/DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) (deploy / rollback), and [ADR-008](./ADR-008-infrastructure-as-code.md) (where ObservabilityStack sits in the six-stack arrangement). Tracks [B23 (#122)](https://github.com/wcmc-its/Scholars-Profile-System/issues/122).

## The WCM ops model (the constraint shaping this design)

WCM ITS app teams do not use dedicated automated paging tools. The org pattern, confirmed 2026-05-21 with a peer app team lead:

- **ServiceNow** holds incident tickets, the CI registry, and per-CI escalation groups.
- **Microsoft Teams channels** are the chat-level notification surface where humans see day-to-day signal.
- **Phone calls from Ops** are the actual escalation mechanism. They are manual / human-driven: Ops calls the on-call engineer when a ticket is classified MI (Major Incident), routed via the CI record's escalation group.
- **No SMS pagers, no ack-tracked off-hours wake-up, no PagerDuty/Opsgenie-style automated routing.** Off-hours, app teams may notice via Teams mobile push notifications or not at all.

SPS pre-launch operates under this same model, with two phases:

1. **Now (B23):** AWS alarms → Teams channel + email. No automated paging. Off-hours wake-up is an explicit accepted gap; same as every other WCM app team.
2. **Future (B23 follow-on, not yet sized):** AWS alarms → ServiceNow incident tickets via the WCM-managed AWS→ServiceNow integration, with SPS registered as a CI and the operator placed in its escalation group. At that point, ITS Ops's MI process becomes the L1 wake-up path. Two unknowns to resolve before that ships: (a) how AWS gets into ServiceNow at WCM today (existing integration vs. custom Lambda relay); (b) the request path to register a new CI with an escalation group.

## Provider choice

**Microsoft Teams channel webhook.** Matches the WCM-native pattern: chat surface for humans, no third-party SaaS to approve. The Workflows app in Teams generates an HTTPS endpoint that vanilla SNS publishes to. Free; no ITS approval beyond the team-channel creation the operator already owns.

Alternates considered and rejected:

- **PagerDuty.** Originally picked in the B23 plan; reversed 2026-05-21 mid-PR. Third-party SaaS that isn't in WCM's stack; introducing it would require an ITS approval ask with low likelihood of success and no peer-team precedent to point at. The off-hours paging capability PagerDuty offers isn't part of how WCM does ops anyway -- Ops handles human routing manually via ServiceNow.
- **Atlassian Opsgenie.** Atlassian end-of-life for new signups; migration target is Jira Service Management, which WCM doesn't operate.
- **AWS SNS -> SMS / email direct (no chat).** No channel visibility, no shared signal for whoever else might triage. Notify-topic email is fine for cost guardrails (low-urgency, archival); page-topic needs the team-visible surface that Teams provides.
- **AWS Chatbot -> Teams (alternative Teams path).** AWS Chatbot supports Teams since mid-2024 and produces nicer-formatted messages than raw SNS-to-Teams. The trade-off: Chatbot requires the WCM Teams tenant admin to install the AWS Chatbot Teams app at the tenant level, which is its own approval ask. Worth revisiting if the SNS-direct Workflow path proves operationally awkward (see § Gotchas).
- **Self-hosted Grafana OnCall / Alertmanager.** Operational cost outweighs the single-operator footprint and the org pattern doesn't have it.
- **Splunk On-Call (VictorOps) / xMatters / FireHydrant / incident.io.** Same class of dedicated paging tools as PagerDuty; same ITS-approval friction; same WCM-pattern mismatch.

## Topic topology

Three SNS topics per env, all provisioned by `cdk/lib/observability-stack.ts`:

| Topic | Logical id | AWS name | Subscriber | What publishes here |
|---|---|---|---|---|
| **Page** (P1) | `AlarmTopic` | `sps-alarms-${env}` | `OncallRelayFunction` Lambda (CDK-managed; B27) -> primary Teams channel | Customer-facing P1 only: the `sps-app-unavailable-${env}` composite, latency-p99, cluster-red |
| **Warn** (P2) | `WarnTopic` | `sps-warn-${env}` | same `OncallRelayFunction` Lambda -> separate "warn" Teams channel (falls back to the primary channel until provisioned) | Leading-indicator + operational alarms: Aurora CPU/connections, OpenSearch JVM pressure, `edit_authz_denied` |
| **Notify** | `NotifyTopic` | `sps-notify-${env}` | `paa2013@med.cornell.edu` (email); + `OncallRelayErrors` alarm | `sps-monthly-budget` thresholds + `sps-anomaly-subscription` (prod only); B27 relay-Lambda failure alarm |

The split is the point of B23: a forecasted-budget tap at 50% of `$600/mo` is not channel-worthy noise for the page channel, and pre-B23 the cost notifications rode the same alarm topic. Page goes to the Teams channel via the B27 relay Lambda; notify goes to the operator's inbox. Topic policies grant `sns:Publish` on the **notify** topic to `budgets.amazonaws.com` and `costalerts.amazonaws.com`; the page topic carries no service-principal grants because nothing in AWS publishes to it directly -- only CloudWatch alarm actions (which use the SNS-resource ARN, not a service principal) and the B27 Lambda subscription (managed by CDK via `SnsEventSource`, which sets up the `lambda:InvokeFunction` permission with `SourceArn: alarmTopicArn`).

B27 changes the page-topic subscriber from "Teams webhook via HTTPS (out-of-band `aws sns subscribe`)" to "Lambda relay (CDK-managed) that POSTs an Adaptive Card to the Teams workflow URL." The Lambda reads the workflow URL from `scholars/${env}/oncall/teams-webhook-url` (already declared by SecretsStack per ADR-008's "no secret values in CDK source" rule) at cold start and caches it for the container lifetime. The original direct-HTTPS path was empirically disproven on 2026-05-21 -- see § Gotchas: *Power Automate Request trigger requires JSON body*. The runbook below seeds the secret and verifies the CDK-provisioned subscription; no `aws sns subscribe` call against the workflow URL is needed (or possible -- the trap is permanent).

The Teams webhook URL **is** stored in Secrets Manager for audit + rotate even though it appears in `aws sns list-subscriptions-by-topic` output anyway. Two reasons: (1) it makes the seed-then-subscribe flow uniform with every other external endpoint in this stack; (2) it gives a rotation handle if the workflow is recreated or the channel moves.

## Severity tiers (P1 page / P2 warn) and the warn channel

The relay assigns a **severity** to every record from its originating SNS topic and routes accordingly:

| Originating topic | Severity | Posts to |
|---|---|---|
| `sps-alarms-${env}` (page) | **P1** | primary Teams channel (`teams-webhook-url`) |
| `sps-warn-${env}` (warn) | **P2** | warn Teams channel (`teams-webhook-url-warn`), else primary |
| `etl-failures-${env}` (ETL) | **P2** | warn Teams channel, else primary |

Discrimination is on the topic-ARN substring (`:sps-warn-`, `:etl-failures-`) in `lambda/oncall-relay/index.ts` (`severityForRecord`); everything else is P1. The point is to keep data-freshness, reconciler, and resource-pressure signals off the on-call channel -- the core alert-fatigue fix -- so the page channel carries only customer-facing P1. Each card carries a **Severity** fact (`P1 (page)` / `P2 (warn)`), the alarm **Description** (so the runbook pointer baked into the alarm text reaches Teams), and a **View reliability dashboard** button alongside the CloudWatch link. The relay log line (`"event":"oncall_relay"`) records `severity` and the `channel` it actually delivered to.

### Provision the warn channel (optional, one-time per env)

The warn webhook is **optional by design**: until it exists, P2 alerts fall back to the primary channel (logged `"channel":"page"`), so demoting an alarm to warn never drops it. To give P2 its own quieter channel:

1. Create (or pick) a second Teams channel, e.g. `#sps-alerts-warn`, and add the same **"Post to a channel when a webhook request is received"** Power Automate workflow used for the primary channel (§ Rollout per env, step 1). Capture its HTTPS URL.
2. Seed the secret -- no redeploy needed, the relay reads it on the next cold start:
   ```bash
   aws secretsmanager create-secret \
     --name "scholars/${ENV}/oncall/teams-webhook-url-warn" \
     --secret-string "<WARN-TEAMS-WEBHOOK-URL>"
   # use put-secret-value instead if the secret already exists
   ```
3. Verify: trip a P2 alarm and confirm the card lands in the warn channel with a `P2 (warn)` Severity fact, and the relay log shows `"channel":"warn"`:
   ```bash
   aws cloudwatch set-alarm-state --alarm-name "sps-aurora-cpu-${ENV}" \
     --state-value ALARM --state-reason "warn-channel test"
   aws cloudwatch set-alarm-state --alarm-name "sps-aurora-cpu-${ENV}" \
     --state-value OK --state-reason "reset"
   ```

The relay's IAM role already grants `secretsmanager:GetSecretValue` on this secret name (declared via `fromSecretNameV2` in `observability-stack.ts`), so activation is the secret alone -- no redeploy.

## Rollout per env

First deploy of B23 changes the stack shape (adds the notify topic, moves the cost subscribers, removes the prior email sub from the page topic). B27 then adds a Lambda that subscribes to the page topic and POSTs an Adaptive Card to the Teams workflow URL -- the direct `aws sns subscribe --protocol https` against a Power Automate workflow URL was empirically disproven on 2026-05-21 (see § Gotchas: *Power Automate Request trigger requires JSON body*). Both staging and prod follow the same sequence; prod can either share the staging Teams channel or use a separate one -- the latter avoids staging dry-run noise leaking into the prod operations channel.

Per-env, in order:

1. **Pre-deploy (one-time per env, in Teams):**
   - In the **Scholars** team, pick or create a channel for alerts (e.g. `#alerts-staging` and `#alerts-prod`, or one shared `#ops` channel for both envs).
   - Click the `...` next to the channel name -> **Workflows**.
   - Search for the template **"Post to a channel when a webhook request is received"** (this is the Power Automate-backed replacement for the deprecated Office 365 Connectors "Incoming Webhook"). Pick it, sign in if prompted, confirm the team + channel, click **Add workflow**.
   - Teams generates an HTTPS URL of the shape `https://prod-NN.eastus.logic.azure.com:443/workflows/<id>/triggers/manual/paths/invoke?api-version=...&sig=...`. Capture it.

2. **Seed the secret** (CDK already declared the empty resource via SecretsStack):
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "scholars/${ENV}/oncall/teams-webhook-url" \
     --secret-string "<TEAMS-WEBHOOK-URL>"
   aws secretsmanager get-secret-value \
     --secret-id "scholars/${ENV}/oncall/teams-webhook-url" \
     --query SecretString --output text
   ```
   The read-back is load-bearing. A blank or wrong-template URL produces silent delivery failure -- the Lambda's `OncallRelayErrors` alarm catches the failure path post-deploy (see step 5), but the seed is the cheap check.

3. **Deploy SecretsStack and ObservabilityStack** -- both via `cdk deploy ... --exclusively` per [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md). The Observability deploy provisions the Lambda relay (`sps-oncall-relay-${env}`), its log group (`/aws/lambda/sps-oncall-relay-${env}`, 30-day retention), an IAM role scoped to `secretsmanager:GetSecretValue` on the env's webhook secret, and the page-topic SNS subscription that wires the Lambda in. The deploy also adds (B23) the notify topic, moves cost subscribers, and removes any prior email sub on the page topic. Confirm the notify-topic email subscription from `paa2013@med.cornell.edu`'s inbox within 3 days or it expires.

4. **Verify the Lambda relay is wired and reachable:**
   ```bash
   RELAY_ARN=$(aws cloudformation describe-stacks \
     --stack-name "Sps-Observability-${ENV}" \
     --query 'Stacks[0].Outputs[?OutputKey==`OncallRelayFunctionArn`].OutputValue' \
     --output text)
   PAGE_TOPIC_ARN=$(aws cloudformation describe-stacks \
     --stack-name "Sps-Observability-${ENV}" \
     --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' \
     --output text)
   aws sns list-subscriptions-by-topic --topic-arn "$PAGE_TOPIC_ARN" \
     --query 'Subscriptions[?Protocol==`lambda`].Endpoint' --output text
   ```
   The output should be exactly `$RELAY_ARN`. CDK provisions the subscription as part of the stack (no `aws sns subscribe` step needed); a missing or extra subscription means a deploy was not run with the latest template.

5. **Fire a test alarm:**
   ```bash
   aws cloudwatch set-alarm-state \
     --alarm-name "sps-alb-5xx-rate-${ENV}" \
     --state-value ALARM \
     --state-reason "B27 dry-run"
   ```
   Expected within ~60 seconds: an Adaptive Card in the Teams channel rendering `🚨 sps-alb-5xx-rate-${ENV}`, state `ALARM`, the dry-run reason, the region, the timestamp, and a `View in CloudWatch` action button. The alarm auto-recovers to `OK` on the next datapoint window -- expect a second card with `✅`. If neither card arrives within 5 minutes, see § Diagnostics; the Lambda's `OncallRelayErrors` alarm should also fire to the notify topic (email) if the Lambda itself errored.

6. **For prod test alarm**, prefer `sps-aurora-connections-prod` over `sps-alb-5xx-rate-prod`. The 5xx-rate one is the customer-visible-symptom alarm; firing it as a dry-run mixes into the same channel as a real outage. The Aurora connections alarm is operationally-internal: setting it ALARM and back to OK has no user-facing signal.

7. **Staging-only chaos test** (verifies the failure path the `OncallRelayErrors` alarm exists to catch -- B27 acceptance criterion #6, do not run in prod):
   ```bash
   # Save the real URL so we can put it back.
   REAL_URL=$(aws secretsmanager get-secret-value \
     --secret-id "scholars/staging/oncall/teams-webhook-url" \
     --query SecretString --output text)
   aws secretsmanager put-secret-value \
     --secret-id "scholars/staging/oncall/teams-webhook-url" \
     --secret-string "https://example.invalid/"
   # Force a Lambda container recycle so the cached URL is evicted.
   aws lambda update-function-configuration \
     --function-name "sps-oncall-relay-staging" \
     --environment "Variables={TEAMS_WEBHOOK_SECRET_ARN=$(aws cloudformation describe-stacks \
       --stack-name Sps-Observability-staging \
       --query 'Stacks[0].Resources[?LogicalResourceId==\`OncallRelayFunction9974C7E1\`]' \
       --output text | head -1),DEPLOY_TS=$(date +%s)}"
   # Fire the test alarm; expect Lambda Errors metric to tick and the
   # OncallRelayErrors alarm to transition to ALARM (email arrives at
   # paa2013@med.cornell.edu within ~2 min).
   aws cloudwatch set-alarm-state \
     --alarm-name "sps-alb-5xx-rate-staging" \
     --state-value ALARM \
     --state-reason "B27 chaos test"
   # Restore.
   aws secretsmanager put-secret-value \
     --secret-id "scholars/staging/oncall/teams-webhook-url" \
     --secret-string "$REAL_URL"
   aws lambda update-function-configuration \
     --function-name "sps-oncall-relay-staging" \
     --environment "Variables={TEAMS_WEBHOOK_SECRET_ARN=...,DEPLOY_TS=$(date +%s)}"
   ```
   Run this once per env after the first deploy; re-run quarterly only if the Power Automate auth surface changes.

## Gotchas

- **Power Automate `Request` trigger requires JSON body -- SNS direct subscription is not viable.** Per the [SNS HTTP/S delivery spec](https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html#http-header), SNS sends `SubscriptionConfirmation` and `Notification` POSTs with `Content-Type: application/x-www-form-urlencoded; charset=utf-8` (the body itself is JSON, but the Content-Type header is fixed). The Power Automate `Request` trigger (the `kind: "TeamsWebhook"` / `type: "Request"` trigger used by every in-channel Workflows template) rejects this with `HTTP 400 InvalidRequestContent: "The input body for trigger 'manual' of type 'Request' must be of type JSON"`. Empirical testing on 2026-05-21 (#434) confirmed: (a) the rejection happens before any schema-validation step, so clearing the trigger's request-body JSON schema does not relax it -- two separately-created workflows returned the identical 400; (b) the same workflow accepts a properly-shaped Adaptive Card POST (`Content-Type: application/json`) with `HTTP 202` and renders a card in the channel. The check is at the trigger level and intrinsic to the Power Automate `Request` trigger family; it is not configurable. SNS treats the 400 as a failed endpoint validation and silently does not create the subscription -- `aws sns list-subscriptions-by-topic` returns `[]` after a failed attempt, with nothing in the channel and no AWS-side error. **Do not retry `aws sns subscribe --protocol https --endpoint <power-automate-url>`** -- this is the trap B27 (#436) closed by inserting an `ObservabilityStack` Lambda relay (SNS -> Lambda -> Adaptive Card JSON POST to workflow URL). The Lambda is provisioned as part of `Sps-Observability-${env}`; § Rollout per env above is the current path. This entry is preserved as a do-not-retry historical record. The error signature that surfaces this trap is `aws sns subscribe` returning an XML-parse error wrapping `{"error":{"code":"InvalidRequestContent",...}}`.
- **SubscriptionConfirmation is manual.** Unlike PagerDuty's CloudWatch integration, Teams Workflows do not auto-confirm an SNS HTTPS subscription. The first message that lands in the channel after `aws sns subscribe` is the SNS confirmation JSON; the operator GETs the `SubscribeURL` once per topic per env. If the confirmation message is missed, `aws sns list-subscriptions-by-topic` shows the sub in `PendingConfirmation` -- re-run the subscribe call. (B27 makes this gotcha moot for the page-topic Teams path -- the subscription is CDK-managed Lambda, no SNS confirmation handshake; the gotcha still applies to the notify-topic email sub and to any future HTTPS subscriber on either topic.)
- **Payload is raw SNS JSON.** Without a Power Automate parse-and-format step in the Workflow, alarm messages arrive as the raw SNS JSON blob (`{"Type":"Notification","MessageId":"...","Message":"...alarm JSON...","Timestamp":"..."}`). Readable but ugly. Iterate by editing the Workflow's Power Automate steps (Parse JSON -> Adaptive Card -> Post message) to extract `AlarmName` / `NewStateValue` / `NewStateReason` for nicer rendering. Worth doing once the first real alarm fires and the rendering is shown to be too dense; not blocking for B23.
- **Workflow URL is tied to the creator's Microsoft account.** Power Automate workflows have an owner identity. If the operator who created the workflow offboards from WCM, the workflow stops working until ownership is transferred or it's recreated under a different identity. Long-term fix is a service account or shared mailbox; for B23, document the workflow owner alongside the secret value.
- **No off-hours paging.** Teams webhook + email = chat-level signal only. No SMS, no phone call, no ack tracking. The off-hours wake-up path at WCM is Ops calling a human via the ServiceNow CI escalation group; SPS doesn't have that wired yet (see § The WCM ops model above).
- **Teams Workflow has rate limits.** Power Automate workflows on the free / default tier throttle at sustained high call volumes. A flapping alarm could in principle hit the throttle; the right place to fix that is the alarm's `evaluationPeriods` and `datapointsToAlarm` (already conservative in B22), not the Teams side.

## Future: ServiceNow integration (B23 follow-on)

Filed as a future B-series row, not yet scoped. The work to land it:

1. **Establish the AWS -> ServiceNow path.** Discovery: does WCM ITS run an existing AWS Service Management Connector / a Lambda relay / an inbound-email rule? If yes, document and reuse. If no, scope a Lambda that consumes the page topic and posts to `https://<wcm>.service-now.com/api/now/table/incident` with a service-account credential.
2. **Register SPS as a CI in ServiceNow.** Service Catalog request to WCM ITS, with the operator (and any future on-call) placed in the CI's escalation group.
3. **Wire the page topic as a second subscriber.** The Teams webhook stays as the chat-visibility surface; ServiceNow becomes the incident source of truth and ITS Ops handles human routing via the escalation group.

Trigger to size this row: (a) SPS has prod traffic; (b) at least one off-hours incident has happened where the Teams-only signal was insufficient; or (c) ITS Ops asks for SPS to register as a CI for compliance/inventory reasons.

## Un-subscribe (staging-only off-hours work)

If the operator is doing staging-only work and wants to suppress staging Teams messages without disturbing prod:

- **Quick path (Teams-side, recommended):** In the staging alert channel, edit the Workflow to be disabled (Workflows app -> select the workflow -> Turn off). Re-enable when finished. No AWS changes.
- **Heavy path (AWS-side, B27):** The Teams subscription is now a CDK-managed Lambda, so `aws sns unsubscribe` is awkward (re-deploy would put it back). Prefer setting the staging Lambda's reserved concurrency to 0 (`aws lambda put-function-concurrency --function-name sps-oncall-relay-staging --reserved-concurrent-executions 0`) -- this drops every incoming SNS invocation to a `Throttle` (not an Error, so it won't trip `OncallRelayErrors`). Restore with `aws lambda delete-function-concurrency --function-name sps-oncall-relay-staging`. Leaves a clear AWS-side audit trail and doesn't affect prod.

Never unsubscribe prod's Teams subscription as a "stop the noise" shortcut. There is no enforcement against it, only this paragraph.

## Rollback

Two flavors:

1. **Revert the B27 PR.** CDK rollback removes the Lambda relay, its log group, IAM role, default policy, the page-topic Lambda subscription, the `OncallRelayErrors` alarm, and the `OncallRelayFunctionArn` output. The page topic stays. The notify topic stays. Email path stays functional via the existing notify-topic email subscription. Alarms continue to publish to the page topic but with no subscriber -- same state as pre-B27 (and pre-B23, which is where the original `aws sns subscribe --protocol https` path was empirically known to fail; reverting B27 puts the topic back into that non-functional state). To re-establish Teams delivery without the Lambda, the only known-working path is to add it back -- the direct-HTTPS subscription is not viable (see § Gotchas).
2. **Revert the B23 PR.** CDK rollback restores the single-topic shape: the notify topic disappears, budget + anomaly subscribers re-target the page topic, the email subscription on the notify topic is gone. The B27 Lambda subscription continues to function against the renamed topic only if B27 is also reverted. The pre-B23 email subscription on the page topic was deleted by the B23 deploy and is **not** restored by the revert -- if you need it back, re-run `aws sns subscribe --topic-arn <page-arn> --protocol email --endpoint paa2013@med.cornell.edu` and confirm the email.
3. **Disable Teams notifications without reverting CDK.** Set the Lambda's reserved concurrency to 0 (see § Un-subscribe heavy path above), or disable the Power Automate workflow Teams-side. Cost notifications keep flowing to the notify topic email regardless. Restore by deleting the reserved-concurrency override or re-enabling the workflow.

## Diagnostics: test alarm fires but no Teams message

If `aws cloudwatch set-alarm-state ... --state-value ALARM` does not produce an Adaptive Card in the channel within 5 minutes:

1. **Check whether `OncallRelayErrors` fired** -- if the Lambda errored, the operator's email already has the page. `aws cloudwatch describe-alarms --alarm-names "sps-oncall-relay-errors-${ENV}" --query 'MetricAlarms[0].StateValue'`. `ALARM` means the Lambda is broken and the email is the canonical signal; jump to step 4. `OK` means the Lambda succeeded (HTTP 2xx from Teams), so the failure is on the Teams side -- continue.
2. **Check the Lambda's recent log group**: `aws logs tail "/aws/lambda/sps-oncall-relay-${ENV}" --since 10m --follow`. Look for structured `event:"oncall_relay"` lines; `outcome:"delivered"` with `status:202` means the POST succeeded, so the problem is downstream of the workflow trigger. `outcome:"upstream_error"` with `status:4xx`/`5xx` means the workflow rejected the POST -- often a stale URL, disabled workflow, or a workflow whose owner offboarded.
3. **Check the Workflow's run history** in Power Automate (Teams -> channel -> Workflows -> select the workflow -> Run history). A failed run shows whether Teams received the call but the Post-to-channel step errored.
4. **Verify the URL secret is correct:** `aws secretsmanager get-secret-value --secret-id "scholars/${ENV}/oncall/teams-webhook-url" --query SecretString --output text`. Compare against the URL captured in step 1 of § Rollout per env. If wrong, `put-secret-value` and force a Lambda container recycle (`aws lambda update-function-configuration ... --environment Variables={...,DEPLOY_TS=$(date +%s)}`).
5. **Verify the alarm itself reached ALARM:** `aws cloudwatch describe-alarms --alarm-names "sps-alb-5xx-rate-${ENV}" --query 'MetricAlarms[0].StateValue'`. `INSUFFICIENT_DATA` means `set-alarm-state` was a no-op against the current evaluation window -- retry with a different alarm or wait for an actual datapoint.
6. **Verify the page-topic subscription still exists:** `aws sns list-subscriptions-by-topic --topic-arn <page-arn>`. There should be exactly one `Protocol: lambda` entry pointing at `sps-oncall-relay-${env}`. A missing entry means a CDK drift -- re-deploy the Observability stack.

If steps 1-6 all check out and the message still doesn't arrive, capture the Lambda log tail + the workflow run history in a hot-fix issue.

## Quarterly review trigger

Same cadence as the SLO review (see [`docs/SLOs.md` § Review cadence](./SLOs.md#review-cadence)). On-call-specific questions:

- Is the Workflow URL holder still at WCM and still owns the workflow? (Off-boarding is the main fragility.)
- Has the WCM ServiceNow CI been registered for SPS yet? If yes, time to wire it in as the second subscriber and start the L1 escalation move.
- Has the page topic accumulated any AWS-side subscriptions outside the single B27 Lambda? Anything else should be justified or removed.
- Are cost guardrails still on the notify topic, not the page topic? Easy to drift if a future operator "consolidates" topics.
- Re-run the staging chaos test in § Rollout per env step 7 if the Power Automate auth surface has changed (Microsoft tenant policy update, workflow recreate, etc.). The test confirms the `OncallRelayErrors` -> email out-of-band fallback path still works end-to-end.

All answered by `aws sns list-subscriptions-by-topic` against each topic ARN + a quick look at the workflow's owner in Teams + a one-shot chaos test. No tooling needed.
