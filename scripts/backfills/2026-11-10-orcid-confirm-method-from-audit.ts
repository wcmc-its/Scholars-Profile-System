/**
 * One-time backfill for #3115 item 5: fill `scholar.orcid_confirm_method` and
 * `orcid_confirmed_by` on iDs confirmed in `/edit` before those columns existed
 * (added 2026-10-24). The writer then was `POST /api/edit/orcid`, which audits
 * `orcid_set`; the method follows the route's own rule: `self` when the real
 * actor is the scholar, `proxy` otherwise.
 *
 * A scholar is matched to the LATEST `orcid_set` audit row that set the same iD
 * now on file. Only rows with `orcid_confirm_method IS NULL` are touched, and
 * `orcid_confirmed_at` is filled only when it is null too. No match = stays null.
 * The 2026-11-10 prod probe found 16 such iDs, all with a matching audit row.
 *
 * Two connections, as in 2026-10-28-orcid-dismissal-who-why.ts: the etl role
 * can't read `scholars_audit`, so planning reads over DATABASE_URL_RO and only
 * the UPDATE uses DATABASE_URL.
 *
 * Dry-run by default; pass --apply to write. Prints counts only (public repo).
 *   npx tsx scripts/backfills/2026-11-10-orcid-confirm-method-from-audit.ts [--apply]
 */
import "dotenv/config";
import { createConnection, type Connection } from "mariadb";
import { connectionOptionsFromDsn } from "@/lib/db-tls";

type AuditRow = { actor_cwid: string; target_entity_id: string; after_values: unknown; ts: Date };
type Held = { cwid: string; orcid: string };
export type Fill = { cwid: string; orcid: string; method: "self" | "proxy"; by: string; at: Date };

const obj = (v: unknown): Record<string, unknown> => {
  const o = typeof v === "string" ? JSON.parse(v) : v;
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
};

/** For each held iD, the latest `orcid_set` row that set exactly it. Pure. */
export function planFills(held: Held[], audit: AuditRow[]): Fill[] {
  const latest = new Map<string, AuditRow>();
  for (const r of audit) {
    const orcid = obj(r.after_values).orcid;
    if (typeof orcid !== "string") continue;
    const k = `${r.target_entity_id}|${orcid}`;
    const prev = latest.get(k);
    if (!prev || r.ts.getTime() > prev.ts.getTime()) latest.set(k, r);
  }
  return held.flatMap((h) => {
    const r = latest.get(`${h.cwid}|${h.orcid}`);
    if (!r) return [];
    const method = r.actor_cwid === h.cwid ? ("self" as const) : ("proxy" as const);
    return [{ cwid: h.cwid, orcid: h.orcid, method, by: r.actor_cwid, at: r.ts }];
  });
}

async function connect(url: string | undefined, label: string): Promise<Connection> {
  if (!url) {
    console.error(`${label} not set.`);
    process.exit(1);
  }
  return createConnection(connectionOptionsFromDsn(url));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ro = await connect(
    process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL,
    "DATABASE_URL_RO/DATABASE_URL",
  );
  let fills: Fill[];
  try {
    const held: Held[] = await ro.query(
      "SELECT cwid, orcid FROM scholar WHERE orcid IS NOT NULL AND orcid_confirm_method IS NULL",
    );
    const audit: AuditRow[] = await ro.query(
      "SELECT actor_cwid, target_entity_id, after_values, ts " +
        "FROM scholars_audit.manual_edit_audit " +
        "WHERE target_entity_type = 'scholar' AND action = 'orcid_set'",
    );
    fills = planFills(held, audit);
    const byMethod = fills.reduce<Record<string, number>>(
      (m, f) => ({ ...m, [f.method]: (m[f.method] ?? 0) + 1 }),
      {},
    );
    console.log(`${held.length} iDs on file with no confirm method; ${audit.length} orcid_set audit rows`);
    console.log(`${fills.length} matched ${JSON.stringify(byMethod)}; ${held.length - fills.length} stay null`);
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
        "UPDATE scholar SET orcid_confirm_method = ?, orcid_confirmed_by = ?, " +
          "orcid_confirmed_at = COALESCE(orcid_confirmed_at, ?) " +
          "WHERE cwid = ? AND orcid = ? AND orcid_confirm_method IS NULL",
        [f.method, f.by, f.at, f.cwid, f.orcid],
      );
      n += Number(r.affectedRows);
    }
    console.log(`updated ${n} rows`);
  } finally {
    await rw.end();
  }
}

// --- self-check ---------------------------------------------------------------
export function selfCheck(): void {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m));
  const audit: AuditRow[] = [
    { actor_cwid: "a", target_entity_id: "a", after_values: { orcid: "X" }, ts: t(1) },
    // b's iD set by a proxy, then re-set by b: the latest row wins.
    { actor_cwid: "p", target_entity_id: "b", after_values: { orcid: "Y" }, ts: t(1) },
    { actor_cwid: "b", target_entity_id: "b", after_values: JSON.stringify({ orcid: "Y" }), ts: t(2) },
    { actor_cwid: "p", target_entity_id: "c", after_values: { orcid: "Z" }, ts: t(1) },
    // A remove (orcid null) and a different iD never match.
    { actor_cwid: "d", target_entity_id: "d", after_values: { orcid: null, removed: true }, ts: t(3) },
    { actor_cwid: "d", target_entity_id: "d", after_values: { orcid: "OTHER" }, ts: t(4) },
  ];
  const fills = planFills(
    [
      { cwid: "a", orcid: "X" },
      { cwid: "b", orcid: "Y" },
      { cwid: "c", orcid: "Z" },
      { cwid: "d", orcid: "W" },
    ],
    audit,
  );
  const got = Object.fromEntries(fills.map((f) => [f.cwid, `${f.method}:${f.by}`]));
  const want = { a: "self:a", b: "self:b", c: "proxy:p" };
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`planFills: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}

if (process.argv[1]?.includes("2026-11-10-orcid-confirm-method-from-audit")) {
  selfCheck();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
