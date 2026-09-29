/**
 * What the three core-only reports (11 Core users, 12 Output over time,
 * 13 Grants citing the core) share: the query-string plumbing that keeps a
 * core addressed (`center=<coreId>&kind=core`, the same pair the reports
 * index and report 3 use), the ONE confirmed-publication set every one of
 * them reads, and the download routes' gate + response.
 *
 * The publication set is `loadConfirmedCorePmidsByCore` (`lib/api/cores.ts`),
 * never a hand-rolled merge: engine `confirmed` minus an active `rejected`
 * claim, plus every active `claimed` claim — a manual PMID add with no
 * `publication_core` row included (`lib/api/core-merge.ts` owns the rule).
 *
 * The gate is `loadReportsContext(code, session, db, "core")` — the page's
 * own gate for a core (`getCoreOwnerRole` + `authorizeCoreClaim`: superuser,
 * comms_steward, this core's Owner or Curator), which also logs a denial.
 *
 * Server-only (`@/lib/db`).
 */
import { NextResponse } from "next/server";

import { loadConfirmedCorePmidsByCore } from "@/lib/api/cores";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { loadReportsContext, type ReportsContext } from "@/lib/edit/cancer-center-reports";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

/** Next's `searchParams` object → `URLSearchParams` (a repeated key is an array). */
export function toSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** The two params that address a core on every report link and form. */
export function coreScopeParams(coreId: string): [string, string][] {
  return [
    ["center", coreId],
    ["kind", "core"],
  ];
}

/** `center=<coreId>&kind=core` + `rest`, as a query string. */
export function coreQueryString(
  coreId: string,
  rest: URLSearchParams = new URLSearchParams(),
): string {
  const q = new URLSearchParams(coreScopeParams(coreId));
  for (const [k, v] of rest) q.append(k, v);
  return q.toString();
}

/** This core's effective-confirmed PMIDs (see the module comment). */
export async function loadCoreConfirmedPmids(coreId: string): Promise<string[]> {
  return (await loadConfirmedCorePmidsByCore([coreId], db.read)).get(coreId) ?? [];
}

/** A PMID list in batches, so an `IN (…)` never grows without bound. */
export function chunk<T>(xs: readonly T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** The download routes' gate: a session, a `center` (the core id), and the
 *  page's own core gate. Returns the core or a ready error response. */
export async function gateCoreReportDownload(
  sp: URLSearchParams,
): Promise<
  | { ok: true; coreId: string; ctx: ReportsContext; session: EditSession }
  | { ok: false; response: NextResponse }
> {
  const identity = await resolveEditIdentity();
  if (!identity) return { ok: false, response: editError(401, "unauthenticated") };
  const coreId = sp.get("center");
  if (!coreId) return { ok: false, response: editError(400, "missing_center", "center") };
  const ctx = await loadReportsContext(coreId, identity.session, db.read, "core");
  if (ctx === null) return { ok: false, response: editError(403, "not_core_owner") };
  return { ok: true, coreId, ctx, session: identity.session };
}

/** The `.xlsx` response every report download sends. */
export function xlsxResponse(buffer: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}

/** A file-name-safe core name. */
export function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "core";
}

/** The "Core" and "Generated" rows every Criteria sheet opens with. */
export function coreCriteriaHead(
  report: string,
  coreName: string,
  generatedAt: Date,
): [string, string][] {
  return [
    ["Report", report],
    ["Core", coreName],
    ["Generated", generatedAt.toISOString()],
  ];
}

/** The year-window select values: this year back 30. */
export function yearOptions(now: Date = new Date()): number[] {
  const thisYear = now.getUTCFullYear();
  return Array.from({ length: 30 }, (_, i) => thisYear - i);
}

/** An integer year param clamped to 1900..2100, or null when absent / junk. */
export function parseYear(v: string | null): number | null {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : null;
}
