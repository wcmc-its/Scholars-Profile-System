/**
 * Center publication cancer relevance — writes `center_publication_relevance`,
 * read by the center's publication relevance report (and, next, the
 * publication citation report and the collaborative publication matrix).
 *
 *   1. SCOPE   Per center, every publication with ≥1 confirmed author who holds
 *              a research or clinical membership (`CenterMembership.membershipType`), in the
 *              year window by `publicationDate` (`lib/edit/center-pub-attribution.ts`).
 *   2. SKIP    A row a reviewer set (`source: "human"`), and a row whose input
 *              hash still matches (nothing about the publication changed),
 *              unless it is a rule row its type no longer earns (a review
 *              decided under the retired review rule): that one is redone.
 *   3. DECIDE  `inferPubRelevance`: the publication-type rule, else one Sonnet
 *              call (`lib/edit/pub-relevance-generator.ts`).
 *   4. WRITE   Each row as it lands, so a crash keeps what it paid for. A
 *              failed call writes nothing; the next run retries it.
 *
 * Usage: `npm run etl:center-pub-relevance [-- --year 2025 | --since 2025]`.
 * Default window: last calendar year onward.
 */
import { db, disconnect } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { publicationInPeriod, publicationPeriodWhere } from "@/lib/edit/center-pub-attribution";
import {
  inferPubRelevance,
  pubRelevanceNeedsDecision,
  type PubRelevanceInput,
} from "@/lib/edit/pub-relevance-generator";

const CONCURRENCY = 4;
/** ponytail: per-run cost ceiling; a bigger backfill finishes on the next run. */
const MAX_SCORED_PER_RUN = 5000;

/** The year window as inclusive ISO dates, tested on `publicationDate`. */
function yearWindow(argv: string[]): { from: string; to?: string } {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    if (i >= 0 && !Number.isInteger(v)) throw new Error(`${name} needs a year`);
    return i >= 0 ? v : null;
  };
  const year = arg("--year");
  if (year != null) return { from: `${year}-01-01`, to: `${year}-12-31` };
  return { from: `${arg("--since") ?? new Date().getUTCFullYear() - 1}-01-01` };
}

function meshLabels(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((m) => (m && typeof m === "object" ? (m as { label?: unknown }).label : null))
    .filter((l): l is string => typeof l === "string");
}

async function main(): Promise<number> {
  const { from, to } = yearWindow(process.argv.slice(2));
  const members = await db.read.centerMembership.findMany({
    // research AND clinical: reports 18/19 filter by either type, and a
    // pub with no row reads as "Not scored", an undercount.
    where: { membershipType: { in: ["research", "clinical"] } },
    select: { centerCode: true, cwid: true },
  });
  const cwidsByCenter = new Map<string, string[]>();
  for (const m of members)
    cwidsByCenter.set(m.centerCode, [...(cwidsByCenter.get(m.centerCode) ?? []), m.cwid]);

  const todo: Array<{ centerCode: string; pmid: string; input: PubRelevanceInput }> = [];
  for (const [centerCode, cwids] of cwidsByCenter) {
    const [found, existing] = await Promise.all([
      db.read.publication.findMany({
        where: {
          ...publicationPeriodWhere(from, to),
          authors: { some: { isConfirmed: true, cwid: { in: cwids } } },
        },
        select: {
          pmid: true,
          title: true,
          abstract: true,
          meshTerms: true,
          publicationType: true,
          year: true,
          dateAddedToEntrez: true,
        },
      }),
      db.read.centerPublicationRelevance.findMany({
        where: { centerCode },
        select: { pmid: true, source: true, inputHash: true, promptHash: true },
      }),
    ]);
    const pubs = found.filter((p) => publicationInPeriod(p, from, to));
    const prior = new Map(existing.map((e) => [e.pmid, e]));
    for (const p of pubs) {
      const input = {
        title: p.title,
        abstract: p.abstract,
        meshTerms: meshLabels(p.meshTerms),
        publicationType: p.publicationType,
      };
      if (!pubRelevanceNeedsDecision(prior.get(p.pmid), input)) continue;
      todo.push({ centerCode, pmid: p.pmid, input });
    }
    console.log(
      `${centerCode}: ${pubs.length} research-member publications, ${prior.size} already decided.`,
    );
  }
  const batch = todo.slice(0, MAX_SCORED_PER_RUN);
  console.log(`${todo.length} new or changed publications; deciding ${batch.length}.`);

  let written = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let t = batch.shift(); t; t = batch.shift()) {
        const r = await inferPubRelevance(t.input);
        if (!r) {
          failed++;
          continue;
        }
        const data = {
          relevant: r.relevant,
          source: r.source,
          reason: r.reason,
          model: r.model,
          promptHash: r.promptHash,
          inputHash: r.inputHash,
          inferredAt: r.inferredAt,
        };
        // The `source` guard re-checks at write time: a reviewer may have
        // decided this row since the scope was read.
        const { count } = await db.write.centerPublicationRelevance.updateMany({
          where: { centerCode: t.centerCode, pmid: t.pmid, source: { not: "human" } },
          data,
        });
        if (count === 0) {
          try {
            await db.write.centerPublicationRelevance.create({
              data: { centerCode: t.centerCode, pmid: t.pmid, ...data },
            });
          } catch (err) {
            // P2002: the row exists after all, and it is a human one. Leave it.
            if ((err as { code?: string }).code !== "P2002") throw err;
            continue;
          }
        }
        written++;
      }
    }),
  );

  console.log(`Decided ${written}, failed ${failed}.`);
  // Some failures retry next run; ALL failing is an outage (IAM, Bedrock) worth an alarm.
  if (failed > 0 && written === 0) throw new Error(`all ${failed} relevance calls failed`);
  return written;
}

withEtlRun("CenterPubRelevance", main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(disconnect);
