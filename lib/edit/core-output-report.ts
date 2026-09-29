/**
 * Report 12 — "Output over time" (core-only). This core's confirmed
 * publications per year; each publication counts once, however many core
 * users authored it. Split by the evidence that put it in the confirmed set,
 * one bucket per paper, in this precedence:
 *
 *   1. Manually added — an active `claimed` claim with NO `publication_core`
 *      row for this core (an owner's PMID add; the engine never scored it).
 *   2. Acknowledgment — the engine row's `signal_ack` (a core alias in the
 *      paper's full text).
 *   3. Core-staff co-author — `signal_coauthors` is a real, non-empty JSON
 *      array. A JSON `null` (or SQL NULL, or `[]`) is NOT a co-author signal:
 *      `Array.isArray`, never "is not null".
 *   4. Other signals — an engine row with neither (LLM read, repeat user,
 *      MeSH / method prior).
 *
 * All cores (`center=all`, superuser only): a publication confirmed for SEVERAL
 * cores still counts once, in the STRONGEST bucket any of those cores gives it
 * (`mergeEvidence`): Acknowledgment, then Core-staff co-author, then Other
 * signals, then Manually added — the display order. Each core's bucket is
 * the per-core precedence above, read only from a core the paper is
 * confirmed for; a manual add is weakest because it is the one bucket with no
 * engine signal behind it, so any core's documentary evidence outranks it.
 *
 * Year basis (`basis`): `cy` = `publication.year`; `added` = the year of
 * `date_added_to_entrez` (the PubMed add date). There is NO fiscal-year basis:
 * `publication` stores a year but no publication month or date, so a
 * July–June year of PUBLICATION cannot be computed. (Report 8's "fiscal year"
 * reads the PubMed add date instead; offering that here under a fiscal label
 * would misstate what it counts.) A paper with no value on the chosen basis
 * is left out of the chart and counted in `undated`.
 *
 * URL: `basis`, `from` / `to` (default the last nine years), repeated `evid`
 * (none = all four), `view` (`year` | `publications`, a view).
 *
 * Server-only (`@/lib/db`); `evidenceBucket` / `buildCoreOutput` are pure.
 */
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import {
  chunk,
  coreCriteriaHead,
  parseYear,
  type CriteriaCore,
} from "@/lib/edit/core-report-common";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export const EVIDENCE_KEYS = ["manual", "ack", "coauthor", "other"] as const;
export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];
/** Display order (the mockup's): acknowledgment first, manual last. */
export const EVIDENCE_ORDER: readonly EvidenceKey[] = ["ack", "coauthor", "other", "manual"];
export const EVIDENCE_LABEL: Record<EvidenceKey, string> = {
  ack: "Acknowledgment",
  coauthor: "Core-staff co-author",
  other: "Other signals",
  manual: "Manually added",
};

export const OUTPUT_BASIS_LABEL = { cy: "Calendar year", added: "Date added to PubMed" } as const;
export type OutputBasis = keyof typeof OUTPUT_BASIS_LABEL;
export type CoreOutputView = "year" | "publications";

export type CoreOutputParams = {
  basis: OutputBasis;
  from: number;
  to: number;
  /** The checked buckets; always non-empty (none in the URL = all). */
  evid: EvidenceKey[];
  view: CoreOutputView;
};

export const DEFAULT_SPAN = 9;

export function parseCoreOutputParams(
  sp: URLSearchParams,
  now: Date = new Date(),
): CoreOutputParams {
  const thisYear = now.getUTCFullYear();
  let from = parseYear(sp.get("from")) ?? thisYear - (DEFAULT_SPAN - 1);
  let to = parseYear(sp.get("to")) ?? thisYear;
  if (from > to) [from, to] = [to, from];
  const evid = EVIDENCE_ORDER.filter((k) => sp.getAll("evid").includes(k));
  return {
    basis: sp.get("basis") === "added" ? "added" : "cy",
    from,
    to,
    evid: evid.length > 0 ? evid : [...EVIDENCE_ORDER],
    view: sp.get("view") === "publications" ? "publications" : "year",
  };
}

export function coreOutputQuery(
  p: CoreOutputParams,
  view: CoreOutputView = p.view,
): URLSearchParams {
  const q = new URLSearchParams();
  if (p.basis !== "cy") q.set("basis", p.basis);
  q.set("from", String(p.from));
  q.set("to", String(p.to));
  if (p.evid.length < EVIDENCE_ORDER.length) for (const e of p.evid) q.append("evid", e);
  if (view !== "year") q.set("view", view);
  return q;
}

export function isCoreOutputDefault(p: CoreOutputParams, now: Date = new Date()): boolean {
  const d = parseCoreOutputParams(new URLSearchParams(), now);
  return (
    p.basis === d.basis &&
    p.from === d.from &&
    p.to === d.to &&
    p.evid.length === EVIDENCE_ORDER.length
  );
}

/** The engine row's evidence, or null for a paper with no `publication_core`
 *  row for this core (a manual add). */
export type EngineEvidence = { signalAck: boolean; signalCoauthors: unknown } | null;

/** One paper's bucket — see the module comment for the precedence. Pure. */
export function evidenceBucket(engine: EngineEvidence): EvidenceKey {
  if (engine === null) return "manual";
  if (engine.signalAck) return "ack";
  if (Array.isArray(engine.signalCoauthors) && engine.signalCoauthors.length > 0) return "coauthor";
  return "other";
}

/** The strongest of several cores' buckets for one paper (the all-cores merge
 *  rule, see the module comment): the first in `EVIDENCE_ORDER`. Pure. */
export function mergeEvidence(buckets: readonly EvidenceKey[]): EvidenceKey {
  return EVIDENCE_ORDER.find((k) => buckets.includes(k)) ?? "manual";
}

export type CoreOutputPub = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  /** `YYYY-MM-DD` or null. */
  dateAdded: string | null;
  evidence: EvidenceKey;
};

export type CoreOutputYear = {
  year: number;
  total: number;
  byEvidence: Record<EvidenceKey, number>;
  pubs: CoreOutputPub[];
};

export type CoreOutputResult = {
  years: CoreOutputYear[];
  /** The counted papers, newest first. */
  publications: (CoreOutputPub & { basisYear: number })[];
  total: number;
  /** Per bucket, over the window (every bucket, checked or not — the rail's counts). */
  evidenceCounts: Record<EvidenceKey, number>;
  /** Confirmed papers with no value on the chosen basis (not charted). */
  undated: number;
};

const zeroes = (): Record<EvidenceKey, number> => ({ manual: 0, ack: 0, coauthor: 0, other: 0 });

export function basisYear(
  pub: Pick<CoreOutputPub, "year" | "dateAdded">,
  basis: OutputBasis,
): number | null {
  if (basis === "added") return pub.dateAdded ? Number(pub.dateAdded.slice(0, 4)) : null;
  return pub.year;
}

/** The chart and the table. Pure; one row per year in `from..to` (zeros filled). */
export function buildCoreOutput(
  pubs: readonly CoreOutputPub[],
  p: CoreOutputParams,
): CoreOutputResult {
  const seen = new Set<string>();
  const years = new Map<number, CoreOutputYear>();
  for (let y = p.from; y <= p.to; y++)
    years.set(y, { year: y, total: 0, byEvidence: zeroes(), pubs: [] });
  const evidenceCounts = zeroes();
  const publications: CoreOutputResult["publications"] = [];
  let undated = 0;
  for (const pub of pubs) {
    if (seen.has(pub.pmid)) continue;
    seen.add(pub.pmid);
    const y = basisYear(pub, p.basis);
    if (y === null) {
      undated++;
      continue;
    }
    const bucket = years.get(y);
    if (!bucket) continue;
    evidenceCounts[pub.evidence]++;
    if (!p.evid.includes(pub.evidence)) continue;
    bucket.total++;
    bucket.byEvidence[pub.evidence]++;
    bucket.pubs.push(pub);
    publications.push({ ...pub, basisYear: y });
  }
  const byNewest = (a: { basisYear?: number; year: number | null; pmid: string }, b: typeof a) =>
    (b.basisYear ?? b.year ?? 0) - (a.basisYear ?? a.year ?? 0) || b.pmid.localeCompare(a.pmid);
  publications.sort(byNewest);
  for (const y of years.values()) y.pubs.sort((a, b) => b.pmid.localeCompare(a.pmid));
  return {
    years: [...years.values()],
    publications,
    total: publications.length,
    evidenceCounts,
    undated,
  };
}

/** Each paper's bucket across the cores it is confirmed for. Pure.
 *  `confirmedCores` = pmid → the cores whose confirmed set holds it;
 *  `engine` = the `publication_core` rows for those cores keyed
 *  `<coreId>|<pmid>` (any status — a promoted `below_threshold` row still
 *  carries its signals). A core with no engine row for the paper is a manual
 *  add there. One core reduces to the single-core `evidenceBucket`. */
export function paperEvidence(
  pmid: string,
  confirmedCores: ReadonlyMap<string, ReadonlySet<string>>,
  engine: ReadonlyMap<string, NonNullable<EngineEvidence>>,
): EvidenceKey {
  const cores = [...(confirmedCores.get(pmid) ?? [])];
  if (cores.length === 0) return "manual";
  return mergeEvidence(cores.map((c) => evidenceBucket(engine.get(`${c}|${pmid}`) ?? null)));
}

/** The papers with their bucket — the page's and the download's ONE loader.
 *  `byCore` (the all-cores roll-up: every core's confirmed PMIDs) is how a
 *  paper under several cores gets the merged bucket; omitted, `pmids` are
 *  `coreId`'s own confirmed set. */
export async function loadCoreOutputPubs(
  coreId: string,
  pmids: readonly string[],
  byCore: ReadonlyMap<string, readonly string[]> = new Map([[coreId, pmids]]),
): Promise<CoreOutputPub[]> {
  const confirmedCores = new Map<string, Set<string>>();
  for (const [core, ps] of byCore)
    for (const p of ps)
      (confirmedCores.get(p) ?? confirmedCores.set(p, new Set()).get(p)!).add(core);
  const coreIds = [...byCore.keys()];
  const out: CoreOutputPub[] = [];
  for (const batch of chunk(pmids)) {
    const [pubs, engine] = await Promise.all([
      db.read.publication.findMany({
        where: { pmid: { in: batch } },
        select: { pmid: true, title: true, journal: true, year: true, dateAddedToEntrez: true },
      }),
      db.read.publicationCore.findMany({
        where: {
          coreId: coreIds.length === 1 ? coreIds[0] : { in: coreIds },
          pmid: { in: batch },
        },
        select: { coreId: true, pmid: true, signalAck: true, signalCoauthors: true },
      }),
    ]);
    const engineBy = new Map(engine.map((e) => [`${e.coreId}|${e.pmid}`, e]));
    for (const p of pubs) {
      out.push({
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        dateAdded: p.dateAddedToEntrez ? p.dateAddedToEntrez.toISOString().slice(0, 10) : null,
        evidence: paperEvidence(p.pmid, confirmedCores, engineBy),
      });
    }
  }
  return out;
}

export async function buildCoreOutputWorkbook(
  coreName: CriteriaCore,
  p: CoreOutputParams,
  r: CoreOutputResult,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addCriteriaSheet(wb, [
    ...coreCriteriaHead("12. Output over time", coreName, generatedAt),
    [
      "Year basis",
      p.basis === "added"
        ? "Year the publication was added to PubMed"
        : "Calendar year of publication",
    ],
    ["Years", `${p.from}–${p.to}`],
    [
      "Evidence",
      p.evid.length === EVIDENCE_ORDER.length
        ? "All"
        : p.evid.map((e) => EVIDENCE_LABEL[e]).join("; "),
    ],
    [
      "Counting rule",
      "Each confirmed publication counts once, in one evidence group: Manually added, then Acknowledgment, then Core-staff co-author, then Other signals.",
    ],
    ...(typeof coreName === "string"
      ? []
      : ([
          [
            "Across cores",
            "A publication confirmed for more than one core takes the strongest evidence any of them has: Acknowledgment, then Core-staff co-author, then Other signals, then Manually added.",
          ],
        ] as [string, string][])),
    ...(r.undated > 0
      ? ([
          [
            "Not counted",
            `${r.undated.toLocaleString()} confirmed publications have no ${p.basis === "added" ? "PubMed add date" : "year"}.`,
          ],
        ] as [string, string][])
      : []),
  ]);
  const byYear = wb.addWorksheet("By year");
  byYear.addRow(["Year", "Publications", ...EVIDENCE_ORDER.map((e) => EVIDENCE_LABEL[e])]);
  boldRow(byYear, 1);
  for (const y of r.years) {
    byYear.addRow([
      y.year,
      y.total,
      ...EVIDENCE_ORDER.map((e) => (p.evid.includes(e) ? y.byEvidence[e] : 0)),
    ]);
  }
  byYear.addRow(["Total", r.total]);
  boldRow(byYear, byYear.rowCount);
  byYear.getColumn(1).width = 10;
  for (let i = 2; i <= 6; i++) byYear.getColumn(i).width = 20;
  const list = wb.addWorksheet("Publications");
  list.addRow(["PMID", "Title", "Journal", "Year", "Date added to PubMed", "Evidence"]);
  boldRow(list, 1);
  list.views = [{ state: "frozen", ySplit: 1 }];
  for (const pub of r.publications) {
    list.addRow([
      pub.pmid,
      pub.title,
      pub.journal,
      pub.year,
      pub.dateAdded,
      EVIDENCE_LABEL[pub.evidence],
    ]);
  }
  for (const [i, w] of [12, 90, 36, 8, 20, 22].entries()) list.getColumn(i + 1).width = w;
  list.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  return workbookBuffer(wb);
}
