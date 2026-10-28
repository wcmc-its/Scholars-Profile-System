/**
 * One-time backfill for ORCID queue v3 B1: fill `orcid_dismissal.dismissed_by`,
 * `reason` and `kept_orcid` on rows written before the writers set them, from
 * the audit log (`orcid_librarian_dismiss`, `orcid_librarian_confirm`,
 * `orcid_set`). A pair is matched to the latest audit row that dismissed it at
 * or before its `dismissed_at` (plus a minute of slack: the audit `ts` and the
 * row default are taken separately in one transaction). Only rows with
 * `dismissed_by IS NULL` are touched; a row with no matching audit row stays null.
 *
 * Also seeds `orcid_pair_seen` for the pairs queued today with the earliest
 * time SPS saw each (evidence `computed_at`, candidate `synced_at`): a floor.
 * On a pair the evidence ETL already stamped, the earlier time wins, so the
 * order against the next ETL run doesn't matter.
 *
 * Two connections, as in scripts/backfill-reveal-historical-appointments.ts:
 * the etl role can't read `scholars_audit`, so planning reads over
 * DATABASE_URL_RO and only the UPDATE uses DATABASE_URL.
 *
 * Dry-run by default; pass --apply to write.
 *   npx tsx scripts/backfills/2026-10-28-orcid-dismissal-who-why.ts [--apply]
 */
import "dotenv/config";
import { createConnection, type Connection } from "mariadb";

type AuditRow = {
  actor_cwid: string;
  target_entity_id: string;
  action: string;
  before_values: unknown;
  after_values: unknown;
  ts: Date;
};
type Dismissal = { cwid: string; orcid: string; dismissed_at: Date };
export type Fill = {
  cwid: string;
  orcid: string;
  by: string;
  reason: string;
  kept: string | null;
};

const SLACK_MS = 60_000;

const obj = (v: unknown): Record<string, unknown> => {
  const o = typeof v === "string" ? JSON.parse(v) : v;
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
};
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Why each iD an audit row dismissed was dismissed. Pure. */
export function reasonsOf(
  r: AuditRow,
): Array<{ orcid: string; reason: string; kept: string | null }> {
  const after = obj(r.after_values);
  const before = obj(r.before_values);
  const ids = Array.isArray(after.dismissed)
    ? after.dismissed.filter((x) => typeof x === "string")
    : [];
  return ids.map((orcid: string) => {
    if (r.action === "orcid_librarian_dismiss") {
      if (after.none_of_these === true) return { orcid, reason: "none_of_these", kept: null };
      if (str(after.with_confirm_of))
        return { orcid, reason: "other_confirmed", kept: str(after.with_confirm_of) };
      return { orcid, reason: "not_this_person", kept: null };
    }
    if (r.action === "orcid_librarian_confirm" || after.authenticated === true)
      return { orcid, reason: "other_confirmed", kept: str(after.orcid) };
    if (after.removed === true && orcid === str(before.orcid))
      return { orcid, reason: "removed", kept: null };
    return { orcid, reason: "not_this_person", kept: null };
  });
}

/** The fill for each unattributed dismissal: the latest audit row that
 *  dismissed the pair no later than `dismissed_at` + slack. Pure. */
export function planFills(dismissals: Dismissal[], audit: AuditRow[]): Fill[] {
  const byPair = new Map<string, Array<{ ts: number; f: Fill }>>();
  for (const r of audit) {
    for (const x of reasonsOf(r)) {
      const k = `${r.target_entity_id}|${x.orcid}`;
      const f = {
        cwid: r.target_entity_id,
        orcid: x.orcid,
        by: r.actor_cwid,
        reason: x.reason,
        kept: x.kept,
      };
      byPair.set(k, [...(byPair.get(k) ?? []), { ts: r.ts.getTime(), f }]);
    }
  }
  const out: Fill[] = [];
  for (const d of dismissals) {
    const limit = d.dismissed_at.getTime() + SLACK_MS;
    const hit = (byPair.get(`${d.cwid}|${d.orcid}`) ?? [])
      .filter((c) => c.ts <= limit)
      .sort((a, b) => b.ts - a.ts)[0];
    if (hit) out.push(hit.f);
  }
  return out;
}

async function connect(url: string | undefined, label: string): Promise<Connection> {
  if (!url) {
    console.error(`${label} not set.`);
    process.exit(1);
  }
  const u = new URL(url);
  return createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.slice(1),
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ro = await connect(
    process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL,
    "DATABASE_URL_RO/DATABASE_URL",
  );
  let fills: Fill[];
  try {
    const dismissals: Dismissal[] = await ro.query(
      "SELECT cwid, orcid, dismissed_at FROM orcid_dismissal WHERE dismissed_by IS NULL",
    );
    const audit: AuditRow[] = await ro.query(
      "SELECT actor_cwid, target_entity_id, action, before_values, after_values, ts " +
        "FROM scholars_audit.manual_edit_audit WHERE target_entity_type = 'scholar' " +
        "AND action IN ('orcid_librarian_dismiss', 'orcid_librarian_confirm', 'orcid_set')",
    );
    fills = planFills(dismissals, audit);
    const byReason = fills.reduce<Record<string, number>>(
      (m, f) => ({ ...m, [f.reason]: (m[f.reason] ?? 0) + 1 }),
      {},
    );
    console.log(
      `${dismissals.length} dismissals without dismissed_by; ${audit.length} ORCID audit rows`,
    );
    console.log(
      `${fills.length} matched ${JSON.stringify(byReason)}; ${dismissals.length - fills.length} stay null`,
    );
  } finally {
    await ro.end();
  }
  if (!apply) {
    console.log("\nDry run only (default). Re-run with --apply to write.");
    return;
  }
  const rw = await connect(process.env.DATABASE_URL, "DATABASE_URL");
  try {
    let n = 0;
    for (const f of fills) {
      const r = await rw.query(
        "UPDATE orcid_dismissal SET dismissed_by = ?, reason = ?, kept_orcid = ? " +
          "WHERE cwid = ? AND orcid = ? AND dismissed_by IS NULL",
        [f.by, f.reason, f.kept, f.cwid, f.orcid],
      );
      n += Number(r.affectedRows);
    }
    console.log(`updated ${n} rows`);
    const seen = await rw.query(
      "INSERT INTO orcid_pair_seen (cwid, orcid, first_queued_at) " +
        "SELECT * FROM (SELECT e.cwid, e.orcid, " +
        "LEAST(e.computed_at, COALESCE(MIN(c.synced_at), e.computed_at)) AS fq " +
        "FROM orcid_candidate_evidence e " +
        "LEFT JOIN orcid_candidate c ON c.cwid = e.cwid AND c.orcid = e.orcid " +
        "GROUP BY e.cwid, e.orcid, e.computed_at) s " +
        "ON DUPLICATE KEY UPDATE first_queued_at = LEAST(orcid_pair_seen.first_queued_at, s.fq)",
    );
    console.log(`orcid_pair_seen: ${Number(seen.affectedRows)} rows affected`);
  } finally {
    await rw.end();
  }
}

// --- self-check ---------------------------------------------------------------
export function selfCheck(): void {
  const t = (s: string) => new Date(`2026-10-01T00:00:${s}Z`);
  const audit: AuditRow[] = [
    {
      actor_cwid: "lib1",
      target_entity_id: "a",
      action: "orcid_librarian_dismiss",
      before_values: {},
      after_values: { dismissed: ["X"], with_confirm_of: "Y" },
      ts: t("01"),
    },
    {
      actor_cwid: "a",
      target_entity_id: "a",
      action: "orcid_set",
      before_values: { orcid: "Z" },
      after_values: JSON.stringify({ orcid: null, removed: true, dismissed: ["Z", "W"] }),
      ts: t("02"),
    },
    {
      actor_cwid: "lib2",
      target_entity_id: "a",
      action: "orcid_librarian_dismiss",
      before_values: {},
      after_values: { dismissed: ["X"], none_of_these: true },
      ts: new Date("2026-10-01T00:05:00Z"),
    },
  ];
  const fills = planFills(
    [
      { cwid: "a", orcid: "X", dismissed_at: t("01") },
      { cwid: "a", orcid: "Z", dismissed_at: t("02") },
      { cwid: "a", orcid: "W", dismissed_at: t("02") },
      { cwid: "a", orcid: "Q", dismissed_at: t("02") },
    ],
    audit,
  );
  const got = Object.fromEntries(fills.map((f) => [f.orcid, `${f.by}:${f.reason}:${f.kept}`]));
  // X: lib2's row is past the slack (a later dismissal of a re-created pair), so lib1's wins.
  const want = { X: "lib1:other_confirmed:Y", Z: "a:removed:null", W: "a:not_this_person:null" };
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`planFills: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}

if (process.argv[1]?.includes("2026-10-28-orcid-dismissal-who-why")) {
  selfCheck();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
