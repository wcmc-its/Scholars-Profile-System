/**
 * MS SQL Server connection helper for ASMS.
 *
 * Env vars (SCHOLARS_ASMS_* namespace):
 *   SCHOLARS_ASMS_HOST       (required)
 *   SCHOLARS_ASMS_PORT       (optional, default 1433)
 *   SCHOLARS_ASMS_USERNAME   (required)
 *   SCHOLARS_ASMS_PASSWORD   (required)
 *   SCHOLARS_ASMS_DATABASE   (optional, default "asms")
 *
 * The institutional client uses `asms.dbo.<table>` three-part naming, so the
 * default database can stay `asms`. Override via SCHOLARS_ASMS_DATABASE if
 * needed.
 *
 * TLS: ASMS is on Amazon RDS for SQL Server, so its certificate chains to the
 * Amazon RDS CA (same bundle as Aurora, `certs/rds-global-bundle.pem`), which
 * Node does not trust by default. `ASMS_TLS_VERIFY=on` verifies the server
 * certificate and hostname against that bundle; unset or anything else keeps
 * the old `trustServerCertificate: true` behaviour. The flag is per env on the
 * sources ETL task def (cdk/lib/etl-stack.ts), so rollback is "off" + deploy.
 */
import sql from "mssql";

import { loadRdsCa } from "@/lib/db-tls";

type Env = Record<string, string | undefined>;

/** TLS options for the ASMS connection: verified against the RDS CA bundle
 *  when `ASMS_TLS_VERIFY` is exactly "on", otherwise encrypted but unverified. */
export function asmsTlsOptions(
  env: Env = process.env,
  caFile?: string,
): Pick<sql.config["options"] & object, "encrypt" | "trustServerCertificate" | "cryptoCredentialsDetails"> {
  if (env.ASMS_TLS_VERIFY !== "on") return { encrypt: true, trustServerCertificate: true };
  return { encrypt: true, trustServerCertificate: false, cryptoCredentialsDetails: { ca: loadRdsCa(caFile) } };
}

let pool: sql.ConnectionPool | null = null;

export async function getAsmsPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const host = process.env.SCHOLARS_ASMS_HOST;
  const user = process.env.SCHOLARS_ASMS_USERNAME;
  const password = process.env.SCHOLARS_ASMS_PASSWORD;
  const database = process.env.SCHOLARS_ASMS_DATABASE ?? "asms";
  const port = parseInt(process.env.SCHOLARS_ASMS_PORT ?? "1433", 10);
  if (!host) throw new Error("SCHOLARS_ASMS_HOST is not set");
  if (!user) throw new Error("SCHOLARS_ASMS_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_ASMS_PASSWORD is not set");

  pool = await sql.connect({
    server: host,
    port,
    user,
    password,
    database,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      ...asmsTlsOptions(),
      enableArithAbort: true,
    },
  });
  return pool;
}

export async function closeAsmsPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
