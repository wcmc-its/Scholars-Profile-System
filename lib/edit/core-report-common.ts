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
 * "All cores" (core reports index picker plan, PR 2, 2026-09-28):
 * `center=all&kind=core` (`ALL_CORES`) addresses the roll-up of every catalog
 * core, SUPERUSER ONLY — not comms_steward, not an owner of several cores
 * (`canViewAllCores`). Only reports 11, 12 and 13 support it
 * (`ALL_CORES_REPORTS`); 3 and 6 are hidden under it. Its publication set is
 * the deduped UNION of every core's confirmed set (`loadCoreScope`), so a
 * publication confirmed for two cores counts once.
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

/** The `center` value that addresses every catalog core at once. */
export const ALL_CORES = "all";

/** The display name of the roll-up (the header reads "All cores reports"). */
export const ALL_CORES_NAME = "All cores";

/** The core reports that support `center=all` (11, 12, 13). 3 and 6 don't. */
export const ALL_CORES_REPORTS = ["11", "12", "13"] as const;

export function isAllCores(coreId: string | null | undefined): boolean {
  return coreId === ALL_CORES;
}

/** Who may open the all-cores roll-up: a superuser, nobody else (decided
 *  2026-09-28 — not comms_steward, not a multi-core owner). */
export function canViewAllCores(session: Pick<EditSession, "isSuperuser">): boolean {
  return session.isSuperuser === true;
}

/** The roll-up's stand-in for the single-core `ReportsContext`. */
export const ALL_CORES_CONTEXT: ReportsContext = { unit: { name: ALL_CORES_NAME } };

/** A report's core scope: the core ids it reads, the confirmed PMIDs per core,
 *  and their deduped union (a PMID under two cores appears once). */
export type CoreScope = {
  coreIds: string[];
  byCore: Map<string, string[]>;
  pmids: string[];
};

/** Every catalog core id (the roll-up's scope). */
export async function loadAllCoreIds(): Promise<string[]> {
  const rows = await db.read.core.findMany({ select: { id: true } });
  return rows.map((r) => r.id);
}

/** The deduped union of a per-core PMID map, in first-seen order. Pure. */
export function unionPmids(byCore: ReadonlyMap<string, readonly string[]>): string[] {
  const out = new Set<string>();
  for (const pmids of byCore.values()) for (const p of pmids) out.add(p);
  return [...out];
}

/** `coreId`'s scope — one core, or every catalog core for `ALL_CORES`. */
export async function loadCoreScope(coreId: string): Promise<CoreScope> {
  const coreIds = isAllCores(coreId) ? await loadAllCoreIds() : [coreId];
  const byCore = await loadConfirmedCorePmidsByCore(coreIds, db.read);
  return { coreIds, byCore, pmids: unionPmids(byCore) };
}

/** This core's effective-confirmed PMIDs (see the module comment); for
 *  `ALL_CORES`, the deduped union over every catalog core. */
export async function loadCoreConfirmedPmids(coreId: string): Promise<string[]> {
  if (isAllCores(coreId)) return (await loadCoreScope(coreId)).pmids;
  return (await loadConfirmedCorePmidsByCore([coreId], db.read)).get(coreId) ?? [];
}

/** A PMID list in batches, so an `IN (…)` never grows without bound. */
export function chunk<T>(xs: readonly T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** The download routes' gate: a session, a `center` (the core id), and the
 *  page's own core gate. Returns the core or a ready error response.
 *  `center=all` is the all-cores roll-up: a superuser only, anyone else 403s. */
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
  if (isAllCores(coreId)) {
    if (!canViewAllCores(identity.session))
      return { ok: false, response: editError(403, "not_core_owner") };
    return { ok: true, coreId, ctx: ALL_CORES_CONTEXT, session: identity.session };
  }
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

/** A download's file name: `<core> <rest>.xlsx` for one core, and
 *  `all-cores-<rest, hyphenated>.xlsx` for the roll-up (the mockup's name). */
export function coreXlsxName(coreId: string, coreName: string, rest: string): string {
  if (isAllCores(coreId)) return `all-cores-${rest.trim().replace(/\s+/g, "-")}.xlsx`;
  return `${fileSafe(coreName)} ${rest}.xlsx`;
}

/** What a workbook's Criteria sheet says about the core. One core: its name.
 *  The roll-up: "All N" in the Core row (the mockup's criteria) plus the
 *  counting note, so a reader knows a shared publication is not double-counted. */
export type CriteriaCore = string | { allCount: number };

export const ALL_CORES_COUNTING_NOTE =
  "Rolled up across every core facility. A publication confirmed for more than one core counts once.";

/** The "Core" and "Generated" rows every Criteria sheet opens with. */
export function coreCriteriaHead(
  report: string,
  core: CriteriaCore,
  generatedAt: Date,
): [string, string][] {
  if (typeof core !== "string") {
    return [
      ["Report", report],
      ["Core", `All ${core.allCount}`],
      ["Roll-up", ALL_CORES_COUNTING_NOTE],
      ["Generated", generatedAt.toISOString()],
    ];
  }
  return [
    ["Report", report],
    ["Core", core],
    ["Generated", generatedAt.toISOString()],
  ];
}

/** The `CriteriaCore` for a gate result: the core's name, or "All N". */
export function criteriaCore(coreId: string, coreName: string, scope: CoreScope): CriteriaCore {
  return isAllCores(coreId) ? { allCount: scope.coreIds.length } : coreName;
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
