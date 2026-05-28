# WAF Request (RITM0792011) — What to Update

**Ticket:** RITM0792011 / REQ0292790 — "Web Application Firewall Request"
**Assigned to:** Andrew Budries (ITSOPS‑Application Hosting)
**Fulfillment tasks owner:** ITSOPS‑Security
**Status:** Work in Progress · Expected 2026‑06‑08
**Purpose of this doc:** what to change in the RITM before / at the Andrew Budries meeting.

## Bottom line

The seven auto‑generated fulfillment tasks describe WCM's **standard on‑prem reverse‑proxy WAF**
(assign a **vIP** → put an **SSL cert on the vIP** → **DNS** to the vIP → open a **network
firewall** path). That model is **architecturally incompatible** with the Scholars Profile System,
which is `client → CloudFront → ALB (origin‑verify header) → ECS Fargate`.

So the RITM updates are not about WAF *features* — they're about **redirecting fulfillment to an
AWS‑native WAF** (an AWS WAFv2 **WebACL**, `CLOUDFRONT` scope, in **our** AWS account) and marking
the appliance‑model tasks N/A. Three small edits + one comment + task dispositions, below.

## 1. Field answers to correct in the RITM

### 1a. "Does this web application utilize XML?" — change **No → Yes (qualified)**

Current answer is inaccurate and will mislead the vuln scan and policy tuning. The app API is JSON,
but the **SAML SSO callback receives base64‑encoded SAML XML assertions**.

> **Replace with:**
> Yes (qualified). The application API is JSON. The only XML is the SAML SSO assertion: the
> ACS endpoint `POST /api/auth/saml/callback` receives a base64‑encoded `SAMLResponse` (SAML 2.0
> XML). No other XML is parsed. This is relevant to WAF tuning — see the SAML exclusion note below.

### 1b. Request Details — append the architecture clarification + explicit ask

The existing text already asks "WebACL on CloudFront or fronts the ALBs?" — make the answer
unambiguous so the meeting starts from the right place.

> **Append to Request Details:**
> Architecture: public entry is AWS CloudFront (two separate distributions — prod
> `scholars.weill.cornell.edu` and staging `scholars-staging.weill.cornell.edu`) → internet‑facing
> ALB (locked to CloudFront via an origin‑verify secret header) → ECS Fargate. TLS terminates at
> CloudFront using ACM certs already ISSUED in us‑east‑1 for both hosts. There is no static IP and
> no on‑prem path.
>
> Requested WAF implementation: an **AWS WAFv2 WebACL, `CLOUDFRONT` scope, us‑east‑1**, associated
> to each distribution (prod + staging = two associations), in **AWS account 665083158573**. We can
> attach the WebACL in our own CDK (the EdgeStack already provisions one for a temporary IP
> allowlist), or ITSOPS‑Security can manage it centrally via AWS Firewall Manager in that account.
> The on‑prem vIP / vIP‑SSL‑cert / DNS‑to‑vIP / network‑firewall pattern does **not** apply to a
> CloudFront‑fronted app (see task dispositions).

### 1c. CSRF (in the request title) — note it's an app‑layer control, not a WAF rule

CSRF is already mitigated in‑app (`SameSite=Lax` `__Secure-` session cookie + an explicit
request‑origin guard on every `/api/edit/*` write). Add a one‑liner so no one tries to build a WAF
rule for it: *"CSRF is handled at the application layer (SameSite cookies + origin guard); no WAF
rule required."*

**Leave as‑is (already correct):** Server Location (AWS, 665083158573, us‑east‑1), hostname
(CloudFront + staging ALB DNS), Server IP (N/A — no static IP), ports (443/tcp), Common Name + SAN.

## 2. Catalog task dispositions (the substance of the meeting)

Walk these task‑by‑task with Andrew. Three proceed, three are N/A, one collapses to a CNAME.

| Task | Disposition | Note |
|---|---|---|
| **SCTASK0662588 — WAF Firewall policy tuning** | ✅ **Proceed** | The real task. Managed rule groups on the CloudFront WebACL — see §3. |
| **SCTASK0662587 — Web Application vulnerability scan** | ✅ Proceed | Scan against the CloudFront URL. |
| **SCTASK0662584 — Server vulnerability scan** | ✅ Proceed | ECS task / ALB. |
| **SCTASK0662586 — vIP address assignment and configuration** | ❌ **N/A** | CloudFront/ALB have no static IP; no vIP exists in this topology. |
| **SCTASK0662585 — Create SSL Certificate for vIP** | ❌ **N/A** | TLS terminates at CloudFront on existing ACM certs (both hosts, us‑east‑1). |
| **SCTASK0662590 — Network Firewall request** | ❌ **N/A (confirm)** | No on‑prem network path; ALB SG already restricts ingress to CloudFront via origin‑verify header. |
| **SCTASK0662589 — DNS record change** | ⚠️ **Reduced scope** | Only the CNAME `scholars → <distribution>.cloudfront.net` (the existing launch‑track DNS ask). **Not** a change to point DNS at a WAF vIP. |

### Closing the N/A tasks

The SCTASK **State** dropdown in this instance offers only: Open · On Hold · Waiting On User ·
Work in Progress · **Closed Incomplete** · **Closed Complete** — there is **no "Closed Skipped."**

- **Do not use Closed Incomplete** for the N/A tasks. It signals a failed/unfinished control and, in
  most ServiceNow configs, blocks the parent RITM from closing Complete (or drags the RITM to
  Closed Incomplete) — making the launch request read as failed.
- The N/A disposition, when Skipped isn't available, is **Closed Complete + a work note**
  ("N/A — CloudFront architecture, no vIP; no work to perform").
- **But these are ITSOPS‑Security's tasks — let them close them**, not the requester. Closing a
  *security* task Complete yourself, when nothing was verified, looks like bypassing a control.
  Until they agree at the meeting, leave the tasks **Open** or set **On Hold** (the honest state for
  "blocked pending the AWS‑native vs. appliance decision"). Never click the red ✗ (Close Incomplete).

## 3. WAF policy scope (for SCTASK0662588 — policy tuning)

**Enable (maps to the ticket's SQLi/XSS/header‑manipulation):**

- `AWSManagedRulesSQLiRuleSet` — SQLi
- `AWSManagedRulesCommonRuleSet` (CRS) — XSS, generic injection, oversized body/header
- `AWSManagedRulesKnownBadInputsRuleSet` — header manipulation (host‑header injection, malformed
  headers) + Log4Shell/JNDI

**Cheap add‑ons worth saying yes to:**

- `AWSManagedRulesAmazonIpReputationList` — low false‑positive, near‑zero cost
- **One rate‑based rule** (~1–2k req / 5 min per IP) — the meaningful L7 "DDoS prevention" lever.
  AWS **Shield Standard** already covers L3/L4 for free on CloudFront.

**Decline:**

- `AWSManagedRulesAnonymousIpList` — would block WCM editors who reach `/edit` over the WCM VPN.
- **Shield Advanced** (~$3k/mo) — unjustified pre‑launch unless WCM has an org‑wide subscription.

**Critical tuning requirement — do not skip:**

> Deploy the rule groups in **Count mode first**, watch sampled requests in CloudWatch, then flip to
> Block. Apply a **scope‑down / exclusion on `POST /api/auth/saml/callback`** (and watch
> `/api/search?q=`). Base64‑encoded SAML XML reliably trips CRS/SQLi signatures — going straight to
> Block **breaks SSO login on day one**. Each of the two distributions (prod + staging) needs its own
> association.

## 4. Facts to cite (so the answers above hold up)

- **AWS account / region:** 665083158573, us‑east‑1 (CLOUDFRONT‑scope WebACLs must live in
  us‑east‑1 — matches EdgeStack's region).
- **Two distributions:** prod and staging are separate CloudFront distributions → two WebACL
  associations.
- **ACM certs already ISSUED** (us‑east‑1) for both hosts — TLS terminates at CloudFront, not a vIP.
- **WebACL already exists in code:** `cdk/lib/edge-stack.ts` provisions a `CfnWebACL` today for the
  temporary #461 WCM‑only IP allowlist and sets `webAclId` on the distribution. A CloudFront
  distribution can hold **only one** WebACL — so if ITSOPS‑Security associates one (via Firewall
  Manager), it will collide with ours. Decide ownership: either they hand us the rule‑group list to
  add into the EdgeStack WebACL, or they manage centrally and we drop our `webAclId` and fold the
  temporary allowlist into theirs. (This WAF was always planned to land here — see the
  "WAF lands with B26 #125" note in `edge-stack.ts`.)
- **SAML ACS path:** `app/api/auth/saml/callback/route.ts`.
- **CSRF posture:** `__Secure-` `SameSite=Lax` session cookie + request‑origin guard in
  `lib/edit/authz.ts` / `lib/edit/request.ts`.
- **Origin‑verify gate:** the ALB only accepts requests carrying CloudFront's secret header, so an
  external WAF appliance could not reach the ALB even if one were inserted.

## 5. Suggested next action

1. Make edits **1a / 1b / 1c** in the RITM now (before the meeting), and add **§2** as a ticket
   comment so ITSOPS‑Security sees the task dispositions in advance.
2. Bring **§3** to the meeting as the answer to "what features / scope do you need."
3. Settle WebACL **ownership** (us‑attach vs. Firewall‑Manager‑central) — that's the one decision
   that blocks implementation.
