/**
 * DB_TLS for the seeder's master connection: the Lambda-side twin of the repo's
 * `lib/db-tls.ts` (this workspace is bundled on its own and cannot import the
 * app's lib/). Same contract: `DB_TLS` exactly "on" requires TLS and verifies
 * the server cert, chain and hostname, against the Amazon RDS CA bundle;
 * anything else adds nothing (plaintext, the pre-flag behaviour).
 *
 * The bundle is the repo's `certs/rds-global-bundle.pem`, copied into the
 * Lambda asset root by DataStack's `afterBundling` hook. The Node Lambda
 * runtime does not trust the RDS CA by default.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** File name of the CA bundle in the Lambda asset root. */
export const RDS_CA_BUNDLE_FILE = "rds-global-bundle.pem";

export interface SslOptions {
  ca: string;
  rejectUnauthorized: true;
}

/** `ssl` for mariadb `createConnection`, or undefined when DB_TLS is off. */
export function seederSslOptions(
  env: Record<string, string | undefined> = process.env,
  readCa: (file: string) => string = (file) => readFileSync(file, "utf8"),
): SslOptions | undefined {
  if (env.DB_TLS !== "on") return undefined;
  const file = path.join(env.LAMBDA_TASK_ROOT ?? process.cwd(), RDS_CA_BUNDLE_FILE);
  const ca = readCa(file);
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`DB_TLS=on but ${file} is not a PEM certificate bundle`);
  }
  return { ca, rejectUnauthorized: true };
}
