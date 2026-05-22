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
    // precede general. Spec § Behaviors #1..#7 map to this list in
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
      ["/edit/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      ["/api/auth/*", cloudfront.AllowedMethods.ALLOW_ALL],
      ["/api/revalidate*", cloudfront.AllowedMethods.ALLOW_ALL],
      ["/api/health/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
      ["/api/analytics", cloudfront.AllowedMethods.ALLOW_ALL],
      ["/api/export/*", cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS],
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
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
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
