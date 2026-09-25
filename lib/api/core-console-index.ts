/**
 * `/edit/core` index data — one summary row per catalog core for the Scholars
 * Console "Core facilities" table: review backlog, confirmed count, clients,
 * staff-feed coverage, leaders, owners/curators and the public-page state.
 *
 * Every number is derived from the SAME definitions the per-core surfaces use,
 * never a parallel re-derivation:
 *   - "To review" is `isOpenCandidate` (lib/api/core-merge.ts) — an engine
 *     `candidate` row with no active CoreClaim, the review queue's own
 *     `candidates` partition. Counted with a grouped query rather than loading
 *     every candidate row, then corrected for the (few) claimed/rejected pairs.
 *   - "Confirmed" is `loadConfirmedCorePmidsByCore` (lib/api/cores.ts).
 *   - Clients are active `CoreClient` rows (`removedAt IS NULL`), split into
 *     CWID and name-only.
 *
 * The DB load is a thin wrapper; `buildCoreConsoleRows` is pure and unit-tested.
 */
import { db } from "@/lib/db";
import { claimKey } from "@/lib/api/core-merge";
import { loadConfirmedCorePmidsByCore } from "@/lib/api/cores";

/** Likelihood at or above which an open candidate counts as high confidence. */
export const HIGH_CONFIDENCE_LIKELIHOOD = 0.8;

export interface CoreConsoleLeader {
  name: string;
  /** Role label resolved through the `core` role vocabulary (falls back to the key). */
  role: string;
  interim: boolean;
}

export interface CoreConsoleRow {
  id: string;
  name: string;
  facility: string | null;
  /** The per-core `Core.visible` toggle. */
  visible: boolean;
  hasUrl: boolean;
  hasDescription: boolean;
  leaders: CoreConsoleLeader[];
  owners: string[];
  curators: string[];
  /** Open candidates (no active claim). */
  reviewTotal: number;
  /** Of `reviewTotal`, those with likelihood >= HIGH_CONFIDENCE_LIKELIHOOD. */
  reviewHigh: number;
  confirmed: number;
  clientsWithCwid: number;
  clientsNameOnly: number;
  /** Staff the dictionary lists; `null` = no staff feed published yet (NOT 0). */
  staffListed: number | null;
  /** Of those, staff the co-author signal can match; same NULL-is-not-0 rule. */
  staffTracked: number | null;
}

/** Inputs to the pure row builder — the raw reads, already fetched. */
export interface CoreConsoleInputs {
  cores: ReadonlyArray<{
    id: string;
    name: string;
    facility: string | null;
    visible: boolean;
    url: string | null;
    description: string | null;
    staffCount: number | null;
    staffTrackedCount: number | null;
  }>;
  leaders: ReadonlyArray<{ coreId: string; cwid: string; role: string; interim: boolean }>;
  roleLabels: ReadonlyMap<string, string>;
  admins: ReadonlyArray<{
    entityId: string;
    cwid: string;
    role: string;
    granteeName: string | null;
  }>;
  names: ReadonlyMap<string, string>;
  /** Engine `candidate` counts per core, before claims are applied. */
  candidateTotals: ReadonlyMap<string, number>;
  candidateHighs: ReadonlyMap<string, number>;
  /** Engine `candidate` rows that carry an ACTIVE claim — decided, so not open. */
  claimedCandidates: ReadonlyArray<{ coreId: string; likelihood: number }>;
  confirmedByCore: ReadonlyMap<string, readonly string[]>;
  clients: ReadonlyArray<{ coreId: string; cwid: string | null }>;
}

/** Pure: assemble one console row per core, in numeric core-id order. */
export function buildCoreConsoleRows(input: CoreConsoleInputs): CoreConsoleRow[] {
  const claimedTotal = new Map<string, number>();
  const claimedHigh = new Map<string, number>();
  for (const c of input.claimedCandidates) {
    claimedTotal.set(c.coreId, (claimedTotal.get(c.coreId) ?? 0) + 1);
    if (c.likelihood >= HIGH_CONFIDENCE_LIKELIHOOD) {
      claimedHigh.set(c.coreId, (claimedHigh.get(c.coreId) ?? 0) + 1);
    }
  }
  const nameOf = (cwid: string, fallback?: string | null) =>
    input.names.get(cwid) ?? (fallback || cwid);

  return input.cores
    .map((core) => {
      const reviewTotal = Math.max(
        0,
        (input.candidateTotals.get(core.id) ?? 0) - (claimedTotal.get(core.id) ?? 0),
      );
      const reviewHigh = Math.min(
        reviewTotal,
        Math.max(0, (input.candidateHighs.get(core.id) ?? 0) - (claimedHigh.get(core.id) ?? 0)),
      );
      const admins = input.admins.filter((a) => a.entityId === core.id);
      const clients = input.clients.filter((c) => c.coreId === core.id);
      return {
        id: core.id,
        name: core.name,
        facility: core.facility,
        visible: core.visible,
        hasUrl: !!core.url?.trim(),
        hasDescription: !!core.description?.trim(),
        leaders: input.leaders
          .filter((l) => l.coreId === core.id)
          .map((l) => ({
            name: nameOf(l.cwid),
            role: input.roleLabels.get(l.role) ?? l.role,
            interim: l.interim,
          })),
        owners: admins.filter((a) => a.role === "owner").map((a) => nameOf(a.cwid, a.granteeName)),
        curators: admins
          .filter((a) => a.role === "curator")
          .map((a) => nameOf(a.cwid, a.granteeName)),
        reviewTotal,
        reviewHigh,
        confirmed: input.confirmedByCore.get(core.id)?.length ?? 0,
        clientsWithCwid: clients.filter((c) => c.cwid != null).length,
        clientsNameOnly: clients.filter((c) => c.cwid == null).length,
        staffListed: core.staffCount,
        staffTracked: core.staffTrackedCount,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

type CoreConsoleReader = Pick<
  typeof db.read,
  | "core"
  | "coreLeader"
  | "orgUnitRole"
  | "unitAdmin"
  | "scholar"
  | "publicationCore"
  | "coreClaim"
  | "coreClient"
>;

/** Load every catalog core's console summary row. */
export async function loadCoreConsoleIndex(
  client: CoreConsoleReader = db.read,
): Promise<CoreConsoleRow[]> {
  const [cores, leaders, roles, admins, totals, highs, activeClaims, clients] = await Promise.all([
    client.core.findMany({
      select: {
        id: true,
        name: true,
        facility: true,
        visible: true,
        url: true,
        description: true,
        staffCount: true,
        staffTrackedCount: true,
      },
    }),
    client.coreLeader.findMany({
      orderBy: [{ sortOrder: "asc" }, { cwid: "asc" }],
      select: { coreId: true, cwid: true, role: true, interim: true },
    }),
    client.orgUnitRole.findMany({
      where: { entityType: "core" },
      select: { key: true, label: true },
    }),
    client.unitAdmin.findMany({
      where: { entityType: "core" },
      orderBy: { createdAt: "asc" },
      select: { entityId: true, cwid: true, role: true, granteeName: true },
    }),
    client.publicationCore.groupBy({
      by: ["coreId"],
      where: { status: "candidate" },
      _count: { _all: true },
    }),
    client.publicationCore.groupBy({
      by: ["coreId"],
      where: { status: "candidate", likelihood: { gte: HIGH_CONFIDENCE_LIKELIHOOD } },
      _count: { _all: true },
    }),
    client.coreClaim.findMany({
      where: { revokedAt: null },
      select: { coreId: true, pmid: true },
    }),
    client.coreClient.findMany({
      where: { removedAt: null },
      select: { coreId: true, cwid: true },
    }),
  ]);

  // The engine `candidate` rows a human already decided (claimed OR rejected):
  // counted by the grouped queries above but not open for review.
  const claimKeys = new Set(activeClaims.map((c) => claimKey(c.pmid, c.coreId)));
  const claimedRows =
    activeClaims.length === 0
      ? []
      : await client.publicationCore.findMany({
          where: {
            status: "candidate",
            pmid: { in: [...new Set(activeClaims.map((c) => c.pmid))] },
          },
          select: { coreId: true, pmid: true, likelihood: true },
        });

  const nameCwids = [...new Set([...leaders.map((l) => l.cwid), ...admins.map((a) => a.cwid)])];
  const [scholars, confirmedByCore] = await Promise.all([
    nameCwids.length
      ? client.scholar.findMany({
          where: { cwid: { in: nameCwids } },
          select: { cwid: true, preferredName: true },
        })
      : Promise.resolve([]),
    loadConfirmedCorePmidsByCore(
      cores.map((c) => c.id),
      client,
    ),
  ]);

  return buildCoreConsoleRows({
    cores,
    leaders,
    roleLabels: new Map(roles.map((r) => [r.key, r.label])),
    admins: admins.map((a) => ({ ...a, role: String(a.role) })),
    names: new Map(scholars.filter((s) => s.preferredName).map((s) => [s.cwid, s.preferredName])),
    candidateTotals: new Map(totals.map((t) => [t.coreId, t._count._all])),
    candidateHighs: new Map(highs.map((t) => [t.coreId, t._count._all])),
    claimedCandidates: claimedRows
      .filter((r) => claimKeys.has(claimKey(r.pmid, r.coreId)))
      .map((r) => ({ coreId: r.coreId, likelihood: Number(r.likelihood) })),
    confirmedByCore,
    clients,
  });
}
