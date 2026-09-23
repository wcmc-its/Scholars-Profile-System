import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import { type Construct } from "constructs";

/** Receive-only mail domain. ITS delegates it to this stack's Route53 zone (NS). */
export const INBOUND_MAIL_DOMAIN = "scholars-mail.weill.cornell.edu";
/** SES writes raw messages under `<prefix><messageId>`; etl/news/clips.ts reads them. */
export const CLIPS_PREFIX = "clips/";
/** Research Dean funding digest; etl/opportunities/funding-digest.ts reads them. */
export const FUNDING_PREFIX = "funding/";
/** Bucket name, derivable from the account alone so the ETL stacks can grant on it by name. */
export const inboundMailBucketName = (account: string): string => `sps-inbound-mail-${account}`;

/**
 * Inbound mail for SPS: `clips@scholars-mail.weill.cornell.edu` is subscribed to
 * the External Affairs clips list, and SES drops each message into S3
 * for the nightly `etl:news-clips` step (Media Highlights).
 * `funding@` does the same for the Research Dean's weekly funding digest
 * (`etl:funding-digest`).
 *
 * ACCOUNT-WIDE SINGLETON, instantiated from the prod app only: SES allows ONE
 * active receipt rule set per account+region and staging/prod share the
 * account, so there is exactly one of these. Both envs' ETL read the bucket.
 *
 * Out-of-band steps (see the Media Highlights section of docs/DEPLOY-RUNBOOK.md):
 *   1. After first deploy, send ITS the zone's NameServers output for delegation.
 *   2. `aws ses set-active-receipt-rule-set --rule-set-name sps-inbound-mail`
 *      (CloudFormation cannot activate a rule set).
 *   3. External Affairs adds the address to the list.
 */
export class InboundMailStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zone = new route53.PublicHostedZone(this, "Zone", { zoneName: INBOUND_MAIL_DOMAIN });

    new route53.MxRecord(this, "Mx", {
      zone,
      values: [{ priority: 10, hostName: `inbound-smtp.${Aws.REGION}.amazonaws.com` }],
    });

    // Domain identity (DKIM CNAMEs land in the zone automatically). Receiving
    // needs the domain verified; nothing sends from it.
    new ses.EmailIdentity(this, "Identity", {
      identity: ses.Identity.publicHostedZone(zone),
    });

    const bucket = new s3.Bucket(this, "Bucket", {
      bucketName: inboundMailBucketName(Aws.ACCOUNT_ID),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The ETL re-reads a 30-day window; the upsert keeps what it matched.
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new ses.ReceiptRuleSet(this, "RuleSet", {
      receiptRuleSetName: "sps-inbound-mail",
      rules: [
        {
          receiptRuleName: "clips",
          recipients: [`clips@${INBOUND_MAIL_DOMAIN}`],
          // Spam/virus scan stamps X-SES-*-Verdict headers the ETL checks.
          scanEnabled: true,
          // The action adds the bucket policy letting SES (this account only) write.
          actions: [new sesActions.S3({ bucket, objectKeyPrefix: CLIPS_PREFIX })],
        },
        {
          receiptRuleName: "funding",
          recipients: [`funding@${INBOUND_MAIL_DOMAIN}`],
          scanEnabled: true,
          actions: [new sesActions.S3({ bucket, objectKeyPrefix: FUNDING_PREFIX })],
        },
      ],
      // SES rejects mail matching no rule, so only clips@ is ever stored.
    });

    new CfnOutput(this, "NameServers", {
      value: Fn.join(", ", zone.hostedZoneNameServers!),
      description: `NS records for ITS to delegate ${INBOUND_MAIL_DOMAIN}`,
    });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
  }
}
