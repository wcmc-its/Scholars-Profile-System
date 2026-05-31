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
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link EdgeStack}. */
export interface EdgeStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** The public ALB from AppStack — the only origin this distribution fronts. */
  readonly publicAlb: elbv2.IApplicationLoadBalancer;
}

/**
 * EdgeStack — CloudFront distribution fronting the SPS public ALB (B07 + B14).
 *
 * Implements the eight behaviors in `docs/cloudfront-cache-spec.md`:
 * one cacheable default behavior (`Managed-CachingOptimized`) plus seven
 * uncacheable behaviors (`Managed-CachingDisabled` + `Managed-AllViewer`)
 * for writer routes, SSO endpoints, mutating internal endpoints, the health
 * probe, telemetry, and on-demand exports. The cache key on the default
 * behavior excludes cookies and all headers beyond `Accept-Encoding` — the
 * single most important knob in the spec, since forwarding cookies on
 * cacheable routes would fragment the cache per session.
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

    const { envConfig, publicAlb } = props;
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
    const origin = new origins.LoadBalancerV2Origin(publicAlb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      customHeaders: {
        "X-Origin-Verify": originVerifyToken,
      },
    });

    // ------------------------------------------------------------------
    // Custom domain + ACM certificate (plan D2, bootstrap two-step).
    //
    // Both context flags must be present for the alias + cert to attach;
    // otherwise the distribution ships on `*.cloudfront.net`. ACM certs
    // for CloudFront must live in us-east-1, which is also the primary
    // region -- no `crossRegionReferences` needed.
    // ------------------------------------------------------------------
    const customDomain = this.node.tryGetContext("edgeCustomDomain") as
      | string
      | undefined;
    const certArn = this.node.tryGetContext("edgeCertArn") as
      | string
      | undefined;
    const viewerCert =
      customDomain && certArn
        ? acm.Certificate.fromCertificateArn(this, "ViewerCert", certArn)
        : undefined;

    // ------------------------------------------------------------------
    // Cache + origin request policies (plan D5).
    //
    // Default behavior uses `Managed-CachingOptimized` (includes
    // Accept-Encoding in the cache key, does not include Cookie). The
    // spec's `Accept` / `Accept-Language` allowlist is documented but
    // unused by any route -- no Vary on content negotiation, no i18n --
    // so the managed policy is correct. Switching to a custom policy is
    // a follow-on if a route is added that varies on those headers.
    //
    // Uncacheable behaviors use `Managed-CachingDisabled` plus
    // `Managed-AllViewer` so writer / SSO / mutating routes get the
    // full request (cookies, query strings, headers) at the origin.
    // ------------------------------------------------------------------
    const cachingOptimized = cloudfront.CachePolicy.CACHING_OPTIMIZED;
    const cachingDisabled = cloudfront.CachePolicy.CACHING_DISABLED;
    const allViewer = cloudfront.OriginRequestPolicy.ALL_VIEWER;

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
      ["/api/export/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      // `/api/search*` (covers `/api/search` AND `/api/search/suggest`): the
      // search API is a query-string-dependent dynamic GET (`export const
      // dynamic = "force-dynamic"`). Without an explicit behavior it falls to
      // the cacheable default, whose Managed-CachingOptimized policy excludes
      // the query string from the cache key -- so CloudFront BOTH strips `?q=`
      // before the origin sees it (every request degrades to a match_all over
      // the whole corpus) AND caches the first response for every subsequent
      // query. CachingDisabled + AllViewer forwards the full query string and
      // never caches, matching the other dynamic GET routes above.
      ["/api/search*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
    ];

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const [pathPattern, allowedMethods] of uncacheableBehaviors) {
      additionalBehaviors[pathPattern] = {
        origin,
        cachePolicy: cachingDisabled,
        originRequestPolicy: allViewer,
        allowedMethods,
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
    // Toggle: `-c edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16` builds the
    // WebACL (IP-set ALLOW, default BLOCK) and attaches it. Omit the flag and
    // redeploy to remove the restriction -- no code change. WAFv2 WebACLs with
    // CLOUDFRONT scope must live in us-east-1, which is EdgeStack's region.
    // ------------------------------------------------------------------
    const allowedCidrsCtx = this.node.tryGetContext("edgeAllowedCidrs") as
      | string
      | undefined;
    const allowedCidrs = allowedCidrsCtx
      ? allowedCidrsCtx
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : [];
    let webAclArn: string | undefined;
    if (allowedCidrs.length > 0) {
      const ipAllowSet = new wafv2.CfnIPSet(this, "WcmIpAllowSet", {
        name: `sps-edge-${env}-wcm-allow`,
        scope: "CLOUDFRONT",
        ipAddressVersion: "IPV4",
        addresses: allowedCidrs,
        // WAFv2 descriptions reject `()` and `;` (allowed: \w + = : # @ / - , .
        // and space) -- a deploy-only constraint cdk synth does not catch.
        description: `Temporary #461 SPS front-end allowlist ${env} - remove after testing`,
      });
      const webAcl = new wafv2.CfnWebACL(this, "EdgeWebAcl", {
        name: `sps-edge-${env}-wcm-only`,
        scope: "CLOUDFRONT",
        defaultAction: { block: {} },
        rules: [
          {
            name: "allow-wcm-networks",
            priority: 0,
            action: { allow: {} },
            statement: {
              ipSetReferenceStatement: { arn: ipAllowSet.attrArn },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `sps-edge-${env}-allow-wcm`,
              sampledRequestsEnabled: true,
            },
          },
        ],
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `sps-edge-${env}-wcm-only`,
          sampledRequestsEnabled: true,
        },
        description: `Temporary #461 SPS front end restricted to WCM networks ${env}`,
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
    // - The default behavior has NO origin request policy, by design:
    //   without it CloudFront forwards only the cache-key headers
    //   (Accept-Encoding) and never the Cookie header. Adding ALL_VIEWER
    //   here would leak cookies onto the cacheable path.
    // ------------------------------------------------------------------
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `SPS edge -- ${env}`,
      domainNames: customDomain ? [customDomain] : undefined,
      certificate: viewerCert,
      // Temporary WCM-only allowlist (#461); undefined => unrestricted.
      webAclId: webAclArn,
      defaultBehavior: {
        origin,
        cachePolicy: cachingOptimized,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors,
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
  }
}
