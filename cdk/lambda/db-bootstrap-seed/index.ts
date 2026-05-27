/**
 * CloudFormation custom-resource handler: seed the least-privilege
 * `sps_bootstrap` DB user using the Aurora **master** credential (#493 PR 2).
 *
 * This is the ONLY place the master credential is used. The Lambda is invoked
 * only by CloudFormation at `cdk deploy` (never CI, never a task definition),
 * its execution role is the sole principal granted read on the master secret,
 * and it runs in a VPC SG that the Aurora SG admits on 3306 — the same in-VPC
 * path the RDS rotation Lambda already uses. It then writes the generated
 * bootstrap DSN into the SecretsStack stub the PR-1 `sps-db-bootstrap` task
 * reads, so master never reaches the deploy pipeline.
 *
 * Idempotent: reuses an already-seeded password (so re-deploys don't churn the
 * credential the task depends on) and re-asserts the user + grants every run.
 */
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createConnection } from "mariadb";

import { runSeed, type RequestType } from "./seed.js";

interface OnEventRequest {
  RequestType: RequestType;
  [key: string]: unknown;
}
interface OnEventResponse {
  PhysicalResourceId?: string;
  Data?: Record<string, unknown>;
}

interface MasterCredential {
  username: string;
  password: string;
  host?: string;
  port?: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is not set`);
  return v;
}

async function getSecretString(
  sm: SecretsManagerClient,
  secretId: string,
): Promise<string | undefined> {
  try {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    return out.SecretString && out.SecretString.length > 0
      ? out.SecretString
      : undefined;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  const masterArn = requireEnv("MASTER_SECRET_ARN");
  const bootstrapArn = requireEnv("BOOTSTRAP_SECRET_ARN");
  const dbHost = requireEnv("DB_HOST");
  const dbPort = Number(process.env.DB_PORT ?? "3306");

  const sm = new SecretsManagerClient({});

  const masterRaw = await getSecretString(sm, masterArn);
  if (masterRaw === undefined) throw new Error("master secret is empty");
  const master = JSON.parse(masterRaw) as MasterCredential;

  const conn = await createConnection({
    host: master.host ?? dbHost,
    port: master.port ?? dbPort,
    user: master.username,
    password: master.password,
    // No `database`: CREATE USER / GRANT are server-level.
    connectTimeout: 10000,
  });

  try {
    const result = await runSeed({
      requestType: event.RequestType,
      query: async (sql) => {
        await conn.query(sql);
      },
      getBootstrapSecret: () => getSecretString(sm, bootstrapArn),
      putBootstrapSecret: async (dsn) => {
        await sm.send(
          new PutSecretValueCommand({ SecretId: bootstrapArn, SecretString: dsn }),
        );
      },
      dbHost,
      dbPort,
      log: (eventName, extra) =>
        console.log(JSON.stringify({ event: eventName, ...extra })),
    });
    return {
      PhysicalResourceId: result.physicalResourceId,
      Data: { reused: result.reused },
    };
  } finally {
    await conn.end();
  }
}
