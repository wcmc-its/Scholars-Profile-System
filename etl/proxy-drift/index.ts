/**
 * #779 — scholar-assigned proxy editor D3 DRIFT AUDIT runner
 * (scholar-proxy-spec.md § Audit queries, query D).
 *
 * Thin CLI around `auditProxyDrift` (lib/edit/proxy-drift.ts), mirroring
 * etl/search-reconcile/index.ts. Intended to run on a daily cadence; the
 * EventBridge schedule + the CloudWatch metric-filter → on-call relay are the
 * infra follow-on (mirrors #393: PR-1 #580 shipped the worker, PR-2 #582 wired
 * the schedule + alarm).
 *
 *   tsx etl/proxy-drift/index.ts
 *
 * Each drifted grant is emitted as one `proxy_drift_detected` WARN line — the
 * alerting contract a metric filter keys on — followed by a `proxy_drift_summary`
 * line and a human-readable table. A drift hit is NOT a job failure: the
 * per-edit re-check already denies the proxy path, so the run exits 0 whether or
 * not drift is found. Exit 1 is reserved for a crash, so the scheduler/alarm
 * distinguishes "audit ran, found drift" from "audit broke".
 */
import { db } from "@/lib/db";
import { auditProxyDrift, type ProxyDriftLookup } from "@/lib/edit/proxy-drift";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: tsx etl/proxy-drift/index.ts");
    process.exit(0);
  }

  const result = await auditProxyDrift(db.read as unknown as ProxyDriftLookup);

  for (const hit of result.drifted) {
    console.warn(
      JSON.stringify({
        event: "proxy_drift_detected",
        scholar_cwid: hit.scholarCwid,
        proxy_cwid: hit.proxyCwid,
        conflicting_role: hit.conflictingRole,
        granted_at: hit.grantedAt.toISOString(),
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "proxy_drift_summary",
      total_grants: result.totalGrants,
      drift_count: result.drifted.length,
    }),
  );

  if (result.drifted.length > 0) {
    console.log(
      `\n${result.drifted.length} drifted proxy grant(s) — revoke manually ` +
        `(POST /api/edit/proxy {action:"revoke"}):`,
    );
    for (const hit of result.drifted) {
      const role = hit.conflictingRole === "proxy_is_scholar" ? "a Scholar" : "a UnitAdmin";
      console.log(
        `  proxy ${hit.proxyCwid} → scholar ${hit.scholarCwid}  ` +
          `[now ${role}]  granted ${hit.grantedAt.toISOString()}`,
      );
    }
  } else {
    console.log(`No proxy-grant drift: ${result.totalGrants} active grant(s), all clean.`);
  }

  // Explicit exit: tsx + the Prisma pool keep the event loop alive otherwise
  // (the run would hang after "wrote" — same reason etl/search-reconcile exits
  // explicitly). 0 = the audit completed, drift or not.
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "proxy_drift_crashed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
