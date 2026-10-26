/**
 * ORCID librarian queue — the loaders the page and the scholar route read,
 * and the writes the decide route makes (`app/api/edit/orcid-queue/*`).
 * Server-only: the client component imports the pure sibling
 * `orcid-queue.ts`. Every function takes the Prisma client (or the
 * transaction client) as a parameter and none checks authorization: the page
 * and routes gate first.
 *
 * A confirm is the same write `POST /api/edit/orcid` makes (`scholar.orcid`,
 * `orcid_confirmed_at`, the pair's dismissal deleted) plus method `librarian`
 * and `orcid_confirmed_by` = the real librarian. A dismiss is an
 * `orcid_dismissal` row; on an iD the ETL email-confirmed it is also the Undo,
 * which clears `scholar.orcid` (the Remove write). Each runs inside the
 * caller's transaction with its audit row.
 *
 * v3 (Roadmap/orcid-queue-v3-redesign-plan.md, PR A): the page lists every
 * scholar in the queue as a summary (`loadOrcidQueue`, under the person and
 * source filter), and the selected scholar's card loads on its own
 * (`loadOrcidQueueCard`). The sample gate and bulk confirm are gone.
 */
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { loadSelectedDivisionRosterCwids, personFilterWhere } from "@/lib/edit/person-filter";
import { formatPublishedName } from "@/lib/postnominal";

import {
  compareCandidates,
  EMPTY_ORCID_QUEUE_FILTER,
  heldFor,
  isOrcidCandidateSource,
  isReciterWorkStatus,
  ORCID_QUEUE_BANDS,
  pairState,
  type OrcidCandidateSource,
  type OrcidEvidenceDetail,
  type OrcidOnFile,
  type OrcidOnFileHow,
  type OrcidQueueBand,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueFilter,
  type OrcidQueueRow,
  type OrcidQueueSummary,
  type OrcidQueueWork,
  type OrcidWorkStatusDetail,
} from "./orcid-queue";

type Client = Pick<
  PrismaClient,
  | "orcidCandidateEvidence"
  | "publicationAuthor"
  | "orcidDismissal"
  | "scholar"
  | "orcidCandidate"
  | "division"
  | "divisionMembership"
>;
type Tx = Prisma.TransactionClient;
type ReadClient = Client | Tx;

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

/** An open pair: a candidate of an active scholar, not dismissed, not on file. */
type OpenPair = {
  cwid: string;
  orcid: string;
  band: OrcidQueueBand;
  shared: number;
  worksTotal: number;
  nameAgrees: boolean;
  competitor: boolean;
  state: "queue" | "conflict";
  onFile: string | null;
};

/** Everything the queue rules read, in one pass: every evidence row, the open
 *  pairs (unfiltered), each pair's live sources, and which scholars the
 *  person filter keeps (null = no person filter). */
type QueueState = {
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

/** `only`: one scholar's pairs (the card route), else every evidence row. */
async function loadQueueState(
  client: ReadClient,
  filter: OrcidQueueFilter = EMPTY_ORCID_QUEUE_FILTER,
  only?: string,
): Promise<QueueState> {
  const all = await client.orcidCandidateEvidence.findMany({
    ...(only ? { where: { cwid: only } } : {}),
    select: {
      cwid: true,
      orcid: true,
      band: true,
      shared: true,
      worksTotal: true,
      nameAgrees: true,
      competitor: true,
    },
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
      worksTotal: r.worksTotal,
      nameAgrees: r.nameAgrees,
      competitor: r.competitor,
      state,
      onFile: state === "conflict" ? onFile : null,
    });
  }
  return { open, sources, people, filter };
}

/** The pair passes the filter: its scholar the person facets, and (when
 *  sources are selected) one of its sources. */
function pairInFilter(st: QueueState, cwid: string, orcid: string): boolean {
  if (st.people && !st.people.has(cwid)) return false;
  if (st.filter.sources.length === 0) return true;
  const mine = st.sources.get(pairKey(cwid, orcid)) ?? [];
  return mine.some((x) => st.filter.sources.includes(x));
}

type WriteMeta = {
  actor: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  ts: Date;
  /** A dismissal made with a confirm of this iD (`dismissOthers`). */
  alongside?: string;
  /** v3: a dismissal made by "None of these". */
  noneOfThese?: boolean;
};

/** Confirm one pair (method `librarian`). The pair must be in the evidence
 *  table and not dismissed (a librarian never overrides the scholar's own
 *  Remove or an earlier Not this person). "On file" is `scholar.orcid` or an
 *  undismissed `rpm_admin` iD, as on /edit. An iD already on file is refused; a
 *  DIFFERENT iD on file (a possible error) is replaced only with `replace`, and
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
      ...(meta.noneOfThese ? { none_of_these: true } : {}),
    },
    ts: meta.ts,
    requestId: meta.requestId,
  });
  return { undid };
}

/** v2 item 5: "Not this person" on the scholar's OTHER candidate iDs, in the
 *  same transaction as the decision on `decided` that precedes it: a confirm,
 *  or (v3, `meta.noneOfThese`) the first iD of "None of these". Each must be a candidate
 *  in the evidence table for this scholar (404 `other_not_in_queue`
 *  otherwise, which rolls the whole decision back); each gets its own
 *  dismissal and `orcid_librarian_dismiss` audit row (`dismissPair`). */
export async function dismissOthers(
  tx: Tx,
  cwid: string,
  decided: string,
  others: readonly string[],
  meta: WriteMeta,
): Promise<string[]> {
  const done: string[] = [];
  for (const orcid of [...new Set(others)].filter((o) => o !== decided)) {
    const evidence = await tx.orcidCandidateEvidence.findUnique({
      where: { cwid_orcid: { cwid, orcid } },
      select: { band: true },
    });
    if (!evidence) throw new OrcidQueueRefused(404, "other_not_in_queue");
    await dismissPair(
      tx,
      { cwid, orcid },
      meta.noneOfThese ? meta : { ...meta, alongside: decided },
    );
    done.push(orcid);
  }
  return done;
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

type ScholarRow = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  postnominal: string | null;
  roleCategory: string | null;
  primaryTitle: string | null;
  primaryDepartment: string | null;
};

const SCHOLAR_SELECT = {
  cwid: true,
  slug: true,
  preferredName: true,
  fullName: true,
  postnominal: true,
  roleCategory: true,
  primaryTitle: true,
  primaryDepartment: true,
} as const;

const publishedName = (s: ScholarRow | undefined, cwid: string) =>
  formatPublishedName(
    s?.preferredName ?? s?.fullName ?? cwid,
    s?.postnominal ?? null,
    s?.roleCategory ?? null,
  );

/** A scholar's pairs as the card and the list see them: their open pairs plus
 *  the iD the ETL email-confirmed (state `auto_confirmed`), best first. */
type CardPair = Pick<
  OpenPair,
  "orcid" | "band" | "shared" | "worksTotal" | "nameAgrees" | "competitor" | "onFile"
> & { state: OrcidQueueRow["state"] };

function pairsByScholar(
  st: QueueState,
  auto: Array<{ cwid: string; orcid: string | null }>,
): Map<string, CardPair[]> {
  const byCwid = new Map<string, CardPair[]>();
  const add = (cwid: string, p: CardPair) => byCwid.set(cwid, [...(byCwid.get(cwid) ?? []), p]);
  for (const p of st.open) add(p.cwid, p);
  for (const a of auto) {
    if (!a.orcid) continue;
    add(a.cwid, {
      orcid: a.orcid,
      band: "email_verified",
      shared: 0,
      worksTotal: 0,
      nameAgrees: false,
      competitor: false,
      state: "auto_confirmed",
      onFile: a.orcid,
    });
  }
  for (const ps of byCwid.values()) ps.sort(compareCandidates);
  return byCwid;
}

/** Scholars whose iD the ETL confirmed from a verified email. */
const loadAutoConfirmed = (client: ReadClient, cwid?: string) =>
  client.scholar.findMany({
    where: {
      ...(cwid ? { cwid } : {}),
      orcidConfirmMethod: "email_verified",
      orcid: { not: null },
      deletedAt: null,
    },
    select: { cwid: true, orcid: true },
  });

/**
 * v3: every scholar in the queue under `filter`, as list summaries. A scholar
 * is in when any of their pairs passes the filter; their summary still carries
 * every pair, so the score and "Clearest winner" read the full set.
 */
export async function loadOrcidQueue(
  client: Client,
  filter: OrcidQueueFilter = EMPTY_ORCID_QUEUE_FILTER,
): Promise<OrcidQueueData> {
  const [st, autoConfirmed] = await Promise.all([
    loadQueueState(client, filter),
    loadAutoConfirmed(client),
  ]);
  const byCwid = pairsByScholar(
    st,
    autoConfirmed.filter((a) => !st.people || st.people.has(a.cwid)),
  );
  const shown = [...byCwid].filter(([cwid, ps]) => ps.some((p) => pairInFilter(st, cwid, p.orcid)));
  const scholars = new Map(
    shown.length === 0
      ? []
      : (
          await client.scholar.findMany({
            where: { cwid: { in: shown.map(([c]) => c) } },
            select: SCHOLAR_SELECT,
          })
        ).map((s) => [s.cwid, s]),
  );
  const summaries: OrcidQueueSummary[] = shown.map(([cwid, ps]) => {
    const s = scholars.get(cwid);
    return {
      cwid,
      name: publishedName(s, cwid),
      surname: (s?.fullName ?? cwid).trim().split(/\s+/).pop()!.toLowerCase(),
      department: s?.primaryDepartment ?? null,
      candidates: ps.map(({ orcid, band, shared, worksTotal, nameAgrees, competitor }) => ({
        orcid,
        band,
        shared,
        worksTotal,
        nameAgrees,
        competitor,
        sources: st.sources.get(pairKey(cwid, orcid)) ?? [],
      })),
      conflict: ps.some((p) => p.state === "conflict"),
      autoConfirmed: ps.some((p) => p.state === "auto_confirmed"),
    };
  });
  return { summaries, filter };
}

const ON_FILE_HOWS: readonly string[] = [
  "self",
  "proxy",
  "librarian",
  "email_verified",
  "authenticated",
];

/**
 * v3: one scholar's card (every candidate iD, best first, with the ETL's
 * evidence, the iD on file and where it came from, and their publication
 * count), or null when the scholar has no open pair and no email-confirmed iD.
 */
export async function loadOrcidQueueCard(
  client: Client,
  cwid: string,
): Promise<OrcidQueueCard | null> {
  const [st, autoConfirmed] = await Promise.all([
    loadQueueState(client, EMPTY_ORCID_QUEUE_FILTER, cwid),
    loadAutoConfirmed(client, cwid),
  ]);
  const ps = pairsByScholar(st, autoConfirmed).get(cwid);
  if (!ps || ps.length === 0) return null;

  const [details, me, reciterTotal] = await Promise.all([
    client.orcidCandidateEvidence.findMany({ where: { cwid } }),
    client.scholar.findUnique({
      where: { cwid },
      select: {
        ...SCHOLAR_SELECT,
        orcid: true,
        orcidConfirmMethod: true,
        orcidConfirmedAt: true,
        orcidConfirmedBy: true,
      },
    }),
    client.publicationAuthor.count({ where: { cwid, isConfirmed: true } }),
  ]);
  const detailBy = new Map(details.map((d) => [d.orcid, d]));
  const onFileOrcid = ps.find((p) => p.onFile)?.onFile ?? me?.orcid ?? null;
  const people = new Set<string>();
  for (const d of details) for (const c of asStrings(d.competitorCwids)) people.add(c);
  if (me?.orcidConfirmedBy && me.orcidConfirmedBy !== "ETL") people.add(me.orcidConfirmedBy);
  const named = new Map(
    people.size === 0
      ? []
      : (
          await client.scholar.findMany({
            where: { cwid: { in: [...people] } },
            select: SCHOLAR_SELECT,
          })
        ).map((s) => [s.cwid, s]),
  );

  let onFile: OrcidOnFile | null = null;
  if (onFileOrcid) {
    const fromScholar = me?.orcid === onFileOrcid;
    const method = fromScholar ? me?.orcidConfirmMethod : null;
    const how: OrcidOnFileHow = !fromScholar
      ? "rpm_admin"
      : method && ON_FILE_HOWS.includes(method)
        ? (method as OrcidOnFileHow)
        : "identity";
    const by = fromScholar ? (me?.orcidConfirmedBy ?? null) : null;
    onFile = {
      orcid: onFileOrcid,
      how,
      at: fromScholar ? (me?.orcidConfirmedAt?.toISOString() ?? null) : null,
      by,
      byName: by && by !== "ETL" ? publishedName(named.get(by), by) : null,
    };
  }

  const candidates: OrcidQueueRow[] = ps.map((p) => {
    const d = detailBy.get(p.orcid);
    const detail = asDetail(d?.evidenceDetail);
    const band = d?.band ?? p.band;
    const competitorShared = new Map(
      (detail?.competitors.cwids ?? []).map((c) => [c.cwid, c] as const),
    );
    const orcidShared = new Map(
      (detail?.competitors.orcids ?? []).map((o) => [o.orcid, o.shared] as const),
    );
    return {
      cwid,
      orcid: p.orcid,
      band: (ORCID_QUEUE_BANDS as readonly string[]).includes(band)
        ? (band as OrcidQueueBand)
        : "weak",
      state: p.state,
      instMatch: d?.instMatch ?? false,
      historyMatch: d?.historyMatch ?? false,
      emailVerified: d?.emailVerified ?? p.state === "auto_confirmed",
      nameAgrees: d?.nameAgrees ?? false,
      shared: d?.shared ?? 0,
      competitor: d?.competitor ?? false,
      competitors: asStrings(d?.competitorCwids).map((c) => ({
        cwid: c,
        name: publishedName(named.get(c), c),
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
      sources: st.sources.get(pairKey(cwid, p.orcid)) ?? [],
      detail,
      onFileOrcid: p.state === "queue" ? null : p.onFile,
      autoConfirmed: p.state === "auto_confirmed",
    };
  });

  return {
    cwid,
    slug: me?.slug ?? null,
    name: publishedName(me ?? undefined, cwid),
    scholarNames: [...new Set([me?.fullName, me?.preferredName].filter((n): n is string => !!n))],
    title: me?.primaryTitle ?? null,
    department: me?.primaryDepartment ?? null,
    onFile,
    reciterTotal,
    candidates,
  };
}
