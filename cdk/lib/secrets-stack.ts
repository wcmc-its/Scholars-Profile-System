import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link SecretsStack}. */
export interface SecretsStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
}

/**
 * Per-secret entry. The value is intentionally omitted — the account holder
 * provisions and rotates secret values out-of-band (ADR-008 hard rule).
 */
interface SecretSpec {
  /** Construct id within this stack. */
  readonly constructId: string;
  /** AWS Secrets Manager secret name (the ARN tail). */
  readonly name: string;
  /** What the secret holds — surfaced in the CFN description for `cdk synth`. */
  readonly description: string;
}

/**
 * SecretsStack — empty Secrets Manager entries for the secrets the
 * application and ETL pipeline consume (ADR-008, B04).
 *
 * Per ADR-008's hard rule, this stack declares secret resources by ARN only;
 * no plaintext value ever appears in CDK source or the synthesized template.
 * `cdk synth` confirms zero `SecretString` / `GenerateSecretString` properties
 * on these resources; the account holder runs
 * `aws secretsmanager put-secret-value --secret-id <arn>` after deploy.
 *
 * Per-source ETL credential secrets (`scholars/etl/{source}`) land in a
 * SecretsStack supplement in Phase 3 (EtlStack) so the list is authored
 * against the live set of Lambdas, not speculative names.
 *
 * ADR-008's text nominally locates "RDS rotation" in this stack (B06). It
 * actually lives in `DataStack` — the Aurora master secret is auto-generated
 * by the cluster, and CDK's `AWS::SecretsManager::RotationSchedule` is
 * placed in the secret's stack, so threading the rotation through here
 * creates a structural cycle between the two stacks. The DataStack comment
 * by `addRotationSingleUser` records the deviation in detail.
 */
export class SecretsStack extends Stack {
  /**
   * The set of empty secret definitions this stack creates. Surfaced so the
   * downstream stacks can reference them by ARN; the values are populated
   * out-of-band.
   */
  public readonly secretArns: Readonly<Record<string, string>>;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // Secrets defined by ARN only — `secretString` and `generateSecretString`
    // are both omitted so neither CDK source nor the synthesized template
    // carry a value. The DB DSN secrets, OpenSearch user secrets, the
    // revalidate token, and the SAML SP private key all share this shape;
    // the account holder seeds each with `aws secretsmanager put-secret-value`
    // before the consuming stack ships (AppStack for db/* and opensearch/*;
    // EtlStack for revalidate-token; the SAML SP key is already pre-staged
    // in prod per the project's SAML SP wiring notes and CDK takes over the
    // ARN from this PR forward).
    // Secret-name convention: `scholars/{env}/...`. Env in the path because
    // account `665083158573` hosts both staging and prod (one-account
    // deviation from ADR-008). Without env-prefixing, the two stacks
    // collide on Secrets Manager's per-region-per-account name uniqueness.
    // The SAML SP key keeps its pre-existing pattern (env between
    // `saml-sp` and `private-key`) so the prod-side `cdk import` of the
    // pre-staged key (per [[saml-sp-wiring]]) matches its current ARN.
    const env = envConfig.envName;
    const specs: ReadonlyArray<SecretSpec> = [
      {
        constructId: "AppRw",
        name: `scholars/${env}/db/app-rw`,
        description:
          "SPS app writer DSN — used by /api/edit and one-shot prisma migrate deploy (PRODUCTION_ADDENDUM § Secrets).",
      },
      {
        constructId: "AppRo",
        name: `scholars/${env}/db/app-ro`,
        description:
          "SPS app reader DSN — backs the db.read PrismaClient (PRODUCTION_ADDENDUM § Reader/writer split).",
      },
      {
        constructId: "Etl",
        name: `scholars/${env}/db/etl`,
        description: "SPS ETL writer DSN (PRODUCTION_ADDENDUM § Secrets).",
      },
      {
        constructId: "OpensearchApp",
        name: `scholars/${env}/opensearch/app`,
        description:
          "SPS OpenSearch app user — read + suggest only (PRODUCTION_ADDENDUM § Secrets).",
      },
      {
        constructId: "OpensearchEtl",
        name: `scholars/${env}/opensearch/etl`,
        description:
          "SPS OpenSearch ETL user — read + write (PRODUCTION_ADDENDUM § Secrets).",
      },
      {
        constructId: "RevalidateToken",
        name: `scholars/${env}/revalidate-token`,
        description:
          "SPS /api/revalidate shared bearer (B04). Quarterly calendar rotation per docs/revalidate-token-rotation.md.",
      },
      {
        constructId: "SamlSpPrivateKey",
        name: `scholars/saml-sp/${env}/private-key`,
        description: `SPS SAML SP private key (${env}) — matches the SP cert filed with WCM IT. Pre-staged value in prod.`,
      },
      // Per-source ETL credential stubs (Phase 3, EtlStack). Each source
      // in the nightly/weekly/annual Step Functions state machines that
      // calls an external system gets its own secret so credentials can
      // rotate independently. Values are populated out-of-band per the
      // ADR-008 hard rule. The eight sources here mirror D6 in
      // `feat-infra-phase3-etlstack.md`.
      {
        constructId: "EtlEd",
        name: `scholars/${env}/etl/ed`,
        description:
          "SPS ETL credentials — WCM Enterprise Directory (LDAP simple bind).",
      },
      {
        constructId: "EtlAsms",
        name: `scholars/${env}/etl/asms`,
        description:
          "SPS ETL credentials — ASMS export endpoint (basic auth or signed URL).",
      },
      {
        constructId: "EtlInfoed",
        name: `scholars/${env}/etl/infoed`,
        description: "SPS ETL credentials — InfoEd grants export.",
      },
      {
        constructId: "EtlCoi",
        name: `scholars/${env}/etl/coi`,
        description: "SPS ETL credentials — COI source endpoint.",
      },
      {
        constructId: "EtlReciter",
        name: `scholars/${env}/etl/reciter`,
        description:
          "SPS ETL credentials — ReCiter API bearer + IAM signer keys.",
      },
      {
        constructId: "EtlDynamodb",
        name: `scholars/${env}/etl/dynamodb`,
        description:
          "SPS ETL credentials — ReciterAI DynamoDB scan (IAM scoped).",
      },
      {
        constructId: "EtlSpotlight",
        name: `scholars/${env}/etl/spotlight`,
        description:
          "SPS ETL credentials — Spotlight S3 manifest + signed payload pull.",
      },
      {
        constructId: "EtlHierarchy",
        name: `scholars/${env}/etl/hierarchy`,
        description:
          "SPS ETL credentials — annual hierarchy import (Jenzabar / org chart source).",
      },
      // EdgeStack (B07) — shared secret CloudFront includes on every
      // forwarded request via X-Origin-Verify; the public ALB listener
      // rejects requests missing the matching value. Without this entry
      // the public ALB DNS becomes a back-door bypass of every
      // cache-behavior decision (and the future WAF). 64-char random,
      // rotated out-of-band per ADR-008's hard rule. See
      // PRODUCTION_ADDENDUM § Phase 4 -- EdgeStack.
      {
        constructId: "EdgeOriginSharedSecret",
        name: `scholars/${env}/edge/origin-shared-secret`,
        description:
          "SPS CloudFront-to-ALB origin shared secret (B07). Forwarded as X-Origin-Verify; ALB listener admits only matching requests.",
      },
    ];

    const arns: Record<string, string> = {};
    for (const spec of specs) {
      // L1 CfnSecret because the L2 Secret defaults to generating a random
      // value when no `secretStringValue` / `generateSecretString` is
      // provided — ADR-008's hard rule wants no value in CDK at all.
      const cfn = new secretsmanager.CfnSecret(this, spec.constructId, {
        name: spec.name,
        description: spec.description,
      });
      // Retain the secret resource on stack delete — losing the ARN forces
      // every consumer's task definition to be re-pointed.
      cfn.applyRemovalPolicy(RemovalPolicy.RETAIN);
      arns[spec.name] = cfn.ref;
      new CfnOutput(this, `${spec.constructId}Arn`, {
        value: cfn.ref,
        description: `Secrets Manager ARN — ${spec.name}`,
      });
    }
    this.secretArns = arns;
  }
}
