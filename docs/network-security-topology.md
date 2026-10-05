# Network & security topology

**Audience.** ITS security colleagues and operators who need a single review-ready picture
of the VPC, subnets, security groups, egress, and edge filtering — without reading eight
CDK files.

**Authoritative source.** [`cdk/lib/network-stack.ts`](../cdk/lib/network-stack.ts) (VPC +
SGs), [`cdk/lib/config.ts`](../cdk/lib/config.ts) (per-env values), plus the SG-to-SG
ingress and endpoints added by AppStack/EtlStack/DataStack
([`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md)). Decisions and threat model:
[`ADR-008`](./ADR-008-infrastructure-as-code.md). IAM roles and human access:
[`access-control-rbac.md`](./access-control-rbac.md).

---

## Account & region boundary

- **Two separate AWS accounts** — staging and production — not one account with two stack
  sets. A misconfigured IAM grant or a `cdk deploy` with the wrong `-c env` cannot reach
  production from a staging operation; the blast radius of any staging mistake is the
  staging account ([`ADR-008` decision 5](./ADR-008-infrastructure-as-code.md)).
- **Primary region `us-east-1`; DR region `us-west-2`** (Aurora cross-region backup copy only).
- Org-level controls (SCPs, GuardDuty, org CloudTrail) are assumed administered above this
  project and are explicitly out of ADR-008's scope.

## VPC layout (per environment)

| | Staging | Production |
|---|---|---|
| VPC CIDR | `10.x.0.0/16` (internal) | `10.x.0.0/16` (internal) |
| AZs | `us-east-1a`, `us-east-1b` | same |
| Public subnets | /24 per AZ — ALB + NAT only | same |
| Private-with-egress subnets | /22 per AZ — ECS tasks, Aurora, OpenSearch, ETL | same |
| NAT gateways | 1 | 1 (EIP-cap-constrained; single-NAT trade-off documented in `config.ts`) |

**Nothing that holds data is in a public subnet.** ECS tasks, Aurora, and OpenSearch live
in private-with-egress subnets — unreachable from the internet, able only to reach *out*
through the NAT (or, for AWS services, via VPC endpoints — see below).

```mermaid
flowchart TB
  inet([Internet]):::ext
  cf["CloudFront + AWS WAF"]:::edge
  subgraph vpc["VPC 10.x.0.0/16 — 2 AZs"]
    subgraph pub["Public subnets /24"]
      albp["Public ALB (internet-facing)<br/>SG: alb"]:::net
      nat["NAT gateway"]:::net
    end
    subgraph priv["Private-with-egress subnets /22"]
      ecs["ECS Fargate: app + ETL tasks<br/>SG: app / etl"]:::app
      albi["Internal ALB<br/>(/api/revalidate)<br/>SG: alb"]:::net
      aur[("Aurora MySQL<br/>SG: aurora")]:::data
      os[("OpenSearch<br/>SG: opensearch")]:::data
      vpce["VPC endpoints:<br/>Secrets Mgr (interface)<br/>S3 (gateway)"]:::net
    end
  end
  sm["Secrets Manager / ECR-via-S3"]:::aws
  wcm["WCM source systems<br/>(ED, InfoEd, COI, ReciterDB…)"]:::ext

  inet --> cf -->|"X-Origin-Verify header"| albp --> ecs
  ecs --> aur
  ecs --> os
  ecs -->|":443"| vpce --> sm
  ecs -->|"egress"| nat -->|"to WCM via TGW + firewall"| wcm
  ecs --> albi

  classDef ext fill:#eee,stroke:#999;
  classDef edge fill:#fde7e7,stroke:#7d1c1c;
  classDef net fill:#eef2ff,stroke:#3b5bdb;
  classDef app fill:#e6fcf5,stroke:#0ca678;
  classDef data fill:#fff3bf,stroke:#f08c00;
  classDef aws fill:#f3f0ff,stroke:#7048e8;
```

## Security groups (default-deny, SG-to-SG)

The three base SGs are created with **no ingress** (default-deny) and allow-all egress;
reachability is defined by explicit SG-to-SG rules added by the stack that owns each
listener/service. There are **no IP allowlists** for intra-VPC reachability — every rule is
SG-referenced.

| SG | Ingress (who can reach it) | Owned/added by |
|---|---|---|
| `alb` (public ALB) | `:80` from `0.0.0.0/0` **but** the listener default action is `403`; a priority-1 rule forwards only when `X-Origin-Verify` matches the CloudFront-injected secret | NetworkStack (SG; flag-off) or `sharedVpc.albSgId` (flag-on) / AppStack + EdgeStack (rule) |
| `alb` (internal ALB listener) | `:80` from the `etl` SG only (the `/api/revalidate` path) | EtlStack |
| `app` (ECS app tasks) | from the `alb` SG only | AppStack |
| `etl` (ETL tasks) | none inbound (egress only) | NetworkStack (flag-off) or `sharedVpc.etlSgId` (flag-on) |
| `aurora` | from `app` SG + `etl` SG only | DataStack |
| `opensearch` | from `app` SG + `etl` SG only (private ENI, data plane) | DataStack |
| Secrets Manager interface-endpoint SG | `:443` from `app` SG + `etl` SG only (CDK's default `:443 from VPC CIDR` is suppressed) | AppStack (B17) |

## Egress confinement (VPC endpoints)

Keeps AWS-service traffic off the NAT / public internet:

- **Secrets Manager interface endpoint** — task-execution-role secret pulls stay on the AWS
  backbone.
- **S3 gateway endpoint** — ECR image-layer pulls (S3-backed) stay off the NAT;
  route-table association only, no SG.
- **OpenSearch** is intentionally *not* an endpoint — the managed domain exposes a private
  ENI inside the VPC, so data-plane queries already stay on the AWS network. (An interface
  endpoint would only matter for the OpenSearch control plane, which the runtime never
  calls — `PRODUCTION_ADDENDUM.md § VPC endpoints`.)
- **X-Ray** export from the OTel sidecar currently goes via NAT (no endpoint provisioned;
  out of B24 scope — [`tracing.md`](./tracing.md)).

## WCM-internal connectivity (the ETL's hardest dependency)

The ETL must reach WCM-internal source systems (ED LDAP, InfoEd, COI, ReciterDB). This has
two halves:

1. **DNS resolution** — three RAM-shared Route 53 Resolver FORWARD rules (for
   `weill.cornell.edu`, `med.cornell.edu`, `wcmc.ad.net`) from the Central Services account
   (`091981818184`) are associated to this VPC, sending those domains to the shared
   outbound resolver — the same wiring ReCiter's EKS VPC uses. Codified in NetworkStack,
   which is not synthesized while `useSharedVpc` is on; the shared VPC's associations are
   owned outside SPS.
2. **Routing** — reaching the resolved IPs additionally needs the Central Services Transit
   Gateway attachment + the WCM-side firewall opened for this VPC's CIDR. **Those are owned
   by the Central Services account / WCM network, not by SPS**, and are tracked separately.
   This is the known connectivity gap that gates first ETL data population — see
   [`data-population-runbook.md`](./data-population-runbook.md).

## Edge & WAF

- **CloudFront** fronts everything; the public ALB is reachable only with the
  `X-Origin-Verify` shared-secret header CloudFront injects (so the ALB DNS — published
  nowhere but discoverable — can't bypass the CDN/WAF). Secret in
  `scholars/${env}/edge/origin-shared-secret`; rotation runbook in
  [`PRODUCTION_ADDENDUM.md § Origin protection`](./PRODUCTION_ADDENDUM.md).
- **AWS WAF** attaches to the distribution: a rate-based rule (1000 req / 5 min / IP) plus
  AWS Managed Rules. The WAF topology is decided (#502): CloudFront + AWS WAF → NetScaler →
  ALB → Fargate, with the NetScaler an AWS VPX run by the WCM network team (RITM0801140,
  prod+staging, staging-first). **Both environments are cut over and live** (staging 2026-07-21,
  prod 2026-07-24): CloudFront reaches the app through the NetScaler VIP — origin leg
  **HTTPS-only** (an HTTP origin behind the VIP's HTTP→HTTPS upgrade loops), NetScaler → ALB on
  **`:443`** forwarding `X-Origin-Verify`; durable in CDK via the `#1507` origin-flip (PR #1852
  staging, #1926 prod). The `:80` listener still exists in both envs but is not the live path —
  it carries only internet-scanner noise. (Port corrected 2026-07-25: this paragraph previously
  said staging rode `:80`; VPC flow logs across all four staging ALB ENIs plus a timed causal
  probe showed otherwise. See #1937, which also closed the `:443` TLS-policy gap — both envs
  now carry the #1929 AEAD-only pin, staging deployed 2026-07-27.) A WCM-only access gate (#461)
  stays in place meanwhile. **Do not lift the WCM-only gate until the NetScaler enforces
  equivalent filtering.**
- **TLS:** ACM certs for `scholars[-staging].weill.cornell.edu` are provisioned and rotated
  by WCM ITS (not CDK). HSTS ships on the security-headers policy; CSP and the other headers
  are filled in by B21 ([`ADR-007`](./ADR-007-csp-script-src-strategy.md)).
- **Cookies are stripped on cacheable routes** (the single most important cache-key knob);
  full cookie/header forwarding only on the uncacheable writer routes
  ([`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md)).

### Origin backout: NetScaler VIP to ALB (#1936)

The dynamic origin has **no failover**. The default behavior and every ordered behavior
target one custom origin, the NetScaler VIP. The only origin group is `/_next/static/*`
(S3 primary). If the VIP stops forwarding, the whole dynamic site is down until an operator
moves the origin. The `sps-edge-origin-down-<env>` alarm (inside the
`sps-app-unavailable-<env>` composite) is what detects this.

**How the origin is built.** `cdk/lib/edge-stack.ts` picks one of two origins:

- `edgeOriginCertArn` **and** `edgeOriginHostname` both non-empty (today, both envs): the
  origin is `edgeOriginHostname` (the NetScaler VIP), `HTTPS_ONLY` on :443, TLS 1.2.
- `edgeOriginHostname` empty: the origin is the public ALB DNS name read from SSM
  `/sps/<env>/app/public-alb-dns`, **`HTTP_ONLY` on :80**.

`X-Origin-Verify` is sent on both paths. The edge-stack test "with the cert seeded but NO
origin hostname, CloudFront stays HTTP_ONLY on the ALB DNS name" pins the second path.

**Do not repoint the origin to the ALB DNS name in the console with `https-only`.** The
ALB's :443 cert names the public hostname only, with no SAN for the
`*.elb.amazonaws.com` name. CloudFront checks a custom origin's cert against the origin
domain name, so that check fails and every dynamic request returns 502. The backout looks
applied while the site stays down. The CDK path below avoids this because it lands on
`http-only` :80.

**Procedure** (run from a fresh `origin/master` checkout, per
[`DEPLOY-RUNBOOK.md` § EdgeStack](./DEPLOY-RUNBOOK.md)):

1. In `cdk/lib/config.ts`, in the affected env's block, set `edgeOriginHostname: ""`.
   **Leave `edgeOriginCertArn` as it is.** It gates only the ALB :443 listener and its SG
   ingress (AppStack). Keeping it means the NetScaler path is still there when you roll
   forward, and `Sps-App-<env>` does not need a deploy.
2. Diff, then deploy, the Edge stack alone:

   ```sh
   cd cdk
   npx cdk diff --method=template --exclusively Sps-Edge-<env> -c env=<env>
   # expect ONLY the origin to change: DomainName -> the SSM-resolved ALB DNS,
   # OriginProtocolPolicy https-only -> http-only, HTTPPort 80.
   # NO destroy/Removed of WebACL / IPSet / Aliases / ViewerCertificate.
   npx cdk deploy --require-approval never --exclusively Sps-Edge-<env> -c env=<env>
   ```

   CloudFront takes about 5-15 minutes to propagate. Background the deploy.
3. Check: the edge serves a dynamic page from a WCM network, and the ALB `RequestCount`
   rises again. The `sps-edge-origin-down-<env>` probe dials the VIP hostname baked into
   its Lambda env at the last `Sps-Observability-<env>` deploy, so it keeps alarming while
   the VIP is down, even after the backout works. Use the ALB metrics to confirm recovery.
   Do not deploy `Sps-Observability-<env>` while backed out: with an empty hostname the
   probe refuses to report and the origin alarm goes blind.
4. Roll forward once the VIP is healthy again: restore the hostname from git and deploy
   `Sps-Edge-<env>` the same way.

**The ALB :80 listener is load-bearing.** This procedure is the only recovery path, and it
lands on `HTTP_ONLY` :80 (listener `PublicHttpListener` plus the `0.0.0.0/0` :80 SG
ingress in `cdk/lib/app-stack.ts`). Do not remove :80 while this is the backout. A
dedicated ALB hostname with its own ACM cert, pre-staged as an HTTPS failover member of a
dynamic origin group, would remove both the SPOF and the :80 dependency (#1936, not
built).

**Not rehearsed.** This procedure has **not** been run on staging. Rehearse it once on
staging (VIP -> ALB -> VIP) before relying on it in prod. Until then, plan on a recovery
time of 30-60+ minutes (config edit, diff, deploy, propagation), not "minutes".

**Open questions for the WCM network team (unanswered, record the answers here):**

- Is the VIP highly available (two appliances behind one address) or a single node? That
  decides whether the missing failover is accepted risk or an open gap.
- What is the NetScaler's idle/read timeout on this vserver? CloudFront's
  `OriginReadTimeout` is the 30s default (`edge-stack.ts` sets none). The NetScaler
  timeout must be at least as long. **Do not raise `OriginReadTimeout`** (for example, for
  the Bedrock-backed routes) until this is known. `sps-edge-origin-latency-p99-<env>`
  (warn tier, p99 > 20s) is the early warning for requests nearing the 30s cutoff.

## Secrets posture (network-relevant slice)

- All credentials live in **Secrets Manager**; referenced by ARN only — **no secret value
  ever appears in CDK source or a synthesized template** (ADR-008 hard rule).
- The ECS **task-execution role** can `GetSecretValue` on exactly the enumerated consumer
  ARNs; the **task role** (runtime app identity) has **zero** secret access — app code sees
  secrets only as env vars injected at task start. Full IAM detail:
  [`access-control-rbac.md`](./access-control-rbac.md).

## Threat-model summary (from ADR-008)

In scope and enforced by this topology: IAM least privilege (role split), private-subnet
placement, SG-to-SG-only reachability, egress confinement via endpoints, edge filtering
(WAF), account-boundary environment isolation, no long-lived CI credentials (OIDC), and
drift detection (`cdk diff`). Explicitly out of scope: application-layer authn/authz (that
is SAML + RBAC, see [`access-control-rbac.md`](./access-control-rbac.md)), secret *values*
(provisioned out-of-band), org-level controls, and runtime intrusion detection.

## Known gaps / caveats

- **Single NAT in prod** — an AZ failure costs outbound for tasks in the other AZ
  (accepted; raise EIP quota and bump to 2 post-launch).
- **TGW + WCM firewall are not SPS-owned** — the ETL connectivity path depends on another
  team; resolver associations are codified but routing is external.
- **NetScaler VIP is a single dynamic origin with no failover** (#1936). Both envs route
  every dynamic request through it (staging 2026-07-21, prod 2026-07-24; see § Edge & WAF).
  Recovery is the manual [origin backout](#origin-backout-netscaler-vip-to-alb-1936), which
  has not been rehearsed. Whether the VIP is HA is an open question to the network team.
  The #461 WCM-only gate stays until the NetScaler enforces equivalent filtering.
- **`cdk diff` is the only drift detector** — there is no continuous config-drift scanner;
  console changes are caught at the next diff, not in real time.
