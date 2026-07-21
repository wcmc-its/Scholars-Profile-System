/**
 * #728 — ED admin-role org-unit-manager ETL.
 *
 * Imports four WCM Enterprise Directory delegated-admin populations — option-tagged
 * `weillCornellEduCWID;{da,diva,iamdela,diva-iamdela}` on the org-unit entries under
 * `ou=orgunits,ou=Groups` (see `fetchOrgUnitAdmins` in lib/sources/ldap.ts) — and
 * provisions each member as a per-unit `UnitAdmin` grant LOCKED to the org unit they
 * administer. Role is per population (`ED_ADMIN_ROLE`): DA and DivA-IAMDELA get
 * `owner`, DivA and IAMDELA get `curator`. The org unit is the entry's canonical
 * N-code (`cn`), resolved to a Scholars `Department`/`Division`/`Center` row; codes
 * with no Scholars row (the deep level-3–6 divisions the model doesn't carry) are
 * skipped-and-logged (D4).
 *
 * Scope locking comes from the row naming exactly ONE unit: a `curator` can only
 * edit/proxy-edit it; an `owner` may additionally grant/delegate WITHIN that unit
 * (`canGrant`, lib/edit/authz.ts) but cannot reach a unit they don't hold — neither
 * role can widen to another unit. Making DA/DivA-IAMDELA owners is a deliberate
 * grant of that in-unit delegate capability.
 *
 * Idempotent: upserts on the (entityType, entityId, cwid) PK. Per-source reconcile
 * (#393 pattern) removes a member dropped from population P (their `ED:<P>` row),
 * WITHOUT touching `manual` rows or another population's rows. Fail-closed: an LDAP
 * bind failure or an empty population fetch writes/deletes NOTHING.
 *
 * MUST-9 (OQ-6): never downgrade a deliberate manual `owner` grant — those keys are
 * left untouched. A `manual` curator on the same key is adopted into the ED source.
 *
 * WRITES ARE GATED: `SELF_EDIT_ED_ADMINS_IMPORT="on"` enables writes + reconcile.
 * Default (off) is a DRY RUN — fetch + resolve + log counts, no DB mutation — so the
 * job is safe to deploy dormant under #443 (no WCM LDAPS route yet) and gives a
 * built-in dry-run from an operator vantage that can reach the directory.
 *
 * Usage: `npm run etl:ed:admins`   (probe first: `npm run etl:ed:admins:probe`)
 */
import "dotenv/config";

import type { Client } from "ldapts";

import { db } from "../../lib/db";
import {
  ED_ADMIN_ROLE,
  ED_ADMIN_SOURCE,
  ED_ADMIN_TAGS,
  fetchActiveMembersByCwid,
  fetchOrgUnitAdmins,
  fetchPersonNamesByCwid,
  openLdap,
  type EdOrgUnitAdmins,
} from "@/lib/sources/ldap";

/** Synthetic actor for the `granted_by` breadcrumb. NOT a valid CWID
 *  (CWID_PATTERN = /^[a-z][a-z0-9]{2,8}$/ — `ED-ETL` has an uppercase + hyphen),
 *  so it can never shadow a real operator. The typed `source` column is the
 *  load-bearing provenance, not this. */
const GRANTED_BY = "ED-ETL";

/** Writes + reconcile are gated; default is a non-mutating dry run. */
const WRITES_ENABLED = process.env.SELF_EDIT_ED_ADMINS_IMPORT === "on";

type ScholarsUnitType = "department" | "division" | "center";
export type ResolvedUnit = { entityType: ScholarsUnitType; entityId: string };
export type EdAdminGrant = {
  entityType: ScholarsUnitType;
  entityId: string;
  cwid: string;
  source: string;
  role: "owner" | "curator";
};

/** Stable composite key for a (unit, cwid) grant. The `|` separator is printable
 *  and cannot appear in an entityType ("department"|"division"|"center"), an
 *  N-code, or a CWID — so the key is collision-free. */
export function grantKey(entityType: string, entityId: string, cwid: string): string {
  return `${entityType}|${entityId}|${cwid}`;
}

/** Pure: every unique lowercased CWID tagged as an admin across all fetched
 *  units + tags. Feeds the one-shot active-member lookup. */
export function collectTaggedCwids(units: EdOrgUnitAdmins[]): string[] {
  const set = new Set<string>();
  for (const u of units) {
    for (const tag of ED_ADMIN_TAGS) {
      for (const cwid of u.byTag[tag]) set.add(cwid.toLowerCase());
    }
  }
  return Array.from(set);
}

/**
 * Pure: drop every tagged CWID whose ED person is not an active member
 * (`activeByCwid.get(cwid) !== true`). Returns units with filtered `byTag`
 * arrays plus the count of dropped (unit, tag, cwid) tuples.
 *
 * ED never removes an admin tag when a person expires, so an inactive tagged
 * CWID is a stale grant. Filtering it out of `byTag` HERE means it never enters
 * `buildEdAdminGrants` — so it is neither upserted nor added to any source's
 * `seen` set, and the per-source reconcile deletes its existing `UnitAdmin` row
 * on this run (self-healing revocation, no manual SQL).
 */
export function filterUnitsByActiveMembers(
  units: EdOrgUnitAdmins[],
  activeByCwid: Map<string, boolean>,
): { units: EdOrgUnitAdmins[]; droppedInactive: number } {
  let droppedInactive = 0;
  const filtered = units.map((u) => {
    const byTag = {} as Record<(typeof ED_ADMIN_TAGS)[number], string[]>;
    for (const tag of ED_ADMIN_TAGS) {
      byTag[tag] = u.byTag[tag].filter((cwid) => {
        const active = activeByCwid.get(cwid.toLowerCase()) === true;
        if (!active) droppedInactive++;
        return active;
      });
    }
    return { ...u, byTag };
  });
  return { units: filtered, droppedInactive };
}

/**
 * Pure: from the fetched org units + a code→Scholars-unit resolver, build the
 * desired grant set (last-population-wins on `source` for a cwid holding several
 * tags on one unit) and the per-source "seen" key sets used by the reconcile.
 * Codes with no Scholars unit are counted (skip-and-log, D4) — never written.
 */
export function buildEdAdminGrants(
  units: EdOrgUnitAdmins[],
  resolver: Map<string, ResolvedUnit>,
): {
  grants: Map<string, EdAdminGrant>;
  seenBySource: Map<string, Set<string>>;
  skippedNoUnit: number;
  unmatchedCodes: Set<string>;
} {
  const grants = new Map<string, EdAdminGrant>();
  const seenBySource = new Map<string, Set<string>>();
  const unmatchedCodes = new Set<string>();
  let skippedNoUnit = 0;

  for (const u of units) {
    const resolved = resolver.get(u.code);
    for (const tag of ED_ADMIN_TAGS) {
      const source = ED_ADMIN_SOURCE[tag];
      for (const cwid of u.byTag[tag]) {
        if (!resolved) {
          skippedNoUnit++;
          unmatchedCodes.add(u.code);
          continue;
        }
        const key = grantKey(resolved.entityType, resolved.entityId, cwid);
        let seen = seenBySource.get(source);
        if (!seen) {
          seen = new Set<string>();
          seenBySource.set(source, seen);
        }
        seen.add(key);
        grants.set(key, {
          entityType: resolved.entityType,
          entityId: resolved.entityId,
          cwid,
          source,
          role: ED_ADMIN_ROLE[tag],
        });
      }
    }
  }
  return { grants, seenBySource, skippedNoUnit, unmatchedCodes };
}

/** Pure: rows of one source present in the DB but absent from this run's seen
 *  set — the per-population reconcile delete-set. */
export function selectStaleRows<T extends { entityType: string; entityId: string; cwid: string }>(
  rows: T[],
  seen: Set<string>,
): T[] {
  return rows.filter((r) => !seen.has(grantKey(r.entityType, r.entityId, r.cwid)));
}

/** MUST-9 (OQ-6): a deliberate manual `owner` on a key is never overwritten — the
 *  ED grant for that same (entityType, entityId, cwid) is skipped entirely, whatever
 *  role ED would write (owner OR curator). `manualOwnerKeys` are the grantKey()s of
 *  the `source='manual' role='owner'` rows. */
export function isManualOwnerProtected(
  g: Pick<EdAdminGrant, "entityType" | "entityId" | "cwid">,
  manualOwnerKeys: ReadonlySet<string>,
): boolean {
  return manualOwnerKeys.has(grantKey(g.entityType, g.entityId, g.cwid));
}

/**
 * N-code → Scholars unit. Department + Division key on the N-code directly;
 * centers rarely match an N-code (Meyer Cancer Center is the known exception,
 * OQ-7) but are included for completeness. Department wins on the (theoretical)
 * code collision — most-specific admin scope; codes don't collide in practice.
 */
async function loadUnitResolver(): Promise<Map<string, ResolvedUnit>> {
  const [depts, divs, centers] = await Promise.all([
    db.write.department.findMany({ select: { code: true } }),
    db.write.division.findMany({ select: { code: true } }),
    db.write.center.findMany({ select: { code: true } }),
  ]);
  const map = new Map<string, ResolvedUnit>();
  for (const c of centers) map.set(c.code, { entityType: "center", entityId: c.code });
  for (const d of divs) map.set(d.code, { entityType: "division", entityId: d.code });
  for (const d of depts) map.set(d.code, { entityType: "department", entityId: d.code });
  return map;
}

async function main(): Promise<void> {
  const run = await db.write.etlRun.create({
    data: { source: "ED-Admins", status: "running" },
  });

  // Bind first; a bind/connect failure is `ldap_unavailable` — write nothing,
  // delete nothing, exit non-fatally so the orchestrator continues (MUST-6 / §3.6).
  let client: Client;
  try {
    client = await openLdap();
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "failed", completedAt: new Date(), errorMessage: "ldap_unavailable" },
    });
    console.error(
      "[ed-admins] LDAP unavailable — no writes, no deletes:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  try {
    const units = await fetchOrgUnitAdmins(client);
    console.log(`[ed-admins] ${units.length} org-unit entries carry an imported admin tag.`);

    // Active-member guard: ED does NOT drop an admin tag when a person expires,
    // so a tagged CWID whose `weillCornellEduActiveMember` is not TRUE is a stale
    // grant. Filter those out BEFORE grants/seen are built — they never upsert and
    // never enter any source's `seen` set, so the per-source reconcile below
    // deletes their existing UnitAdmin rows this run (no manual SQL). The
    // empty-source guard still protects against a total-fetch failure; this filter
    // only ever removes a strict subset of one source's members.
    const taggedCwids = collectTaggedCwids(units);
    const activeByCwid = await fetchActiveMembersByCwid(client, taggedCwids);
    const { units: activeUnits, droppedInactive } = filterUnitsByActiveMembers(
      units,
      activeByCwid,
    );
    console.log(
      `[ed-admins] active-member guard: ${taggedCwids.length} distinct tagged CWID(s), ` +
        `dropped ${droppedInactive} inactive tagged grant(s) (weillCornellEduActiveMember != TRUE).`,
    );

    const resolver = await loadUnitResolver();
    const { grants, seenBySource, skippedNoUnit, unmatchedCodes } = buildEdAdminGrants(
      activeUnits,
      resolver,
    );

    const sources = ED_ADMIN_TAGS.map((t) => ED_ADMIN_SOURCE[t]);
    console.log(
      `[ed-admins] resolved grants=${grants.size}; skipped_no_unit=${skippedNoUnit} (${unmatchedCodes.size} distinct unmatched N-codes — deep/centerless units, expected per D4)`,
    );
    for (const s of sources) {
      console.log(`[ed-admins]   ${s}: ${seenBySource.get(s)?.size ?? 0} resolved grants`);
    }

    if (!WRITES_ENABLED) {
      console.log(
        "[ed-admins] DRY RUN (set SELF_EDIT_ED_ADMINS_IMPORT=on to write) — no upserts, no reconcile.",
      );
      await db.write.etlRun.update({
        where: { id: run.id },
        data: { status: "success", completedAt: new Date(), rowsProcessed: 0 },
      });
      return;
    }

    // MUST-9: never downgrade a deliberate manual owner. Pre-load those keys once.
    const manualOwnerRows = await db.write.unitAdmin.findMany({
      where: { source: "manual", role: "owner" },
      select: { entityType: true, entityId: true, cwid: true },
    });
    const manualOwnerKeys = new Set(
      manualOwnerRows.map((r) => grantKey(r.entityType, r.entityId, r.cwid)),
    );

    // Resolve grantee display names FROM THE DIRECTORY in the same pull that fetched
    // the grants, and store them on the row. The app runtime can't reach LDAP (#443),
    // so resolving on the fly at render falls back to the bare CWID for non-Scholar
    // admins; capturing the name here is the fix. Best-effort: a lookup failure leaves
    // the name untouched (prior value preserved on update, null on create) and the
    // roster keeps its Scholar-name / CWID fallback.
    const nameByCwid = new Map<string, string>();
    try {
      const raw = await fetchPersonNamesByCwid(taggedCwids);
      for (const [cwid, n] of raw) {
        const name = [n.firstName, n.lastName].filter(Boolean).join(" ").trim();
        if (name) nameByCwid.set(cwid, name);
      }
      console.log(
        `[ed-admins] resolved ${nameByCwid.size}/${taggedCwids.length} grantee display name(s).`,
      );
    } catch (err) {
      console.warn(
        "[ed-admins] grantee name resolution failed — grants keep their prior name / CWID fallback:",
        err instanceof Error ? err.message : String(err),
      );
    }

    let upserts = 0;
    let skippedManualOwner = 0;
    for (const g of grants.values()) {
      if (isManualOwnerProtected(g, manualOwnerKeys)) {
        skippedManualOwner++;
        continue;
      }
      const granteeName = nameByCwid.get(g.cwid.toLowerCase());
      await db.write.unitAdmin.upsert({
        where: {
          entityType_entityId_cwid: {
            entityType: g.entityType,
            entityId: g.entityId,
            cwid: g.cwid,
          },
        },
        create: {
          entityType: g.entityType,
          entityId: g.entityId,
          cwid: g.cwid,
          role: g.role,
          grantedBy: GRANTED_BY,
          source: g.source,
          granteeName: granteeName ?? null,
        },
        // A lookup miss preserves a prior name (`undefined` = no-op) rather than
        // wiping it to null on a transient directory failure.
        update: {
          role: g.role,
          grantedBy: GRANTED_BY,
          source: g.source,
          granteeName: granteeName ?? undefined,
        },
      });
      upserts++;
    }

    // Per-source reconcile. Empty-source guard (MUST-5): a population that resolved
    // to ZERO grants this run is NOT reconciled — an empty/transient fetch must
    // never wipe a whole population's grants.
    let revoked = 0;
    for (const source of sources) {
      const seen = seenBySource.get(source);
      if (!seen || seen.size === 0) {
        console.warn(
          `[ed-admins] ${source}: 0 resolved this run — SKIPPING reconcile (empty-source guard).`,
        );
        continue;
      }
      const rows = await db.write.unitAdmin.findMany({
        where: { source },
        select: { entityType: true, entityId: true, cwid: true },
      });
      const stale = selectStaleRows(rows, seen);
      for (const r of stale) {
        await db.write.unitAdmin.delete({
          where: {
            entityType_entityId_cwid: {
              entityType: r.entityType,
              entityId: r.entityId,
              cwid: r.cwid,
            },
          },
        });
        revoked++;
      }
      console.log(`[ed-admins] ${source}: reconcile removed ${stale.length} stale grant(s).`);
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: upserts + revoked },
    });
    console.log(
      `[ed-admins] done: upserts=${upserts}, revoked=${revoked}, skipped_manual_owner=${skippedManualOwner}, skipped_no_unit=${skippedNoUnit}`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Import-safe: only run when invoked as a script, never when imported by vitest.
if (!process.env.VITEST) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
