/**
 * ESearch-translation audit for WCM clinical-specialty names — issue #642.
 *
 * Run: `npm run audit:specialty-mesh` (add `-- --limit 5` for a smoke run).
 *
 * For every WCM department + division name, ask PubMed's Automatic Term
 * Mapping (ATM) how it resolves the phrase, then cross-check that verdict
 * against our own resolver's data so the output is directly actionable.
 *
 * PubMed verdict (from esearch `querytranslation`):
 *   NATIVE     whole phrase -> a single [MeSH Terms] concept (no AND split).
 *              NLM has a descriptor/entry-term; resolves natively.
 *   SPLIT      phrase decomposed with ` AND `; >=1 token mapped to [MeSH Terms]
 *              but the modifier fell to [All Fields]. Head-noun-only mapping
 *              -> ALIAS CANDIDATE (the failure mode #642 describes).
 *   FREE_TEXT  no [MeSH Terms] anywhere (often a [Journal] / [All Fields]
 *              match) -> nothing mapped. ALIAS CANDIDATE.
 *
 * Ours (replicates lib/api/search-taxonomy.ts exactly):
 *   mesh:  resolveMeshDescriptor -> exact normalized membership over
 *          descriptor name + entry_terms (byForm.get(normalized)).
 *   topic: matchQueryToTaxonomy  -> normalized(query) is a substring of a
 *          normalized topic label / subtopic displayName.
 *
 * Actionable cells:
 *   PubMed NATIVE + we MISS mesh        -> our entry_terms drifted from NLM.
 *   PubMed SPLIT/FREE_TEXT + we MISS    -> curated alias needed (#642 fix).
 *
 * NB: the alias layer (query -> descriptor) does NOT exist yet. `byForm` is
 * built only from mesh_descriptor.name + entry_terms; mesh_curated_topic_anchor
 * is descriptor -> topic, a different layer. This audit only *identifies* the
 * gap; closing it needs a new curated-alias source merged into `byForm`.
 *
 * Read-only against the DB; the only writes are the output JSON file.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createConnection, type Connection } from "mariadb";

const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const NCBI_TOOL = "wcm-sps-specialty-audit";
const NCBI_EMAIL = "paa2013@med.cornell.edu"; // NCBI etiquette contact (SPS operator)
const DEFAULT_THROTTLE_MS = 400; // < 3 req/s, keyless-safe

/** Mirror of normalizeForMatch in lib/api/search-taxonomy.ts (incl. the #690
 *  standalone-"and" drop, so the audit's "we MISS / we RESOLVE" verdicts match
 *  the live resolver). */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

type Verdict = "NATIVE" | "SPLIT" | "FREE_TEXT" | "ERROR";

type ResultRow = {
  name: string;
  count: number;
  kinds: string;
  pubmed: Verdict;
  pubmedHits: number;
  fallback: string[];
  ourMesh: string | null; // descriptor name we'd resolve to, or null
  ourTopic: string | null; // topic/subtopic label we'd match, or null
  translation: string;
};

function parseArgs(argv: string[]) {
  let limit = Infinity;
  let out = "tmp/audit-results.json";
  let throttle = DEFAULT_THROTTLE_MS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = parseInt(argv[++i], 10);
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--throttle") throttle = parseInt(argv[++i], 10);
  }
  return { limit, out, throttle };
}

function dbConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

type Specialty = { name: string; count: number; kinds: Set<string> };

async function loadSpecialties(conn: Connection): Promise<Specialty[]> {
  const rows: Array<{ name: string; scholar_count: number; kind: string }> = await conn.query(
    `SELECT name, scholar_count, 'dept' AS kind FROM department
       UNION ALL
       SELECT name, scholar_count, 'div'  AS kind FROM division`,
  );
  const byName = new Map<string, Specialty>();
  for (const r of rows) {
    const key = r.name.trim();
    const existing = byName.get(key);
    if (existing) {
      existing.count = Math.max(existing.count, Number(r.scholar_count));
      existing.kinds.add(r.kind);
    } else {
      byName.set(key, { name: key, count: Number(r.scholar_count), kinds: new Set([r.kind]) });
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Build the resolver's byForm: normalized(name|entryTerm) -> preferred name. */
async function loadMeshForms(conn: Connection): Promise<Map<string, string>> {
  const rows: Array<{ name: string; entry_terms: unknown }> = await conn.query(
    `SELECT name, entry_terms FROM mesh_descriptor`,
  );
  const forms = new Map<string, string>();
  for (const r of rows) {
    const candidates = [r.name];
    // The mariadb driver auto-parses JSON columns, so entry_terms arrives as a
    // string[] already; older rows / raw text come back as a JSON string. Handle both.
    let terms: unknown = r.entry_terms;
    if (typeof terms === "string") {
      try {
        terms = JSON.parse(terms);
      } catch {
        terms = []; // ETL contract violation; ignore for the audit
      }
    }
    if (Array.isArray(terms)) for (const t of terms) if (typeof t === "string") candidates.push(t);
    for (const c of candidates) {
      const nf = normalizeForMatch(c);
      if (nf && !forms.has(nf)) forms.set(nf, r.name);
    }
  }
  return forms;
}

/** Topic/subtopic match keys: [normalizedKey, displayLabel]. */
async function loadTopicKeys(conn: Connection): Promise<Array<[string, string]>> {
  const topics: Array<{ label: string }> = await conn.query(`SELECT label FROM topic`);
  const subs: Array<{ k: string }> = await conn.query(
    `SELECT COALESCE(NULLIF(TRIM(display_name), ''), label) AS k FROM subtopic`,
  );
  const out: Array<[string, string]> = [];
  for (const t of topics) {
    const nf = normalizeForMatch(t.label);
    if (nf) out.push([nf, t.label]);
  }
  for (const s of subs) {
    const nf = normalizeForMatch(s.k);
    if (nf) out.push([nf, s.k]);
  }
  return out;
}

const MESH_TOKEN = /"([^"]+)"\[MeSH Terms\]/gi;

function classify(name: string, translation: string): { verdict: Verdict; fallback: string[] } {
  const norm = normalizeForMatch(name);
  const meshTokens = [...translation.matchAll(MESH_TOKEN)].map((m) => m[1]);
  const hasMesh = meshTokens.length > 0;
  const isSplit = translation.includes(" AND ");
  const wholePhraseMesh = meshTokens.some((t) => normalizeForMatch(t) === norm);
  let verdict: Verdict;
  if (wholePhraseMesh || (hasMesh && !isSplit)) verdict = "NATIVE";
  else if (hasMesh && isSplit) verdict = "SPLIT";
  else verdict = "FREE_TEXT";
  return { verdict, fallback: [...new Set(meshTokens)] };
}

async function esearch(term: string): Promise<{ count: number; translation: string }> {
  const qs = new URLSearchParams({
    db: "pubmed",
    term,
    retmode: "json",
    retmax: "0",
    tool: NCBI_TOOL,
    email: NCBI_EMAIL,
  });
  const resp = await fetch(`${ESEARCH}?${qs}`, {
    headers: { "User-Agent": `${NCBI_TOOL}/1.0` },
  });
  if (!resp.ok) throw new Error(`esearch HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    esearchresult?: { count?: string; querytranslation?: string };
  };
  const res = data.esearchresult ?? {};
  return { count: parseInt(res.count ?? "0", 10), translation: res.querytranslation ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function render(rows: ResultRow[]): void {
  const yn = (v: unknown) => (v ? "yes" : "—");
  const order: Record<Verdict, number> = { NATIVE: 0, SPLIT: 1, FREE_TEXT: 2, ERROR: 3 };
  console.log("\n" + "=".repeat(110));
  console.log("WCM SPECIALTY -> PUBMED ATM AUDIT");
  console.log("=".repeat(110));
  console.log(
    `${"specialty".padEnd(42)}${"sch".padStart(5)}  ${"pubmed".padEnd(10)}` +
      `${"ourMeSH".padStart(8)}${"ourTopic".padStart(9)}  fallback MeSH (what PubMed mapped)`,
  );
  console.log("-".repeat(110));
  for (const r of [...rows].sort(
    (a, b) => order[a.pubmed] - order[b.pubmed] || b.count - a.count,
  )) {
    const fb = r.pubmed === "NATIVE" ? "" : r.fallback.slice(0, 3).join(", ");
    console.log(
      `${r.name.padEnd(42)}${String(r.count).padStart(5)}  ${r.pubmed.padEnd(10)}` +
        `${yn(r.ourMesh).padStart(8)}${yn(r.ourTopic).padStart(9)}  ${fb}`,
    );
  }
  const aliasCandidates = rows.filter(
    (r) => (r.pubmed === "SPLIT" || r.pubmed === "FREE_TEXT") && !r.ourMesh && !r.ourTopic,
  );
  const syncGaps = rows.filter((r) => r.pubmed === "NATIVE" && !r.ourMesh && !r.ourTopic);
  const resolved = rows.filter((r) => r.ourMesh || r.ourTopic);
  console.log("\n" + "=".repeat(110));
  console.log("BUCKETS");
  console.log("=".repeat(110));
  console.log(
    `  ALIAS CANDIDATES (PubMed SPLIT/FREE_TEXT & we miss both): ${aliasCandidates.length}`,
  );
  for (const r of aliasCandidates) {
    const anchor = r.fallback[0] ?? "(none)";
    console.log(`      - ${r.name.padEnd(40)} ${r.pubmed.padEnd(9)} natural anchor: ${anchor}`);
  }
  console.log(`\n  ENTRY-TERM SYNC GAPS (PubMed NATIVE but we miss): ${syncGaps.length}`);
  for (const r of syncGaps) console.log(`      - ${r.name}`);
  console.log(`\n  ALREADY RESOLVED BY US (mesh or topic): ${resolved.length}`);
}

async function main(): Promise<void> {
  const { limit, out, throttle } = parseArgs(process.argv.slice(2));
  const conn = await createConnection(dbConfig());
  try {
    const [specialties, meshForms, topicKeys] = await Promise.all([
      loadSpecialties(conn),
      loadMeshForms(conn),
      loadTopicKeys(conn),
    ]);
    const list = specialties.slice(0, limit);
    console.error(
      `Loaded ${specialties.length} specialties (auditing ${list.length}), ` +
        `${meshForms.size} MeSH forms, ${topicKeys.length} topic keys.\n`,
    );
    const rows: ResultRow[] = [];
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      const norm = normalizeForMatch(sp.name);
      const ourMesh = meshForms.get(norm) ?? null;
      const ourTopic = topicKeys.find(([k]) => k.includes(norm))?.[1] ?? null;
      let row: ResultRow;
      try {
        const { count, translation } = await esearch(sp.name);
        const { verdict, fallback } = classify(sp.name, translation);
        row = {
          name: sp.name,
          count: sp.count,
          kinds: [...sp.kinds].sort().join("+"),
          pubmed: verdict,
          pubmedHits: count,
          fallback,
          ourMesh,
          ourTopic,
          translation,
        };
      } catch (e) {
        row = {
          name: sp.name,
          count: sp.count,
          kinds: [...sp.kinds].sort().join("+"),
          pubmed: "ERROR",
          pubmedHits: -1,
          fallback: [e instanceof Error ? e.message : String(e)],
          ourMesh,
          ourTopic,
          translation: "",
        };
      }
      rows.push(row);
      console.error(
        `[${String(i + 1).padStart(2)}/${list.length}] ${sp.name.padEnd(42)} ${row.pubmed}`,
      );
      await sleep(throttle);
    }
    writeFileSync(out, JSON.stringify(rows, null, 2));
    render(rows);
    console.error(`\nWrote ${rows.length} rows to ${out}`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
