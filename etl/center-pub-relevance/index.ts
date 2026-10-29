/**
 * Center publication cancer relevance — writes `center_publication_relevance`,
 * read by the center's publication relevance report (and, next, the
 * publication citation report and the collaborative publication matrix).
 *
 *   1. SCOPE   Per center, every publication with ≥1 confirmed author who holds
 *              a RESEARCH membership (`CenterMembership.membershipType`), in the
 *              year window.
 *   2. SKIP    A row a reviewer set (`source: "human"`), and a row whose input
 *              hash still matches (nothing about the publication changed).
 *   3. DECIDE  `inferPubRelevance`: the publication-type rule, else one Sonnet
 *              call (`lib/edit/pub-relevance-generator.ts`).
 *   4. WRITE   Each row as it lands, so a crash keeps what it paid for. A
 *              failed call writes nothing; the next run retries it.
 *   5. AFFIL   For relevant rows with no `externalAuthor` yet, read every
 *              author's affiliation from PubMed (`lib/edit/pubmed-affiliations.ts`)
 *              for the matrix's inter-institutional column. A PubMed failure
 *              is logged and retried next run; it never fails the step.
 *
 * Usage: `npm run etl:center-pub-relevance [-- --year 2025 | --since 2025]`.
 * Default window: last calendar year onward.
 */
import { db, disconnect } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import {
  inferPubRelevance,
  pubRelevanceInputHash,
  type PubRelevanceInput,
} from "@/lib/edit/pub-relevance-generator";
import { fetchExternalAuthorFlags } from "@/lib/edit/pubmed-affiliations";

const CONCURRENCY = 4;
/** ponytail: per-run cost ceiling; a bigger backfill finishes on the next run. */
const MAX_SCORED_PER_RUN = 5000;
/** 25 EFetch calls at most; a larger backfill finishes on later runs. */
const MAX_AFFILIATION_LOOKUPS = 5000;

function yearWindow(argv: string[]): { gte: number; lte?: number } {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    if (i >= 0 && !Number.isInteger(v)) throw new Error(`${name} needs a year`);
    return i >= 0 ? v : null;
  };
  const year = arg("--year");
  if (year != null) return { gte: year, lte: year };
  return { gte: arg("--since") ?? new Date().getUTCFullYear() - 1 };
}

function meshLabels(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((m) => (m && typeof m === "object" ? (m as { label?: unknown }).label : null))
    .filter((l): l is string => typeof l === "string");
}

/** Step 5. Rows PubMed gives no affiliations for stay null and are asked again next run. */
async function markExternalAuthors(): Promise<void> {
  const rows = await db.read.centerPublicationRelevance.findMany({
    where: { relevant: true, externalAuthor: null },
    distinct: ["pmid"],
    select: { pmid: true },
    take: MAX_AFFILIATION_LOOKUPS,
  });
  if (rows.length === 0) return;
  let flags: Map<string, boolean | null>;
  try {
    flags = await fetchExternalAuthorFlags(rows.map((r) => r.pmid));
  } catch (err) {
    console.warn(`PubMed affiliations failed; retrying next run: ${(err as Error).message}`);
    return;
  }
  let set = 0;
  for (const [pmid, externalAuthor] of flags) {
    if (externalAuthor === null) continue;
    await db.write.centerPublicationRelevance.updateMany({
      where: { pmid },
      data: { externalAuthor },
    });
    set++;
  }
  console.log(`Affiliations: looked up ${rows.length}, set ${set}.`);
}

async function main(): Promise<number> {
  const year = yearWindow(process.argv.slice(2));
  const members = await db.read.centerMembership.findMany({
    where: { membershipType: "research" },
    select: { centerCode: true, cwid: true },
  });
  const cwidsByCenter = new Map<string, string[]>();
  for (const m of members)
    cwidsByCenter.set(m.centerCode, [...(cwidsByCenter.get(m.centerCode) ?? []), m.cwid]);

  const todo: Array<{ centerCode: string; pmid: string; input: PubRelevanceInput }> = [];
  for (const [centerCode, cwids] of cwidsByCenter) {
    const [pubs, existing] = await Promise.all([
      db.read.publication.findMany({
        where: { year, authors: { some: { isConfirmed: true, cwid: { in: cwids } } } },
        select: { pmid: true, title: true, abstract: true, meshTerms: true, publicationType: true },
      }),
      db.read.centerPublicationRelevance.findMany({
        where: { centerCode },
        select: { pmid: true, source: true, inputHash: true },
      }),
    ]);
    const prior = new Map(existing.map((e) => [e.pmid, e]));
    for (const p of pubs) {
      const input = {
        title: p.title,
        abstract: p.abstract,
        meshTerms: meshLabels(p.meshTerms),
        publicationType: p.publicationType,
      };
      const row = prior.get(p.pmid);
      if (row?.source === "human" || row?.inputHash === pubRelevanceInputHash(input)) continue;
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
  await markExternalAuthors();
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
