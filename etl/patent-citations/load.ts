/**
 * Patent-citations import, the part with no command line: read an extract file
 * and load it. Kept apart from import.ts so it can be tested against a mocked
 * client (tests/unit/patent-citations.test.ts).
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import type { CitingDoc } from "../policy-citations/shape";
import {
  decideSharedId,
  linkEvidence,
  patentDoc,
  stable,
  type DocRow,
  type ExtractHeader,
  type LinkRow,
  type MapRow,
  type PatentDetails,
  type PatentEvidence,
  type TieRow,
} from "./shape";

const INSERT_BATCH = 2000;
const UPDATE_BATCH = 100;
/** Max share of the environment's publications the extract may never have considered. */
const MAX_UNCONSIDERED_PCT = 2;
/** Max tolerated shrink of documents or links against the last load. */
const MAX_DROP_PCT = 20;

export type Extract = {
  header: ExtractHeader;
  considered: Set<string>;
  maps: MapRow[];
  ties: TieRow[];
  docs: DocRow[];
  links: LinkRow[];
};

function chunks<T>(a: ReadonlyArray<T>, n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

/**
 * Parse the extract's lines. A release is a whole snapshot, so nothing is
 * skipped: an unreadable line, an unknown row type, or a row count that
 * differs from the header's (a cut-off upload) throws.
 */
export function readExtract(lines: Iterable<string>): Extract {
  let header: ExtractHeader | undefined;
  const x = { considered: new Set<string>(), maps: [] as MapRow[], ties: [] as TieRow[], docs: [] as DocRow[], links: [] as LinkRow[] };
  let n = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    n++;
    const { t, ...row } = JSON.parse(line) as { t?: string } & Record<string, unknown>;
    if (n === 1) {
      if (t !== "header" || row.format !== 1) throw new Error("Not a patent-citations extract: the first line is not a format 1 header.");
      header = { t, ...row } as ExtractHeader;
    } else if (t === "considered") for (const p of row.pmids as string[]) x.considered.add(p);
    else if (t === "map") x.maps.push(row as MapRow);
    else if (t === "tie") x.ties.push(row as TieRow);
    else if (t === "doc") x.docs.push(row as DocRow);
    else if (t === "link") x.links.push(row as LinkRow);
    else throw new Error(`Extract line ${n}: unknown row type ${JSON.stringify(t)}.`);
  }
  if (!header) throw new Error("The extract is empty.");
  const read = { considered: x.considered.size, map: x.maps.length, tie: x.ties.length, doc: x.docs.length, link: x.links.length };
  for (const k of Object.keys(read) as Array<keyof typeof read>) {
    if (read[k] !== header.counts[k]) {
      throw new Error(`The extract is incomplete: its header promises ${header.counts[k]} ${k} rows, the file has ${read[k]}.`);
    }
  }
  return { header, ...x };
}

type PatentDoc = CitingDoc & { details: PatentDetails };
type PatentLink = { pmid: string; externalId: string; evidence: PatentEvidence };

/** Turn the extract's rows into documents and links, and check its tie-break. No I/O. */
export function shapeExtract(x: Extract) {
  for (const tie of x.ties) {
    const { rule, winner } = decideSharedId(tie);
    if (rule !== tie.rule || winner !== tie.winner) {
      throw new Error(
        `Shared OpenAlex id ${tie.openalexId}: the extract says ${tie.rule} (${tie.winner ?? "neither"}), ` +
          `the rule gives ${rule} (${winner ?? "neither"}). The extract and the importer disagree; load nothing.`,
      );
    }
  }
  const docs = new Map<string, PatentDoc>();
  const unreadable: string[] = [];
  for (const row of x.docs) {
    const doc = patentDoc(row, x.header.metadataRelease);
    if (doc) docs.set(doc.externalId, doc);
    else unreadable.push(row.id);
  }
  const links = new Map<string, PatentLink>();
  const dropped = { noDocument: 0, belowFloor: 0 };
  for (const row of x.links) {
    const evidence = linkEvidence(row, x.header.release);
    if (!evidence) dropped.belowFloor++;
    else if (!docs.has(row.doc)) dropped.noDocument++;
    else links.set(`${row.pmid}|${row.doc}`, { pmid: row.pmid, externalId: row.doc, evidence });
  }
  // A document only matters through its links.
  const linked = new Set([...links.values()].map((l) => l.externalId));
  return {
    docs: [...docs.values()].filter((d) => linked.has(d.externalId)),
    links: [...links.values()],
    unreadable,
    dropped,
    unresolved: x.ties.filter((t) => t.rule === "unresolved"),
  };
}

export type LoadSummary = {
  /** What the file holds. */
  file: { documents: number; links: number; inventions: number; publications: number };
  /** How much of that the database does not have. For publications: cited papers with no `publication` row. */
  notInDatabase: { documents: number; links: number; inventions: number; publications: number };
  /** Publications here that the extract never considered. */
  unconsidered: number;
  written: { mappings: number; documents: number; documentsRefreshed: number; links: number; linksRefreshed: number; rollup: number } | null;
};

/**
 * Load a parsed extract. Documents and links are inserted if new; an existing
 * document's title, year, family key and details, and an existing link's
 * evidence, are rewritten when the file says otherwise (new patent tables
 * regroup families; a new release restates a score). Nothing is deleted.
 * // ponytail: a link the next dataset release drops stays. Removal belongs
 * // with the refresh step, behind assertPruneVolume, keyed on `evidence.release`.
 */
export async function loadExtract(x: Extract, opts: { dryRun?: boolean } = {}): Promise<LoadSummary> {
  const { docs, links, unreadable, dropped, unresolved } = shapeExtract(x);
  if (unreadable.length > 0) console.warn(`${unreadable.length} documents skipped, id not a US patent number: ${unreadable.join(", ")}`);
  if (dropped.noDocument + dropped.belowFloor > 0) {
    console.warn(`${dropped.noDocument} links skipped with their document, ${dropped.belowFloor} below the confidence floor.`);
  }
  const byRule = (r: string) => x.ties.filter((t) => t.rule === r).length;
  console.log(
    `Shared OpenAlex ids: ${x.ties.length}; own-work ${byRule("own-work")}, year ${byRule("year")}, DOI ${byRule("doi")}, ` +
      `unresolved ${unresolved.length} (links for neither paper loaded).`,
  );
  for (const t of unresolved) console.log(`  unresolved ${t.openalexId}: PMID ${t.api.pmid} or ${t.crosswalk.pmid}`);

  const corpus = (await db.write.publication.findMany({ select: { pmid: true } })).map((p) => p.pmid);
  const stored = new Map(
    (
      await db.write.citingDocument.findMany({
        where: { source: "ros" },
        select: { id: true, externalId: true, title: true, year: true, url: true, dedupKey: true, details: true },
      })
    ).map((d) => [d.externalId, d]),
  );
  const storedLinks = new Map(
    (
      await db.write.publicationCitingDocument.findMany({
        where: { citingDocument: { source: "ros" } },
        select: { pmid: true, citingDocumentId: true, evidence: true },
      })
    ).map((l) => [`${l.pmid}|${l.citingDocumentId}`, stable(l.evidence)]),
  );
  const storedKey = (l: PatentLink) => `${l.pmid}|${stored.get(l.externalId)?.id}`;

  const inCorpus = new Set(corpus);
  const cited = new Set(links.map((l) => l.pmid));
  const inventions = new Set(docs.map((d) => d.dedupKey));
  const storedInventions = new Set([...stored.values()].map((d) => d.dedupKey));
  const summary: LoadSummary = {
    file: { documents: docs.length, links: links.length, inventions: inventions.size, publications: cited.size },
    notInDatabase: {
      documents: docs.filter((d) => !stored.has(d.externalId)).length,
      links: links.filter((l) => !storedLinks.has(storedKey(l))).length,
      inventions: [...inventions].filter((k) => !storedInventions.has(k)).length,
      publications: [...cited].filter((p) => !inCorpus.has(p)).length,
    },
    unconsidered: corpus.filter((p) => !x.considered.has(p)).length,
    written: null,
  };
  const line = (o: LoadSummary["file"]) =>
    `${o.documents} documents, ${o.links} links, ${o.inventions} inventions, ${o.publications} publications`;
  console.log(`In the file: ${line(summary.file)}.`);
  console.log(`Of those, not in the database: ${line(summary.notInDatabase)} (publications: cited papers with no publication row).`);
  console.log(`${summary.unconsidered} of ${corpus.length} publications here were never considered by the extract.`);

  // The extract was built from another database's publication list. Papers it
  // never looked up get no patents, silently, so a wide gap refuses the load.
  assertSourceVolume("patent-citations:publications-considered", {
    incoming: corpus.length - summary.unconsidered,
    existing: corpus.length,
    maxDropPct: MAX_UNCONSIDERED_PCT,
  });
  assertSourceVolume("patent-citations:documents", { incoming: docs.length, existing: stored.size, floor: 1, maxDropPct: MAX_DROP_PCT });
  assertSourceVolume("patent-citations:links", { incoming: links.length, existing: storedLinks.size, floor: 1, maxDropPct: MAX_DROP_PCT });
  if (opts.dryRun) return summary;

  const written = { mappings: 0, documents: 0, documentsRefreshed: 0, links: 0, linksRefreshed: 0, rollup: 0 };
  const checkedAt = new Date(x.header.mappedAt);
  for (const batch of chunks(x.maps, INSERT_BATCH)) {
    written.mappings += (
      await db.write.publicationOpenalex.createMany({ data: batch.map((m) => ({ ...m, checkedAt })), skipDuplicates: true })
    ).count;
  }

  const changed = docs.filter((d) => {
    const was = stored.get(d.externalId);
    return was && (was.title !== d.title || was.year !== d.year || was.url !== d.url || was.dedupKey !== d.dedupKey || stable(was.details) !== stable(d.details));
  });
  for (const batch of chunks(changed, UPDATE_BATCH)) {
    await db.write.$transaction(
      batch.map((d) =>
        db.write.citingDocument.update({
          where: { source_externalId: { source: "ros", externalId: d.externalId } },
          data: { title: d.title, year: d.year, url: d.url, dedupKey: d.dedupKey, details: d.details },
        }),
      ),
    );
  }
  written.documentsRefreshed = changed.length;
  for (const batch of chunks(docs.filter((d) => !stored.has(d.externalId)), INSERT_BATCH)) {
    written.documents += (await db.write.citingDocument.createMany({ data: batch, skipDuplicates: true })).count;
  }

  const ids = new Map(
    (await db.write.citingDocument.findMany({ where: { source: "ros" }, select: { id: true, externalId: true } })).map(
      (d) => [d.externalId, d.id],
    ),
  );
  const rows = links.map((l) => ({ pmid: l.pmid, citingDocumentId: ids.get(l.externalId)!, evidence: l.evidence }));
  const restated = rows.filter((l) => {
    const was = storedLinks.get(`${l.pmid}|${l.citingDocumentId}`);
    return was !== undefined && was !== stable(l.evidence);
  });
  // ponytail: one UPDATE per restated link. A new release restates every link
  // (its `release` changes), about 250,000 statements: minutes, on an
  // occasional hand run. One statement per release would do if it ever matters.
  for (const batch of chunks(restated, UPDATE_BATCH)) {
    await db.write.$transaction(
      batch.map(({ evidence, ...where }) => db.write.publicationCitingDocument.updateMany({ where, data: { evidence } })),
    );
  }
  written.linksRefreshed = restated.length;
  for (const batch of chunks(rows, INSERT_BATCH)) {
    written.links += (await db.write.publicationCitingDocument.createMany({ data: batch, skipDuplicates: true })).count;
  }

  // Only this column: a hand-run patent load must not be able to move the
  // ranked counts. The same expression is in the weekly rollup
  // (etl/policy-citations/index.ts), which then keeps it current.
  written.rollup = await db.write.$executeRaw`
    UPDATE publication p
      LEFT JOIN (
        SELECT l.pmid, COUNT(DISTINCT d.dedup_key) AS pf
          FROM publication_citing_document l
          JOIN citing_document d ON d.id = l.citing_document_id
         WHERE d.level = 'patent'
         GROUP BY l.pmid
      ) x ON x.pmid = p.pmid
       SET p.patent_family_count = COALESCE(x.pf, 0)
     WHERE p.patent_family_count <> COALESCE(x.pf, 0)`;
  console.log(
    `Written: ${written.mappings} paper mappings, ${written.documents} documents (${written.documentsRefreshed} refreshed), ` +
      `${written.links} links (${written.linksRefreshed} refreshed); patent_family_count changed on ${written.rollup} publications.`,
  );
  return { ...summary, written };
}
