import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/**
 * Same-origin echo path that returns the caller's public IP as `text/plain`.
 *
 * Served entirely by a viewer-request CloudFront Function (no origin contact)
 * and carved out of the `block-non-wcm` WAF rule below, so an OFF-network
 * visitor -- who by definition cannot reach anything else -- can still fetch it
 * from the block page. Value is a literal, not a config knob: it is baked into
 * the static WAF response body, so the two can never be allowed to diverge.
 */
const EDGE_IP_PATH = "/edge-ip";

/**
 * Body served by the `block-non-wcm` WAF rule instead of AWS's stock
 * "The request could not be satisfied / Request blocked" 403.
 *
 * Hard constraints, all load-bearing:
 *  - **<= 4096 bytes.** The AWS WAF quotas page fixes the size of a single
 *    custom response body at 4 KB (the WAFv2 API's 10240 is only the string
 *    validator; the service quota is the one that bites at apply time). If a
 *    copy change overflows, TIGHTEN THE HTML -- the limit is not raisable.
 *    `cdk/test/edge-stack.test.ts` ratchets this.
 *  - **Fully static.** WAF does no interpolation of any kind: no client IP, no
 *    request id, no header echo. That is exactly why `EDGE_IP_PATH` exists.
 *  - **Zero external references.** A blocked client cannot fetch a font, a
 *    stylesheet, an image, or the origin -- WAF terminates before CloudFront
 *    even matches a cache behavior. Everything is inline, system fonts only.
 *  - Inline `<style>`/`<script>` are safe here: no CSP reaches this response.
 *    Neither `securityHeaders` nor `htmlHeaders` sets one (HSTS only, see
 *    below), the app's CSP comes from the origin, and a response-headers
 *    policy is attached to a cache behavior -- which is never selected for a
 *    WAF-blocked request. The script degrades to the static "Unavailable"
 *    already in the markup if any of that turns out to be wrong.
 *
 * Copy state machine -- the markup ships in its FAILURE state on purpose, so
 * every path where the echo does not produce a usable address still reads
 * correctly and stays actionable:
 *  - **No JS / script blocked** -- nothing runs, so the visitor sees
 *    "Unavailable" next to "Email support ... and tell us which network you
 *    are connecting from." Correct as-is; that is why there is no
 *    `<noscript>` block (it would only restate the default markup).
 *  - **In flight** -- the script's first act is to swap the dd to the neutral
 *    "Checking...", so the page never asserts "Unavailable" before it knows.
 *  - **Terminal failure** -- non-2xx (the carve-out leaves `/edge-ip` subject
 *    to the managed groups and the rate limit), network error, empty body, a
 *    body that is not IP-shaped (a TLS-inspecting proxy answering 200 with its
 *    own block page), or 4s elapsed: back to "Unavailable", failure copy
 *    intact, reason on `console.warn`. A late-but-valid response still
 *    upgrades the page -- the 4s timer is a floor on the message, not an
 *    abort.
 *  - **Success** -- and ONLY then -- the dd gets the address and the note is
 *    rewritten to "Send the address above to support@...".
 *
 * The IP-shape test is deliberately a character-class check, not a parser: it
 * has to reject prose (a proxy block page) in ~40 bytes, not validate RFC 4291.
 *
 * Palette/wordmark match the site: `#B31B1B` and `#2c4f6e` are the locked
 * brand tokens from `app/globals.css`; the two-line text lockup mirrors
 * `components/site/header.tsx` and `app/global-error.tsx` (there is no logo
 * asset in the repo, by design).
 */
/**
 * Shared chrome for the WAF block bodies below: same Scholars / Weill Cornell
 * Medicine lockup, same tokens, same responsive + dark rules. Two callers
 * (off-network and rate-limited) is exactly why this is a function -- the two
 * pages are seen by different people in different situations and must not be
 * allowed to drift into looking like different sites.
 *
 * `main` is everything inside `<main class="w">`; the caller closes it, so a
 * page can put a `<script>` after it (only OFF_NETWORK_HTML does).
 */
const wafPage = (title: string, main: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${title}</title><style>
:root{color-scheme:light dark;--red:#B31B1B;--slate:#2c4f6e;--ink:#191919;--mut:#5a5f66;--bg:#fff;--chip:#fbf1ee;--line:rgba(0,0,0,.12)}
@media(prefers-color-scheme:dark){:root{--red:#e08585;--slate:#9dc0dd;--ink:#ededed;--mut:#a3a9b0;--bg:#151515;--chip:#241a1a;--line:rgba(255,255,255,.15)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.w{max-width:560px;margin:0 auto;padding:72px 24px 56px}
.m{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:48px}
.m b{display:block;font:600 22px/1.1 Georgia,"Times New Roman",serif;letter-spacing:-.005em;color:var(--red)}
.m span{display:block;margin-top:4px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
h1{margin:0 0 16px;font:600 34px/1.15 Georgia,"Times New Roman",serif;letter-spacing:-.01em}
p{margin:0 0 20px;color:var(--mut)}
dl{margin:36px 0;padding:16px 18px;background:var(--chip);border-left:3px solid var(--red);border-radius:4px}
dt{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--slate)}
dd{margin:6px 0 0;font:17px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);word-break:break-all}
.n{margin:0;padding-top:20px;border-top:1px solid var(--line);font-size:13px}
a{color:var(--slate)}
@media(max-width:420px){.w{padding:44px 18px 36px}h1{font-size:27px}}
</style></head><body><main class="w">
${main}`;

const OFF_NETWORK_HTML = wafPage(
  "Coming soon - Scholars @ Weill Cornell Medicine",
  `<div class="m"><b>Scholars</b><span>Weill Cornell Medicine</span></div>
<h1>Coming soon</h1>
<p>Scholars @ Weill Cornell Medicine is not publicly available yet. While we finish testing, the site is open only to visitors on the Weill Cornell Medicine network.</p>
<dl><dt>Your IP address</dt><dd id="i" aria-live="polite" aria-label="Your IP address">Unavailable</dd></dl>
<p class="n"><span id="s">We could not detect your address. Email </span><a href="mailto:support@med.cornell.edu">support@med.cornell.edu</a><span id="e"> and tell us which network you are connecting from.</span></p>
</main><script>(function(){var d=document.getElementById("i"),s=document.getElementById("s"),e=document.getElementById("e"),st=0;
function bad(w){if(st)return;st=1;d.textContent="Unavailable";if(window.console)console.warn("edge-ip: "+w)}
d.textContent="Checking...";setTimeout(function(){bad("timeout")},4000);
fetch("${EDGE_IP_PATH}").then(function(r){return r.ok?r.text():Promise.reject("http "+r.status)}).then(function(t){t=(t||"").trim();if(!/^[0-9a-fA-F.:]{3,45}$/.test(t))return bad("shape");st=2;d.textContent=t;s.textContent="Already on campus or on the WCM VPN? Send the address above to ";e.textContent=" and we will get your network added."}).catch(bad);})();</script></body></html>`,
);

/**
 * Body for the `rate-limit` rule. NOT the off-network page: whoever sees this
 * tripped the per-IP cap, which means they are INSIDE the WCM allowlist -- the
 * priority-0 rule would have caught them first otherwise. Telling them they are
 * "outside the network" would be a flat lie, which is why this is a second body
 * rather than a reuse of `offNetwork`. No IP echo either: their address is not
 * the problem and `/edge-ip` should not grow callers.
 */
const RATE_LIMITED_HTML = wafPage(
  "Too many requests - Scholars @ Weill Cornell Medicine",
  `<div class="m"><b>Scholars</b><span>Weill Cornell Medicine</span></div>
<h1>Too many requests</h1>
<p>Scholars has paused requests from your network because it received an unusually large number of them in a short time. This is automatic and temporary - access resumes on its own within a few minutes.</p>
<p class="n">If this keeps happening, or you believe it is a mistake, email <a href="mailto:support@med.cornell.edu">support@med.cornell.edu</a>.</p>
</main></body></html>`,
);

/** Props for {@link EdgeStack}. */
export interface EdgeStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /**
   * ARN of the AppStack GitHub Actions deploy role (`sps-deploy-<env>`). The
   * static-asset bucket grants this principal `s3:PutObject` (prefix-scoped) so
   * the deploy workflow can sync `.next/static` to S3. Passed as a string (not
   * the role handle) to keep the App -> Edge dependency one-directional; the
   * grant is a resource-based bucket-policy statement, so no identity policy is
   * mutated cross-stack.
   */
  readonly deployRoleArn: string;
}

/**
 * EdgeStack — CloudFront distribution fronting the SPS public ALB (B07 + B14).
 *
 * Implements the behaviors in `docs/cloudfront-cache-spec.md`. Four classes:
 *   1. One cacheable default behavior (custom `sps-default-rsc-*`, mirroring
 *      Managed-CachingOptimized) for the bulk of read-only HTML pages. Its
 *      edge `maxTtl` is clamped to 60s so a force-static page's bogus
 *      `s-maxage=31536000` cannot pin year-stale HTML at the edge (the cause
 *      of the /about "client-side exception": stale HTML -> rotated-out chunk
 *      404 -> dead App Router bootstrap). The default also gets a dedicated
 *      `sps-html-headers-*` policy overriding viewer `Cache-Control` to
 *      `max-age=0, must-revalidate`.
 *   2. A long-cache behavior for `/_next/static/*` (Managed-CachingOptimized):
 *      content-hashed, immutable build assets that MUST stay cached a year,
 *      independent of the 60s HTML ceiling above.
 *   3. Uncacheable behaviors (`Managed-CachingDisabled` + `Managed-AllViewer`)
 *      for writer routes, SSO endpoints, mutating internal endpoints, the
 *      health probe, telemetry, on-demand exports, and every query-string
 *      DYNAMIC route (search + the #634 Group A API/feedback/export routes).
 *      One carve-out: `/api/search*` keeps the uncacheable semantics but on
 *      the custom `sps-search-nostore-compress-*` policy (1s query-keyed
 *      TTL + gzip/brotli flags) so compression can fire — see the policy
 *      definition below and docs/cloudfront-cache-spec.md §Compression.
 *   4. Query-keyed CACHEABLE behaviors (#634 Group B) for the high-traffic
 *      ISR pages (profile, dept/center/division, topic-scholars) that read
 *      `searchParams`: a custom cache policy that keeps them edge-cacheable
 *      but puts the query string in the cache key and forwards it to the
 *      origin -- without forwarding cookies. These are `revalidate`-based
 *      (short `s-maxage`), so unlike the force-static pages they refresh
 *      within the revalidate window and need no `maxTtl` clamp.
 * The cache key on the default and the query-keyed behaviors both exclude
 * cookies and all headers beyond `Accept-Encoding` — the single most
 * important knob in the spec, since forwarding cookies on cacheable routes
 * would fragment the cache per session.
 *
 * Origin protection (plan D3): CloudFront-only access is enforced by a
 * shared-secret custom origin header `X-Origin-Verify`. CloudFront injects
 * the value via `Origin.customHeaders`; AppStack's public ALB listener
 * default-denies and only forwards when the header value matches. The
 * secret entry lives in SecretsStack and is rotated out-of-band.
 *
 * Custom domain (plan D2, bootstrap two-step): the distribution ships on
 * `*.cloudfront.net` by default. When `-c edgeCustomDomain=...` and
 * `-c edgeCertArn=...` are both supplied, the alias + ACM certificate
 * are attached. DNS / Route 53 / hosted-zone management is WCM ITS
 * lifecycle and stays out of this stack.
 *
 * Out of scope (plan D4 / D6): WAF lands with B26 #125; security headers
 * beyond HSTS land with B21 #120 by editing the response-headers policy
 * defined here.
 */
export class EdgeStack extends Stack {
  /** The CloudFront distribution. */
  public readonly distribution: cloudfront.Distribution;
  /** S3 bucket receiving CloudFront standard access logs. */
  public readonly logsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const env = envConfig.envName;

    // ------------------------------------------------------------------
    // Origin shared-secret (plan D3).
    //
    // The secret entry is defined in SecretsStack (`scholars/${env}/edge/
    // origin-shared-secret`) and seeded out-of-band per ADR-008's hard
    // rule. CloudFront passes the value as a custom origin header on
    // every forwarded request; the public ALB listener denies anything
    // without the matching header. Without this header the public ALB
    // DNS would be a back-door bypass of every cache-behavior decision
    // (and any future WAF), since the DNS name is published nowhere but
    // is trivially discoverable.
    //
    // `SecretValue.secretsManager(name)` emits the FRIENDLY-NAME dynamic
    // reference (`{{resolve:secretsmanager:<name>:SecretString:::}}`);
    // `unsafeUnwrap()` returns that token, not the value, so the secret never
    // sits in the synthesized template. CloudFront + CloudFormation resolve it
    // at deploy time into the OriginCustomHeaders property.
    //
    // DO NOT use `Secret.fromSecretNameV2(...).secretValue` here: it emits a
    // PARTIAL-ARN reference (the ARN without the random `-xxxxxx` suffix) that
    // Secrets Manager rejects at deploy with ResourceNotFoundException -- the
    // same footgun fixed in AppStack (#431 blocker #5). It broke the first
    // Edge deploy (the secret existed; the reference form was wrong).
    // ------------------------------------------------------------------
    const originVerifyToken = SecretValue.secretsManager(
      `scholars/${env}/edge/origin-shared-secret`,
    ).unsafeUnwrap();

    // ------------------------------------------------------------------
    // S3 bucket for CloudFront standard access logs.
    //
    // CloudFront's standard logging requires the destination bucket to
    // allow ACL writes from the log delivery service. With S3's default
    // BucketOwnerEnforced ownership ACLs are rejected; opt the bucket
    // back to BUCKET_OWNER_PREFERRED so the legacy ACL grant lands and
    // log delivery succeeds. Logs are name-spaced under `cf/${env}/`.
    //
    // Bucket name is left unset so CFN generates a unique name; the
    // stack name (which carries `${env}` via the registration in
    // `cdk/bin/sps-infra.ts`) feeds into that generated name, satisfying
    // Footgun #3 without colliding across the staging+prod single-account
    // deployment.
    // ------------------------------------------------------------------
    this.logsBucket = new s3.Bucket(this, "LogsBucket", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: `sps-cf-logs-expire-${env}`,
          enabled: true,
          expiration: Duration.days(90),
        },
      ],
    });

    // ------------------------------------------------------------------
    // Response-headers policy (plan D6).
    //
    // B21 #120 layers CSP / X-Frame-Options / Referrer-Policy on top.
    // HSTS is included here so the policy is non-empty (CloudFront
    // rejects a policy with no configured sections) and so the
    // distribution ships with at least one security header on day one.
    // ------------------------------------------------------------------
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        responseHeadersPolicyName: `sps-security-headers-${env}`,
        comment: `SPS security headers (${env}) -- HSTS only; B21 layers CSP/XFO.`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(730),
            includeSubdomains: true,
            override: true,
          },
        },
      },
    );

    // ------------------------------------------------------------------
    // HTML response-headers policy (default behavior only).
    //
    // Next.js stamps `Cache-Control: s-maxage=31536000` on force-static HTML
    // (revalidate=false pages such as /about). `s-maxage` is a SHARED-cache
    // directive that is only ever correct for content-hashed assets, never for
    // the HTML documents that REFERENCE them: an HTML page cached for a year
    // keeps pointing at `/_next/static/chunks/main-app-<hash>.js` long after a
    // redeploy rotates that hash and the old file 404s -> the App Router
    // bootstrap fails to load -> "Application error: a client-side exception."
    //
    // Two knobs fix this without a deploy-time invalidation:
    //   1. The default cache policy below clamps the EDGE TTL to 60s (so a bad
    //      deploy self-corrects in <=60s regardless of the origin's bogus year).
    //   2. This policy overrides the VIEWER Cache-Control to `max-age=0,
    //      must-revalidate` so browsers revalidate too. Response-headers
    //      policies are applied to the viewer-facing response AFTER CloudFront's
    //      own caching decision, so this does NOT affect the 60s edge TTL.
    //
    // Carries the same HSTS as `securityHeaders` so HTML keeps the security
    // header. Applied to the DEFAULT behavior only -- `/_next/static/*` keeps
    // `securityHeaders` (immutable assets must stay long-cached in the browser),
    // and the #634 Group B ISR pages keep `securityHeaders` too: they are
    // `revalidate`-based (short `s-maxage`), so their edge copy refreshes within
    // the revalidate window and is not vulnerable to the year-long staleness.
    // ------------------------------------------------------------------
    const htmlHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "HtmlHeaders",
      {
        responseHeadersPolicyName: `sps-html-headers-${env}`,
        comment: `SPS HTML headers (${env}) -- HSTS + no-store Cache-Control so HTML never outlives a deploy.`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(730),
            includeSubdomains: true,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "public, max-age=0, must-revalidate",
              override: true,
            },
          ],
        },
      },
    );

    // ------------------------------------------------------------------
    // Origin (plan D7).
    //
    // HTTP-only on port 80 -- the public ALB has no TLS listener today
    // (PRODUCTION_ADDENDUM § Two-ALB topology; one-PR exposure window
    // accepted at launch). CloudFront-to-origin TLS is the follow-on
    // once the cert lifecycle is in place.
    //
    // customHeaders carries the X-Origin-Verify shared secret; the
    // listener-rule edit in AppStack admits only requests matching it.
    // ------------------------------------------------------------------
    // Item-3 pass 2b: point the origin at the public-ALB DNS name AppStack
    // publishes to SSM (pass 1) instead of the cross-stack ALB handle — severs the
    // App→Edge FnGetAtt DNSName import (edge 8) that would lock the flip (the
    // public ALB replaces onto the shared VPC). `HttpOrigin` defaults to
    // HTTPS_ONLY, so HTTP_ONLY + httpPort:80 stay explicit; every other origin
    // prop is left default (byte-identical to the LoadBalancerV2Origin, which
    // injected none). The X-Origin-Verify header is the whole origin-protection
    // contract — the ALB listener default-denies 403 and forwards only the
    // matching secret — and is unchanged.
    // #1507 -- when edgeOriginCertArn is seeded, CloudFront talks HTTPS to a
    // custom origin hostname the public ALB's :443 listener presents a cert for
    // (the ALB DNS name can't carry a public cert). Otherwise it stays HTTP_ONLY
    // on the ALB DNS name (today's behavior). The X-Origin-Verify shared-secret
    // origin-protection contract is unchanged on both paths.
    //
    // The cert alone is NOT enough to flip this leg: it also needs the origin
    // hostname to resolve to the ALB in DNS, and synth cannot see DNS. So the
    // flip is gated on BOTH -- the cert (AppStack adds the :443 listener) and a
    // non-empty hostname (the operator's assertion that the record is cut). That
    // lets the ALB :443 listener land for a NetScaler front, which dials the ALB
    // directly, without dragging CloudFront's origin onto a hostname that does
    // not yet resolve. Seeding only the cert keeps this leg byte-identical.
    const originHttps =
      envConfig.edgeOriginCertArn.length > 0 && envConfig.edgeOriginHostname.length > 0;
    const origin = originHttps
      ? new origins.HttpOrigin(envConfig.edgeOriginHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          httpsPort: 443,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
          customHeaders: {
            "X-Origin-Verify": originVerifyToken,
          },
        })
      : new origins.HttpOrigin(
          ssm.StringParameter.valueForStringParameter(
            this,
            `/sps/${env}/app/public-alb-dns`,
          ),
          {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              "X-Origin-Verify": originVerifyToken,
            },
          },
        );

    // ------------------------------------------------------------------
    // Static-asset S3 origin (Layer 2 of the /about chunk-404 fix).
    //
    // The default behavior's 60s HTML clamp bounds *stale HTML*, but the Next
    // standalone server still bakes `.next/static` into the container image, so
    // a deploy that rolls the ECS task set deletes the old build's
    // content-hashed chunks -- a browser holding HTML from just before the
    // deploy can still 404 a chunk. Serving `/_next/static/*` from an S3 bucket
    // that the deploy writes ADDITIVELY (no `--delete`, see deploy.yml) makes
    // old hashes survive every deploy, so they never 404.
    //
    // Private bucket + OAC (CloudFront signs requests; no public access, no
    // ACLs). Name is CFN-generated (no `bucketName`) so it inherits the
    // stack-name prefix and satisfies Footgun #3 without colliding across the
    // staging+prod single-account deployment. 14-day lifecycle on the asset
    // prefix sweeps hashes long after any HTML referencing them has aged out of
    // the 60s edge cache and every browser tab has been refreshed.
    // ------------------------------------------------------------------
    const staticBucket = new s3.Bucket(this, "StaticAssetsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: `sps-static-assets-expire-${env}`,
          enabled: true,
          prefix: "_next/static/",
          expiration: Duration.days(14),
        },
      ],
    });

    // Resource-based grant: the deploy role (AppStack) writes hashed assets
    // under `_next/static/` only -- PutObject prefix-scoped, plus ListBucket so
    // `aws s3 sync` (no `--delete`) can skip already-uploaded objects. NO
    // DeleteObject: the sync is additive by design. Granting via the bucket
    // policy (not the role's identity policy) keeps the App -> Edge dependency
    // one-directional.
    const deployPrincipal = new iam.ArnPrincipal(props.deployRoleArn);
    staticBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [deployPrincipal],
        actions: ["s3:PutObject"],
        resources: [staticBucket.arnForObjects("_next/static/*")],
      }),
    );
    staticBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [deployPrincipal],
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
        resources: [staticBucket.bucketArn],
      }),
    );

    // `/_next/static/*` origin: S3 (OAC) primary, ALB fallback. The origin
    // group fails over to the Next server's baked-in `.next/static` on a 403
    // (OAC GetObject on a missing key -> AccessDenied) or 404, so the asset is
    // ALWAYS resolvable even if S3 is momentarily incomplete -- e.g. the window
    // between deploying this EdgeStack (flipping the behavior to S3) and the
    // first app deploy that populates the bucket. That failover is what makes
    // the two-mechanism rollout (manual Edge deploy + CI app deploy) safe.
    const staticS3Origin = origins.S3BucketOrigin.withOriginAccessControl(staticBucket);
    const staticOriginGroup = new origins.OriginGroup({
      primaryOrigin: staticS3Origin,
      fallbackOrigin: origin,
      fallbackStatusCodes: [403, 404],
    });

    // ------------------------------------------------------------------
    // Custom domain + ACM certificate (plan D2, bootstrap two-step).
    //
    // Alias + cert now come from committed config (#1506) so a bare
    // `cdk deploy` no longer strips them; a `-c edgeCustomDomain/edgeCertArn`
    // flag still overrides. Both must resolve for the alias to attach;
    // otherwise the distribution ships on `*.cloudfront.net`. ACM certs
    // for CloudFront must live in us-east-1, which is also the primary
    // region -- no `crossRegionReferences` needed.
    // ------------------------------------------------------------------
    const customDomain =
      (this.node.tryGetContext("edgeCustomDomain") as string | undefined) ??
      envConfig.edgeCustomDomain;
    const certArn =
      (this.node.tryGetContext("edgeCertArn") as string | undefined) ??
      envConfig.edgeCertArn;
    const viewerCert =
      customDomain && certArn
        ? acm.Certificate.fromCertificateArn(this, "ViewerCert", certArn)
        : undefined;

    // ------------------------------------------------------------------
    // Cache + origin request policies (plan D5).
    //
    // Default behavior uses a custom policy (`defaultRscCache`) that
    // mirrors `Managed-CachingOptimized` (URL-keyed, Accept-Encoding in
    // the cache key, no Cookie) but additionally keys on the Next.js App
    // Router RSC headers -- see the policy below for why. The spec's
    // `Accept` / `Accept-Language` allowlist is documented but unused by
    // any route (no Vary on content negotiation, no i18n) so it is left
    // out of the key.
    //
    // Uncacheable behaviors use `Managed-CachingDisabled` plus
    // `Managed-AllViewer` so writer / SSO / mutating routes get the
    // full request (cookies, query strings, headers) at the origin.
    // ------------------------------------------------------------------
    const cachingDisabled = cloudfront.CachePolicy.CACHING_DISABLED;
    const allViewer = cloudfront.OriginRequestPolicy.ALL_VIEWER;

    // #866 internal-viewer origin request policy. ALL_VIEWER forwards every
    // cookie / query string / viewer header but NOT the CloudFront-generated
    // CloudFront-* headers, so the on-network signal cannot read the true
    // viewer IP under plain ALL_VIEWER. This policy adds CloudFront-Viewer-Address
    // to the forwarded set so the #866 internal-viewer check can match the source
    // IP against INTERNAL_VIEWER_CIDRS. Applied to EXACTLY two uncacheable
    // behaviors below -- "/api/profile/*" (the reveal) and "/api/export/*" (so the
    // roster export can read the viewer IP) -- every other uncacheable behavior
    // keeps plain ALL_VIEWER. Name/description ASCII-only (#401).
    const internalViewerOrp = new cloudfront.OriginRequestPolicy(
      this,
      "InternalViewerOrp",
      {
        originRequestPolicyName: `sps-internal-viewer-${env}`,
        comment: `SPS internal-viewer (${env}) -- ALL_VIEWER plus CloudFront-Viewer-Address (#866).`,
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.all(
          "CloudFront-Viewer-Address",
        ),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      },
    );
    // Per-path override: these uncacheable behaviors get internalViewerOrp instead
    // of plain allViewer so the on-network signal can read the viewer IP (#866).
    // Every other uncacheable behavior defaults to allViewer.
    const orpOverrides: ReadonlyMap<string, cloudfront.IOriginRequestPolicy> =
      new Map([
        ["/api/profile/*", internalViewerOrp],
        ["/api/export/*", internalViewerOrp],
      ]);

    // Compression-enabling policy for `/api/search*`. Managed-CachingDisabled
    // hard-codes gzip/brotli support OFF, so the behavior's `compress: true`
    // never fires and the search API ships raw (measured 177.7 KB for a
    // publications-tab response that gzips to ~20-30 KB). CloudFront only
    // compresses responses it can store: the search routes send NO
    // Cache-Control header, so with defaultTtl 0 the response is uncacheable
    // and CloudFront skips compression too (verified empirically on staging
    // 2026-07-02 -- policy live, compress on, still identity encoding).
    // defaultTtl/maxTtl 1s makes the header-less response cacheable for <=1s,
    // which is what lets compression fire; a 1-second, full-query-keyed cache
    // on a public read-only API is deliberate and harmless. Query strings ALL
    // go in the cache key -- they are forwarded by AllViewer regardless --
    // and cookies / headers stay out of the key, same as the managed policy.
    // Key shape mirrors `queryKeyedCache` below where applicable.
    const searchApiNoStoreCompressible = new cloudfront.CachePolicy(
      this,
      "SearchApiNoStoreCompressible",
      {
        cachePolicyName: `sps-search-nostore-compress-${env}`,
        comment: `SPS search API (${env}) -- 1s query-keyed TTL plus gzip/brotli support so compress fires.`,
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
        minTtl: Duration.seconds(0),
        defaultTtl: Duration.seconds(1),
        maxTtl: Duration.seconds(1),
      },
    );
    // Per-path cache-policy override (mirrors `orpOverrides`): ONLY
    // `/api/search*` swaps off Managed-CachingDisabled; every other
    // uncacheable behavior keeps it.
    const cachePolicyOverrides: ReadonlyMap<string, cloudfront.ICachePolicy> =
      new Map([["/api/search*", searchApiNoStoreCompressible]]);

    // Next.js App Router serves two representations at the SAME URL: the
    // full HTML document (a hard navigation / refresh) and the React
    // Flight payload (a soft navigation -- a `<Link>` click), told apart
    // only by the `RSC` request header (`Next-Router-Prefetch` additionally
    // marks a prefetch). A URL-only cache key (Managed-CachingOptimized)
    // caches whichever it sees first and serves it to both: a soft
    // navigation then receives a `text/html` body the client router cannot
    // apply, so the click silently does nothing (e.g. the "About these
    // disclosures" cross-page link). Keying on these two headers -- and
    // CloudFront forwards cache-key headers to the origin, so the app
    // returns the matching representation -- splits the cache into at most
    // three variants per URL: document, navigation flight, prefetch flight.
    // We deliberately do NOT key on `Next-Router-State-Tree` / `Next-Url`:
    // they vary per navigation context and would all but eliminate edge
    // cacheability of the static pages.
    const rscCacheKeyHeaders = ["RSC", "Next-Router-Prefetch"];
    const defaultRscCache = new cloudfront.CachePolicy(this, "DefaultRscCache", {
      cachePolicyName: `sps-default-rsc-${env}`,
      comment: `SPS default cache (${env}) -- Managed-CachingOptimized plus RSC header keying so App Router soft navigation works.`,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        ...rscCacheKeyHeaders,
      ),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      // Clamp the EDGE TTL to 60s. The default behavior serves HTML documents
      // (the force-static pages such as /about, plus sitemap/OG/misc). Next
      // stamps force-static HTML with `s-maxage=31536000`; `maxTtl` is the
      // ceiling CloudFront will honor, so that bogus year collapses to 60s here
      // -- a bad deploy (rotated chunk hashes the year-cached HTML still points
      // at) self-corrects within a minute instead of persisting for up to a
      // year. Immutable assets are NOT affected: `/_next/static/*` has its own
      // long-cache behavior (CachingOptimized) added below. `defaultTtl` 60s
      // bounds header-less responses to the same ceiling; `minTtl` 0 so a
      // `no-store`/`private` page is never force-cached.
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(60),
    });

    // Each entry: [pathPattern, allowedMethods]. Order matters because
    // CloudFront evaluates path patterns top-down -- specific must
    // precede general. Spec § Behaviors #1..#8 map to this list in
    // the exact same order.
    //
    // Methods: CloudFront's AllowedMethods enum exposes three values
    // (ALLOW_GET_HEAD, ALLOW_GET_HEAD_OPTIONS, ALLOW_ALL). The spec
    // calls for GET+HEAD+OPTIONS+POST on auth and analytics, and
    // GET+HEAD+OPTIONS+PUT+POST+PATCH+DELETE on /api/edit*; both
    // collapse to ALLOW_ALL. Cache policy CACHING_DISABLED already
    // prevents POST responses from being cached, and ALL_VIEWER
    // forwards the full request.
    const uncacheableBehaviors: ReadonlyArray<[string, cloudfront.AllowedMethods]> = [
      ["/api/edit*", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/impersonation*` (#637 "View as"): the start/stop POST + DELETE and
      // the `?q=&kind=` candidates GET all need cookies + the query string
      // forwarded and the non-GET methods allowed. Same shape as `/api/edit*`,
      // placed right after it so the #490/#624 query-strip and the POST-403
      // edge guards both stay satisfied. No public route begins with
      // "impersonation", so the broad glob is safe.
      ["/api/impersonation*", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/edit*`, NOT `/edit/*`: the bare `/edit` self-editor route must also
      // forward cookies. `/edit/*` does not match `/edit` (no trailing slash),
      // so a bare `/edit` request falls to the cacheable default behavior, which
      // strips the session cookie -> the SSO gate sees no session -> redirect
      // loop. Mirrors `/api/edit*` above. No public route begins with "edit",
      // so the broader glob is safe.
      ["/edit*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      ["/api/auth/*", cloudfront.AllowedMethods.ALLOW_ALL],
      ["/api/revalidate*", cloudfront.AllowedMethods.ALLOW_ALL],
      ["/api/health/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      ["/api/analytics", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/export/*` -- the publications export (`/api/export/publications/
      // <granularity>`) is a POST handler (large filter body), `force-dynamic`,
      // `Cache-Control: no-store`. ALLOW_ALL, not GET-only: the GET-only form
      // 403'd the POST at the edge so the export never worked through
      // CloudFront. CachingDisabled still prevents any caching.
      ["/api/export/*", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/csp-report` -- the CSP `report-uri` / `report-to` collector
      // (lib/security-headers.ts). Browsers POST violation reports here; the
      // cacheable default allows only GET/HEAD/OPTIONS, so every report was
      // 403'd at the edge and silently dropped. ALLOW_ALL.
      ["/api/csp-report", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/nih-resolve` -- POST batch resolver fired from profile / funding
      // pages (lib/use-nih-resolve.ts) after first paint. Falls to the default
      // GET-only behavior -> every resolve 403'd at the edge -> NIH award
      // links silently fail to resolve on live profiles. ALLOW_ALL.
      ["/api/nih-resolve", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/feedback/submit` -- POST from the feedback form
      // (components/feedback/feedback-form.tsx). Same default GET-only 403;
      // breaks feedback submission once FEEDBACK_BADGE_ENABLED is on. ALLOW_ALL.
      ["/api/feedback/submit", cloudfront.AllowedMethods.ALLOW_ALL],
      // `/api/search*` (covers `/api/search` AND `/api/search/suggest`): the
      // search API is a query-string-dependent dynamic GET (`export const
      // dynamic = "force-dynamic"`). Without an explicit behavior it falls to
      // the cacheable default, whose Managed-CachingOptimized policy excludes
      // the query string from the cache key -- so CloudFront BOTH strips `?q=`
      // before the origin sees it (every request degrades to a match_all over
      // the whole corpus) AND caches the first response for every subsequent
      // query. AllViewer forwards the full query string; the cache policy is
      // the custom `searchApiNoStoreCompressible` above (same never-cache
      // TTLs, but with gzip/brotli support ON so the large JSON compresses),
      // via `cachePolicyOverrides` -- not Managed-CachingDisabled.
      ["/api/search*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // `/search*` -- the user-facing search PAGE (SSR, `force-dynamic`). Same
      // failure mode as `/api/search*` but it was never given an explicit
      // behavior, so the page falls to the cacheable default whose
      // Managed-CachingOptimized policy excludes the query string from the cache
      // key: CloudFront strips `?q` before the origin (the page renders the
      // query-less "browse all" default -- all ~8,937 people, with an empty
      // search box) AND caches that one response for every query (#624).
      // CachingDisabled + AllViewer forwards the full query string and never
      // caches; #632 already made the origin render sub-0.5s so there is no
      // caching benefit to preserve.
      ["/search*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],

      // ----------------------------------------------------------------
      // #634 Group A -- query-string-dependent DYNAMIC routes that must
      // NEVER cache (same treatment as `/api/search*` / `/search*`).
      // Each reads `searchParams` at a `force-dynamic` origin; without an
      // explicit behavior they fall to the cacheable default whose
      // Managed-CachingOptimized policy strips the query string (#490/#624
      // root cause) AND caches one query-less response for everyone.
      // CachingDisabled + AllViewer forwards the full request (cookies +
      // query string + headers) and never caches. All are GET-only; their
      // form POSTs (where any) go to separate `/api/*` routes already
      // covered above.
      // ----------------------------------------------------------------
      // SSO-gated directory typeahead -- reads `q` / `cwids` AND the session
      // cookie, so it needs AllViewer (cookies) not just the query string.
      ["/api/directory/people", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // RePORTER click-through proxy -- reads `cwid` / `profile_id`, 302s.
      ["/api/nih-portfolio", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Person-popover context -- reads `surface` + `context*` params.
      ["/api/scholars/*/popover-context", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Method-badge representative-paper hover (#967 §7) -- `force-dynamic`,
      // `no-store`, reads `?family=` to resolve the family's exemplar pub.
      // Unlisted it falls to the cacheable default, whose query allow-list omits
      // `family`, so the param would be stripped before the origin and the hover
      // would always come back empty. AllViewer forwards it. GET-only (a read).
      ["/api/scholar/*/method-exemplar", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Funding-row representative grants (SEARCH_EVIDENCE_ROWS) -- `force-dynamic`,
      // `no-store`, reads `?q=` to resolve the scholar's topic-matching grants for the
      // "Key funding" disclosure. Same shape as `/api/scholar/*/method-exemplar`: unlisted
      // it falls to the cacheable default whose per-route query allow-list omits `q`, so
      // the param is stripped before the origin and the row never shows. AllViewer
      // forwards it. GET-only (a read).
      ["/api/scholar/*/grants", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Topic publication feed -- reads `sort`/`filter`/`subtopic`/`tier`/`page`.
      ["/api/topics/*/publications", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Method (cross-scholar family) publication feed -- reads `sort`/`filter`/
      // `page` (#824). Same shape as `/api/topics/*/publications`.
      ["/api/methods/*/*/publications", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Org-unit (dept/division) method-facet roster -- `force-dynamic`,
      // `no-store`, reads repeatable `?method=` (+ `?page=`) for the #974 Phase 2
      // facet. Unlisted it falls to the cacheable default, whose query allow-list
      // omits `method`, so the filter would be stripped before the origin. AllViewer
      // forwards it. GET-only (a read).
      ["/api/units/*/*/members", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // `/api/profile/*` -- the #866 internal-viewer reveal endpoint. MUST have an
      // explicit uncacheable behavior: an unlisted `/api/profile/*` path falls to
      // the cacheable default, which would cache one viewer's reveal (incl. the
      // sensitive live-animal-model families) and serve it to every viewer -- a
      // leak. CachingDisabled never caches; the internalViewerOrp applied below
      // additionally forwards CloudFront-Viewer-Address so the on-network signal
      // can read the source IP. GET-only (the reveal is a read).
      ["/api/profile/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Feedback form page -- `force-dynamic`, reads `?from=` for contextual
      // mode AND the session cookie to prefill; both are stripped by the
      // cacheable default today. AllViewer restores both.
      ["/about/feedback", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // Co-pub exports -- `force-dynamic`, `Cache-Control: no-store`, read
      // `?format=csv|docx`. Mirror the `/api/export/*` belt-and-suspenders
      // CachingDisabled behavior. These two MUST precede the cacheable
      // `/scholars/*` behavior below: CloudFront is first-match-wins in list
      // order, and `/scholars/*` (a `*` glob spanning slashes) would otherwise
      // swallow `/scholars/<slug>/co-pubs/export` and cache the download.
      ["/scholars/*/co-pubs/export", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      ["/scholars/*/co-pubs/*/export", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // GrantRecs Phase 2 — forward matcher ("Grants for me"). Reads
      // `sort`/`weights`/`limit`; the cacheable default's query allow-list omits
      // them, so unlisted the params would be stripped before the origin. AllViewer
      // forwards the full query string. GET-only (a read); per-cwid + no cookies,
      // so the personalization works on this uncached path. Same shape as
      // `/api/scholars/*/popover-context`.
      ["/api/scholars/*/opportunities", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // GrantRecs Phase 2 — reverse matcher ("Find researchers"). `force-dynamic`,
      // superuser-gated; reads `sort`/`stageLens`/`limit`. CachingDisabled +
      // AllViewer forwards the query string and never caches an admin response.
      ["/api/opportunities/*/researchers", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // GrantRecs slice 3 — opportunity browse list. `force-dynamic`, admin-gated;
      // reads `q`/`includeGrantsGov`/`limit`. The `/api/opportunities/*/researchers`
      // glob does NOT cover the bare collection path (no trailing slash), so this
      // exact behavior is required or the query params are stripped at the edge.
      // `/api/opportunities/<id>` (the public, cacheable detail GET) reads no query
      // string, so it correctly stays on the cacheable default — unaffected.
      ["/api/opportunities", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
    ];

    // ------------------------------------------------------------------
    // #634 Group B -- query-keyed cache policy for CACHEABLE pages.
    //
    // The profile, department, center, division, and topic-scholars pages
    // are ISR (`revalidate`) and the highest-traffic content on the site;
    // making them CachingDisabled (Group A) would kill their edge caching.
    // But they read `searchParams` (selector/tab/page/sort/role), so the
    // cacheable default's Managed-CachingOptimized policy (QueryString=none)
    // strips those params and serves one query-less response for every URL
    // -- the #490/#624 strip, just degrading a sub-feature instead of the
    // whole page.
    //
    // The fix is a custom cache policy that keeps the page cacheable but
    // puts the query string in the cache key (so `?page=2` and `?page=3`
    // cache separately) and forwards it to the origin. Cache-key params are
    // always forwarded to the origin, so NO origin request policy is needed
    // -- and crucially MUST NOT be added: AllViewer would forward cookies,
    // fragmenting the cache per session and leaking one user's cached HTML
    // to another (the single most important knob in cloudfront-cache-spec.md).
    // Cookies stay stripped, exactly as on the default behavior.
    //
    // ALLOW-LIST, not ALL: only the params these pages actually read enter
    // the cache key (the union across all Group B routes). Tracking params
    // (utm_*, fbclid, gclid) are dropped, so inbound campaign links don't
    // fragment the profile-page cache. The trade-off: a NEW param added to
    // one of these pages must also be added here, or it is silently stripped
    // (a narrow re-run of the #490 class the synth guard does not catch --
    // it only checks that *some* behavior forwards the query string).
    // ------------------------------------------------------------------
    const queryKeyedCache = new cloudfront.CachePolicy(this, "QueryKeyedCache", {
      cachePolicyName: `sps-query-keyed-${env}`,
      comment: `SPS query-keyed cache (${env}) -- per-query cache key, cookies stripped (#634).`,
      // Union of params read by the Group B pages: /scholars/* (mentees-sort),
      // /departments/* + /centers/* + divisions (page/tab/sort),
      // /topics/*/scholars (q/role/page).
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList(
        "mentees-sort",
        "page",
        "tab",
        "sort",
        "q",
        "role",
      ),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      // Key on the RSC headers too (same rationale as `defaultRscCache`) so
      // App Router soft navigation TO a Group B page (e.g. /scholars/*)
      // returns the Flight payload, not a cached HTML document.
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        ...rscCacheKeyHeaders,
      ),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      // Mirror Managed-CachingOptimized so caching behaviour is identical to
      // the default except the query string + RSC headers now key the cache.
      minTtl: Duration.seconds(1),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
    });

    // Group B path patterns (all GET-only cacheable pages). `/departments/*`
    // (trailing-`*` prefix glob) also covers `/departments/*/divisions/*`.
    const queryCacheablePatterns: ReadonlyArray<string> = [
      "/scholars/*",
      "/departments/*",
      "/centers/*",
      "/topics/*/scholars",
      // Cross-scholar method "all scholars in family" page (#824) -- reads
      // `q`/`role`/`page`, all already in the allowList union above.
      "/methods/*/*/scholars",
    ];

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

    // Immutable, content-hashed Next.js build assets (`/_next/static/*`).
    // Added FIRST so it is unambiguously evaluated before any other pattern
    // (none of which match `/_next/static/*`, but first-match-wins makes the
    // intent explicit). These files carry `Cache-Control: public,
    // max-age=31536000, immutable` from the origin and their filenames change
    // when content changes, so they are safe to cache a year at the edge -- and
    // MUST cache independently of HTML: the default behavior is now clamped to a
    // 60s `maxTtl`, so without this dedicated behavior every chunk would inherit
    // that 60s ceiling and stampede the origin. `CachingOptimized` keys on URL +
    // Accept-Encoding (no cookies, no RSC headers -- assets have no soft-nav
    // variant) and respects the origin's immutable TTL. Served from the
    // S3-primary / ALB-fallback origin group (`staticOriginGroup`) so old
    // content-hashed chunks survive a deploy and never 404 (#700); the ALB
    // fallback preserves today's behavior whenever S3 lacks the object.
    additionalBehaviors["/_next/static/*"] = {
      origin: staticOriginGroup,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      responseHeadersPolicy: securityHeaders,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
    };

    // `/edge-ip` -- the IP echo the off-network block page fetches. A
    // viewer-request CloudFront Function answers it entirely at the POP:
    // `event.viewer.ip` is the TCP peer address, which is the SAME address the
    // WAF IPSet matches on, so what the visitor is shown is exactly what an
    // operator would need to allowlist. The function returns a synthetic
    // response, so CloudFront never consults the cache or the origin -- the
    // `origin` below is only here because `BehaviorOptions` requires one.
    //
    // ponytail: no CORS headers, no JSON envelope, no versioning. It is a
    // same-origin fetch of one line of text/plain by exactly one caller
    // (OFF_NETWORK_HTML). If a second caller ever appears, that is the moment
    // to give it a real contract, not now.
    const ipEchoFn = new cloudfront.Function(this, "EdgeIpEcho", {
      functionName: `sps-edge-ip-${env}`,
      comment: `SPS off-network page IP echo (${env}) -- returns event.viewer.ip as text/plain.`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  return {
    statusCode: 200,
    statusDescription: "OK",
    headers: {
      "content-type": { value: "text/plain; charset=utf-8" },
      "cache-control": { value: "no-store" },
    },
    body: event.viewer.ip,
  };
}`),
    });
    additionalBehaviors[EDGE_IP_PATH] = {
      origin,
      cachePolicy: cachingDisabled,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      responseHeadersPolicy: securityHeaders,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
      functionAssociations: [
        {
          function: ipEchoFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };

    // Uncacheable (existing + #634 Group A) FIRST so the scholars-export
    // behaviors precede the cacheable `/scholars/*` glob (first-match-wins).
    for (const [pathPattern, allowedMethods] of uncacheableBehaviors) {
      additionalBehaviors[pathPattern] = {
        origin,
        cachePolicy: cachePolicyOverrides.get(pathPattern) ?? cachingDisabled,
        originRequestPolicy: orpOverrides.get(pathPattern) ?? allViewer,
        allowedMethods,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      };
    }
    // Query-keyed cacheable pages (#634 Group B): custom cache policy, NO
    // origin request policy (cookies stay stripped).
    for (const pathPattern of queryCacheablePatterns) {
      additionalBehaviors[pathPattern] = {
        origin,
        cachePolicy: queryKeyedCache,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      };
    }

    // ------------------------------------------------------------------
    // TEMPORARY front-end IP allowlist (#461).
    //
    // While we test, the front end is restricted to the WCM network ranges;
    // it is lifted (opened to the public) once verified. Enforced here at the
    // CloudFront layer via an AWS WAFv2 WebACL -- the ALB SG can't do it
    // because CloudFront is the only client the ALB ever sees.
    //
    // Source: the seeded SSM StringList by default, or `-c edgeAllowedCidrs=
    // 140.251.0.0/16,157.139.0.0/16` to override (see the block below). The
    // WebACL is always built now (#1506) -- to open to the public, delete the
    // block, not the flag. WAFv2 WebACLs with CLOUDFRONT scope must live in
    // us-east-1, which is EdgeStack's region.
    //
    // Layering (priority order): the WebACL defaults to ALLOW; a priority-0
    // `block-non-wcm` rule drops anything outside the WCM IP set (so only WCM
    // traffic reaches the rest), then AWS managed rule groups + a rate-based
    // rule inspect that traffic in COUNT mode (observe-only until the metrics
    // prove no false positives). That is the application-layer inspection the
    // IP allowlist alone never did -- the reason we do not need to sit behind
    // the enterprise NetScaler for edge security.
    //
    // ponytail: managed rules live inside this allowlist gate because we only
    // ever run WCM-only. If the front end is opened to the public, move them
    // OUT of the block so payload inspection survives without the allowlist.
    // ------------------------------------------------------------------
    // The internal WCM/WCM-Qatar/NYP ranges are NOT committed to this public
    // repo (#876/#502/#1506). Default source is the operator-seeded SSM
    // StringList `/sps/<env>/edge/allowed-cidrs` (a deploy-time token -- fine
    // for a WAF IPSet); a `-c edgeAllowedCidrs=1.2.0.0/16,...` flag overrides
    // (the escape hatch before the param is seeded). The WebACL is now ALWAYS
    // built, so a bare deploy no longer strips it. To open the front end to the
    // public, delete this block (per the #461 note above) -- omitting the flag
    // no longer removes it.
    const allowedCidrsCtx = this.node.tryGetContext("edgeAllowedCidrs") as
      | string
      | undefined;
    const overrideCidrs = allowedCidrsCtx
      ? allowedCidrsCtx
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : undefined;
    const allowedCidrs =
      overrideCidrs && overrideCidrs.length > 0
        ? overrideCidrs
        : ssm.StringListParameter.valueForTypedListParameter(
            this,
            `/sps/${env}/edge/allowed-cidrs`,
          );
    let webAclArn: string;
    {
      const ipAllowSet = new wafv2.CfnIPSet(this, "WcmIpAllowSet", {
        name: `sps-edge-${env}-wcm-allow`,
        scope: "CLOUDFRONT",
        ipAddressVersion: "IPV4",
        addresses: allowedCidrs,
        // WAFv2 descriptions reject `()` and `;` (allowed: \w + = : # @ / - , .
        // and space) -- a deploy-only constraint cdk synth does not catch.
        description: `Temporary #461 SPS front-end allowlist ${env} - remove after testing`,
      });
      // AWS managed rule groups -- application-layer inspection (SQLi/XSS/
      // known-bad-inputs) the IP allowlist never did. ENFORCED since #1434:
      // the 06-27..07-04 count-mode window showed zero matches for
      // KnownBadInputs/SQLi/rate-limit; the only CommonRuleSet sub-rule firing
      // was SizeRestrictions_BODY, and only on legitimate large /edit saves
      // (overview/biosketch POSTs > 8 KB), so that one sub-rule stays in count
      // while its group enforces.
      const managedGroups = [
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesKnownBadInputsRuleSet",
        "AWSManagedRulesSQLiRuleSet",
      ];
      const webAcl = new wafv2.CfnWebACL(this, "EdgeWebAcl", {
        name: `sps-edge-${env}-wcm-only`,
        scope: "CLOUDFRONT",
        // Default ALLOW: only WCM traffic ever reaches the default action --
        // the priority-0 block-non-wcm rule drops everything else. (Was
        // default-BLOCK + a terminating allow-wcm rule, which short-circuited
        // evaluation so no later rule could inspect WCM requests.)
        defaultAction: { allow: {} },
        // Referenced by `block-non-wcm` below. TEXT_HTML is one of WAF's three
        // permitted content types and it derives the Content-Type header from
        // it -- a custom response header named `content-type` is rejected.
        customResponseBodies: {
          offNetwork: {
            contentType: "TEXT_HTML",
            content: OFF_NETWORK_HTML,
          },
          rateLimited: {
            contentType: "TEXT_HTML",
            content: RATE_LIMITED_HTML,
          },
        },
        rules: [
          {
            name: "block-non-wcm",
            priority: 0,
            // Branded "coming soon" page instead of AWS's stock 403 body. The
            // body is static (WAF interpolates nothing) -- the visitor's IP is
            // filled in client-side from EDGE_IP_PATH, carved out below.
            action: {
              block: {
                customResponse: {
                  responseCode: 403,
                  customResponseBodyKey: "offNetwork",
                },
              },
            },
            statement: {
              andStatement: {
                statements: [
                  {
                    notStatement: {
                      statement: {
                        ipSetReferenceStatement: { arn: ipAllowSet.attrArn },
                      },
                    },
                  },
                  // The block page's IP echo must survive the block that
                  // renders it. WAF evaluates BEFORE CloudFront matches a
                  // cache behavior, so the viewer-request function never runs
                  // on a blocked request -- a carve-out here is the only way
                  // an off-network client can reach `/edge-ip`. Exempting the
                  // path (rather than adding a priority -1 allow rule, which
                  // WAF has no room for: 0 is the minimum priority) also keeps
                  // `/edge-ip` subject to the managed rule groups and the
                  // rate limit that follow. Telling a caller its own IP
                  // discloses nothing it could not already learn elsewhere.
                  //
                  // NONE, not LOWERCASE: the exemption must be exactly as wide
                  // as the thing it protects, and CloudFront path patterns are
                  // CASE-SENSITIVE, so only the literal `/edge-ip` selects the
                  // echo behavior. Under LOWERCASE all 128 case variants
                  // (`/EDGE-IP`, `/Edge-Ip`, ...) satisfied the byteMatch, so
                  // the AndStatement went false and the WebACL's default ALLOW
                  // let them through -- but CloudFront matched no additional
                  // behavior for them either, so they fell to the DEFAULT
                  // behavior and hit the ALB origin. That is a hole, not a
                  // convenience: `/EDGE-IP` could never have reached the echo
                  // function, so blocking it is the correct outcome.
                  {
                    notStatement: {
                      statement: {
                        byteMatchStatement: {
                          fieldToMatch: { uriPath: {} },
                          positionalConstraint: "EXACTLY",
                          searchString: EDGE_IP_PATH,
                          textTransformations: [{ priority: 0, type: "NONE" }],
                        },
                      },
                    },
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `sps-edge-${env}-block-non-wcm`,
              sampledRequestsEnabled: true,
            },
          },
          ...managedGroups.map((groupName, i) => ({
            name: groupName,
            priority: i + 1,
            // Enforced (#1434, after the count-mode soak). SizeRestrictions_BODY
            // alone stays in count: it fires on legitimate >8 KB /edit saves.
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: groupName,
                ...(groupName === "AWSManagedRulesCommonRuleSet"
                  ? {
                      ruleActionOverrides: [
                        {
                          name: "SizeRestrictions_BODY",
                          actionToUse: { count: {} },
                        },
                      ],
                    }
                  : {}),
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `sps-edge-${env}-${groupName}`,
              sampledRequestsEnabled: true,
            },
          })),
          // #125 -- Bot Control runs label-only (count override): its
          // `awswaf:managed:aws:bot-control:bot:verified` label exempts
          // verified crawlers/AI fetchers (Googlebot, Bingbot, GPTBot, ...)
          // from the rate limit below. Labels are visible only to LATER rules,
          // so this must precede rate-limit. Pre-launch the #461 block above
          // still drops all non-WCM traffic incl. bots; at launch that block
          // is deleted (#432) and this exemption becomes load-bearing for
          // SEO + AI-answer visibility (#594 measured both pinned at zero).
          // Cost: Bot Control bills per WebACL/month + per request inspected.
          {
            name: "AWSManagedRulesBotControlRuleSet",
            priority: managedGroups.length + 1,
            overrideAction: { count: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: "AWSManagedRulesBotControlRuleSet",
                managedRuleGroupConfigs: [
                  {
                    awsManagedRulesBotControlRuleSet: {
                      inspectionLevel: "COMMON",
                    },
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `sps-edge-${env}-AWSManagedRulesBotControlRuleSet`,
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "rate-limit",
            priority: managedGroups.length + 2,
            // Enforced (#1434): zero rate matches in the count window -- the
            // WCM shared-NAT pooling worry did not materialize at pre-launch
            // volume. Re-check the per-IP aggregation once launch traffic
            // ramps (#1455 also rides this).
            //
            // 429, not 403: anyone who reaches this rule is inside the IP
            // allowlist, so the request is not forbidden -- it is throttled,
            // and 429 is the only code that tells a client (or a crawler) to
            // back off and retry rather than to stop asking. WAF permits 429.
            // It is deliberately NOT in the distribution's `errorResponses`
            // list, so CloudFront applies no TTL of its own to it.
            action: {
              block: {
                customResponse: {
                  responseCode: 429,
                  customResponseBodyKey: "rateLimited",
                },
              },
            },
            statement: {
              rateBasedStatement: {
                limit: 5000,
                aggregateKeyType: "IP",
                // #125: verified bots burst legitimately; a per-IP cap that
                // blocks them zeroes SEO/AI visibility. Everything except
                // Bot-Control-verified bots stays subject to the limit.
                scopeDownStatement: {
                  notStatement: {
                    statement: {
                      labelMatchStatement: {
                        scope: "LABEL",
                        key: "awswaf:managed:aws:bot-control:bot:verified",
                      },
                    },
                  },
                },
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `sps-edge-${env}-rate-limit`,
              sampledRequestsEnabled: true,
            },
          },
        ],
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `sps-edge-${env}-wcm-only`,
          sampledRequestsEnabled: true,
        },
        description: `SPS front end ${env} - WCM-only IP allow, AWS managed rule groups enforced, bot-aware rate limit`,
      });
      webAclArn = webAcl.attrArn;
    }

    // ------------------------------------------------------------------
    // Distribution.
    //
    // - priceClass PRICE_CLASS_100 (NA + EU): SPS audience is US-centric;
    //   limiting edge POPs keeps the cost predictable without measurable
    //   latency impact.
    // - enableLogging + logFilePrefix wire standard access logs to the
    //   stack-owned bucket.
    // - The default behavior carries NO origin request policy, by design:
    //   ALL_VIEWER must never be attached here, because it would forward
    //   cookies onto the CACHEABLE path and leak one viewer's HTML to
    //   another.
    // - #1930/#1931 briefly attached `viewerHostOrp` here so `middleware.ts`
    //   could build absolute redirect Locations from the forwarded viewer
    //   `Host` (needed for the legacy VIVO paths -- `/display`, `/individual`,
    //   `/profile` -- which match no behavior below and so are served HERE).
    //   That header was forwarded but not cache-keyed, which made the
    //   default behavior Host-poisonable (reproduced in prod 2026-07-25).
    //   #1935 closed this at the source: `middleware.ts` now builds those
    //   Locations from the configured `SITE_URL`, not from `Host`, so
    //   nothing on this behavior needs the header any more. `viewerHostOrp`
    //   was removed (#1944) once #1935 was confirmed running in both envs.
    // ------------------------------------------------------------------
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `SPS edge -- ${env}`,
      domainNames: customDomain ? [customDomain] : undefined,
      certificate: viewerCert,
      // WCM-only allowlist (#461/#1506); always attached now (see WAF block).
      webAclId: webAclArn,
      defaultBehavior: {
        origin,
        cachePolicy: defaultRscCache,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // HTML-specific headers: HSTS + a `max-age=0, must-revalidate`
        // Cache-Control override so browsers revalidate HTML and never serve a
        // year-stale document referencing rotated-out chunks. Edge TTL is
        // governed by `defaultRscCache` (60s), not by this header.
        responseHeadersPolicy: htmlHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors,
      // ------------------------------------------------------------------
      // #668 §4 -- error-response caching.
      //   404: cache 60s so dead-URL crawler floods (the legacy-VIVO cutover)
      //   are absorbed at the edge rather than hitting the force-dynamic
      //   origin every time. No responseHttpStatus / responsePagePath, so the
      //   origin's branded 404 body AND its 404 status pass through unchanged
      //   -- a cached 404 stays a real 404 (never a soft-404). 60s is safe:
      //   profiles are 24h-cached, so the edge is never the freshness
      //   bottleneck for a URL that later becomes valid.
      //   5xx: ttl 0 (ErrorCachingMinTTL 0) -- NEVER cache, so a transient
      //   Aurora/OpenSearch blip can't get pinned at the edge and turn a
      //   10-second hiccup into a multi-minute outage for cached paths.
      // The 5xx-never-cache invariant is ratcheted by edge-stack.test.ts.
      // ------------------------------------------------------------------
      errorResponses: [
        { httpStatus: 404, ttl: Duration.seconds(60) },
        { httpStatus: 500, ttl: Duration.seconds(0) },
        { httpStatus: 502, ttl: Duration.seconds(0) },
        { httpStatus: 503, ttl: Duration.seconds(0) },
        { httpStatus: 504, ttl: Duration.seconds(0) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: this.logsBucket,
      logFilePrefix: `cf/${env}/`,
      // Publish CloudFront additional metrics so the reliability dashboard
      // (ObservabilityStack) can graph OriginLatency. This synthesizes an
      // AWS::CloudFront::MonitoringSubscription; the additional metrics are a
      // paid CloudFront feature (~$0.30 per distribution per metric per month).
      // Without it OriginLatency / cache-hit-rate are never emitted and the
      // dashboard panel would render empty. The standard metrics the rest of
      // the CF dashboard row uses (error rate, requests, bytes) are free and
      // unaffected by this flag.
      publishAdditionalMetrics: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Serve A records only (no AAAA). The #461 WAF allowlist is IPv4-only, so
      // dual-stack admits no authorized client, yet any viewer on a broken-IPv6
      // path (an address configured but black-holed -- common on enterprise
      // nets) has its browser prefer IPv6 (RFC 6724), stall on the dead path,
      // and never fall back -- the homepage and /api/search "spin" indefinitely.
      // Confirmed 2026-05-31 from a WCM client: IPv4 edge 200 in <0.4s, every
      // AAAA hung. Re-enable only once WCM IPv6 egress is verified end-to-end.
      enableIpv6: false,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ------------------------------------------------------------------
    // Outputs.
    // ------------------------------------------------------------------
    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description: "SPS CloudFront distribution domain (*.cloudfront.net)",
    });
    new CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
      description: "SPS CloudFront distribution id",
    });
    new CfnOutput(this, "LogsBucketName", {
      value: this.logsBucket.bucketName,
      description: "SPS CloudFront access logs bucket",
    });
    // Consumed by the deploy workflow's "Sync static assets to S3" step
    // (#700). The step self-skips if this output is absent (Edge not yet
    // redeployed with Layer 2), matching the resilient discovery pattern used
    // for the ETL repo / db-bootstrap task family.
    new CfnOutput(this, "StaticAssetsBucketName", {
      value: staticBucket.bucketName,
      description: "SPS static-asset bucket (/_next/static/*) for additive deploy sync",
    });
  }
}
