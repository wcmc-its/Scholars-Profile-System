import { Match, Template } from "aws-cdk-lib/assertions";
import { SecretsStack } from "../lib/secrets-stack";
import { makeFixture } from "./test-utils";

function buildSecretsStack(envName: "staging" | "prod"): {
  template: Template;
  stack: SecretsStack;
} {
  const fixture = makeFixture(envName);
  const stack = new SecretsStack(fixture.app, `Sps-Secrets-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  return { template: Template.fromStack(stack), stack };
}

const EXPECTED_SECRETS_PROD = [
  "scholars/prod/db/app-rw",
  "scholars/prod/db/app-ro",
  "scholars/prod/db/etl",
  "scholars/prod/opensearch/app",
  "scholars/prod/opensearch/etl",
  "scholars/prod/revalidate-token",
  "scholars/prod/saml-sp/private-key",
];

const EXPECTED_SECRETS_STAGING = [
  "scholars/staging/db/app-rw",
  "scholars/staging/db/app-ro",
  "scholars/staging/db/etl",
  "scholars/staging/opensearch/app",
  "scholars/staging/opensearch/etl",
  "scholars/staging/revalidate-token",
  "scholars/staging/saml-sp/private-key",
];

describe("SecretsStack", () => {
  describe("prod", () => {
    const { template } = buildSecretsStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates the seven expected secrets by name", () => {
      template.resourceCountIs("AWS::SecretsManager::Secret", 7);
      for (const name of EXPECTED_SECRETS_PROD) {
        template.hasResourceProperties("AWS::SecretsManager::Secret", {
          Name: name,
        });
      }
    });

    it("never embeds a SecretString or GenerateSecretString in any secret (ADR-008 hard rule)", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const violations: string[] = [];
      for (const [id, resource] of Object.entries(secrets)) {
        if (resource.Properties?.SecretString !== undefined) {
          violations.push(`${id} embeds SecretString`);
        }
        if (resource.Properties?.GenerateSecretString !== undefined) {
          violations.push(`${id} embeds GenerateSecretString`);
        }
      }
      expect(violations).toEqual([]);
    });

    it("retains every secret on stack delete", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const nonRetained: string[] = [];
      for (const [id, resource] of Object.entries(secrets)) {
        if (resource.DeletionPolicy !== "Retain") {
          nonRetained.push(`${id} DeletionPolicy=${resource.DeletionPolicy}`);
        }
        if (resource.UpdateReplacePolicy !== "Retain") {
          nonRetained.push(
            `${id} UpdateReplacePolicy=${resource.UpdateReplacePolicy}`,
          );
        }
      }
      expect(nonRetained).toEqual([]);
    });

    it("contains no resources other than secrets, descriptions, and the stack metadata", () => {
      // Rotation lives in DataStack (see DataStack.addRotationSingleUser);
      // SecretsStack must not pull in a rotation Lambda or attaching SAR app.
      template.resourceCountIs(
        "AWS::SecretsManager::RotationSchedule",
        0,
      );
      template.resourceCountIs("AWS::Serverless::Application", 0);
      template.resourceCountIs("AWS::Lambda::Function", 0);
    });

    it("every secret Name is env-scoped under `scholars/prod/` (no unscoped collisions in single-account)", () => {
      // Synth-time guard: catches the failure mode that bit Sps-Secrets-prod
      // when staging and prod both tried to create the same unscoped names
      // in one account. Every SecretsStack Name must start with the env.
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const offenders: string[] = [];
      for (const [id, resource] of Object.entries(secrets)) {
        const name = resource.Properties?.Name;
        if (typeof name !== "string" || !name.startsWith("scholars/prod/")) {
          offenders.push(`${id}: Name=${JSON.stringify(name)}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("staging", () => {
    const { template } = buildSecretsStack("staging");

    it("creates the seven expected secrets with env-scoped staging names", () => {
      template.resourceCountIs("AWS::SecretsManager::Secret", 7);
      for (const name of EXPECTED_SECRETS_STAGING) {
        template.hasResourceProperties("AWS::SecretsManager::Secret", {
          Name: name,
        });
      }
    });

    it.each(EXPECTED_SECRETS_STAGING)(
      "secret %s has a CFN description",
      (name) => {
        template.hasResourceProperties("AWS::SecretsManager::Secret", {
          Name: name,
          Description: Match.stringLikeRegexp(".+"),
        });
      },
    );

    it("every secret Name is env-scoped under `scholars/staging/`", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const offenders: string[] = [];
      for (const [id, resource] of Object.entries(secrets)) {
        const name = resource.Properties?.Name;
        if (typeof name !== "string" || !name.startsWith("scholars/staging/")) {
          offenders.push(`${id}: Name=${JSON.stringify(name)}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
