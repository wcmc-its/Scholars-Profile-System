/**
 * Patent-citations EXTRACT: build the file import.ts loads, from the Reliance
 * on Science dataset, the 2023 OpenAlex-to-PMID crosswalk, the PatentsView
 * tables and a publication list. A TypeScript port of the laptop pipeline the
 * 2026-11-26 load was built with (ros_filter, oa_map, oa_map_other, tiebreak,
 * pv_extract, pv_edges, pv_family, emit_ndjson); its output is the format
 * described in import.ts.
 *
 * Steps:
 *   1. Map publications to OpenAlex works: the crosswalk, plus the OpenAlex API
 *      for every key not asked before (PMIDs by pmid, `OPENALEX:W…` keys by
 *      id, other keys by DOI). Answers are kept in the state folder, so each
 *      key is asked once.
 *   2. Keep the dataset rows whose work maps to one of ours.
 *   3. Decide each OpenAlex id two of our papers claim (shape.ts
 *      decideSharedId), asking the API about the work and both papers once.
 *   4. Read the cited documents' facts from the PatentsView tables, and the
 *      related-document tables of ALL patents for families.
 *   5. Write the gzipped NDJSON.
 *
 * The state folder holds the laptop pipeline's own files, same format:
 * oa_map.tsv, oa_asked.txt, oa_asked_other.txt, tiebreak_api.json.
 *
 * Zips are read with `unzip -p` (installed in the ETL image).
 *
 * Usage:
 *   npm run etl:patent-citations:extract -- --ros pcs_oa_uspto.csv --crosswalk paperpmid.zip \
 *     --pv <folder of PatentsView zips> --state <folder> --release zenodo:22967630 \
 *     --metadata-release 2026-04-10 --out patent-citations.ndjson.gz [--corpus pubs.tsv] [--offline]
 * `--corpus` is a TSV of key, year, doi; without it the publication table is read.
 * `--offline` refuses to call OpenAlex: every answer must already be in the state folder.
 */
import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { decideSharedId, type DocRow, type TieRow } from "./shape";
import {
  DelimitedReader,
  Families,
  REL_KINDS,
  REL_TYPES,
  appNorm,
  clean,
  docKey,
  docRow,
  pairRecord,
  relNumber,
  sortRecord,
  unpad,
  type PatentTables,
  type RelRow,
} from "./extract-shape";

export type Corpus = Array<{ key: string; year: number | null; doi: string | null }>;

export type ExtractOptions = {
  ros: string;
  crosswalk: string;
  pv: string;
  state: string;
  corpus: Corpus;
  release: string;
  metadataRelease: string;
  mappedAt: string;
  out: string;
  offline?: boolean;
  log?: (msg: string) => void;
};

const isDigits = (s: string) => /^\d+$/.test(s);
const multiAdd = (m: Map<string, Set<string>>, k: string, v: string) => {
  const s = m.get(k);
  if (s) s.add(v);
  else m.set(k, new Set([v]));
};

/** Every row of a delimited file (a .zip is read through `unzip -p`), header first as `ix`. */
async function eachRow(path: string, delim: string, fn: (ix: Record<string, number>, row: string[]) => void): Promise<{ rows: number; bad: number }> {
  const zipped = path.endsWith(".zip");
  const proc = zipped ? spawn("unzip", ["-p", path], { stdio: ["ignore", "pipe", "inherit"] }) : null;
  const src = proc ? proc.stdout! : createReadStream(path);
  const dec = new TextDecoder("utf-8");
  const reader = new DelimitedReader(delim);
  let ix: Record<string, number> | null = null;
  let width = 0;
  let rows = 0;
  let bad = 0;
  const out = (r: string[]) => {
    if (!ix) {
      ix = Object.fromEntries(r.map((c, i) => [c, i]));
      width = r.length;
    } else if (r.length !== width) bad++;
    else {
      rows++;
      fn(ix, r);
    }
  };
  for await (const chunk of src) reader.push(dec.decode(chunk as Buffer, { stream: true }), out);
  reader.push(dec.decode(), out);
  reader.end(out);
  if (proc) {
    const code: number = await new Promise((res) => (proc.exitCode !== null ? res(proc.exitCode) : proc.on("close", res)));
    if (code !== 0) throw new Error(`unzip -p ${path} exited ${code}`);
  }
  return { rows, bad };
}

// ---- OpenAlex -------------------------------------------------------------

type Slim = { id: string; pmid: string; doi: string; year: number | null };
type TieCache = { work: Record<string, Slim | null>; pmid: Record<string, Slim[]>; requests: number; remaining?: string | null };

const oaId = (url: string) => url.split("/").pop()!.replace(/^W+/, "");
const oaPmid = (w: Record<string, unknown>) => ((w.ids as { pmid?: string } | undefined)?.pmid ?? "").replace(/\/+$/, "").split("/").pop()!;
const normDoi = (d: string | null | undefined) => (d ?? "").trim().toLowerCase().replace("https://doi.org/", "");
/** Python's urllib.parse.quote(d, safe="/:.-_()"). */
const quote = (d: string) =>
  d.replace(/[^A-Za-z0-9_.\-~/:()]/gu, (c) => [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));

class OpenAlex {
  requests = 0;
  remaining: string | null = null;
  constructor(private readonly offline: boolean) {}
  async works(filter: string, select: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    if (this.offline) throw new Error(`--offline, but OpenAlex would be asked: ${filter.slice(0, 80)}…`);
    const key = process.env.OPENALEX_API_KEY;
    const url = `https://api.openalex.org/works?filter=${filter}&select=${select}&per-page=200${key ? `&api_key=${encodeURIComponent(key)}` : ""}`;
    const r = await fetch(url, { headers: { "User-Agent": "research-script/1.0" }, signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`OpenAlex answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()) as { meta: { count: number }; results: Array<Record<string, unknown> & { id: string }> };
    this.requests++;
    this.remaining = r.headers.get("x-ratelimit-remaining");
    if (d.meta.count > d.results.length) throw new Error(`OpenAlex truncated a batch: ${d.meta.count} works, ${d.results.length} returned`);
    await new Promise((res) => setTimeout(res, key ? 100 : 300));
    return d.results;
  }
}

/**
 * Ask OpenAlex about every corpus key not asked before and not already mapped
 * by the crosswalk (`inXw`); appends to the state files.
 * ponytail: a key is asked once; a paper OpenAlex did not know then is not asked again.
 */
async function mapNewKeys(corpus: Corpus, inXw: Set<string>, state: string, oa: OpenAlex, log: (m: string) => void) {
  const readSet = (f: string) => new Set(existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);
  const mapFile = join(state, "oa_map.tsv");
  // PMIDs, 100 per request
  const asked = readSet("oa_asked.txt");
  const pmids = [...new Set(corpus.map((c) => c.key))].filter((k) => isDigits(k) && !inXw.has(k) && !asked.has(k));
  for (let i = 0; i < pmids.length; i += 100) {
    const b = pmids.slice(i, i + 100);
    const res = await oa.works(`pmid:${b.join("|")}`, "id,ids");
    appendFileSync(mapFile, res.map((w) => `${oaPmid(w)}\t${oaId(w.id)}\n`).join(""));
    appendFileSync(join(state, "oa_asked.txt"), `${b.join("\n")}\n`);
  }
  // other keys: OPENALEX:W… by id, the rest by DOI
  const askedOther = readSet("oa_asked_other.txt");
  const byId = corpus.map((c) => c.key).filter((k) => /^OPENALEX:W\d+$/.test(k) && !askedOther.has(k));
  const byDoi = new Map<string, string[]>();
  for (const c of corpus) {
    if (isDigits(c.key) || /^OPENALEX:W\d+$/.test(c.key) || askedOther.has(c.key)) continue;
    const d = normDoi(c.doi);
    if (d && !/[|, \t]/.test(d)) byDoi.set(d, [...(byDoi.get(d) ?? []), c.key]);
  }
  for (let i = 0; i < byId.length; i += 100) {
    const b = byId.slice(i, i + 100);
    const got = new Set((await oa.works(`openalex:${b.map((k) => k.split(":")[1]).join("|")}`, "id,doi")).map((w) => w.id.split("/").pop()!));
    appendFileSync(mapFile, b.filter((k) => got.has(k.split(":")[1])).map((k) => `${k}\t${k.split(":")[1].replace(/^W+/, "")}\n`).join(""));
    appendFileSync(join(state, "oa_asked_other.txt"), `${b.join("\n")}\n`);
  }
  const dois = [...byDoi.keys()].sort();
  for (let i = 0; i < dois.length; i += 100) {
    const b = dois.slice(i, i + 100);
    const hit = new Map<string, Set<string>>();
    for (const w of await oa.works(`doi:${b.map(quote).join("|")}`, "id,doi")) multiAdd(hit, normDoi(w.doi as string | null), oaId(w.id));
    const lines = b.flatMap((d) => byDoi.get(d)!.flatMap((k) => [...(hit.get(d) ?? [])].sort().map((o) => `${k}\t${o}\n`)));
    appendFileSync(mapFile, lines.join(""));
    appendFileSync(join(state, "oa_asked_other.txt"), `${b.flatMap((d) => byDoi.get(d)!).join("\n")}\n`);
  }
  log(`OpenAlex mapping: asked ${pmids.length} PMIDs, ${byId.length} OpenAlex keys, ${dois.length} DOIs.`);
}

// ---- the extract ------------------------------------------------------------

/** The PatentsView tables the extract reads, `<name>.tsv.zip` in the --pv folder. */
export const PATENTSVIEW_TABLES = [
  "g_patent",
  "g_application",
  "g_us_rel_doc",
  "g_assignee_disambiguated",
  "g_inventor_disambiguated",
  "pg_published_application",
  "pg_us_rel_doc",
  "pg_assignee_disambiguated",
  "pg_inventor_disambiguated",
] as const;
const WHERE: Record<string, string> = { frontonly: "front", bodyonly: "body", both: "both" };
const BUCKETS = 64;

export async function buildExtract(o: ExtractOptions): Promise<Record<string, number>> {
  const log = o.log ?? ((m: string) => console.log(m));
  const oa = new OpenAlex(!!o.offline);
  const keys = [...new Set(o.corpus.map((c) => c.key))];
  const corpus = new Set(keys);
  const meta = new Map(o.corpus.map((c) => [c.key, { year: c.year, doi: (c.doi ?? "").trim().toLowerCase() || null }]));

  // 1. mapping: the crosswalk first, then the API for what it does not cover
  const xw = new Map<string, Set<string>>();
  const inXw = new Set<string>();
  const xwStat = await eachRow(o.crosswalk, ",", (_ix, r) => {
    if (!corpus.has(r[1])) return; // "oaid,pmid"
    multiAdd(xw, r[0].replace(/^W+/, ""), r[1]);
    inXw.add(r[1]);
  });
  log(`Crosswalk: ${xwStat.rows} rows, ${xw.size} works ours.`);
  await mapNewKeys(o.corpus, inXw, o.state, oa, log);
  const api = new Map<string, Set<string>>(); // oaid -> keys
  for (const l of readFileSync(join(o.state, "oa_map.tsv"), "utf8").split("\n")) {
    const [p, w] = l.split(/\s+/);
    if (p && w && corpus.has(p)) multiAdd(api, w, p);
  }

  // 2. dataset rows of our works
  const ids = new Set([...api.keys(), ...xw.keys()]);
  type Ros = { p: string; o: string; pat: string; score: number; where: string };
  const ros: Ros[] = [];
  const rosStat = await eachRow(o.ros, ",", (ix, r) => {
    const w = r[ix.oaid].replace(/^[Ww]+/, "");
    if (!ids.has(w)) return;
    for (const p of new Set([...(api.get(w) ?? []), ...(xw.get(w) ?? [])])) ros.push({ p, o: w, pat: r[ix.patent], score: Number(r[ix.confscore]), where: r[ix.wherefound] });
  });
  log(`Dataset: ${rosStat.rows} rows (${rosStat.bad} malformed), ${ros.length} kept.`);

  // 3. shared ids
  const shared = [...ids].filter((w) => new Set([...(api.get(w) ?? []), ...(xw.get(w) ?? [])]).size > 1);
  const ruled = shared.filter((w) => api.get(w)?.size === 1 && xw.get(w)?.size === 1 && [...api.get(w)!, ...xw.get(w)!].every(isDigits)).sort();
  // ponytail: ids outside the rule (two papers through the API, or a key that is not a PMID) are left alone: both keep it.
  const cacheFile = join(o.state, "tiebreak_api.json");
  const cache: TieCache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : { work: {}, pmid: {}, requests: 0 };
  const slim = (w: Record<string, unknown> & { id: string }): Slim => ({
    id: oaId(w.id),
    pmid: oaPmid(w),
    doi: ((w.doi as string | null) ?? "").toLowerCase().replace("https://doi.org/", ""),
    year: (w.publication_year as number | null) ?? null,
  });
  const askWorks = ruled.filter((w) => !(w in cache.work));
  for (let i = 0; i < askWorks.length; i += 100) {
    const b = askWorks.slice(i, i + 100);
    const got = new Map((await oa.works(`openalex:${b.map((w) => `W${w}`).join("|")}`, "id,ids,doi,publication_year")).map((w) => [oaId(w.id), slim(w)]));
    for (const w of b) cache.work[w] = got.get(w) ?? null; // null: merged or deleted
    cache.requests++;
  }
  const askPmids = [...new Set(ruled.flatMap((w) => [...api.get(w)!, ...xw.get(w)!]))].filter((p) => !(p in cache.pmid)).sort();
  for (let i = 0; i < askPmids.length; i += 100) {
    const b = askPmids.slice(i, i + 100);
    const got = new Map<string, Slim[]>();
    for (const s of (await oa.works(`pmid:${b.join("|")}`, "id,ids,doi,publication_year")).map(slim)) got.set(s.pmid, [...(got.get(s.pmid) ?? []), s]);
    for (const p of b) cache.pmid[p] = got.get(p) ?? [];
    cache.requests++;
  }
  if (askWorks.length || askPmids.length) writeFileSync(cacheFile, JSON.stringify(cache));
  const ties: TieRow[] = [];
  const winner = new Map<string, { rule: TieRow["rule"]; pmid: string | null }>();
  for (const w of ruled) {
    const a = [...api.get(w)!][0];
    const x = [...xw.get(w)!][0];
    const work = cache.work[w];
    const xnow = new Set((cache.pmid[x] ?? []).map((s) => s.id));
    const facts = {
      workYear: work ? work.year : null,
      workDoi: (work && work.doi) || null,
      crosswalkHasOwnWork: xnow.size > 0 && !xnow.has(w),
      api: { pmid: a, year: meta.get(a)!.year, doi: meta.get(a)!.doi },
      crosswalk: { pmid: x, year: meta.get(x)!.year, doi: meta.get(x)!.doi },
    };
    const d = decideSharedId(facts);
    winner.set(w, { rule: d.rule, pmid: d.winner });
    ties.push({ openalexId: `W${w}`, ...facts, rule: d.rule, winner: d.winner });
  }
  log(`Shared OpenAlex ids: ${ruled.length} decided, ${shared.length - ruled.length} outside the rule.`);

  // maps (a shared id goes to its winner only), then links
  const maps = new Map<string, "api" | "crosswalk-2023">();
  for (const [src, m] of [["crosswalk-2023", xw], ["api", api]] as const)
    for (const [w, ps] of m) for (const p of ps) if (!winner.has(w) || winner.get(w)!.pmid === p) maps.set(`${p}\t${w}`, src);
  const links = new Map<string, { score: number; where: string; routes: Set<string> }>();
  for (const r of ros) {
    if (winner.has(r.o) && winner.get(r.o)!.pmid !== r.p) continue;
    const k = `${r.p}\t${r.pat}`;
    const l = links.get(k);
    if (!l) links.set(k, { score: r.score, where: r.where, routes: new Set([r.o]) });
    else {
      l.routes.add(r.o);
      if (r.score > l.score) Object.assign(l, { score: r.score, where: r.where });
    }
  }

  // 4. patent tables. The cited documents are every patent the kept rows name.
  const docs = new Set(ros.map((r) => r.pat));
  const gkeys = new Set<string>();
  const pkeys = new Set<string>();
  for (const d of docs) {
    const { kind, key } = docKey(d);
    if (!key) continue;
    if (kind === "pregrant") pkeys.add(key);
    else {
      gkeys.add(key);
      if (kind === "sir") gkeys.add(`H${key.slice(1).padStart(6, "0")}`);
    }
  }
  const t: PatentTables = { grant: new Map(), grantFiling: new Map(), pgpub: new Map(), app: new Map(), assignees: new Map(), inventors: new Map() };
  const pv = (name: string) => join(o.pv, `${name}.tsv.zip`);
  const push = <V>(m: Map<string, V[]>, k: string, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  const stat = async (name: string, fn: (ix: Record<string, number>, r: string[]) => void) => {
    const s = await eachRow(pv(name), "\t", fn);
    log(`${name}: ${s.rows} rows${s.bad ? `, ${s.bad} malformed skipped` : ""}.`);
  };
  await stat("g_patent", (ix, r) => {
    if (gkeys.has(r[0])) t.grant.set(unpad(r[0]), { date: r[ix.patent_date], title: clean(r[ix.patent_title]) });
  });
  await stat("g_application", (ix, r) => {
    const p = r[ix.patent_id];
    if (!gkeys.has(p)) return;
    t.app.set(`g${p}`, appNorm(r[ix.application_id]));
    t.grantFiling.set(unpad(p), r[ix.filing_date]);
  });
  await stat("pg_published_application", (ix, r) => {
    if (!pkeys.has(r[0])) return;
    t.app.set(`p${r[0]}`, appNorm(r[ix.application_id]));
    t.pgpub.set(r[0], { title: clean(r[ix.application_title]), published: r[ix.published_date], filing: r[ix.filing_date] });
  });
  for (const [name, keyset] of [["g_assignee_disambiguated", gkeys], ["pg_assignee_disambiguated", pkeys]] as const)
    await stat(name, (ix, r) => {
      if (!keyset.has(r[0])) return;
      const n = clean(r[ix.disambig_assignee_organization]) || `${clean(r[ix.disambig_assignee_individual_name_first])} ${clean(r[ix.disambig_assignee_individual_name_last])}`.trim();
      if (n) push(t.assignees, unpad(r[0]), [Number(clean(r[ix.assignee_sequence])), n] as [number, string]);
    });
  for (const [name, keyset] of [["g_inventor_disambiguated", gkeys], ["pg_inventor_disambiguated", pkeys]] as const)
    await stat(name, (ix, r) => {
      if (keyset.has(r[0]))
        push(t.inventors, unpad(r[0]), [Number(clean(r[ix.inventor_sequence])), clean(r[ix.disambig_inventor_name_first]), clean(r[ix.disambig_inventor_name_last])] as [number, string, string]);
    });

  // families: related-document rows of all patents, bucketed on disk by record, then paired per record
  const tmp = mkdtempSync(join(tmpdir(), "patent-edges-"));
  const fam = new Families();
  try {
    const pending: string[][] = Array.from({ length: BUCKETS }, () => []);
    const flush = (b: number) => {
      if (pending[b].length) appendFileSync(join(tmp, String(b)), pending[b].join(""));
      pending[b] = [];
    };
    const bucket = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return (h >>> 0) % BUCKETS;
    };
    for (const [name, pre] of [["g_us_rel_doc", "g"], ["pg_us_rel_doc", "p"]] as const)
      await stat(name, (ix, r) => {
        const type = REL_TYPES[r[ix.related_doc_type]];
        const kind = REL_KINDS[r[ix.related_doc_kind]];
        if (!type || !kind) return;
        const doc = pre + r[0];
        const b = bucket(doc);
        pending[b].push(`${doc}\t${r[ix.related_doc_sequence]}\t${type}\t${kind}\t${relNumber(kind, r[ix.related_doc_number])}\n`);
        if (pending[b].length >= 20_000) flush(b);
      });
    for (let b = 0; b < BUCKETS; b++) flush(b);
    let records = 0;
    let edges = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const f = join(tmp, String(b));
      if (!existsSync(f)) continue;
      const byDoc = new Map<string, RelRow[]>();
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line) continue;
        const [doc, seq, type, kind, num] = line.split("\t");
        push(byDoc, doc, { seq, type, kind, num, line });
      }
      for (const [doc, rows] of byDoc) {
        records++;
        for (const [p, c, ty] of pairRecord(doc[0] === "g", sortRecord(rows))) {
          fam.addEdge(p, c, ty);
          edges++;
        }
      }
    }
    log(`Families: ${records} records, ${edges} edges (before de-duplication), ${fam.nodes} application numbers.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 5. the file
  const docRows: DocRow[] = [];
  let noMeta = 0;
  for (const pat of [...new Set([...links.keys()].map((k) => k.split("\t")[1]))].sort()) {
    const { noMetadata, ...d } = docRow(pat, t, fam);
    if (noMetadata) noMeta++;
    docRows.push(d);
  }
  const header = {
    t: "header",
    format: 1,
    release: o.release,
    metadataRelease: o.metadataRelease,
    mappedAt: o.mappedAt,
    counts: { considered: keys.length, map: maps.size, tie: ties.length, doc: docRows.length, link: links.size },
  };
  const gz = createGzip({ level: 9 });
  const done = new Promise<void>((res, rej) => gz.pipe(createWriteStream(o.out)).on("finish", res).on("error", rej));
  const w = async (row: object) => {
    if (!gz.write(`${JSON.stringify(row)}\n`)) await new Promise((r) => gz.once("drain", r));
  };
  await w(header);
  for (let i = 0; i < keys.length; i += 5000) await w({ t: "considered", pmids: keys.slice(i, i + 5000) });
  for (const k of [...maps.keys()].sort()) {
    const [pmid, w2] = k.split("\t");
    await w({ t: "map", pmid, openalexId: `W${w2}`, source: maps.get(k) });
  }
  for (const tie of ties) await w({ t: "tie", ...tie });
  for (const d of docRows) await w({ t: "doc", ...d });
  let sharedLinks = 0;
  for (const k of [...links.keys()].sort()) {
    const l = links.get(k)!;
    const [pmid, doc] = k.split("\t");
    const byRule2 = [...l.routes].every((r) => winner.has(r) && ["year", "doi"].includes(winner.get(r)!.rule));
    if (byRule2) sharedLinks++;
    await w({ t: "link", pmid, doc, score: l.score, where: WHERE[l.where] ?? l.where, ...(byRule2 ? { sharedId: true } : {}) });
  }
  gz.end();
  await done;
  log(`Wrote ${o.out}: ${JSON.stringify(header.counts)}; ${noMeta} documents with no patent-table row; ${sharedLinks} links marked sharedId; ${oa.requests} OpenAlex requests.`);
  return { ...header.counts, noMetadata: noMeta, sharedLinks, openalexRequests: oa.requests };
}

// ---- command line -------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`${name} is required.`);
  return v;
}

async function readCorpus(): Promise<Corpus> {
  const f = arg("--corpus");
  if (f)
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [key, y, doi] = l.split("\t");
        return { key, year: y ? Number(y) : null, doi: doi || null };
      });
  const { db } = await import("../../lib/db");
  const rows = await db.read.publication.findMany({ select: { pmid: true, year: true, doi: true } });
  return rows.map((r) => ({ key: r.pmid, year: r.year, doi: r.doi }));
}

if (process.argv[1]?.endsWith("extract.ts")) {
  (async () => {
    await buildExtract({
      ros: need("--ros"),
      crosswalk: need("--crosswalk"),
      pv: need("--pv"),
      state: need("--state"),
      corpus: await readCorpus(),
      release: need("--release"),
      metadataRelease: need("--metadata-release"),
      mappedAt: arg("--mapped-at") ?? new Date().toISOString().slice(0, 10),
      out: need("--out"),
      offline: process.argv.includes("--offline"),
    });
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (!arg("--corpus")) await (await import("../../lib/db")).db.read.$disconnect();
    });
}
