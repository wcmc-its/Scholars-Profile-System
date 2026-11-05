# Security Policy

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab and choose **Report a vulnerability**. You can also email **paa2013@med.cornell.edu**. Please do not open a public issue or pull request for a security problem.

Include the affected page, endpoint or file, steps to reproduce, and the impact you expect.

## Supported versions

Only the code deployed from the `master` branch is supported. There are no release branches, and fixes are not backported.

## Remediation targets

**Status: Proposed, pending owner approval.**

| Severity | Target to fix or mitigate |
|---|---|
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low | Best effort |

The clock starts when a finding about SPS code or SPS-owned resources is first reported by any of:

- a Dependabot alert or security update PR,
- a CodeQL, Checkov or secret-scanning alert on the Security tab,
- a Prowler or OWASP ZAP review run under the [security review runbook](docs/SECURITY-REVIEW-RUNBOOK.md),
- a GuardDuty finding (these go to ITS Security first, per the runbook),
- a private vulnerability report or other report to the team.

Severity is the scanner's own rating, or CVSS for a report. The team may re-rate a finding after triage and records why. A finding accepted as a design decision gets an ADR instead of a fix, as [ADR-013](docs/ADR-013-session-revocation.md) and [ADR-014](docs/ADR-014-saml-inresponseto-not-validated.md) do.

## Security controls

This is a summary. The linked docs are the source of truth.

- **Scanning.** CodeQL, dependency review, Dependabot, secret scanning with push protection, and Checkov run in CI. Prowler and an OWASP ZAP baseline run quarterly, and the ASVS Level 2 self-assessment yearly. See the [security review runbook](docs/SECURITY-REVIEW-RUNBOOK.md).
- **Authentication.** `/edit` sign-in is WCM SSO over SAML. The session is an encrypted `__Host-` cookie with an 8-hour absolute cap and a 2-hour idle timeout. See [ADR-013](docs/ADR-013-session-revocation.md), [ADR-014](docs/ADR-014-saml-inresponseto-not-validated.md) and [`saml-sp.md`](docs/saml-sp.md).
- **Authorization.** Roles are re-read on every request, and every edit writes an append-only audit row. See [`access-control-rbac.md`](docs/access-control-rbac.md).
- **AWS access.** No shared credentials for people. Developers use a personal IAM user that can do nothing without MFA, with one 12-hour session a day, or WCM SAML federation (`saml2aws`, 1-hour sessions). IAM Identity Center is not available at WCM. Workloads use IAM roles. See [ADR-015](docs/ADR-015-human-aws-access-saml-federation.md).
- **Edge.** CloudFront with an AWS WAF web ACL (managed rules and a rate rule) sits in front of the app. The origin admits only requests that carry the shared origin-verify header. See [`network-security-topology.md`](docs/network-security-topology.md).
- **Data in transit and at rest.** Aurora requires TLS for every connection and is encrypted at rest. OpenSearch enforces HTTPS and encrypts at rest and between nodes.

## Key and certificate inventory

Listed by purpose and storage location. Secret values are never in this repo or in CloudFormation templates. They are seeded out of band.

| Purpose | Stored in | Rotation | Owner |
|---|---|---|---|
| Aurora master credential | Secrets Manager | Automatic, every 30 days (Secrets Manager rotation) | SPS team |
| Application, ETL, migration and bootstrap database credentials | Secrets Manager | Manual. Bootstrap and migration credentials are minted at deploy time | SPS team |
| OpenSearch user credentials (master, app read-only, ETL) | Secrets Manager | Manual | SPS team |
| Session cookie encryption key | Secrets Manager | Manual. Rotating it signs out every user, and it is the emergency kill switch (ADR-013) | SPS team |
| SAML service provider key pair | Secrets Manager | Manual, re-filed with WCM ITS on change | SPS team |
| SAML identity provider signing certificates | Secrets Manager | Replaced when the IdP rotates. Both rollover certs can be held at once | WCM IdP team, applied by SPS team |
| Origin-verify shared secret (CloudFront to origin) | Secrets Manager | Manual | SPS team |
| Bearer tokens for the revalidate API and the two grants API consumers | Secrets Manager | Manual, with a `_PREVIOUS` overlap slot. The revalidate token rotates quarterly ([runbook](docs/revalidate-token-rotation.md)) | SPS team |
| ORCID member API client credentials and token encryption key (AES-256-GCM) | Secrets Manager (staging only for now) | Manual | SPS team |
| Directory (LDAP) bind credentials | Secrets Manager | Manual | SPS team |
| Upstream source system credentials used by the ETL (one secret per source) | Secrets Manager | Manual, per source | SPS team, with each source's owner |
| Observability ingest key and on-call webhook URL | Secrets Manager | Manual | SPS team |
| TLS certificates for the public site (CloudFront and load balancer) | ACM | Provisioned and renewed by WCM ITS, not by CDK | WCM ITS |
| Network identifiers and the edge allowlist | SSM Parameter Store | Changed on infrastructure change. Not secrets | SPS team |

## Data classification

| Class | Examples | Where it can be seen |
|---|---|---|
| Public | Profile content: names, titles, appointments, publications, grants, overviews, published conflict-of-interest disclosures, emails released as public | Anyone. Served from the CDN cache |
| Internal | Emails released to the institution only | WCM viewers only, through an uncached endpoint ([`email-visibility-spec.md`](docs/email-visibility-spec.md)) |
| Restricted | The `/edit` audit log; hidden or suppressed content and pending requests; conflict-of-interest gap candidates (shown only to the scholar); feedback submissions; stored ORCID access tokens (encrypted); doctoral student records ([FERPA carve](docs/student-profile-visibility.md)) | Signed-in users with the right role, or operators. Served only on uncached routes |
| Secret | Credentials, keys and tokens in the inventory above | Runtime only, through Secrets Manager |
