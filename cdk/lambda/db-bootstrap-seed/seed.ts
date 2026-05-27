/**
 * Orchestration for the sps_bootstrap seeder, with every I/O dependency injected
 * so it is unit-testable without AWS or a live DB (mirrors the PR-1 runner's
 * `bootstrap(conn, …)` shape). `index.ts` wires the real Secrets Manager client
 * and mariadb connection; this decides what runs.
 */
import {
  BOOTSTRAP_USER,
  buildDsn,
  decidePassword,
  dropStatements,
  seedStatements,
} from "./statements.js";

export type RequestType = "Create" | "Update" | "Delete";

export interface SeedDeps {
  requestType: RequestType;
  /** Run one SQL statement as the master user. */
  query(sql: string): Promise<void>;
  /** Current bootstrap-secret value, or undefined if absent/empty. */
  getBootstrapSecret(): Promise<string | undefined>;
  /** Persist the bootstrap DSN (only called when a fresh password is generated). */
  putBootstrapSecret(dsn: string): Promise<void>;
  /** Aurora writer host + port for the DSN written to the secret. */
  dbHost: string;
  dbPort: number;
  /** Structured logger — MUST NOT be passed the password or DSN. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

export interface SeedResult {
  physicalResourceId: string;
  /** True when an existing password was reused (no secret write). */
  reused: boolean;
}

const PHYSICAL_ID = `db-bootstrap-seed-${BOOTSTRAP_USER}`;

/**
 * Seed (Create/Update) or drop (Delete) the bootstrap role. On Create/Update:
 * reuse the secret's existing password if present (so the DB user and the DSN
 * the bootstrap task reads never drift), else generate one and write the DSN;
 * always (re-)assert the user + grants idempotently. On Delete: drop the user.
 * Throws on any failure so the custom resource reports failure to CloudFormation
 * (the deploy fails — fails-closed).
 */
export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const log = deps.log ?? (() => {});

  if (deps.requestType === "Delete") {
    for (const sql of dropStatements()) await deps.query(sql);
    log("db_bootstrap_seed_dropped", { user: BOOTSTRAP_USER });
    return { physicalResourceId: PHYSICAL_ID, reused: false };
  }

  const existing = await deps.getBootstrapSecret();
  const { password, reused } = decidePassword(existing);

  for (const sql of seedStatements(password)) await deps.query(sql);

  if (!reused) {
    await deps.putBootstrapSecret(buildDsn(deps.dbHost, deps.dbPort, password));
  }

  // Never logs the password or DSN — only the outcome class.
  log("db_bootstrap_seed_ok", { user: BOOTSTRAP_USER, reused });
  return { physicalResourceId: PHYSICAL_ID, reused };
}
