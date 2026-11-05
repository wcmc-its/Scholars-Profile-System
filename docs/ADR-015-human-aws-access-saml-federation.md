# docs/ADR-015 — Human AWS access is SAML federation with 1-hour sessions; no IAM Identity Center

**Status:** Accepted (2026-11-05)
**Date:** 2026-11-05
**Revision:** 1
**Authors:** Scholars Profile System development team
**Resolves:** How developers get AWS CLI access once long-lived IAM user access keys are retired
**Supersedes:** —
**Superseded by:** —

## Context

The AWS account that hosts SPS staging and prod is shared with other WCM research applications. Historically, some command-line access to it used long-lived IAM user access keys. We want to retire those keys for people and give them short-lived federated credentials instead.

On 2026-10-23 we asked the WCM ITS Cloud team (ITS ticket INC2230014) for one of two things:

1. Assign developers to IAM Identity Center permission sets, so `aws sso login` gives 12-hour CLI sessions with no extra tooling.
2. Raise the maximum session duration on the federated roles behind WCM sign-in to 12 hours, with a matching `SessionDuration` attribute sent by the IdP.

## What WCM ITS told us

- IAM Identity Center is **not enabled at the AWS Organization level** and is not integrated with the WCM IdP. `aws sso login` is not available.
- The supported CLI path is the developer's own federated WCM identity through **`saml2aws`**. WCM ITS keeps a ServiceNow knowledge-base article on setting it up.
- Federated sessions are capped at **1 hour**. The IdP enforces this cap, not AWS: the AWS roles themselves allow 8 hours.
- Lengthening the session would need **WCM Security** to approve it. ITS does not know why the cap moved from 8 hours to 1 hour some years ago.

The full email thread is kept in the team's private project notes, not in this public repo.

## Decision

- **People:** AWS console and CLI access is through WCM SAML federation only. The CLI uses `saml2aws`. We accept the 1-hour session and re-authenticate when it expires. We do not issue IAM user access keys to people.
- **Workloads:** use IAM roles (ECS task roles, EKS IRSA, Lambda execution roles). A workload that cannot use a role yet keeps a dedicated, least-privilege key scoped to that workload alone, and that key is listed for retirement.
- We will not reopen the session-length question unless the 1-hour cap blocks real work. If it does, the request goes to WCM Security, not ITS Cloud.

## Consequences

- Long-running local jobs, such as backfills and probes, must either finish within an hour or run in-account (ECS task, `run-staging-probe.sh`) under a task role. They cannot rely on a laptop session.
- Every human action in CloudTrail is attributed to a federated session name, not to a shared IAM user.
- If WCM later enables IAM Identity Center, this ADR should be revised to move the CLI to `aws sso login`.
