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

Two SNS topics per env, both provisioned by `cdk/lib/observability-stack.ts`:

| Topic | Logical id | AWS name | Subscriber | What publishes here |
|---|---|---|---|---|
| **Page** | `AlarmTopic` | `sps-alarms-${env}` | Teams channel webhook (HTTPS, out-of-band) | All 8 CloudWatch alarm actions in the stack |
| **Notify** | `NotifyTopic` | `sps-notify-${env}` | `paa2013@med.cornell.edu` (email) | `sps-monthly-budget` thresholds + `sps-anomaly-subscription` (prod only) |

The split is the point of B23: a forecasted-budget tap at 50% of `$600/mo` is not channel-worthy noise for the page channel, and pre-B23 the cost notifications rode the same alarm topic. Page goes to the Teams channel; notify goes to the operator's inbox. Topic policies grant `sns:Publish` on the **notify** topic to `budgets.amazonaws.com` and `costalerts.amazonaws.com`; the page topic carries no service-principal grants because nothing in AWS publishes to it directly -- only CloudWatch alarm actions, which use the SNS-resource ARN, not a service principal.

CDK does not declare the Teams webhook subscription. The integration URL is a per-env secret (`scholars/${env}/oncall/teams-webhook-url`) populated out-of-band per ADR-008's "no secret values in CDK source" rule. The runbook below seeds the secret and runs the one-shot `aws sns subscribe` call.

The Teams webhook URL **is** stored in Secrets Manager for audit + rotate even though it appears in `aws sns list-subscriptions-by-topic` output anyway. Two reasons: (1) it makes the seed-then-subscribe flow uniform with every other external endpoint in this stack; (2) it gives a rotation handle if the workflow is recreated or the channel moves.

## Rollout per env

First deploy of B23 changes the stack shape (adds a topic, moves the cost subscribers, removes the email sub from the page topic). The Teams subscription is then added against the running page topic via `aws sns subscribe`. Both staging and prod follow the same sequence; prod can either share the staging Teams channel or use a separate one -- the latter avoids staging dry-run noise leaking into the prod operations channel.

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
   The read-back is load-bearing. A blank seed produces a successful `sns subscribe` against an empty endpoint that silently never delivers.

3. **Deploy SecretsStack and ObservabilityStack** -- both via `cdk deploy ... --exclusively` per [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md). The Observability deploy adds the notify topic, moves cost subscribers, and removes any prior email sub on the page topic. Confirm the new notify-topic email subscription from `paa2013@med.cornell.edu`'s inbox within 3 days or it expires.

4. **Subscribe the Teams webhook to the page topic:**
   ```bash
   PAGE_TOPIC_ARN=$(aws cloudformation describe-stacks \
     --stack-name "Sps-Observability-${ENV}" \
     --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' \
     --output text)
   TEAMS_URL=$(aws secretsmanager get-secret-value \
     --secret-id "scholars/${ENV}/oncall/teams-webhook-url" \
     --query SecretString --output text)
   aws sns subscribe --topic-arn "$PAGE_TOPIC_ARN" \
     --protocol https --endpoint "$TEAMS_URL"
   ```

5. **Confirm the subscription manually.** SNS posts a `SubscriptionConfirmation` JSON message into the Teams channel. Open the message, find the `SubscribeURL` value, and GET it once (paste into a browser or `curl <URL>`). This is the SNS handshake; the Workflow does not auto-confirm. Verify with `aws sns list-subscriptions-by-topic --topic-arn "$PAGE_TOPIC_ARN"` -- the subscription should move from `PendingConfirmation` to a real ARN.

6. **Fire a test alarm:**
   ```bash
   aws cloudwatch set-alarm-state \
     --alarm-name "sps-alb-5xx-rate-${ENV}" \
     --state-value ALARM \
     --state-reason "B23 dry-run"
   ```
   Expected: a Teams channel message within ~60 seconds containing the SNS notification JSON (alarm name, state, reason, timestamp). The alarm auto-recovers to `OK` on the next datapoint window. If nothing arrives within 5 minutes, see § Diagnostics.

7. **For prod test alarm**, prefer `sps-aurora-connections-prod` over `sps-alb-5xx-rate-prod`. The 5xx-rate one is the customer-visible-symptom alarm; firing it as a dry-run mixes into the same channel as a real outage. The Aurora connections alarm is operationally-internal: setting it ALARM and back to OK has no user-facing signal.

## Gotchas

- **SubscriptionConfirmation is manual.** Unlike PagerDuty's CloudWatch integration, Teams Workflows do not auto-confirm an SNS HTTPS subscription. The first message that lands in the channel after `aws sns subscribe` is the SNS confirmation JSON; the operator GETs the `SubscribeURL` once per topic per env. If the confirmation message is missed, `aws sns list-subscriptions-by-topic` shows the sub in `PendingConfirmation` -- re-run the subscribe call.
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
- **Heavy path (AWS-side):** `aws sns unsubscribe --subscription-arn <staging-Teams-sub-arn>` revokes the staging HTTPS subscription. Re-subscribe via the step 4 command above when finished. Avoid this path if the next operator might not realize the staging subscription is missing.

Never unsubscribe prod's Teams subscription as a "stop the noise" shortcut. There is no enforcement against it, only this paragraph.

## Rollback

Two flavors:

1. **Revert the B23 PR.** CDK rollback restores the single-topic shape: the notify topic disappears, budget + anomaly subscribers re-target the page topic, the email subscription on the notify topic is gone. The Teams HTTPS subscription on the page topic is **not** affected by the revert (it's out-of-band); messages continue to fire as long as the URL secret hasn't been rotated. The pre-B23 email subscription on the page topic was deleted by the B23 deploy and is **not** restored by the revert -- if you need it back, re-run `aws sns subscribe --topic-arn <page-arn> --protocol email --endpoint paa2013@med.cornell.edu` and confirm the email.
2. **Disable Teams notifications without reverting CDK.** Either disable the Power Automate workflow (Teams-side) or `aws sns unsubscribe --subscription-arn ...` on the page topic. Cost notifications keep flowing to the notify topic email. Re-subscribe with the seed-then-subscribe flow above when ready.

## Diagnostics: test alarm fires but no Teams message

If `aws cloudwatch set-alarm-state ... --state-value ALARM` does not produce a Teams channel post within 5 minutes:

1. **Verify the subscription is confirmed:** `aws sns list-subscriptions-by-topic --topic-arn <page-arn>`. `PendingConfirmation` means the `SubscribeURL` in the channel was never GET'd. Open the channel, find the SNS SubscriptionConfirmation message, and GET its `SubscribeURL`.
2. **Check SNS delivery metrics** for the page topic: `NumberOfNotificationsDelivered` and `NumberOfNotificationsFailed`. A `Failed` increment means the topic published but Teams rejected -- the workflow URL is stale, disabled, or the owner identity is no longer valid.
3. **Check the Workflow's run history** in Power Automate (Teams -> channel -> Workflows -> select the workflow -> Run history). A failed run shows whether Teams received the call but the Post-to-channel step errored.
4. **Verify the URL secret is non-empty:** `aws secretsmanager get-secret-value --secret-id "scholars/${ENV}/oncall/teams-webhook-url" --query SecretString --output text`. Empty value -> seed it and resubscribe.
5. **Validate the alarm itself reached ALARM:** `aws cloudwatch describe-alarms --alarm-names "sps-alb-5xx-rate-${ENV}" --query 'MetricAlarms[0].StateValue'`. `INSUFFICIENT_DATA` means `set-alarm-state` was a no-op against the current evaluation window -- retry with a different alarm or wait for an actual datapoint.

If steps 1-5 all check out and the message still doesn't arrive, capture the workflow run history + SNS delivery metrics in a hot-fix issue and re-subscribe rather than running production blind.

## Quarterly review trigger

Same cadence as the SLO review (see [`docs/SLOs.md` § Review cadence](./SLOs.md#review-cadence)). On-call-specific questions:

- Is the Workflow URL holder still at WCM and still owns the workflow? (Off-boarding is the main fragility.)
- Has the WCM ServiceNow CI been registered for SPS yet? If yes, time to wire it in as the second subscriber and start the L1 escalation move.
- Has the page topic accumulated any AWS-side subscriptions outside the single Teams webhook? Anything else should be justified or removed.
- Are cost guardrails still on the notify topic, not the page topic? Easy to drift if a future operator "consolidates" topics.

All answered by `aws sns list-subscriptions-by-topic` against each topic ARN + a quick look at the workflow's owner in Teams. No tooling needed.
