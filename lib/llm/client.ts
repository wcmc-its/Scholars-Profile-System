/**
 * Shared Bedrock client construction (#2123) — the single AWS SDK credential-
 * chain factory the overview generator, biosketch generator, Matcha concept
 * extraction, and the CV research-summary call each used to duplicate
 * byte-for-byte as their own private `xBedrock()` function.
 */
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

/** Lazily build a Bedrock client from the AWS credential chain (ECS task role
 *  in deployment, shell creds locally). Not memoized — construction is cheap
 *  and each caller controls its own call cadence. */
export function bedrockClient() {
  return createAmazonBedrock({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentialProvider: fromNodeProviderChain(),
  });
}
