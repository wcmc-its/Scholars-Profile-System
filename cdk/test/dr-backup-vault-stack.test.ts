import { Template } from "aws-cdk-lib/assertions";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { makeFixture } from "./test-utils";

describe("DrBackupVaultStack", () => {
  describe("prod", () => {
    const fixture = makeFixture("prod");
    const stack = new DrBackupVaultStack(
      fixture.app,
      "Sps-DrBackupVault-prod",
      {
        env: fixture.drEnv,
        envConfig: fixture.envConfig,
        crossRegionReferences: true,
      },
    );
    const template = Template.fromStack(stack);

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("synthesizes in the DR region (us-west-2)", () => {
      expect(stack.region).toBe("us-west-2");
    });

    it("creates exactly one BackupVault with the expected name", () => {
      template.resourceCountIs("AWS::Backup::BackupVault", 1);
      template.hasResourceProperties("AWS::Backup::BackupVault", {
        BackupVaultName: "sps-dr-backup-vault-prod",
      });
    });

    it("retains the vault on stack delete", () => {
      template.hasResource("AWS::Backup::BackupVault", {
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });
  });

  describe("staging", () => {
    const fixture = makeFixture("staging");
    const stack = new DrBackupVaultStack(
      fixture.app,
      "Sps-DrBackupVault-staging",
      {
        env: fixture.drEnv,
        envConfig: fixture.envConfig,
        crossRegionReferences: true,
      },
    );
    const template = Template.fromStack(stack);

    it("names the staging vault distinctly", () => {
      template.hasResourceProperties("AWS::Backup::BackupVault", {
        BackupVaultName: "sps-dr-backup-vault-staging",
      });
    });
  });
});
