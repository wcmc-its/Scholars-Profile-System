# docs/ADR-015 — Human AWS access: personal MFA-gated IAM users or SAML federation; no shared keys, no IAM Identity Center

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

- **No shared credentials for people.** Every human action must be attributable to one named person. Shared IAM user keys are retired.
- **Daily CLI work: a personal IAM user, gated on MFA.** Each developer who needs the CLI gets an IAM user named after their WCM ID. A deny-unless-MFA inline policy blocks every action except `sts:GetSessionToken` and read-only lookups of the user and its MFA devices, so the long-term access key is useless on its own. MFA enrollment is deliberately not exempt: if it were, a leaked key alone could enroll an attacker's device. The MFA device is enrolled from the console under the SAML role, and the developer then creates their own access key there. Once a day the developer exchanges a TOTP code for a 12-hour session (`sts:GetSessionToken`), so there is one authentication event per working day. EKS access is granted to the user through an access entry.
- **SAML federation stays available** for the console and for occasional CLI use via `saml2aws`, with its 1-hour sessions.
- **Workloads:** use IAM roles (ECS task roles, EKS IRSA, Lambda execution roles). A workload that cannot use a role yet keeps a dedicated key scoped to that workload alone, and that key is listed for retirement.

### Why personal IAM users and not SAML alone

`saml2aws` cannot hold an IdP session across refreshes, so every hourly refresh means a full sign-in with MFA. That is roughly eight interactive sign-ins a day, and it breaks unattended work longer than an hour. A personal IAM user with an MFA-gated policy keeps the two properties that matter, per-person attribution and MFA on every session, at one sign-in a day. The trade-off is a long-lived access key on the developer's machine. The MFA gate reduces that key to a factor that cannot act alone.

## Consequences

- CloudTrail attributes every human CLI action to a named IAM user (or a federated session name), not to a shared user.
- Offboarding a developer means deleting their IAM user and EKS access entry. It does not touch workloads or other people.
- Personal IAM users will show up in security scanners as "IAM user with access key". These are expected; the MFA-only policy is the compensating control.
- If WCM later enables IAM Identity Center or lengthens the SAML session, revise this ADR and retire the personal IAM users in favour of federation.
