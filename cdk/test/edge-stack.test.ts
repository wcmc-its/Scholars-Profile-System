import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { EdgeStack } from "../lib/edge-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

interface BuildResult {
  template: Template;
  stack: EdgeStack;
}

function buildEdgeStack(
  envName: "staging" | "prod",
  options?: { customDomain?: string; certArn?: string; allowedCidrs?: string },
): BuildResult {
  const fixture = makeFixture(envName);
  if (options?.customDomain) {
    fixture.app.node.setContext("edgeCustomDomain", options.customDomain);
  }
  if (options?.certArn) {
    fixture.app.node.setContext("edgeCertArn", options.certArn);
  }
  if (options?.allowedCidrs) {
    fixture.app.node.setContext("edgeAllowedCidrs", options.allowedCidrs);
  }
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const app = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    albSecurityGroup: network.albSecurityGroup,
  });
  const stack = new EdgeStack(fixture.app, `Sps-Edge-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    publicAlb: app.publicAlb,
  });
  return { template: Template.fromStack(stack), stack };
}

// Same allow-set used across the AppStack / DataStack synth-time guards
// (Footgun #5 / #6, PRs #401/#402). Re-applied here so CloudFront / S3 /
// ResponseHeadersPolicy descriptions can't smuggle a banned character past
// `cdk synth`.
const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

describe("EdgeStack", () => {
  describe("prod", () => {
    const { template } = buildEdgeStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    describe("Resource counts (the plan's § Acceptance criteria)", () => {
      it("creates exactly one CloudFront distribution and one response-headers policy", () => {
        template.resourceCountIs("AWS::CloudFront::Distribution", 1);
        template.resourceCountIs(
          "AWS::CloudFront::ResponseHeadersPolicy",
          1,
        );
      });

      it("creates exactly one S3 bucket (the access-logs target)", () => {
        template.resourceCountIs("AWS::S3::Bucket", 1);
      });
    });

    describe("Distribution behaviors (acceptance #2..#8)", () => {
      const distributions = (): Array<Record<string, unknown>> =>
        Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        ).map((r) => r.Properties as Record<string, unknown>);

      it("has one default behavior plus seven additional cache behaviors (acceptance #2)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        expect(defaultBehavior).toBeDefined();
        expect(cacheBehaviors).toHaveLength(7);
      });

      it("evaluates additional behaviors in the spec-defined order (#1..#7)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        const paths = cacheBehaviors.map((b) => b.PathPattern as string);
        expect(paths).toEqual([
          "/api/edit*",
          "/edit/*",
          "/api/auth/*",
          "/api/revalidate*",
          "/api/health/*",
          "/api/analytics",
          "/api/export/*",
        ]);
      });

      it("default behavior uses Managed-CachingOptimized (acceptance #3)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        // Managed-CachingOptimized id.
        expect(defaultBehavior.CachePolicyId).toBe(
          "658327ea-f89d-4fab-a63d-7e88639e58f6",
        );
      });

      it("all additional behaviors use Managed-CachingDisabled (acceptance #3)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        for (const behavior of cacheBehaviors) {
          // Managed-CachingDisabled id.
          expect(behavior.CachePolicyId).toBe(
            "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          );
        }
      });

      it("all uncacheable behaviors use Managed-AllViewer origin request policy (acceptance #4)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        for (const behavior of cacheBehaviors) {
          // Managed-AllViewer id.
          expect(behavior.OriginRequestPolicyId).toBe(
            "216adef6-5c7f-47e4-b989-5492eafa07d3",
          );
        }
      });

      it("default behavior has NO origin request policy (acceptance #5 -- prevents cookie leak)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        expect(defaultBehavior.OriginRequestPolicyId).toBeUndefined();
      });

      it("origin is HTTP-only on port 80 (acceptance #6)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const ods = dc.Origins as Array<Record<string, unknown>>;
        expect(ods).toHaveLength(1);
        const origin = ods[0];
        const config = origin?.CustomOriginConfig as Record<string, unknown>;
        expect(config.OriginProtocolPolicy).toBe("http-only");
        expect(config.HTTPPort).toBe(80);
      });

      it("origin sends an X-Origin-Verify custom header (acceptance #7)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const ods = dc.Origins as Array<Record<string, unknown>>;
        const origin = ods[0];
        const customHeaders =
          (origin?.OriginCustomHeaders as Array<{ HeaderName?: string; HeaderValue?: unknown }>) ??
          [];
        const verify = customHeaders.find((h) => h.HeaderName === "X-Origin-Verify");
        expect(verify).toBeDefined();
        // The header value is a CFN dynamic reference; CDK emits the
        // FRIENDLY-NAME form (`{{resolve:secretsmanager:<name>:SecretString:::}}`)
        // via SecretValue.secretsManager(name). The secret value itself never
        // appears in the template.
        const serialized = JSON.stringify(verify?.HeaderValue);
        expect(serialized).toMatch(/\{\{resolve:secretsmanager:/);
        expect(serialized).toContain(
          "scholars/prod/edge/origin-shared-secret",
        );
        // Guard the #431-blocker-#5 footgun that broke the first Edge deploy:
        // Secret.fromSecretNameV2(...).secretValue emits a PARTIAL-ARN
        // reference Secrets Manager rejects at deploy (ResourceNotFound). The
        // friendly-name form must contain NO ARN.
        expect(serialized).not.toContain("arn:aws:secretsmanager");
      });

      it("default + every additional behavior redirects HTTP to HTTPS (acceptance #8)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        expect(defaultBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        for (const behavior of cacheBehaviors) {
          expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
        }
      });

      it("default behavior allows GET/HEAD/OPTIONS; writer/auth/etc behaviors allow ALL methods", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        const defaultMethods = (defaultBehavior.AllowedMethods as string[]).sort();
        expect(defaultMethods).toEqual(["GET", "HEAD", "OPTIONS"]);
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        // Per the spec table: /api/edit*, /api/auth/*, /api/revalidate*,
        // /api/analytics need POST; CloudFront's enum collapses to ALLOW_ALL
        // for any of those. The GET-only routes (/edit/*, /api/health/*,
        // /api/export/*) stay on GET/HEAD/OPTIONS.
        const byPath = new Map<string, string[]>();
        for (const b of cacheBehaviors) {
          byPath.set(
            b.PathPattern as string,
            (b.AllowedMethods as string[]).slice().sort(),
          );
        }
        const allMethods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
        const ghOptions = ["GET", "HEAD", "OPTIONS"];
        expect(byPath.get("/api/edit*")).toEqual(allMethods);
        expect(byPath.get("/edit/*")).toEqual(ghOptions);
        expect(byPath.get("/api/auth/*")).toEqual(allMethods);
        expect(byPath.get("/api/revalidate*")).toEqual(allMethods);
        expect(byPath.get("/api/health/*")).toEqual(ghOptions);
        expect(byPath.get("/api/analytics")).toEqual(allMethods);
        expect(byPath.get("/api/export/*")).toEqual(ghOptions);
      });
    });

    describe("Response headers + logging", () => {
      it("response-headers policy has a non-empty HSTS section (D6 -- B21 layers more on top)", () => {
        template.hasResourceProperties(
          "AWS::CloudFront::ResponseHeadersPolicy",
          {
            ResponseHeadersPolicyConfig: Match.objectLike({
              Name: "sps-security-headers-prod",
              SecurityHeadersConfig: Match.objectLike({
                StrictTransportSecurity: Match.objectLike({
                  AccessControlMaxAgeSec: Match.anyValue(),
                  IncludeSubdomains: true,
                  Override: true,
                }),
              }),
            }),
          },
        );
      });

      it("standard logging is enabled and points at the stack-owned bucket with cf/${env}/ prefix", () => {
        template.hasResourceProperties("AWS::CloudFront::Distribution", {
          DistributionConfig: Match.objectLike({
            Logging: Match.objectLike({
              Bucket: Match.anyValue(),
              Prefix: "cf/prod/",
            }),
          }),
        });
      });

      it("S3 logs bucket enforces BlockPublicAccess and BucketOwnerPreferred for CloudFront log delivery", () => {
        template.hasResourceProperties("AWS::S3::Bucket", {
          PublicAccessBlockConfiguration: Match.objectLike({
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          }),
          OwnershipControls: Match.objectLike({
            Rules: Match.arrayWith([
              Match.objectLike({ ObjectOwnership: "BucketOwnerPreferred" }),
            ]),
          }),
        });
      });
    });

    describe("Custom domain bootstrap two-step (acceptance #13)", () => {
      it("with neither context flag set, the distribution has no alias and no custom ACM cert (acceptance #13)", () => {
        const props = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0]?.Properties as Record<string, unknown> | undefined;
        const dc = props?.DistributionConfig as Record<string, unknown>;
        expect(dc.Aliases).toBeUndefined();
        // CDK omits ViewerCertificate entirely (CloudFront defaults to its
        // own cert) when no certificate is attached. Either undefined or an
        // object lacking AcmCertificateArn is acceptable; what must NOT
        // appear is a reference to a custom certificate.
        const cert = dc.ViewerCertificate as Record<string, unknown> | undefined;
        if (cert !== undefined) {
          expect(cert.AcmCertificateArn).toBeUndefined();
        }
      });
    });
  });

  describe("staging", () => {
    const { template } = buildEdgeStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("the X-Origin-Verify header value points at the staging secret name", () => {
      const props = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = props?.DistributionConfig as Record<string, unknown>;
      const ods = dc.Origins as Array<Record<string, unknown>>;
      const customHeaders =
        (ods[0]?.OriginCustomHeaders as Array<{ HeaderName?: string; HeaderValue?: unknown }>) ??
        [];
      const verify = customHeaders.find((h) => h.HeaderName === "X-Origin-Verify");
      const serialized = JSON.stringify(verify?.HeaderValue);
      expect(serialized).toContain(
        "scholars/staging/edge/origin-shared-secret",
      );
    });

    it("standard logging prefix is env-prefixed (cf/staging/)", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Logging: Match.objectLike({ Prefix: "cf/staging/" }),
        }),
      });
    });
  });

  describe("custom domain enabled (acceptance #14)", () => {
    const STUB_CERT =
      "arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { template } = buildEdgeStack("prod", {
      customDomain: "scholars.weill.cornell.edu",
      certArn: STUB_CERT,
    });

    it("attaches the alias when -c edgeCustomDomain and -c edgeCertArn are both set", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Aliases: Match.arrayWith(["scholars.weill.cornell.edu"]),
        }),
      });
    });

    it("attaches the ACM certificate (ViewerCertificate references the stub ARN)", () => {
      const props = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = props?.DistributionConfig as Record<string, unknown>;
      const cert = dc.ViewerCertificate as Record<string, unknown>;
      expect(cert.AcmCertificateArn).toBe(STUB_CERT);
      expect(cert.SslSupportMethod).toBe("sni-only");
    });
  });

  describe("temporary front-end IP allowlist (#461)", () => {
    it("with no -c edgeAllowedCidrs: no WebACL, distribution unrestricted", () => {
      const { template } = buildEdgeStack("staging");
      template.resourceCountIs("AWS::WAFv2::WebACL", 0);
      template.resourceCountIs("AWS::WAFv2::IPSet", 0);
      const dist = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = dist?.DistributionConfig as Record<string, unknown>;
      expect(dc.WebACLId).toBeUndefined();
    });

    describe("with -c edgeAllowedCidrs set", () => {
      const { template } = buildEdgeStack("staging", {
        allowedCidrs: "140.251.0.0/16,157.139.0.0/16",
      });

      it("creates an IPSet (CLOUDFRONT scope) holding exactly the WCM CIDRs", () => {
        template.resourceCountIs("AWS::WAFv2::IPSet", 1);
        const ipset = Object.values(
          template.findResources("AWS::WAFv2::IPSet"),
        )[0]?.Properties as Record<string, unknown>;
        expect(ipset.Scope).toBe("CLOUDFRONT");
        expect(ipset.Addresses).toEqual([
          "140.251.0.0/16",
          "157.139.0.0/16",
        ]);
      });

      it("creates a WebACL that defaults to BLOCK and ALLOWs the IP set", () => {
        template.resourceCountIs("AWS::WAFv2::WebACL", 1);
        const acl = Object.values(
          template.findResources("AWS::WAFv2::WebACL"),
        )[0]?.Properties as Record<string, unknown>;
        expect(acl.Scope).toBe("CLOUDFRONT");
        expect(acl.DefaultAction).toHaveProperty("Block");
        const rules = acl.Rules as Array<Record<string, unknown>>;
        expect(rules).toHaveLength(1);
        expect(rules[0].Action).toHaveProperty("Allow");
        expect(JSON.stringify(rules[0].Statement)).toContain(
          "IPSetReferenceStatement",
        );
      });

      it("attaches the WebACL to the distribution (WebACLId set)", () => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0]?.Properties as Record<string, unknown>;
        const dc = dist.DistributionConfig as Record<string, unknown>;
        expect(dc.WebACLId).toBeDefined();
      });

      // Synth-time guard for a deploy-only constraint: WAFv2 IPSet/WebACL
      // Description must match ^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$
      // -- no parens, no semicolons. cdk synth accepts anything; only the AWS
      // create validates it (it rolled back the first #461 deploy).
      it("every WAFv2 IPSet/WebACL Description satisfies the AWS charset", () => {
        const WAFV2_DESCRIPTION = /^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/;
        const violations: string[] = [];
        for (const type of ["AWS::WAFv2::IPSet", "AWS::WAFv2::WebACL"]) {
          for (const [id, r] of Object.entries(template.findResources(type))) {
            const desc = (r.Properties as Record<string, unknown>)
              .Description as string | undefined;
            if (typeof desc === "string" && !WAFV2_DESCRIPTION.test(desc)) {
              violations.push(`${id}: ${JSON.stringify(desc)}`);
            }
          }
        }
        expect(violations).toEqual([]);
      });
    });
  });

  describe("Footgun #3 -- env-prefix guard", () => {
    // Account 665083158573 hosts both staging and prod. Every named
    // CloudFront resource in this stack must carry the env literal so the
    // two stacks coexist. The S3 logs bucket name is CFN-generated (no
    // Name property) so it inherits the stack-name prefix and is not
    // asserted by this guard; the Distribution itself has no Name
    // property and is asserted by Comment + log prefix.
    const { template } = buildEdgeStack("prod");
    const ENV = "prod";

    it("ResponseHeadersPolicy Name carries the env literal", () => {
      const policies = template.findResources(
        "AWS::CloudFront::ResponseHeadersPolicy",
      );
      for (const resource of Object.values(policies)) {
        const cfg = resource.Properties?.ResponseHeadersPolicyConfig as
          | Record<string, unknown>
          | undefined;
        expect(typeof cfg?.Name).toBe("string");
        expect((cfg?.Name as string).includes(ENV)).toBe(true);
      }
    });

    it("Distribution Comment carries the env literal", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      for (const resource of Object.values(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        expect(typeof dc?.Comment).toBe("string");
        expect((dc?.Comment as string).includes(ENV)).toBe(true);
      }
    });

    it("CloudFront standard log prefix carries the env literal", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      for (const resource of Object.values(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        const logging = dc?.Logging as { Prefix?: string } | undefined;
        expect(typeof logging?.Prefix).toBe("string");
        expect((logging?.Prefix as string).includes(ENV)).toBe(true);
      }
    });
  });

  describe("Footgun #5 -- EC2/AWS property character-set safety", () => {
    const { template } = buildEdgeStack("prod");

    it("CloudFront Distribution Comment is ASCII-safe", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      const violations: string[] = [];
      for (const [id, resource] of Object.entries(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        const comment = dc?.Comment as string | undefined;
        if (
          typeof comment === "string" &&
          !EC2_DESCRIPTION_ALLOWED.test(comment)
        ) {
          const bad = [...comment].filter(
            (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
          );
          violations.push(
            `${id}: ${JSON.stringify(comment)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
          );
        }
      }
      expect(violations).toEqual([]);
    });

    it("CloudFront ResponseHeadersPolicy Comment is ASCII-safe", () => {
      const policies = template.findResources(
        "AWS::CloudFront::ResponseHeadersPolicy",
      );
      const violations: string[] = [];
      for (const [id, resource] of Object.entries(policies)) {
        const cfg = resource.Properties?.ResponseHeadersPolicyConfig as
          | Record<string, unknown>
          | undefined;
        const comment = cfg?.Comment as string | undefined;
        if (
          typeof comment === "string" &&
          !EC2_DESCRIPTION_ALLOWED.test(comment)
        ) {
          const bad = [...comment].filter(
            (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
          );
          violations.push(
            `${id}: ${JSON.stringify(comment)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
          );
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
