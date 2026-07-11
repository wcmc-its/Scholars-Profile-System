/**
 * Dense topical-affinity axis for sponsor-match — the Stage-2 re-rank the
 * convergence adds (design: `docs/2026-07-10-sponsor-match-phase2-3-design.md`
 * §2, §8, §16-Q0 path (c) "retrieval-grounded").
 *
 * Reuses the grant matcher's cosine (`topicAffinity`) and scholar-vector shape
 * (`scholarTopicRowWeight`): build the PASTE's topic vector from the topics of the
 * papers it retrieves (relevance-weighted), build each candidate scholar's vector,
 * and cosine them in the shared `parentTopicId` space. Fully SPS-native — no
 * Bedrock topic-scoring, no ReciterAI. Gated by `SPONSOR_MATCH_DENSE_WEIGHT`
 * (0 = off ⇒ ranking byte-identical to the terms-only path).
 *
 * ponytail: retrieval-grounded, so it inherits BM25's surface-lexical blind spots
 *   and correlates with the terms axis; the §13a bake-off compares it against a
 *   Bedrock topic-distribution (path a) before we commit a nonzero W_dense.
 */
import { db } from "@/lib/db";
import { topicAffinity, scholarTopicRowWeight } from "@/lib/api/match-opportunities";

const RECITERAI_YEAR_FLOOR = 2020; // mirrors sponsor-match.ts / match-opportunities.ts

/** Stage-2 dense weight w ∈ [0,1]: fused = (1-w)·termsNorm + w·denseNorm.
 *  0 (default) ⇒ dense axis off, no extra queries, ranking unchanged.
 *  1 ⇒ pure dense re-rank of the term-retrieved pool (bake-off "dense-only"). */
export function denseWeight(): number {
  const raw = Number.parseFloat(process.env.SPONSOR_MATCH_DENSE_WEIGHT ?? "0");
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

function l2normalize(raw: Map<string, number>): Map<string, number> {
  let norm = 0;
  for (const v of raw.values()) norm += v * v;
  if (norm === 0) return raw;
  const inv = 1 / Math.sqrt(norm);
  for (const [k, v] of raw) raw.set(k, v * inv);
  return raw;
}

/** The paste's topic vector: a relevance-weighted aggregate of its matching
 *  papers' topics, deduped to one score per (pmid, topic) so co-authorship can't
 *  inflate a topic, L2-normalized. Same topic space (`parentTopicId`) as scholar
 *  vectors, so `topicAffinity` cosines them directly. No scholar/year gate — the
 *  paste's topic profile is a property of the matching PAPERS, author-independent. */
export async function pasteTopicVector(rel: Map<string, number>): Promise<Map<string, number>> {
  const pmids = [...rel.keys()];
  if (pmids.length === 0) return new Map();
  const rows = await db.read.publicationTopic.groupBy({
    by: ["pmid", "parentTopicId"],
    where: { pmid: { in: pmids } },
    _max: { score: true },
  });
  const raw = new Map<string, number>();
  for (const r of rows) {
    const w = (rel.get(r.pmid) ?? 0) * Number(r._max.score ?? 0);
    if (w > 0) raw.set(r.parentTopicId, (raw.get(r.parentTopicId) ?? 0) + w);
  }
  return l2normalize(raw);
}

/** Candidate scholars' topic vectors, batched into ONE groupBy for all cwids.
 *  Same recency/authorship weighting + L2 norm as the grant matcher's
 *  `scholarTopicVector`, so a sponsor cosine is comparable to a grant one. */
export async function scholarTopicVectors(
  cwids: string[],
  now: Date = new Date(),
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (cwids.length === 0) return out;
  const rows = await db.read.publicationTopic.groupBy({
    by: ["cwid", "parentTopicId", "year", "authorPosition"],
    where: {
      cwid: { in: cwids },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: { deletedAt: null, status: "active" },
    },
    _sum: { score: true },
  });
  const nowYear = now.getFullYear();
  const rawByCwid = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const w = scholarTopicRowWeight(Number(r._sum.score ?? 0), r.year ?? nowYear, r.authorPosition, nowYear);
    if (w <= 0) continue;
    const v = rawByCwid.get(r.cwid) ?? new Map<string, number>();
    v.set(r.parentTopicId, (v.get(r.parentTopicId) ?? 0) + w);
    rawByCwid.set(r.cwid, v);
  }
  for (const [cwid, raw] of rawByCwid) out.set(cwid, l2normalize(raw));
  return out;
}

/** Stage-2 fused re-rank (pure). Normalizes term + dense scores each to [0,1] by
 *  their own max, blends by `wDense`, returns cwids in fused order. wDense=0 ⇒
 *  term order (dense a no-op); wDense=1 ⇒ dense order. Ties keep input order. */
export function fuseDenseRerank(
  items: { cwid: string; termScore: number; denseScore: number }[],
  wDense: number,
): string[] {
  const maxTerm = items.reduce((m, i) => Math.max(m, i.termScore), 0);
  const maxDense = items.reduce((m, i) => Math.max(m, i.denseScore), 0);
  return items
    .map((i, idx) => ({
      cwid: i.cwid,
      idx,
      fused:
        (1 - wDense) * (maxTerm > 0 ? i.termScore / maxTerm : 0) +
        wDense * (maxDense > 0 ? i.denseScore / maxDense : 0),
    }))
    .sort((a, b) => b.fused - a.fused || a.idx - b.idx)
    .map((s) => s.cwid);
}

/** Re-rank a term-ranked candidate list by the fused Stage-2 score. Skips all
 *  work (and the two extra groupBys) when `wDense` is 0. `rel` is the paste's
 *  relevance map (already computed upstream); `termScoreOf` reads each row's
 *  terms-axis score. Returns the rows in fused order (same objects, reordered). */
export async function applyDenseRerank<T extends { cwid: string }>(
  rows: T[],
  termScoreOf: (r: T) => number,
  rel: Map<string, number>,
  wDense: number,
  now: Date = new Date(),
): Promise<T[]> {
  if (wDense <= 0 || rows.length === 0) return rows;
  const [pasteVec, scholarVecs] = await Promise.all([
    pasteTopicVector(rel),
    scholarTopicVectors(rows.map((r) => r.cwid), now),
  ]);
  const items = rows.map((r) => ({
    cwid: r.cwid,
    termScore: termScoreOf(r),
    denseScore: topicAffinity(pasteVec, scholarVecs.get(r.cwid) ?? new Map()),
  }));
  const order = fuseDenseRerank(items, wDense);
  const byCwid = new Map(rows.map((r) => [r.cwid, r]));
  return order.flatMap((c) => {
    const r = byCwid.get(c);
    return r ? [r] : [];
  });
}
