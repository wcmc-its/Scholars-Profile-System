import { Match, Template } from "aws-cdk-lib/assertions";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

function buildDataStack(envName: "staging" | "prod"): {
  template: Template;
  stack: DataStack;
} {
  const fixture = makeFixture(envName);
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const dr = new DrBackupVaultStack(
    fixture.app,
    `Sps-DrBackupVault-${envName}`,
    {
      env: fixture.drEnv,
      envConfig: fixture.envConfig,
      crossRegionReferences: true,
    },
  );
  const stack = new DataStack(fixture.app, `Sps-Data-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    crossRegionReferences: true,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    etlSecurityGroup: network.etlSecurityGroup,
    drBackupVault: dr.vault,
  });
  return { template: Template.fromStack(stack), stack };
}

describe("DataStack", () => {
  describe("prod", () => {
    const { template } = buildDataStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    describe("Aurora", () => {
      it("creates one DBCluster with storage encryption, deletion protection, and the expected backup retention", () => {
        template.resourceCountIs("AWS::RDS::DBCluster", 1);
        template.hasResourceProperties("AWS::RDS::DBCluster", {
          Engine: "aurora-mysql",
          StorageEncrypted: true,
          DeletionProtection: true,
          BackupRetentionPeriod: 14,
          DatabaseName: "scholars",
        });
      });

      it("retains the cluster on stack delete", () => {
        template.hasResource("AWS::RDS::DBCluster", {
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
        });
      });

      it("configures Serverless v2 capacity from env config (prod 1–8 ACU)", () => {
        template.hasResourceProperties("AWS::RDS::DBCluster", {
          ServerlessV2ScalingConfiguration: {
            MinCapacity: 1,
            MaxCapacity: 8,
          },
        });
      });

      it("provisions a writer + one reader in prod (multi-AZ)", () => {
        // Two DBInstance resources — writer + Reader1.
        template.resourceCountIs("AWS::RDS::DBInstance", 2);
        template.hasResourceProperties("AWS::RDS::DBInstance", {
          DBInstanceClass: "db.serverless",
          PubliclyAccessible: false,
        });
      });

      it("creates the master secret with the documented name (no plaintext value)", () => {
        template.hasResourceProperties("AWS::SecretsManager::Secret", {
          Name: "scholars/prod/db/master",
          GenerateSecretString: Match.objectLike({
            SecretStringTemplate: Match.stringLikeRegexp(
              "\\{\\s*\"username\"\\s*:\\s*\"scholars_admin\"",
            ),
          }),
        });
        // The template must not contain the plaintext password.
        const json = JSON.stringify(template.toJSON());
        expect(json).not.toMatch(/PasswordValue/);
        expect(json).not.toMatch(/scholars_admin_password/);
      });

      it("the master secret retains on BOTH delete and replace (a Name change must not delete the cluster's live credentials)", () => {
        // Regression guard. The previous implementation applied
        // RemovalPolicy.RETAIN to `cluster.secret.node.defaultChild`, which
        // resolves to the SecretTargetAttachment — leaving the actual
        // Secret with the CFN default `UpdateReplacePolicy: Delete`. The
        // env-scope rename in #404 would have wiped the staging cluster's
        // password value off AWS entirely on the next deploy.
        const masterSecretResources = Object.entries(
          template.findResources("AWS::SecretsManager::Secret"),
        ).filter(
          ([, r]) =>
            typeof r.Properties?.Name === "string" &&
            r.Properties.Name.endsWith("/db/master"),
        );
        expect(masterSecretResources).toHaveLength(1);
        const [, masterSecret] = masterSecretResources[0]!;
        expect(masterSecret.DeletionPolicy).toBe("Retain");
        expect(masterSecret.UpdateReplacePolicy).toBe("Retain");
      });
    });

    describe("OpenSearch", () => {
      it("creates one Domain with encryption + HTTPS + FGAC + internal user DB", () => {
        template.resourceCountIs("AWS::OpenSearchService::Domain", 1);
        template.hasResourceProperties("AWS::OpenSearchService::Domain", {
          EngineVersion: "OpenSearch_2.19",
          EncryptionAtRestOptions: { Enabled: true },
          NodeToNodeEncryptionOptions: { Enabled: true },
          DomainEndpointOptions: Match.objectLike({
            EnforceHTTPS: true,
            TLSSecurityPolicy: "Policy-Min-TLS-1-2-PFS-2023-10",
          }),
          AdvancedSecurityOptions: Match.objectLike({
            Enabled: true,
            InternalUserDatabaseEnabled: true,
            MasterUserOptions: Match.objectLike({
              MasterUserARN: Match.anyValue(),
            }),
          }),
        });
      });

      it("AdvancedSecurityOptions does NOT carry MasterUserName/MasterUserPassword (IAM master only; app/ETL internal users seeded out-of-band)", () => {
        // Phase 1 sign-off: the master credential is the IAM role, not a
        // basic-auth user. The two `scholars/{env}/opensearch/{app,etl}`
        // secrets are *internal users* the master creates via the
        // `_security` API after deploy — none of their values appear in
        // the synthesized template.
        const domains = Object.values(
          template.findResources("AWS::OpenSearchService::Domain"),
        );
        expect(domains).toHaveLength(1);
        const advancedSecurity = (
          domains[0]?.Properties as { AdvancedSecurityOptions?: unknown }
        )?.AdvancedSecurityOptions as
          | { MasterUserOptions?: Record<string, unknown> }
          | undefined;
        const opts = advancedSecurity?.MasterUserOptions ?? {};
        expect(opts).not.toHaveProperty("MasterUserName");
        expect(opts).not.toHaveProperty("MasterUserPassword");
      });

      it("domain access policy permits es:ESHttp* from any AWS principal (required for HTTP basic auth to reach FGAC)", () => {
        // With FGAC + internal user database + basic auth, the unsigned
        // HTTP request hits AWS IAM first. If the access policy doesn't
        // permit `es:ESHttp*` from `Principal: { AWS: "*" }`, AWS denies
        // the request as anonymous BEFORE OpenSearch ever runs FGAC.
        // VPC + SGs are the network gate; FGAC + the internal user DB
        // are the application gate; anonymous OpenSearch access stays
        // blocked because `AnonymousAuthEnabled` is false.
        //
        // `Domain.addAccessPolicies` materializes the policy as a
        // `Custom::OpenSearchAccessPolicy` custom resource (a Lambda that
        // calls `opensearch:UpdateDomainConfig`), not as the CFN
        // `AccessPolicies` property — so assert on the custom resource.
        template.resourceCountIs("Custom::OpenSearchAccessPolicy", 1);
        const policyResources = template.findResources(
          "Custom::OpenSearchAccessPolicy",
        );
        const policyJson = JSON.stringify(policyResources);
        expect(policyJson).toContain("es:ESHttp*");
        expect(policyJson).toMatch(/Principal.{1,40}AWS.{1,40}\*/);
        expect(policyJson).toMatch(/Effect.{1,20}Allow/);
      });

      it("master role has es:ESHttp* on the domain ARN (without it, _security API calls 403 before FGAC sees them)", () => {
        // Match a policy attached to the OS master role that allows
        // es:ESHttp* on the domain ARN. The L2 Domain helper does NOT
        // automatically attach this; without it, the assumed master role
        // gets `not authorized to perform: es:ESHttpPut` at the IAM
        // gate, which is a deploy-only failure mode.
        template.hasResourceProperties(
          "AWS::IAM::Policy",
          Match.objectLike({
            Roles: Match.arrayWith([
              Match.objectLike({ Ref: Match.stringLikeRegexp("OpensearchMasterRole") }),
            ]),
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Effect: "Allow",
                  Action: "es:ESHttp*",
                  Resource: Match.objectLike({
                    "Fn::Join": Match.arrayWith([
                      "",
                      Match.arrayWith([
                        Match.objectLike({
                          "Fn::GetAtt": Match.arrayWith([
                            Match.stringLikeRegexp("OpenSearch"),
                            "Arn",
                          ]),
                        }),
                        "/*",
                      ]),
                    ]),
                  }),
                }),
              ]),
            }),
          }),
        );
      });

      it("retains the OpenSearch domain on stack delete", () => {
        template.hasResource("AWS::OpenSearchService::Domain", {
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
        });
      });

      it("the OpenSearch VPCOptions subnet count matches the data-node count", () => {
        // OpenSearch validates `len(VPCOptions.SubnetIds) == data-node AZ
        // count` at create time. A mismatch was the root cause of the v5
        // deploy failure for `Sps-Data-staging`. Locked in synth-time.
        const domain = Object.values(
          template.findResources("AWS::OpenSearchService::Domain"),
        )[0];
        const subnetIds: unknown =
          domain?.Properties?.VPCOptions?.SubnetIds ?? [];
        expect(Array.isArray(subnetIds)).toBe(true);
        expect((subnetIds as unknown[]).length).toBe(2);
      });

      it("uses prod capacity (2 data nodes, m6g.large.search, zone-aware)", () => {
        template.hasResourceProperties("AWS::OpenSearchService::Domain", {
          ClusterConfig: Match.objectLike({
            InstanceCount: 2,
            InstanceType: "m6g.large.search",
            ZoneAwarenessEnabled: true,
            ZoneAwarenessConfig: { AvailabilityZoneCount: 2 },
            MultiAZWithStandbyEnabled: false,
          }),
        });
      });

      it("creates the IAM FGAC master role with AccountRootPrincipal trust", () => {
        template.hasResourceProperties("AWS::IAM::Role", {
          RoleName: "sps-opensearch-master-prod",
          AssumeRolePolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: Match.objectLike({ AWS: Match.anyValue() }),
              }),
            ]),
          }),
        });
      });
    });

    describe("EC2 property character-set safety", () => {
      // EC2 validates resource descriptions against this set at deploy time
      // (NOT at synth time). `cdk-assertions` snapshots don't catch
      // violations either — the only way to be sure is to scan the synth
      // output. Two prior hotfixes (PRs #401 and a follow-up) both burned
      // a deploy attempt to the same lines because the original `→` was
      // replaced with `->` (still contains the banned `>`). This test
      // makes the next regression a synth-time failure, not a deploy
      // failure. (~20 minutes saved per bad description.)
      //
      // See AWS Security Group rule description constraint, EC2 API:
      //   "Up to 256 characters in length, allowed:
      //    a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*"
      const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

      it("every AWS::EC2::SecurityGroupIngress Description uses only EC2's allowed character set", () => {
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(ingress)) {
          const desc = resource.Properties?.Description;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            const bad = [...desc].filter(
              (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
            );
            violations.push(
              `${id}: ${JSON.stringify(desc)} — banned chars: ${JSON.stringify(bad.join(""))}`,
            );
          }
        }
        expect(violations).toEqual([]);
      });

      it("every AWS::EC2::SecurityGroup GroupDescription uses only EC2's allowed character set", () => {
        const sgs = template.findResources("AWS::EC2::SecurityGroup");
        const violations: string[] = [];
        for (const [id, resource] of Object.entries(sgs)) {
          const desc = resource.Properties?.GroupDescription;
          if (typeof desc === "string" && !EC2_DESCRIPTION_ALLOWED.test(desc)) {
            const bad = [...desc].filter(
              (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
            );
            violations.push(
              `${id}: ${JSON.stringify(desc)} — banned chars: ${JSON.stringify(bad.join(""))}`,
            );
          }
        }
        expect(violations).toEqual([]);
      });
    });

    describe("Security groups", () => {
      it("Aurora SG admits the app and ETL SGs on 3306", () => {
        // We declare two ingress rules explicitly (app + ETL). The Secrets
        // Manager rotation Lambda's reachability is added by
        // `cluster.addRotationSingleUser()` separately; that connection
        // path is verified by the RotationSchedule + Serverless application
        // resources in the "RDS rotation" describe block.
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const aurora3306 = Object.values(ingress).filter(
          (r) =>
            r.Properties?.FromPort === 3306 &&
            r.Properties?.ToPort === 3306 &&
            r.Properties?.IpProtocol === "tcp",
        );
        expect(aurora3306).toHaveLength(2);
      });

      it("OpenSearch SG admits the app + ETL SGs on 443 — and nothing else", () => {
        const ingress = template.findResources(
          "AWS::EC2::SecurityGroupIngress",
        );
        const os443 = Object.values(ingress).filter(
          (r) =>
            r.Properties?.FromPort === 443 &&
            r.Properties?.ToPort === 443 &&
            r.Properties?.IpProtocol === "tcp",
        );
        expect(os443).toHaveLength(2);
      });
    });

    describe("RDS rotation", () => {
      it("attaches a single-user MySQL rotation schedule on a 30-day cadence (B06)", () => {
        template.resourceCountIs(
          "AWS::SecretsManager::RotationSchedule",
          1,
        );
        template.hasResourceProperties(
          "AWS::SecretsManager::RotationSchedule",
          {
            RotationRules: { ScheduleExpression: "rate(30 days)" },
          },
        );
      });

      it("deploys the Secrets Manager rotation Serverless application", () => {
        template.resourceCountIs("AWS::Serverless::Application", 1);
      });
    });

    describe("AWS Backup", () => {
      it("creates a daily plan with a cross-region copy action (B10)", () => {
        template.resourceCountIs("AWS::Backup::BackupVault", 1);
        template.resourceCountIs("AWS::Backup::BackupPlan", 1);
        template.hasResourceProperties("AWS::Backup::BackupPlan", {
          BackupPlan: Match.objectLike({
            BackupPlanName: "sps-aurora-daily-prod",
            BackupPlanRule: Match.arrayWith([
              Match.objectLike({
                RuleName: "daily",
                ScheduleExpression: "cron(0 5 * * ? *)",
                Lifecycle: Match.objectLike({ DeleteAfterDays: 35 }),
                CopyActions: Match.arrayWith([
                  Match.objectLike({
                    DestinationBackupVaultArn: Match.anyValue(),
                    Lifecycle: Match.objectLike({ DeleteAfterDays: 35 }),
                  }),
                ]),
              }),
            ]),
          }),
        });
      });

      it("selects the Aurora cluster as the backup resource", () => {
        template.resourceCountIs("AWS::Backup::BackupSelection", 1);
      });
    });
  });

  describe("staging", () => {
    const { template } = buildDataStack("staging");

    it("provisions writer-only Aurora (no reader instances)", () => {
      template.resourceCountIs("AWS::RDS::DBInstance", 1);
    });

    it("uses staging Aurora ACU range (0.5–2)", () => {
      template.hasResourceProperties("AWS::RDS::DBCluster", {
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      });
    });

    it("uses single-AZ OpenSearch in staging", () => {
      template.hasResourceProperties("AWS::OpenSearchService::Domain", {
        ClusterConfig: Match.objectLike({
          InstanceCount: 1,
          InstanceType: "t3.small.search",
          ZoneAwarenessEnabled: false,
        }),
      });
    });

    it("the staging OpenSearch VPCOptions has exactly 1 subnet (single-AZ)", () => {
      const domain = Object.values(
        template.findResources("AWS::OpenSearchService::Domain"),
      )[0];
      const subnetIds: unknown =
        domain?.Properties?.VPCOptions?.SubnetIds ?? [];
      expect(Array.isArray(subnetIds)).toBe(true);
      expect((subnetIds as unknown[]).length).toBe(1);
    });

    it("uses 14-day backup retention for the AWS Backup plan", () => {
      template.hasResourceProperties("AWS::Backup::BackupPlan", {
        BackupPlan: Match.objectLike({
          BackupPlanRule: Match.arrayWith([
            Match.objectLike({
              Lifecycle: Match.objectLike({ DeleteAfterDays: 14 }),
            }),
          ]),
        }),
      });
    });
  });
});
