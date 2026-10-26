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
 *
 * v2 (docs/orcid-librarian-queue-spec.md, "v2"): the page is one card per
 * scholar with every candidate iD, best first, and the card sits in its best
 * candidate's tab (`cardTabOf`); tab counts are scholars. One filter (person
 * type, department / division, institution, candidate source) narrows the
 * list, the counts, the sample draw and bulk confirm alike, and a sample
 * stores the filter it was drawn under (`filter_key`). The uniqueness rules
 * (one qualifying row per scholar, best band) always read the scholar's FULL
 * candidate set, never the filtered one, so a filter can never hide a second
 * iD from bulk confirm.
 */
import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { loadSelectedDivisionRosterCwids, personFilterWhere } from "@/lib/edit/person-filter";
import { formatPublishedName } from "@/lib/postnominal";

import {
  bandRank,
  cardTabOf,
  compareCandidates,
  EMPTY_ORCID_QUEUE_FILTER,
  heldFor,
  isOrcidCandidateSource,
  isOrcidQueueTab,
  isReciterWorkStatus,
  ORCID_QUEUE_BANDS,
  ORCID_QUEUE_SAMPLE_SIZE,
  ORCID_QUEUE_TABS,
  orcidQueueFilterKey,
  pairState,
  sampleStatus,
  type OrcidCandidateSource,
  type OrcidEvidenceDetail,
  type OrcidQueueBand,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueFilter,
  type OrcidQueueRow,
  type OrcidQueueSampleState,
  type OrcidQueueTab,
  type OrcidQueueWork,
  type OrcidSampleBand,
  type OrcidWorkStatusDetail,
} from "./orcid-queue";

type Client = Pick<
  PrismaClient,
  | "orcidCandidateEvidence"
  | "orcidQueueSample"
  | "orcidDismissal"
  | "scholar"
  | "orcidCandidate"
  | "division"
  | "divisionMembership"
>;
type Tx = Prisma.TransactionClient;
type ReadClient = Client | Tx;

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
      | "dismissed"
      | "state_changed"
      | "sample_row_not_found"
      | "sample_row_decided"
      | "other_not_in_queue",
  ) {
    super(code);
  }
}

const pairKey = (cwid: string, orcid: string) => `${cwid}|${orcid}`;

/** Each scholar's undismissed `rpm_admin` iDs: with `scholar.orcid`, what makes
 *  up "on file" (`heldFor`). */
async function loadAdminIds(
  client: Pick<PrismaClient, "orcidCandidate"> | Tx,
  cwids: string[],
  dismissed: Set<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (cwids.length === 0) return out;
  const rows = await client.orcidCandidate.findMany({
    where: { cwid: { in: cwids }, source: "rpm_admin" },
    select: { cwid: true, orcid: true },
  });
  for (const r of rows) {
    if (dismissed.has(pairKey(r.cwid, r.orcid))) continue;
    const ids = out.get(r.cwid) ?? [];
    if (!ids.includes(r.orcid)) ids.push(r.orcid);
    out.set(r.cwid, ids);
  }
  return out;
}

/** One scholar's on-file state read on the writer: `scholar.orcid`, their
 *  undismissed `rpm_admin` iDs, and every iD they dismissed. */
async function readOnFile(tx: Tx, cwid: string) {
  const held = await tx.scholar.findUnique({
    where: { cwid },
    select: { orcid: true, orcidConfirmMethod: true },
  });
  if (!held) throw new OrcidQueueRefused(404, "scholar_not_found");
  const dismissed = new Set(
    (await tx.orcidDismissal.findMany({ where: { cwid }, select: { orcid: true } })).map(
      (d) => d.orcid,
    ),
  );
  const admins =
    (await loadAdminIds(tx, [cwid], new Set([...dismissed].map((o) => pairKey(cwid, o))))).get(
      cwid,
    ) ?? [];
  return { held, admins, dismissed };
}

/** True when a later ETL run re-scored the band after the sample was drawn: the
 *  sample measured a population that is gone, so it no longer authorizes bulk. */
export async function isSampleStale(
  client: Pick<PrismaClient, "orcidCandidateEvidence"> | Tx,
  band: OrcidSampleBand,
  startedAt: Date,
): Promise<boolean> {
  const newer = await client.orcidCandidateEvidence.findFirst({
    where: { band, computedAt: { gt: startedAt } },
    select: { cwid: true },
  });
  return newer !== null;
}

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
      url: typeof w.url === "string" ? w.url : null,
      // v2.1: absent on rows an earlier run wrote; null = ReCiter not read.
      ...(w.status === null || isReciterWorkStatus(w.status) ? { status: w.status } : {}),
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
    select: { id: true, startedAt: true, filterKey: true },
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
    filterKey: head.filterKey ?? "",
    total: rows.length,
    decided: rows.filter((r) => r.decision !== null).length,
    dismissed: rows.filter((r) => r.decision === "dismissed").length,
    status: sampleStatus(rows),
    pairs: rows,
  };
}

/** An open pair: a candidate of an active scholar, not dismissed, not on file. */
type OpenPair = {
  cwid: string;
  orcid: string;
  band: OrcidQueueBand;
  shared: number;
  nameAgrees: boolean;
  state: "queue" | "conflict";
  onFile: string | null;
};

/** Everything the queue rules read, in one pass: every evidence row, the open
 *  pairs (unfiltered), each pair's live sources, and which scholars the
 *  person filter keeps (null = no person filter). */
type QueueState = {
  all: Array<{ cwid: string; orcid: string; band: string }>;
  open: OpenPair[];
  sources: Map<string, OrcidCandidateSource[]>;
  people: Set<string> | null;
  filter: OrcidQueueFilter;
};

/** The scholars among `cwids` the person filter keeps (`personFilterWhere`, the
 *  Prisma form `/edit` rosters use; a division also matches its hand-added
 *  roster). null when the filter has no person facet. */
async function matchPeople(
  client: ReadClient,
  cwids: string[],
  filter: OrcidQueueFilter,
): Promise<Set<string> | null> {
  if (filter.types.length === 0 && filter.units.length === 0) return null;
  if (cwids.length === 0) return new Set();
  const roster = await loadSelectedDivisionRosterCwids(client, filter.units);
  const w = personFilterWhere({ types: filter.types, unitValues: filter.units }, [], roster);
  const rows = await client.scholar.findMany({
    where: {
      cwid: { in: cwids },
      ...(w.roleCategory ? { roleCategory: w.roleCategory } : {}),
      ...(w.unit ? { AND: [w.unit] } : {}),
    },
    select: { cwid: true },
  });
  return new Set(rows.map((r) => r.cwid));
}

async function loadQueueState(
  client: ReadClient,
  filter: OrcidQueueFilter = EMPTY_ORCID_QUEUE_FILTER,
): Promise<QueueState> {
  const all = await client.orcidCandidateEvidence.findMany({
    select: { cwid: true, orcid: true, band: true, shared: true, nameAgrees: true },
  });
  const cwids = [...new Set(all.map((r) => r.cwid))];
  const [scholars, dismissals, candidates, people] = await Promise.all([
    cwids.length === 0
      ? Promise.resolve([])
      : client.scholar.findMany({
          where: { cwid: { in: cwids } },
          select: { cwid: true, orcid: true, status: true, deletedAt: true },
        }),
    cwids.length === 0
      ? Promise.resolve([])
      : client.orcidDismissal.findMany({
          where: { cwid: { in: cwids } },
          select: { cwid: true, orcid: true },
        }),
    cwids.length === 0
      ? Promise.resolve([])
      : client.orcidCandidate.findMany({
          where: { cwid: { in: cwids } },
          select: { cwid: true, orcid: true, source: true },
        }),
    matchPeople(client, cwids, filter),
  ]);
  const held = new Map(
    scholars.filter((s) => s.status === "active" && !s.deletedAt).map((s) => [s.cwid, s.orcid]),
  );
  const dismissed = new Set(dismissals.map((d) => pairKey(d.cwid, d.orcid)));
  const admins = new Map<string, string[]>();
  const sources = new Map<string, OrcidCandidateSource[]>();
  for (const c of candidates) {
    const k = pairKey(c.cwid, c.orcid);
    if (isOrcidCandidateSource(c.source) && !(sources.get(k) ?? []).includes(c.source))
      sources.set(k, [...(sources.get(k) ?? []), c.source]);
    if (c.source !== "rpm_admin" || dismissed.has(k)) continue;
    const ids = admins.get(c.cwid) ?? [];
    if (!ids.includes(c.orcid)) ids.push(c.orcid);
    admins.set(c.cwid, ids);
  }
  for (const [k, v] of sources) sources.set(k, [...v].sort());
  const open: OpenPair[] = [];
  for (const r of all) {
    if (!held.has(r.cwid)) continue;
    if (!(ORCID_QUEUE_BANDS as readonly string[]).includes(r.band)) continue;
    const onFile = heldFor(r.orcid, held.get(r.cwid) ?? null, admins.get(r.cwid) ?? []);
    const state = pairState(r.orcid, onFile, dismissed.has(pairKey(r.cwid, r.orcid)));
    if (state !== "queue" && state !== "conflict") continue;
    open.push({
      cwid: r.cwid,
      orcid: r.orcid,
      band: r.band as OrcidQueueBand,
      shared: r.shared,
      nameAgrees: r.nameAgrees,
      state,
      onFile: state === "conflict" ? onFile : null,
    });
  }
  return { all, open, sources, people, filter };
}

/** The pair passes the filter: its scholar the person facets, and (when
 *  sources are selected) one of its sources. */
function pairInFilter(st: QueueState, cwid: string, orcid: string): boolean {
  if (st.people && !st.people.has(cwid)) return false;
  if (st.filter.sources.length === 0) return true;
  const mine = st.sources.get(pairKey(cwid, orcid)) ?? [];
  return mine.some((x) => st.filter.sources.includes(x));
}

/** The band's rows that qualify for a sample or a bulk confirm: nothing on
 *  file, not dismissed (`loadQueueState`), the pair inside the filter, and,
 *  over the scholar's FULL candidate set (never the filtered one), exactly one
 *  open row in the band and no open row in a stronger band, so the card sits in
 *  this band's tab. The one-row rule is v1's (spec Deviations); the best-band
 *  rule is v2's, so a sampled pair is always on its band's tab. `total` counts
 *  the band's evidence rows inside the filter, as v1 counted the whole band. */
function qualifyingFrom(
  st: QueueState,
  band: OrcidQueueBand,
): { qualifying: Array<{ cwid: string; orcid: string }>; total: number } {
  const byCwid = new Map<string, OpenPair[]>();
  for (const p of st.open)
    if (p.state === "queue") byCwid.set(p.cwid, [...(byCwid.get(p.cwid) ?? []), p]);
  const qualifying: Array<{ cwid: string; orcid: string }> = [];
  for (const [cwid, ps] of byCwid) {
    const inBand = ps.filter((p) => p.band === band);
    if (inBand.length !== 1) continue;
    if (ps.some((p) => bandRank(p.band) < bandRank(band))) continue;
    if (!pairInFilter(st, cwid, inBand[0]!.orcid)) continue;
    qualifying.push({ cwid, orcid: inBand[0]!.orcid });
  }
  const total = st.all.filter((r) => r.band === band && pairInFilter(st, r.cwid, r.orcid)).length;
  return { qualifying, total };
}

/** `qualifyingFrom` read now, on the client given (the writer, in a route). */
export async function loadQualifying(
  client: ReadClient,
  band: OrcidQueueBand,
  filter: OrcidQueueFilter = EMPTY_ORCID_QUEUE_FILTER,
): Promise<{ qualifying: Array<{ cwid: string; orcid: string }>; total: number }> {
  return qualifyingFrom(await loadQueueState(client, filter), band);
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
 *  random rows that qualify now under `filter`, stored with the filter's key.
 *  A passed or locked sample is not open, so a call after one starts a fresh
 *  sample (which supersedes it for bulk). An open sample drawn under a
 *  DIFFERENT filter is not returned either: one sample per band at a time, so
 *  drawing one for this filter abandons it.
 *  `restart` abandons an open sample the same way: a sampled pair can leave the
 *  queue before it is decided (the scholar confirms it, or the ETL drops it), so
 *  an open sample must never be the band's last word. The fresh sample still
 *  has to pass in full, so this opens no way around the gate. */
export async function openOrStartSample(
  tx: Tx,
  band: OrcidSampleBand,
  actor: string,
  now: Date,
  opts: { restart?: boolean; filter?: OrcidQueueFilter } = {},
): Promise<{ sample: OrcidQueueSampleState; created: boolean }> {
  const filter = opts.filter ?? EMPTY_ORCID_QUEUE_FILTER;
  const filterKey = orcidQueueFilterKey(filter);
  const latest = await loadLatestSample(tx, band);
  if (latest && latest.status === "open" && !opts.restart && latest.filterKey === filterKey) {
    const { id, band: b, startedAt, total, decided, dismissed, status } = latest;
    return {
      sample: { id, band: b, startedAt, filterKey, total, decided, dismissed, status },
      created: false,
    };
  }
  const { qualifying } = await loadQualifying(tx, band, filter);
  const chosen = pick(qualifying, ORCID_QUEUE_SAMPLE_SIZE);
  const id = randomUUID();
  if (chosen.length > 0) {
    await tx.orcidQueueSample.createMany({
      data: chosen.map((c) => ({
        id,
        band,
        startedBy: actor,
        startedAt: now,
        filterKey,
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
      filterKey,
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
  /** A dismissal made with a confirm of this iD (`dismissOthers`). */
  alongside?: string;
};

/** Confirm one pair (method `librarian`). The pair must be in the evidence
 *  table and not dismissed (a librarian never overrides the scholar's own
 *  Remove or an earlier Not this person). "On file" is `scholar.orcid` or an
 *  undismissed `rpm_admin` iD, as on /edit. An iD already on file is refused; a
 *  DIFFERENT iD on file (the Conflicts tab) is replaced only with `replace`, and
 *  every replaced iD is dismissed. Optimistic: the update re-checks what was read. */
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
  const { held, admins, dismissed } = await readOnFile(tx, pair.cwid);
  const onFile = heldFor(pair.orcid, held.orcid, admins);
  if (onFile === pair.orcid) throw new OrcidQueueRefused(409, "already_on_file");
  if (dismissed.has(pair.orcid)) throw new OrcidQueueRefused(409, "dismissed");
  if (onFile !== null && !pair.replace) throw new OrcidQueueRefused(409, "on_file_differs");
  const replaced = [...new Set([held.orcid, ...admins])].filter(
    (o): o is string => o !== null && o !== pair.orcid,
  );
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
  // The /api/edit/orcid confirm write; a no-op here, since a dismissed pair is refused above.
  await tx.orcidDismissal.deleteMany({ where: { cwid: pair.cwid, orcid: pair.orcid } });
  for (const r of replaced) {
    await tx.orcidDismissal.upsert({
      where: { cwid_orcid: { cwid: pair.cwid, orcid: r } },
      create: { cwid: pair.cwid, orcid: r },
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
    beforeValues: { orcid: held.orcid ?? onFile, method: held.orcidConfirmMethod },
    afterValues: {
      orcid: pair.orcid,
      method: "librarian",
      band: evidence.band,
      ...(replaced.length > 0 ? { dismissed: replaced } : {}),
      ...(meta.sampleId ? { sample_id: meta.sampleId } : {}),
      ...(meta.bulk ? { bulk: true } : {}),
    },
    ts: meta.ts,
    requestId: meta.requestId,
  });
}

/** "Not this person": an `orcid_dismissal` row. On the iD on file it is the
 *  Undo of an email auto-confirm, which also clears `scholar.orcid` and its
 *  confirmation; any other iD on file, an `rpm_admin` one included, is refused
 *  (that is Remove on /edit). */
export async function dismissPair(
  tx: Tx,
  pair: { cwid: string; orcid: string },
  meta: WriteMeta,
): Promise<{ undid: boolean }> {
  const { held, admins } = await readOnFile(tx, pair.cwid);
  let undid = false;
  if (heldFor(pair.orcid, held.orcid, admins) === pair.orcid) {
    if (held.orcid !== pair.orcid || held.orcidConfirmMethod !== "email_verified")
      throw new OrcidQueueRefused(409, "on_file");
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
      ...(meta.alongside ? { with_confirm_of: meta.alongside } : {}),
      ...(meta.sampleId && !meta.alongside ? { sample_id: meta.sampleId } : {}),
    },
    ts: meta.ts,
    requestId: meta.requestId,
  });
  return { undid };
}

/** v2 item 5: "Not this person" on the scholar's OTHER candidate iDs, in the
 *  same transaction as the confirm that precedes it. Each must be a candidate
 *  in the evidence table for this scholar (404 `other_not_in_queue`
 *  otherwise, which rolls the whole decision back); each gets its own
 *  dismissal and `orcid_librarian_dismiss` audit row (`dismissPair`). */
export async function dismissOthers(
  tx: Tx,
  cwid: string,
  confirmed: string,
  others: readonly string[],
  meta: WriteMeta,
): Promise<string[]> {
  const done: string[] = [];
  for (const orcid of [...new Set(others)].filter((o) => o !== confirmed)) {
    const evidence = await tx.orcidCandidateEvidence.findUnique({
      where: { cwid_orcid: { cwid, orcid } },
      select: { band: true },
    });
    if (!evidence) throw new OrcidQueueRefused(404, "other_not_in_queue");
    await dismissPair(tx, { cwid, orcid }, { ...meta, alongside: confirmed });
    done.push(orcid);
  }
  return done;
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

/** The ETL's `evidence_detail`, or null (a v1 row, or a shape we do not know). */
function asDetail(v: unknown): OrcidEvidenceDetail | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Partial<OrcidEvidenceDetail>;
  if (!d.names || !Array.isArray(d.institutions) || !Array.isArray(d.shared)) return null;
  return {
    names: d.names,
    institutions: d.institutions,
    institutionEmail: d.institutionEmail ?? null,
    email: d.email ?? null,
    shared: d.shared,
    competitors: {
      cwids: Array.isArray(d.competitors?.cwids) ? d.competitors.cwids : [],
      orcids: Array.isArray(d.competitors?.orcids) ? d.competitors.orcids : [],
    },
    sources: Array.isArray(d.sources) ? d.sources : [],
    worksDropped: typeof d.worksDropped === "number" ? d.worksDropped : 0,
    ...(asWorkStatus(d.workStatus) ? { workStatus: asWorkStatus(d.workStatus)! } : {}),
  };
}

/** `evidence_detail.workStatus` (v2.1), or null on an earlier run's row. */
function asWorkStatus(v: unknown): OrcidWorkStatusDetail | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const w = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  const counts: OrcidWorkStatusDetail["counts"] = {};
  if (w.counts && typeof w.counts === "object")
    for (const [k, c] of Object.entries(w.counts as Record<string, unknown>))
      if (isReciterWorkStatus(k) && n(c) > 0) counts[k] = n(c);
  return {
    counts,
    unknown: n(w.unknown),
    reciterRead: w.reciterRead === true,
    acceptedInReciter: n(w.acceptedInReciter),
    resolvedByDoi: n(w.resolvedByDoi),
    resolvedByTitle: n(w.resolvedByTitle),
    pubmedUnknown: n(w.pubmedUnknown),
  };
}

type CardPair = {
  orcid: string;
  band: OrcidQueueBand;
  shared: number;
  nameAgrees: boolean;
  state: OrcidQueueRow["state"];
  onFile: string | null;
};

/**
 * One tab of the queue: one card per scholar (every candidate iD, best first),
 * the band's sample first, under `filter`; plus every tab's count of scholars.
 */
export async function loadOrcidQueue(
  client: Client,
  rawTab: unknown,
  filter: OrcidQueueFilter = EMPTY_ORCID_QUEUE_FILTER,
): Promise<OrcidQueueData> {
  const tab: OrcidQueueTab = isOrcidQueueTab(rawTab) ? rawTab : "strong";
  const [st, autoConfirmed] = await Promise.all([
    loadQueueState(client, filter),
    client.scholar.findMany({
      where: { orcidConfirmMethod: "email_verified", orcid: { not: null }, deletedAt: null },
      select: { cwid: true, orcid: true },
    }),
  ]);
  const auto = autoConfirmed.filter((a) => !st.people || st.people.has(a.cwid));

  // Every scholar's pairs, unfiltered: the tab a card sits in reads them all.
  const byCwid = new Map<string, CardPair[]>();
  const add = (cwid: string, p: CardPair) => byCwid.set(cwid, [...(byCwid.get(cwid) ?? []), p]);
  for (const p of st.open) add(p.cwid, { ...p });
  for (const a of auto)
    add(a.cwid, {
      orcid: a.orcid!,
      band: "email_verified",
      shared: 0,
      nameAgrees: false,
      state: "auto_confirmed",
      onFile: a.orcid,
    });

  const counts = Object.fromEntries(ORCID_QUEUE_TABS.map((t) => [t, 0])) as Record<
    OrcidQueueTab,
    number
  >;
  const inTab = new Map<string, CardPair[]>();
  for (const [cwid, ps] of byCwid) {
    if (!ps.some((p) => pairInFilter(st, cwid, p.orcid))) continue;
    const t = cardTabOf(ps);
    counts[t]++;
    if (t === tab) inTab.set(cwid, ps);
  }

  let sample: OrcidQueueSampleState | null = null;
  let remaining: number | null = null;
  const sampled = new Map<string, "confirmed" | "dismissed" | null>();
  const filterKey = orcidQueueFilterKey(filter);
  if (tab === "strong" || tab === "shared_only") {
    const latest = await loadLatestSample(client, tab);
    if (latest) {
      const { pairs, ...state } = latest;
      sample =
        state.status === "passed" && (await isSampleStale(client, tab, new Date(state.startedAt)))
          ? { ...state, stale: true }
          : state;
      // A sample drawn under another filter shows its state only; its rows
      // and its bulk confirm belong to that filter.
      const mine = state.filterKey === filterKey;
      if (state.status === "open" && mine) {
        for (const p of pairs) {
          sampled.set(pairKey(p.cwid, p.orcid), p.decision as "confirmed" | "dismissed" | null);
          const ps = inTab.get(p.cwid) ?? [];
          const all = byCwid.get(p.cwid) ?? [];
          const stillOpen = all.some(
            (x) => x.orcid === p.orcid && (x.state === "queue" || x.state === "conflict"),
          );
          if (ps.some((x) => x.orcid === p.orcid)) {
            // Already on this tab's card.
          } else if (stillOpen) {
            // Still undecided, but the card now sits in another tab (a later ETL
            // run moved the band, or a stronger iD appeared): bring the scholar's
            // real pairs here, so the sampled one stays decidable and stamps the
            // sample, and the card shows every iD the scholar has.
            for (const x of all) if (!ps.some((y) => y.orcid === x.orcid)) ps.push({ ...x });
          } else {
            // Decided since (on file or dismissed): it left the band's list; show
            // it in place, decided.
            ps.push({
              orcid: p.orcid,
              band: tab,
              shared: 0,
              nameAgrees: false,
              state: "on_file",
              onFile: null,
            });
          }
          inTab.set(p.cwid, ps);
        }
      }
      if (state.status === "passed" && !sample.stale && mine) {
        const done = new Set(pairs.map((p) => pairKey(p.cwid, p.orcid)));
        remaining = qualifyingFrom(st, tab).qualifying.filter(
          (q) => !done.has(pairKey(q.cwid, q.orcid)),
        ).length;
      }
    }
  }

  // Cards: the sample first, then by best candidate.
  const isSampledCard = (cwid: string, ps: CardPair[]) =>
    ps.some((p) => sampled.has(pairKey(cwid, p.orcid)));
  const best = (ps: CardPair[]) => [...ps].sort(compareCandidates)[0]!;
  const ordered = [...inTab].sort(
    ([ca, a], [cb, b]) =>
      Number(isSampledCard(cb, b)) - Number(isSampledCard(ca, a)) ||
      compareCandidates(best(a), best(b)),
  );
  const sampledCards = ordered.filter(([c, ps]) => isSampledCard(c, ps)).length;
  const shown = ordered.slice(0, Math.max(TAB_LIMIT, sampledCards));

  const wanted = shown.flatMap(([cwid, ps]) => ps.map((p) => ({ cwid, orcid: p.orcid })));
  const details =
    wanted.length === 0
      ? []
      : await client.orcidCandidateEvidence.findMany({ where: { OR: wanted } });
  const detailBy = new Map(details.map((d) => [pairKey(d.cwid, d.orcid), d]));
  const people = new Set(shown.map(([c]) => c));
  for (const d of details) for (const c of asStrings(d.competitorCwids)) people.add(c);
  const scholars = new Map(
    people.size === 0
      ? []
      : (
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

  const rowOf = (cwid: string, p: CardPair): OrcidQueueRow => {
    const d = detailBy.get(pairKey(cwid, p.orcid));
    const detail = asDetail(d?.evidenceDetail);
    const band = (d?.band ?? p.band) as OrcidQueueBand;
    const key = pairKey(cwid, p.orcid);
    const competitorShared = new Map(
      (detail?.competitors.cwids ?? []).map((c) => [c.cwid, c] as const),
    );
    const orcidShared = new Map(
      (detail?.competitors.orcids ?? []).map((o) => [o.orcid, o.shared] as const),
    );
    return {
      cwid,
      orcid: p.orcid,
      band: (ORCID_QUEUE_BANDS as readonly string[]).includes(band) ? band : "weak",
      state: p.state,
      instMatch: d?.instMatch ?? false,
      historyMatch: d?.historyMatch ?? false,
      emailVerified: d?.emailVerified ?? p.state === "auto_confirmed",
      nameAgrees: d?.nameAgrees ?? false,
      shared: d?.shared ?? 0,
      competitor: d?.competitor ?? false,
      competitors: asStrings(d?.competitorCwids).map((c) => ({
        cwid: c,
        name: nameOf(c),
        shared: competitorShared.get(c)?.shared ?? null,
        reason: competitorShared.get(c)?.reason ?? null,
      })),
      competitorOrcids: asStrings(d?.competitorOrcids).map((o) => ({
        orcid: o,
        shared: orcidShared.get(o) ?? null,
      })),
      worksTotal: d?.worksTotal ?? 0,
      newWorks: d?.newWorks ?? 0,
      newWorksSample: asWorks(d?.newWorksSample),
      sources: st.sources.get(key) ?? [],
      detail,
      onFileOrcid: p.state === "conflict" || p.state === "auto_confirmed" ? p.onFile : null,
      autoConfirmed: p.state === "auto_confirmed",
      ...(sampled.has(key) ? { sampleDecision: sampled.get(key) ?? null } : {}),
    };
  };

  const cards: OrcidQueueCard[] = shown.map(([cwid, ps]) => {
    const s = scholars.get(cwid);
    const candidates = ps
      .map((p) => rowOf(cwid, p))
      .sort(
        (a, b) =>
          Number(b.state === "auto_confirmed") - Number(a.state === "auto_confirmed") ||
          compareCandidates(a, b),
      );
    return {
      cwid,
      slug: s?.slug ?? null,
      name: nameOf(cwid),
      scholarNames: [...new Set([s?.fullName, s?.preferredName].filter((n): n is string => !!n))],
      title: s?.primaryTitle ?? null,
      department: s?.primaryDepartment ?? null,
      tab,
      candidates,
    };
  });

  return { tab, cards, counts, filter, sample, remaining };
}
