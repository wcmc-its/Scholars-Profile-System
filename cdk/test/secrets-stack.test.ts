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

const PER_SOURCE_ETL_NAMES = [
  "ed",
  "asms",
  "infoed",
  "coi",
  "reciter",
  "jenzabar",
  "dynamodb",
  "spotlight",
  "hierarchy",
] as const;

function expectedSecrets(env: "staging" | "prod"): string[] {
  return [
    `scholars/${env}/db/app-rw`,
    `scholars/${env}/db/app-ro`,
    `scholars/${env}/db/etl`,
    `scholars/${env}/db/bootstrap`,
    `scholars/${env}/db/migrate`,
    `scholars/${env}/opensearch/master`,
    `scholars/${env}/opensearch/app`,
    `scholars/${env}/opensearch/etl`,
    `scholars/${env}/revalidate-token`,
    `scholars/${env}/session-cookie-key`,
    `scholars/saml-sp/${env}/private-key`,
    `scholars/saml-sp/${env}/cert`,
    `scholars/${env}/saml/idp-cert`,
    `scholars/${env}/newrelic-license-key`,
    // #742 — Vercel AI Gateway key for the overview-statement generator.
    `scholars/${env}/ai-gateway-api-key`,
    ...PER_SOURCE_ETL_NAMES.map((s) => `scholars/${env}/etl/${s}`),
    // #746 — ReCiter engine REST API (ETL-task only); distinct from the
    // etl/reciter ReciterDB DSN above.
    `scholars/${env}/reciter-api`,
    `scholars/${env}/edge/origin-shared-secret`,
    `scholars/${env}/oncall/teams-webhook-url`,
  ];
}

const EXPECTED_SECRETS_PROD = expectedSecrets("prod");
const EXPECTED_SECRETS_STAGING = expectedSecrets("staging");
const EXPECTED_SECRET_COUNT = EXPECTED_SECRETS_PROD.length;

describe("SecretsStack", () => {
  describe("prod", () => {
    const { template } = buildSecretsStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates the expected set of secrets by name (fourteen core incl. opensearch/master + session-cookie-key + saml/idp-cert + saml-sp/cert + db/bootstrap + db/migrate (ADR-009) + newrelic-license-key + nine per-source ETL stubs + reciter-api (#746) + EdgeStack origin shared secret + on-call Teams webhook)", () => {
      template.resourceCountIs(
        "AWS::SecretsManager::Secret",
        EXPECTED_SECRET_COUNT,
      );
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
  });

  describe("staging", () => {
    const { template } = buildSecretsStack("staging");

    it("names the SAML SP private-key secret per env", () => {
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
  });
});
