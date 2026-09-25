/**
 * Functional role assignments (`functional_role_grant`): the loader, the
 * audited manual writes behind `POST /api/edit/functional-roles`, and the
 * import that mirrors existing holders into the table.
 *
 * Roles (`lib/edit/functional-roles.ts`): External Affairs, one role whose
 * functions (Communications, Development) are the grant's scopes, and
 * Reporting. Access has always come from:
 *   - External Affairs · Communications = the `comms_steward` role (ED group,
 *     or the `SCHOLARS_COMMS_STEWARD_ALLOWLIST` break-glass list);
 *   - External Affairs · Development = the `development` role (ED group, or
 *     `SCHOLARS_DEVELOPMENT_ALLOWLIST`);
 *   - Reporting = `report_access` rows.
 * Those keep working. With `FUNCTIONAL_ROLES_AUTHZ` "on" the gates ALSO admit
 * a MANUAL registry grant (additive, `lib/auth/functional-role-authz.ts`);
 * imported rows never admit anyone (they would outlive a revoke at their
 * source until the next import). While the flag is off, a manual row here
 * records an assignment and grants nothing.
 *
 * What the import can see. `report_access` is a table, so every holder is
 * imported (one Reporting row per person, scopes = the reports they hold).
 * The two allowlists are env lists and are imported as-is (both are empty in
 * every deployed env today) into ONE External Affairs row per person, with
 * Communications for the comms-steward list and Development for the
 * development list (both when on both). The ED groups CANNOT be imported: the read-only
 * bind account can `compare` a member but not read the member list
 * (`lib/auth/ldap-group.ts`), so group-only holders are invisible to any
 * enumeration. Record them as manual rows, or get a bind that can read
 * `member`.
 *
 * Imported rows (`source` ≠ "manual") are read-only on the page, like
 * ED-sourced `unit_admin` grants: the manual writes below only ever address
 * the `(role, cwid, "manual")` key, so they cannot touch an imported row. The
 * import reconciles only imported rows: it adds, re-scopes and removes rows
 * whose source changed, and never touches a manual row.
 *
 * Reader vs writer: every write probes, writes and re-reads on the WRITER
 * (inside its transaction), and hands back the list it re-read; only the
 * page's server render uses the reader (`report-access.ts`'s rule, PR #2620).
 *
 * Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { EditSession } from "@/lib/auth/superuser";
import { listCommsStewardCwids } from "@/lib/auth/comms-steward";
import { listDevelopmentAllowlistCwids } from "@/lib/auth/development";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  ALL_SCOPE,
  ALLOWLIST_GRANTER,
  EXTERNAL_AFFAIRS_SCOPE_OPTIONS,
  FUNCTIONAL_ROLES,
  isFunctionalRole,
  normalizeScopes,
  sameScopes,
  scopesFromJson,
  type ExternalAffairsFunction,
  type FunctionalRole,
  type FunctionalRoleRow,
  type GateHolder,
  type FunctionalRoleScopeOption,
  type FunctionalRoleScopeOptions,
} from "@/lib/edit/functional-roles";
import { REPORT_ACCESS_SCOPE_OPTIONS } from "@/lib/edit/report-access";
import { REPORT_META_DEFAULTS } from "@/lib/edit/report-meta";

/** Superuser only: these are institution-wide roles, so a unit Owner (who
 *  can open the Administrators page for their own units) neither sees nor
 *  manages them. */
export function canManageFunctionalRoles(session: Pick<EditSession, "isSuperuser">): boolean {
  return session.isSuperuser;
}

/** The report's display name by `report_access.report_key` (= its slug). */
function reportName(reportKey: string): string {
  for (const meta of Object.values(REPORT_META_DEFAULTS)) {
    if (meta.slug === reportKey) return meta.name;
  }
  return reportKey;
}

/**
 * Reporting's scope options: "All reports", then each person-grantable report
 * (`REPORT_ACCESS_SCOPE_OPTIONS`) as a whole, then each of its sub-scopes
 * ("Mentored publications · MD"). Keys: `"*"`, `reportKey`,
 * `"reportKey:scope"`: the same shape the import writes.
 */
export function reportingScopeOptions(): FunctionalRoleScopeOption[] {
  const out: FunctionalRoleScopeOption[] = [{ key: ALL_SCOPE, label: "All reports" }];
  for (const [reportKey, options] of Object.entries(REPORT_ACCESS_SCOPE_OPTIONS)) {
    const name = reportName(reportKey);
    out.push({ key: reportKey, label: name });
    for (const [scopeKey, label] of options) {
      if (scopeKey === ALL_SCOPE) continue;
      out.push({ key: `${reportKey}:${scopeKey}`, label: `${name} · ${label}` });
    }
  }
  return out;
}

/** Every role's scope options, for the page and for route validation. */
export function functionalRoleScopeOptions(): FunctionalRoleScopeOptions {
  return {
    external_affairs: EXTERNAL_AFFAIRS_SCOPE_OPTIONS,
    reporting: reportingScopeOptions(),
  };
}

/** Whether every key is a valid scope for `role` (and there is at least one). */
export function validScopes(role: FunctionalRole, scopes: ReadonlyArray<string>): boolean {
  if (scopes.length === 0) return false;
  const allowed = new Set(functionalRoleScopeOptions()[role].map((o) => o.key));
  return scopes.every((s) => allowed.has(s));
}

type ReaderClient = Pick<PrismaClient, "functionalRoleGrant" | "scholar">;

/**
 * Every functional-role row, each with its holder's display name/title and
 * the granter's name resolved from `Scholar` (one `findMany`). Sorted by
 * name, then role. Defaults to the READER; the writes pass their transaction.
 */
export async function listFunctionalRoles(
  client: ReaderClient = db.read,
): Promise<FunctionalRoleRow[]> {
  const rows = await client.functionalRoleGrant.findMany({
    orderBy: [{ cwid: "asc" }, { role: "asc" }, { source: "asc" }],
  });
  if (rows.length === 0) return [];
  const cwids = [...new Set(rows.flatMap((r) => [r.cwid, r.grantedBy]))];
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true, primaryTitle: true },
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));
  const out: FunctionalRoleRow[] = [];
  for (const r of rows) {
    // A role value this build doesn't know (a later build wrote it) is
    // skipped rather than rendered under a wrong label.
    if (!isFunctionalRole(r.role)) continue;
    const s = byCwid.get(r.cwid);
    out.push({
      role: r.role,
      cwid: r.cwid,
      source: r.source,
      scopes: scopesFromJson(r.scopes),
      name: s?.preferredName ?? r.granteeName ?? r.cwid,
      title: s?.primaryTitle ?? null,
      granteeName: r.granteeName,
      grantedBy: r.grantedBy,
      grantedByName: byCwid.get(r.grantedBy)?.preferredName ?? null,
      grantedAt: r.grantedAt.toISOString(),
    });
  }
  out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.cwid.localeCompare(b.cwid) ||
      FUNCTIONAL_ROLES.indexOf(a.role) - FUNCTIONAL_ROLES.indexOf(b.role) ||
      a.source.localeCompare(b.source),
  );
  return out;
}

/**
 * Everyone who holds a functional role through an EXISTING gate that can be
 * enumerated, for the parity check (`parityGaps`): every `report_access` row
 * (Reporting), and each cwid on the comms-steward / development break-glass
 * allowlists (External Affairs · Communications / · Development; empty while
 * that role's kill switch is off, since the list then confers nothing).
 *
 * NOT included, because they cannot be listed: members of the comms-steward
 * and development ED groups (the bind account can only `compare` a member,
 * `lib/auth/ldap-group.ts`). The parity check is therefore complete for
 * Reporting and the allowlists, and blind to group-only holders; the page and
 * the script both say so.
 */
export async function listGateHolders(
  client: Pick<PrismaClient, "reportAccess"> = db.read,
): Promise<GateHolder[]> {
  const out: GateHolder[] = [];
  const reportAccess = await client.reportAccess.findMany({
    select: { reportKey: true, scopeKey: true, cwid: true, granteeName: true },
    orderBy: [{ cwid: "asc" }, { reportKey: "asc" }, { scopeKey: "asc" }],
  });
  for (const r of reportAccess) {
    out.push({
      role: "reporting",
      cwid: r.cwid.toLowerCase(),
      name: r.granteeName,
      reportKey: r.reportKey,
      scope: r.scopeKey,
      via: "report_access",
    });
  }
  for (const cwid of listCommsStewardCwids()) {
    out.push({
      role: "external_affairs",
      cwid,
      name: null,
      scope: "communications",
      via: "comms_steward_allowlist",
    });
  }
  for (const cwid of listDevelopmentAllowlistCwids()) {
    out.push({
      role: "external_affairs",
      cwid,
      name: null,
      scope: "development",
      via: "development_allowlist",
    });
  }
  return out;
}

export type FunctionalRoleWriteResult = {
  /** False for an idempotent no-op (already granted, same scopes, nothing to revoke). */
  changed: boolean;
  /** The full list AFTER the write, read on the writer. */
  rows: FunctionalRoleRow[];
};

type WriteArgs = {
  role: FunctionalRole;
  cwid: string;
  /** The REAL signed-in human (audit `actor_cwid`, `granted_by`). */
  actorCwid: string;
  impersonatedCwid?: string | null;
  requestId?: string | null;
};

const MANUAL = "manual";

function targetId(role: string, cwid: string, source: string): string {
  return `${role}:${cwid}:${source}`;
}

type StoredRow = {
  role: string;
  cwid: string;
  source: string;
  scopes: unknown;
  granteeName: string | null;
  grantedBy: string;
  grantedAt: Date;
};

/** The audit snapshot of one row. */
function snapshot(row: StoredRow): Record<string, unknown> {
  return {
    role: row.role,
    cwid: row.cwid,
    source: row.source,
    scopes: scopesFromJson(row.scopes),
    grantee_name: row.granteeName,
    granted_by: row.grantedBy,
    granted_at: row.grantedAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

function manualKey(role: string, cwid: string) {
  return { role_cwid_source: { role, cwid, source: MANUAL } };
}

/**
 * Create a manual `(role, cwid)` assignment with its audit row, in one
 * transaction. Idempotent for a repeat of the SAME assignment: an existing
 * manual row with the same scopes is left alone and not re-audited
 * (`changed: false`). An existing manual row with DIFFERENT scopes is a
 * conflict (`conflict: true`, nothing written): the request asked for scopes
 * the person does not end up with, so the caller must say so rather than
 * report success; re-scoping is `setFunctionalRoleScopes` ("Edit scope").
 * The caller validates the role, cwid and scopes first.
 */
export async function grantFunctionalRole(
  args: WriteArgs & { scopes: ReadonlyArray<string>; granteeName?: string | null },
): Promise<FunctionalRoleWriteResult & { conflict: boolean }> {
  const { role, cwid, actorCwid } = args;
  const requested = normalizeScopes(args.scopes);
  const existingOutcome = async (): Promise<
    (FunctionalRoleWriteResult & { conflict: boolean }) | null
  > => {
    const existing = await db.write.functionalRoleGrant.findUnique({
      where: manualKey(role, cwid),
      select: { scopes: true },
    });
    if (!existing) return null;
    return {
      changed: false,
      conflict: !sameScopes(scopesFromJson(existing.scopes), requested),
      rows: await listFunctionalRoles(db.write),
    };
  };
  const already = await existingOutcome();
  if (already) return already;
  try {
    const rows = await db.write.$transaction(async (tx) => {
      const row = await tx.functionalRoleGrant.create({
        data: {
          role,
          cwid,
          source: MANUAL,
          scopes: requested,
          granteeName: args.granteeName ?? null,
          grantedBy: actorCwid,
        },
      });
      await appendAuditRow(tx, {
        actorCwid,
        impersonatedCwid: args.impersonatedCwid ?? null,
        targetEntityType: "functional_role",
        targetEntityId: targetId(role, cwid, MANUAL),
        action: "functional_role_grant",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: snapshot(row),
        ts: new Date(),
        requestId: args.requestId ?? null,
      });
      return listFunctionalRoles(tx);
    });
    return { changed: true, conflict: false, rows };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a concurrent-grant race: the other request wrote and audited it.
    // Same scopes ⇒ idempotent; different scopes ⇒ the same conflict as above.
    return (
      (await existingOutcome()) ?? {
        changed: false,
        conflict: false,
        rows: await listFunctionalRoles(db.write),
      }
    );
  }
}

/**
 * Replace a manual assignment's scopes ("Edit scope"), audited as
 * `functional_role_scope_set` with before/after scope lists. `found: false`
 * when there is no manual row for `(role, cwid)`: an imported row is never
 * addressed, so a stale page cannot re-scope one.
 */
export async function setFunctionalRoleScopes(
  args: WriteArgs & { scopes: ReadonlyArray<string> },
): Promise<FunctionalRoleWriteResult & { found: boolean }> {
  const { role, cwid, actorCwid } = args;
  const next = normalizeScopes(args.scopes);
  const existing = await db.write.functionalRoleGrant.findUnique({ where: manualKey(role, cwid) });
  if (!existing) return { found: false, changed: false, rows: await listFunctionalRoles(db.write) };
  if (sameScopes(scopesFromJson(existing.scopes), next)) {
    return { found: true, changed: false, rows: await listFunctionalRoles(db.write) };
  }
  const rows = await db.write.$transaction(async (tx) => {
    const row = await tx.functionalRoleGrant.update({
      where: manualKey(role, cwid),
      data: { scopes: next },
    });
    await appendAuditRow(tx, {
      actorCwid,
      impersonatedCwid: args.impersonatedCwid ?? null,
      targetEntityType: "functional_role",
      targetEntityId: targetId(role, cwid, MANUAL),
      action: "functional_role_scope_set",
      fieldsChanged: ["scopes"],
      beforeValues: { scopes: scopesFromJson(existing.scopes) },
      afterValues: { scopes: scopesFromJson(row.scopes) },
      ts: new Date(),
      requestId: args.requestId ?? null,
    });
    return listFunctionalRoles(tx);
  });
  return { found: true, changed: true, rows };
}

/** Delete a manual assignment with its audit row. Revoking one that does not
 *  exist is an idempotent no-op with no audit row. */
export async function revokeFunctionalRole(args: WriteArgs): Promise<FunctionalRoleWriteResult> {
  const { role, cwid, actorCwid } = args;
  const existing = await db.write.functionalRoleGrant.findUnique({ where: manualKey(role, cwid) });
  if (!existing) return { changed: false, rows: await listFunctionalRoles(db.write) };
  const rows = await db.write.$transaction(async (tx) => {
    await tx.functionalRoleGrant.delete({ where: manualKey(role, cwid) });
    await appendAuditRow(tx, {
      actorCwid,
      impersonatedCwid: args.impersonatedCwid ?? null,
      targetEntityType: "functional_role",
      targetEntityId: targetId(role, cwid, MANUAL),
      action: "functional_role_revoke",
      fieldsChanged: null,
      beforeValues: snapshot(existing),
      afterValues: null,
      ts: new Date(),
      requestId: args.requestId ?? null,
    });
    return listFunctionalRoles(tx);
  });
  return { changed: true, rows };
}

// ─── Import ──────────────────────────────────────────────────────────────────

/** One row the import wants to exist. */
export type ImportedRow = {
  role: FunctionalRole;
  cwid: string;
  source: "report_access" | "allowlist";
  scopes: string[];
  granteeName: string | null;
  grantedBy: string;
  grantedAt: Date | null;
};

export type ImportInputs = {
  reportAccess: ReadonlyArray<{
    reportKey: string;
    scopeKey: string;
    cwid: string;
    grantedBy: string;
    grantedAt: Date;
    granteeName: string | null;
  }>;
  commsStewardCwids: ReadonlyArray<string>;
  developmentCwids: ReadonlyArray<string>;
};

/** A report_access row's Reporting scope key: the report for a wildcard row,
 *  `reportKey:scope` otherwise. */
export function reportAccessScopeKey(reportKey: string, scopeKey: string): string {
  return scopeKey === ALL_SCOPE ? reportKey : `${reportKey}:${scopeKey}`;
}

/** Drop `report:x` keys made redundant by a whole-report key for `report`. */
function collapseReportScopes(keys: ReadonlyArray<string>): string[] {
  const whole = new Set(keys.filter((k) => !k.includes(":")));
  return normalizeScopes(keys.filter((k) => !k.includes(":") || !whole.has(k.split(":")[0]!)));
}

/**
 * What the imported part of the table should hold, from its sources. Pure.
 *   - `report_access`: one Reporting row per cwid, scopes = every report
 *     scope they hold; the earliest grant's granter/time/name stand for the row.
 *   - allowlists: one External Affairs row per listed cwid. Its functions
 *     are the lists the cwid is on: the comms-steward list adds
 *     Communications, the development list adds Development.
 */
export function desiredImportedRows(inputs: ImportInputs): ImportedRow[] {
  const out: ImportedRow[] = [];
  const byCwid = new Map<string, ImportInputs["reportAccess"][number][]>();
  for (const r of inputs.reportAccess) {
    const list = byCwid.get(r.cwid) ?? [];
    list.push(r);
    byCwid.set(r.cwid, list);
  }
  for (const [cwid, list] of byCwid) {
    const first = [...list].sort((a, b) => a.grantedAt.getTime() - b.grantedAt.getTime())[0]!;
    out.push({
      role: "reporting",
      cwid,
      source: "report_access",
      scopes: collapseReportScopes(list.map((r) => reportAccessScopeKey(r.reportKey, r.scopeKey))),
      granteeName: list.find((r) => r.granteeName)?.granteeName ?? null,
      grantedBy: first.grantedBy,
      grantedAt: first.grantedAt,
    });
  }
  // One External Affairs row per allowlisted person; the lists they appear on
  // are its functions (someone on both lists gets one row with both).
  const functions = new Map<string, Set<ExternalAffairsFunction>>();
  const allowlisted: Array<[ExternalAffairsFunction, ReadonlyArray<string>]> = [
    ["communications", inputs.commsStewardCwids],
    ["development", inputs.developmentCwids],
  ];
  for (const [fn, cwids] of allowlisted) {
    for (const cwid of cwids.map((c) => c.trim().toLowerCase()).filter(Boolean)) {
      const set = functions.get(cwid) ?? new Set<ExternalAffairsFunction>();
      set.add(fn);
      functions.set(cwid, set);
    }
  }
  for (const [cwid, fns] of functions) {
    out.push({
      role: "external_affairs",
      cwid,
      source: "allowlist",
      scopes: normalizeScopes([...fns]),
      granteeName: null,
      grantedBy: ALLOWLIST_GRANTER,
      grantedAt: null,
    });
  }
  return out;
}

export type ImportResult = {
  added: number;
  updated: number;
  removed: number;
  rows: FunctionalRoleRow[];
};

/** Keys per import transaction. Each chunk is its own short transaction
 *  (bulk `createMany` / `deleteMany`, one `update` per changed row, one audit
 *  row per change), so the import's size never meets the interactive
 *  transaction timeout the way one all-rows transaction would. */
export const IMPORT_CHUNK_SIZE = 100;
/** Explicit, well above Prisma's 5s interactive default: one chunk is at
 *  most IMPORT_CHUNK_SIZE audit inserts plus a few bulk statements. */
export const IMPORT_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

type RowKey = { role: string; cwid: string; source: string };

/** Which fields of a stored imported row differ from what its source says.
 *  `granted_at` is only compared when the source has a time (allowlists
 *  don't), and `grantee_name` only when the source has a name (a stored name
 *  is never cleared by a nameless source). */
function changedFields(have: StoredRow, d: ImportedRow): string[] {
  const out: string[] = [];
  if (!sameScopes(scopesFromJson(have.scopes), d.scopes)) out.push("scopes");
  if (have.grantedBy !== d.grantedBy) out.push("granted_by");
  if (d.grantedAt && have.grantedAt.getTime() !== d.grantedAt.getTime()) out.push("granted_at");
  if (d.granteeName && have.granteeName !== d.granteeName) out.push("grantee_name");
  return out;
}

function pickFields(row: StoredRow, fields: ReadonlyArray<string>): Record<string, unknown> {
  const all = snapshot(row);
  return Object.fromEntries(fields.map((f) => [f, all[f]]));
}

/**
 * Reconcile the imported rows with their sources: add missing rows, refresh
 * changed ones (scopes AND provenance: `granted_by` / `granted_at` /
 * `grantee_name` follow the source, so revoking the earliest `report_access`
 * grant moves the row's "added by" to the next one), and delete rows whose
 * source no longer lists them. Manual rows are never read for the diff or
 * written. Every change is audited (`functional_role_grant`,
 * `functional_role_scope_set` when scopes changed, `functional_role_update`
 * for provenance only, `functional_role_revoke`; `via: "import"` in the
 * values) under the actor who ran the import.
 *
 * Batched: the keys are split into chunks of IMPORT_CHUNK_SIZE, and each
 * chunk re-reads its stored rows, diffs, and writes them with their audit
 * rows in ONE transaction (IMPORT_TX_OPTIONS). A failure leaves earlier
 * chunks committed, each consistent with its audit rows; re-running
 * converges. Idempotent: a second run with unchanged sources changes nothing.
 */
export async function importFunctionalRoles(args: {
  actorCwid: string;
  impersonatedCwid?: string | null;
  requestId?: string | null;
}): Promise<ImportResult> {
  const reportAccess = await db.write.reportAccess.findMany({
    select: {
      reportKey: true,
      scopeKey: true,
      cwid: true,
      grantedBy: true,
      grantedAt: true,
      granteeName: true,
    },
  });
  const desired = desiredImportedRows({
    reportAccess,
    commsStewardCwids: listCommsStewardCwids(),
    developmentCwids: listDevelopmentAllowlistCwids(),
  });
  // Allowlists carry no grant time: a new row takes the run's time (set here,
  // not left to the DB default, so the audit snapshot matches the row).
  const now = new Date();
  const key = (r: RowKey) => targetId(r.role, r.cwid, r.source);
  const desiredByKey = new Map(desired.map((d) => [key(d), d]));

  // The key universe: every imported row there is, and every one there should be.
  const currentKeys = await db.write.functionalRoleGrant.findMany({
    where: { source: { not: MANUAL } },
    select: { role: true, cwid: true, source: true },
  });
  const universe = new Map<string, RowKey>();
  for (const r of [...currentKeys, ...desired]) {
    universe.set(key(r), { role: r.role, cwid: r.cwid, source: r.source });
  }
  const keys = [...universe.values()].sort((a, b) => key(a).localeCompare(key(b)));

  let added = 0;
  let updated = 0;
  let removed = 0;
  for (let i = 0; i < keys.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + IMPORT_CHUNK_SIZE);
    const counts = await db.write.$transaction(async (tx) => {
      const audit = (
        action:
          | "functional_role_grant"
          | "functional_role_scope_set"
          | "functional_role_update"
          | "functional_role_revoke",
        id: string,
        fieldsChanged: string[] | null,
        beforeValues: Record<string, unknown> | null,
        afterValues: Record<string, unknown> | null,
      ) =>
        appendAuditRow(tx, {
          actorCwid: args.actorCwid,
          impersonatedCwid: args.impersonatedCwid ?? null,
          targetEntityType: "functional_role",
          targetEntityId: id,
          action,
          fieldsChanged,
          beforeValues,
          afterValues,
          ts: new Date(),
          requestId: args.requestId ?? null,
        });

      // Re-read inside the transaction, so the diff is against what this
      // chunk commits over. No key here has source "manual".
      const stored = await tx.functionalRoleGrant.findMany({
        where: { OR: chunk.map((k) => ({ role: k.role, cwid: k.cwid, source: k.source })) },
      });
      const storedByKey = new Map(stored.map((r) => [key(r), r]));

      const toCreate: Array<StoredRow & { scopes: string[] }> = [];
      const toDelete: StoredRow[] = [];
      const toUpdate: Array<{ have: StoredRow; d: ImportedRow; fields: string[] }> = [];
      for (const k of chunk) {
        const have = storedByKey.get(key(k));
        const d = desiredByKey.get(key(k));
        if (d && !have) {
          toCreate.push({
            role: d.role,
            cwid: d.cwid,
            source: d.source,
            scopes: d.scopes,
            granteeName: d.granteeName,
            grantedBy: d.grantedBy,
            grantedAt: d.grantedAt ?? now,
          });
        } else if (have && !d) {
          toDelete.push(have);
        } else if (have && d) {
          const fields = changedFields(have, d);
          if (fields.length > 0) toUpdate.push({ have, d, fields });
        }
      }

      if (toCreate.length > 0) {
        const res = await tx.functionalRoleGrant.createMany({ data: toCreate });
        if (res.count !== toCreate.length) {
          throw new Error(`import created ${res.count} rows, expected ${toCreate.length}`);
        }
        for (const r of toCreate) {
          await audit("functional_role_grant", key(r), null, null, {
            ...snapshot(r),
            via: "import",
          });
        }
      }

      for (const { have, d, fields } of toUpdate) {
        const row = await tx.functionalRoleGrant.update({
          where: { role_cwid_source: { role: d.role, cwid: d.cwid, source: d.source } },
          data: {
            scopes: d.scopes,
            grantedBy: d.grantedBy,
            ...(d.grantedAt ? { grantedAt: d.grantedAt } : {}),
            granteeName: d.granteeName ?? have.granteeName,
          },
        });
        await audit(
          fields.includes("scopes") ? "functional_role_scope_set" : "functional_role_update",
          key(d),
          fields,
          { ...pickFields(have, fields), via: "import" },
          { ...pickFields(row, fields), via: "import" },
        );
      }

      if (toDelete.length > 0) {
        const res = await tx.functionalRoleGrant.deleteMany({
          where: { OR: toDelete.map((r) => ({ role: r.role, cwid: r.cwid, source: r.source })) },
        });
        if (res.count !== toDelete.length) {
          throw new Error(`import deleted ${res.count} rows, expected ${toDelete.length}`);
        }
        for (const r of toDelete) {
          await audit(
            "functional_role_revoke",
            key(r),
            null,
            { ...snapshot(r), via: "import" },
            null,
          );
        }
      }

      return { added: toCreate.length, updated: toUpdate.length, removed: toDelete.length };
    }, IMPORT_TX_OPTIONS);
    added += counts.added;
    updated += counts.updated;
    removed += counts.removed;
  }
  return { added, updated, removed, rows: await listFunctionalRoles(db.write) };
}
