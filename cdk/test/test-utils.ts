import { App, type Environment } from "aws-cdk-lib";
import { resolveEnvConfig, type SpsEnvConfig } from "../lib/config";

/** A fixed 12-digit account used to keep cross-region references deterministic. */
export const TEST_ACCOUNT = "123456789012";

/** Standard fixture: a CDK App plus the resolved config + environments. */
export interface TestFixture {
  readonly app: App;
  readonly envConfig: SpsEnvConfig;
  readonly env: Environment;
  readonly drEnv: Environment;
}

/**
 * Construct the shared test fixture. Both regions resolve from the same
 * config; the explicit account makes synth output stable for snapshot
 * comparison (cross-region references hash the producer's account into the
 * generated SSM parameter name).
 */
export function makeFixture(envName: "staging" | "prod"): TestFixture {
  const app = new App();
  const envConfig = resolveEnvConfig(envName);
  return {
    app,
    envConfig,
    env: { account: TEST_ACCOUNT, region: envConfig.region },
    drEnv: { account: TEST_ACCOUNT, region: envConfig.drRegion },
  };
}
