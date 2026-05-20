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
          Name: "scholars/db/master",
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
    });

    describe("OpenSearch", () => {
      it("creates one Domain with encryption + HTTPS + FGAC", () => {
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
            InternalUserDatabaseEnabled: false,
          }),
        });
      });

      it("retains the OpenSearch domain on stack delete", () => {
        template.hasResource("AWS::OpenSearchService::Domain", {
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
        });
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
