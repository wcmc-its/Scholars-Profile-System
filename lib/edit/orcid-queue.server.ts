/**
 * ORCID librarian queue — the loader the page reads and the writes the three
 * routes share (`app/api/edit/orcid-queue/*`). Server-only: the client
 * component imports the pure sibling `orcid-queue.ts`. Every function takes
 * the Prisma client (or the transaction client) as a parameter and none checks
 * authorization: the page and routes gate first.
 *
 * A confirm is the same write `POST /api/edit/orcid` makes (`scholar.orcid`,
 * `orcid_confirmed_at`, the pair's dismissal deleted) plus method `librarian`
 * and `orcid_confirmed_by` = the real librarian. A dismiss is an
 * `orcid_dismissal` row; on an iD the ETL email-confirmed it is also the Undo,
 * which clears `scholar.orcid` (the Remove write). Each runs inside the
 * caller's transaction with its audit row.
 */
import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { formatPublishedName } from "@/lib/postnominal";

import {
  isOrcidQueueTab,
  ORCID_QUEUE_BANDS,
  ORCID_QUEUE_SAMPLE_SIZE,
  ORCID_QUEUE_TABS,
  pairState,
  sampleStatus,
  type OrcidQueueBand,
  type OrcidQueueData,
  type OrcidQueueRow,
  type OrcidQueueSampleState,
  type OrcidQueueTab,
  type OrcidQueueWork,
  type OrcidSampleBand,
} from "./orcid-queue";

type Client = Pick<
  PrismaClient,
  "orcidCandidateEvidence" | "orcidQueueSample" | "orcidDismissal" | "scholar"
>;
type Tx = Prisma.TransactionClient;

/** Rows shown per tab. The tab pills count them all. */
const TAB_LIMIT = 200;

/** A refused write: the route maps it to `editError(status, code)`. */
export class OrcidQueueRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code:
      | "not_in_queue"
      | "scholar_not_found"
      | "already_on_file"
      | "on_file_differs"
      | "on_file"
      | "state_changed"
      | "sample_row_not_found"
      | "sample_row_decided",
  ) {
    super(code);
  }
}

const pairKey = (cwid: string, orcid: string) => `${cwid}|${orcid}`;

function asWorks(v: unknown): OrcidQueueWork[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .map((w) => ({
      title: typeof w.title === "string" ? w.title : null,
      year: typeof w.year === "number" ? w.year : null,
      doi: typeof w.doi === "string" ? w.doi : null,
      pmid: typeof w.pmid === "string" ? w.pmid : null,
      source: typeof w.source === "string" ? w.source : null,
    }));
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The newest sample of a band and its state, or null. */
export async function loadLatestSample(
  client: Pick<PrismaClient, "orcidQueueSample"> | Tx,
  band: OrcidSampleBand,
): Promise<
  | (OrcidQueueSampleState & {
      pairs: Array<{ cwid: string; orcid: string; decision: string | null }>;
    })
  | null
> {
  const head = await client.orcidQueueSample.findFirst({
    where: { band },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });
  if (!head) return null;
  const rows = await client.orcidQueueSample.findMany({
    where: { id: head.id },
    select: { cwid: true, orcid: true, decision: true },
  });
  return {
    id: head.id,
    band,
    startedAt: head.startedAt.toISOString(),
    total: rows.length,
    decided: rows.filter((r) => r.decision !== null).length,
    dismissed: rows.filter((r) => r.decision === "dismissed").length,
    status: sampleStatus(rows),
    pairs: rows,
  };
}

/** The band's rows that still qualify for a confirm when read now: the band is
 *  unchanged, the scholar has no iD on file, and the pair is not dismissed. A
 *  scholar with two such rows is left out (only one can be theirs). */
export async function loadQualifying(
  client: Pick<PrismaClient, "orcidCandidateEvidence" | "scholar" | "orcidDismissal"> | Tx,
  band: OrcidQueueBand,
): Promise<{ qualifying: Array<{ cwid: string; orcid: string }>; total: number }> {
  const rows = await client.orcidCandidateEvidence.findMany({
    where: { band },
    select: { cwid: true, orcid: true },
  });
  const cwids = [...new Set(rows.map((r) => r.cwid))];
  const [scholars, dismissals] = await Promise.all([
    client.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, orcid: true, status: true, deletedAt: true },
    }),
    client.orcidDismissal.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, orcid: true },
    }),
  ]);
  const held = new Map(
    scholars.filter((s) => s.status === "active" && !s.deletedAt).map((s) => [s.cwid, s.orcid]),
  );
  const dismissed = new Set(dismissals.map((d) => pairKey(d.cwid, d.orcid)));
  const open = rows.filter(
    (r) =>
      held.has(r.cwid) &&
      pairState(r.orcid, held.get(r.cwid) ?? null, dismissed.has(pairKey(r.cwid, r.orcid))) ===
        "queue",
  );
  const perCwid = new Map<string, number>();
  for (const r of open) perCwid.set(r.cwid, (perCwid.get(r.cwid) ?? 0) + 1);
  return { qualifying: open.filter((r) => perCwid.get(r.cwid) === 1), total: rows.length };
}

/** Fisher–Yates, first `n`. */
function pick<T>(xs: T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** Returns the band's open sample, or starts one: up to ORCID_QUEUE_SAMPLE_SIZE
 *  random rows that qualify now. A passed or locked sample is not open, so a
 *  call after one starts a fresh sample (which supersedes it for bulk). */
export async function openOrStartSample(
  tx: Tx,
  band: OrcidSampleBand,
  actor: string,
  now: Date,
): Promise<{ sample: OrcidQueueSampleState; created: boolean }> {
  const latest = await loadLatestSample(tx, band);
  if (latest && latest.status === "open") {
    const { id, band: b, startedAt, total, decided, dismissed, status } = latest;
    return {
      sample: { id, band: b, startedAt, total, decided, dismissed, status },
      created: false,
    };
  }
  const { qualifying } = await loadQualifying(tx, band);
  const chosen = pick(qualifying, ORCID_QUEUE_SAMPLE_SIZE);
  const id = randomUUID();
  if (chosen.length > 0) {
    await tx.orcidQueueSample.createMany({
      data: chosen.map((c) => ({
        id,
        band,
        startedBy: actor,
        startedAt: now,
        cwid: c.cwid,
        orcid: c.orcid,
      })),
    });
  }
  return {
    sample: {
      id,
      band,
      startedAt: now.toISOString(),
      total: chosen.length,
      decided: 0,
      dismissed: 0,
      status: "open",
    },
    created: true,
  };
}

type WriteMeta = {
  actor: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  ts: Date;
  sampleId?: string | null;
  bulk?: boolean;
};

/** Confirm one pair (method `librarian`). The pair must be in the evidence
 *  table. An iD already on file is refused; a DIFFERENT iD on file (the
 *  Conflicts tab) is replaced only with `replace`, and the replaced iD is
 *  dismissed. Optimistic: the update re-checks what was read. */
export async function confirmPair(
  tx: Tx,
  pair: { cwid: string; orcid: string; replace?: boolean },
  meta: WriteMeta,
): Promise<void> {
  const evidence = await tx.orcidCandidateEvidence.findUnique({
    where: { cwid_orcid: { cwid: pair.cwid, orcid: pair.orcid } },
    select: { band: true },
  });
  if (!evidence) throw new OrcidQueueRefused(404, "not_in_queue");
  const held = await tx.scholar.findUnique({
    where: { cwid: pair.cwid },
    select: { orcid: true, orcidConfirmMethod: true },
  });
  if (!held) throw new OrcidQueueRefused(404, "scholar_not_found");
  if (held.orcid === pair.orcid) throw new OrcidQueueRefused(409, "already_on_file");
  if (held.orcid !== null && !pair.replace) throw new OrcidQueueRefused(409, "on_file_differs");
  const { count } = await tx.scholar.updateMany({
    where: { cwid: pair.cwid, orcid: held.orcid },
    data: {
      orcid: pair.orcid,
      orcidConfirmedAt: meta.ts,
      orcidConfirmMethod: "librarian",
      orcidConfirmedBy: meta.actor,
    },
  });
  if (count !== 1) throw new OrcidQueueRefused(409, "state_changed");
  await tx.orcidDismissal.deleteMany({ where: { cwid: pair.cwid, orcid: pair.orcid } });
  if (held.orcid !== null) {
    await tx.orcidDismissal.upsert({
      where: { cwid_orcid: { cwid: pair.cwid, orcid: held.orcid } },
      create: { cwid: pair.cwid, orcid: held.orcid },
      update: {},
    });
  }
  await appendAuditRow(tx, {
    actorCwid: meta.actor,
    impersonatedCwid: meta.impersonatedCwid,
    targetEntityType: "scholar",
    targetEntityId: pair.cwid,
    action: "orcid_librarian_confirm",
    fieldsChanged: ["orcid"],
    beforeValues: { orcid: held.orcid, method: held.orcidConfirmMethod },
    afterValues: {
      orcid: pair.orcid,
      method: "librarian",
      band: evidence.band,
      ...(held.orcid !== null ? { dismissed: [held.orcid] } : {}),
      ...(meta.sampleId ? { sample_id: meta.sampleId } : {}),
      ...(meta.bulk ? { bulk: true } : {}),
    },
    ts: meta.ts,
    requestId: meta.requestId,
  });
}

/** "Not this person": an `orcid_dismissal` row. On the iD on file it is the
 *  Undo of an email auto-confirm, which also clears `scholar.orcid` and its
 *  confirmation; any other iD on file is refused (that is Remove on /edit). */
export async function dismissPair(
  tx: Tx,
  pair: { cwid: string; orcid: string },
  meta: WriteMeta,
): Promise<{ undid: boolean }> {
  const held = await tx.scholar.findUnique({
    where: { cwid: pair.cwid },
    select: { orcid: true, orcidConfirmMethod: true },
  });
  if (!held) throw new OrcidQueueRefused(404, "scholar_not_found");
  let undid = false;
  if (held.orcid === pair.orcid) {
    if (held.orcidConfirmMethod !== "email_verified") throw new OrcidQueueRefused(409, "on_file");
    const { count } = await tx.scholar.updateMany({
      where: { cwid: pair.cwid, orcid: pair.orcid },
      data: {
        orcid: null,
        orcidConfirmedAt: null,
        orcidConfirmMethod: null,
        orcidConfirmedBy: null,
      },
    });
    if (count !== 1) throw new OrcidQueueRefused(409, "state_changed");
    undid = true;
  }
  const evidence = await tx.orcidCandidateEvidence.findUnique({
    where: { cwid_orcid: { cwid: pair.cwid, orcid: pair.orcid } },
    select: { band: true },
  });
  await tx.orcidDismissal.upsert({
    where: { cwid_orcid: { cwid: pair.cwid, orcid: pair.orcid } },
    create: { cwid: pair.cwid, orcid: pair.orcid },
    update: {},
  });
  await appendAuditRow(tx, {
    actorCwid: meta.actor,
    impersonatedCwid: meta.impersonatedCwid,
    targetEntityType: "scholar",
    targetEntityId: pair.cwid,
    action: "orcid_librarian_dismiss",
    fieldsChanged: undid ? ["orcid"] : null,
    beforeValues: { orcid: held.orcid, method: held.orcidConfirmMethod },
    afterValues: {
      orcid: undid ? null : held.orcid,
      dismissed: [pair.orcid],
      band: evidence?.band ?? null,
      ...(undid ? { undo_email_autoconfirm: true } : {}),
      ...(meta.sampleId ? { sample_id: meta.sampleId } : {}),
    },
    ts: meta.ts,
    requestId: meta.requestId,
  });
  return { undid };
}

/** Stamps a sample row with a decision; it must exist and be undecided. */
export async function stampSampleRow(
  tx: Tx,
  row: { sampleId: string; cwid: string; orcid: string },
  decision: "confirmed" | "dismissed",
  actor: string,
  ts: Date,
): Promise<void> {
  const found = await tx.orcidQueueSample.findUnique({
    where: { id_cwid_orcid: { id: row.sampleId, cwid: row.cwid, orcid: row.orcid } },
    select: { decision: true },
  });
  if (!found) throw new OrcidQueueRefused(404, "sample_row_not_found");
  const { count } = await tx.orcidQueueSample.updateMany({
    where: { id: row.sampleId, cwid: row.cwid, orcid: row.orcid, decision: null },
    data: { decision, decidedBy: actor, decidedAt: ts },
  });
  if (count !== 1) throw new OrcidQueueRefused(409, "sample_row_decided");
}

/** One tab of the queue, its sample first, plus every tab's count. */
export async function loadOrcidQueue(client: Client, rawTab: unknown): Promise<OrcidQueueData> {
  const tab: OrcidQueueTab = isOrcidQueueTab(rawTab) ? rawTab : "strong";
  const all = await client.orcidCandidateEvidence.findMany({
    select: { cwid: true, orcid: true, band: true },
  });
  const cwids = [...new Set(all.map((r) => r.cwid))];
  const [held, dismissals, autoConfirmed] = await Promise.all([
    client.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, orcid: true, status: true, deletedAt: true },
    }),
    client.orcidDismissal.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, orcid: true },
    }),
    client.scholar.findMany({
      where: { orcidConfirmMethod: "email_verified", orcid: { not: null }, deletedAt: null },
      select: { cwid: true, orcid: true },
    }),
  ]);
  const heldBy = new Map(
    held.filter((s) => s.status === "active" && !s.deletedAt).map((s) => [s.cwid, s.orcid]),
  );
  const dismissed = new Set(dismissals.map((d) => pairKey(d.cwid, d.orcid)));

  const counts = Object.fromEntries(ORCID_QUEUE_TABS.map((t) => [t, 0])) as Record<
    OrcidQueueTab,
    number
  >;
  const inTab: Array<{ cwid: string; orcid: string; onFile: string | null }> = [];
  for (const r of all) {
    if (!heldBy.has(r.cwid)) continue;
    const onFile = heldBy.get(r.cwid) ?? null;
    const state = pairState(r.orcid, onFile, dismissed.has(pairKey(r.cwid, r.orcid)));
    const t: OrcidQueueTab | null =
      state === "conflict" ? "conflicts" : state === "queue" ? (r.band as OrcidQueueBand) : null;
    if (!t || !(ORCID_QUEUE_TABS as readonly string[]).includes(t)) continue;
    counts[t]++;
    if (t === tab)
      inTab.push({ cwid: r.cwid, orcid: r.orcid, onFile: state === "conflict" ? onFile : null });
  }
  // Email verified also lists what the ETL already confirmed (each with Undo).
  counts.email_verified += autoConfirmed.length;
  if (tab === "email_verified") {
    for (const a of autoConfirmed) inTab.push({ cwid: a.cwid, orcid: a.orcid!, onFile: a.orcid });
  }

  let sample: OrcidQueueSampleState | null = null;
  let remaining: number | null = null;
  const sampled = new Map<string, "confirmed" | "dismissed" | null>();
  if (tab === "strong" || tab === "shared_only") {
    const latest = await loadLatestSample(client, tab);
    if (latest) {
      const { pairs, ...state } = latest;
      sample = state;
      if (state.status === "open") {
        for (const p of pairs)
          sampled.set(pairKey(p.cwid, p.orcid), p.decision as "confirmed" | "dismissed" | null);
        // A sampled pair decided since left the band's list; show it in place, decided.
        const listed = new Set(inTab.map((r) => pairKey(r.cwid, r.orcid)));
        for (const p of pairs)
          if (!listed.has(pairKey(p.cwid, p.orcid)))
            inTab.push({ cwid: p.cwid, orcid: p.orcid, onFile: null });
      }
      if (state.status === "passed") {
        const done = new Set(pairs.map((p) => pairKey(p.cwid, p.orcid)));
        remaining = (await loadQualifying(client, tab)).qualifying.filter(
          (q) => !done.has(pairKey(q.cwid, q.orcid)),
        ).length;
      }
    }
  }

  // The sample first, then strongest evidence first.
  const ordered = [...inTab].sort(
    (a, b) =>
      Number(sampled.has(pairKey(b.cwid, b.orcid))) - Number(sampled.has(pairKey(a.cwid, a.orcid))),
  );
  const shown = ordered.slice(0, Math.max(TAB_LIMIT, sampled.size));
  const details =
    shown.length === 0
      ? []
      : await client.orcidCandidateEvidence.findMany({
          where: { OR: shown.map((r) => ({ cwid: r.cwid, orcid: r.orcid })) },
        });
  const detailBy = new Map(details.map((d) => [pairKey(d.cwid, d.orcid), d]));
  const people = new Set(shown.map((r) => r.cwid));
  for (const d of details) for (const c of asStrings(d.competitorCwids)) people.add(c);
  const scholars = new Map(
    (
      await client.scholar.findMany({
        where: { cwid: { in: [...people] } },
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          fullName: true,
          postnominal: true,
          roleCategory: true,
          primaryTitle: true,
          primaryDepartment: true,
        },
      })
    ).map((s) => [s.cwid, s]),
  );
  const nameOf = (cwid: string) => {
    const s = scholars.get(cwid);
    return formatPublishedName(
      s?.preferredName ?? s?.fullName ?? cwid,
      s?.postnominal ?? null,
      s?.roleCategory ?? null,
    );
  };

  const rows: OrcidQueueRow[] = shown.map((r) => {
    const d = detailBy.get(pairKey(r.cwid, r.orcid));
    const s = scholars.get(r.cwid);
    const band = (d?.band ?? (tab === "conflicts" ? "weak" : tab)) as OrcidQueueBand;
    const key = pairKey(r.cwid, r.orcid);
    return {
      cwid: r.cwid,
      orcid: r.orcid,
      slug: s?.slug ?? null,
      name: nameOf(r.cwid),
      title: s?.primaryTitle ?? null,
      department: s?.primaryDepartment ?? null,
      band: (ORCID_QUEUE_BANDS as readonly string[]).includes(band) ? band : "weak",
      instMatch: d?.instMatch ?? false,
      emailVerified: d?.emailVerified ?? tab === "email_verified",
      nameAgrees: d?.nameAgrees ?? false,
      shared: d?.shared ?? 0,
      competitor: d?.competitor ?? false,
      competitors: asStrings(d?.competitorCwids).map((c) => ({ cwid: c, name: nameOf(c) })),
      competitorOrcids: asStrings(d?.competitorOrcids),
      worksTotal: d?.worksTotal ?? 0,
      newWorks: d?.newWorks ?? 0,
      newWorksSample: asWorks(d?.newWorksSample),
      onFileOrcid: r.onFile,
      autoConfirmed: tab === "email_verified" && r.onFile === r.orcid,
      ...(sampled.has(key) ? { sampleDecision: sampled.get(key) ?? null } : {}),
    };
  });

  return { tab, rows, counts, sample, remaining };
}
