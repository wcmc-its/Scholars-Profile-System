/**
 * #3071 cue 2 — mirror ReCiter "not me" rejections into `reciter_rejected_pmid`.
 *
 * SPS keeps only accepted authorships, so the RePORTER grant scorer
 * (`etl/reporter-grants`) cannot see which papers a scholar rejected. That step
 * runs on the base ETL task, which has no reciterdb credentials, so this step
 * (on the sources task, inside `etl/reciter`) copies the rejected
 * (personIdentifier, pmid) pairs across. One indexed query per batch of cwids.
 *
 * Best-effort, and a diff, not a replace: only pairs that appeared are inserted
 * and only pairs that disappeared are deleted. A source read that comes back
 * empty or far smaller than what we hold is refused (a degraded read must not
 * wipe the mirror: an empty mirror switches cue 2 off, which only ever makes
 * the scorer more lenient, but a half-wiped one would be silently uneven).
 */
import { db } from "@/lib/db";
import { assertPruneVolume, assertSourceVolume } from "@/lib/etl-guard";
import { withReciterConnection } from "@/lib/sources/reciterdb";

const IN_BATCH = 500;
const WRITE_BATCH = 1000;

const pairKey = (cwid: string, pmid: string) => `${cwid}\t${pmid}`;

/** What to insert and delete to turn `existing` into `incoming`. Pure. */
export function diffRejectedPairs(
  existing: Iterable<{ cwid: string; pmid: string }>,
  incoming: Iterable<{ cwid: string; pmid: string }>,
): { add: Array<{ cwid: string; pmid: string }>; remove: Array<{ cwid: string; pmid: string }> } {
  const have = new Map<string, { cwid: string; pmid: string }>();
  for (const p of existing) have.set(pairKey(p.cwid, p.pmid), p);
  const want = new Map<string, { cwid: string; pmid: string }>();
  for (const p of incoming) want.set(pairKey(p.cwid, p.pmid), p);
  const add = [...want].filter(([k]) => !have.has(k)).map(([, v]) => v);
  const remove = [...have].filter(([k]) => !want.has(k)).map(([, v]) => v);
  return { add, remove };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncRejectedPmids(cwids: readonly string[]): Promise<void> {
  const incoming: Array<{ cwid: string; pmid: string }> = [];
  for (const batch of chunks([...cwids], IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT personIdentifier, pmid
         FROM person_article
         WHERE userAssertion = 'REJECTED' AND personIdentifier IN (?)`,
        [batch],
      )) as Array<{ personIdentifier: string; pmid: number | string | null }>;
      for (const r of rows) {
        const pmid = Number(r.pmid);
        if (!r.personIdentifier || !Number.isFinite(pmid) || pmid <= 0) continue;
        incoming.push({ cwid: r.personIdentifier, pmid: String(pmid) });
      }
    });
  }

  const existing = await db.write.reciterRejectedPmid.findMany({
    select: { cwid: true, pmid: true },
  });
  // Rejections only accumulate in normal operation. Refuse an empty or sharply
  // smaller read before touching the mirror.
  assertSourceVolume("reciter:rejected-pmids", {
    incoming: incoming.length,
    existing: existing.length,
    floor: existing.length > 0 ? 1 : 0,
    maxDropPct: 20,
  });
  const { add, remove } = diffRejectedPairs(existing, incoming);
  assertPruneVolume("reciter:rejected-pmids-prune", {
    pruning: remove.length,
    of: existing.length,
    maxPct: 20,
  });

  for (const batch of chunks(add, WRITE_BATCH)) {
    await db.write.reciterRejectedPmid.createMany({ data: batch, skipDuplicates: true });
  }
  for (const batch of chunks(remove, WRITE_BATCH)) {
    await db.write.reciterRejectedPmid.deleteMany({
      where: { OR: batch.map((p) => ({ cwid: p.cwid, pmid: p.pmid })) },
    });
  }
  console.log(
    `[rejected-pmids] ${incoming.length} ReCiter rejections mirrored ` +
      `(${add.length} added, ${remove.length} removed).`,
  );
}
