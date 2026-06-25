/**
 * #1258 — DRY RUN for the dormant derived-anchor path, with relevance weighting
 * and an optional TF-IDF lens. WRITES NOTHING. Run in the ETL env (needs DB):
 *
 *   tsx scripts/derive-anchors-dryrun.ts
 *
 * Answers: "if descriptor→topic anchors were mined from papers' MeSH terms
 * (weighted by ReciterAI relevance), how many of the 137 hand-curated anchors
 * in etl/mesh-anchors/curated.candidates.csv would it reproduce — and what free
 * anchors would it discover?"
 *
 * Three selection rules are scored side by side so we can decide empirically
 * whether TF-IDF earns its keep over the existing precision threshold:
 *   P     baseline  P(topic|descriptor) = n_both/n_desc           (today's ETL, unweighted)
 *   relP  relevance-weighted precision  relBoth/relDescTotal       (your score filter)
 *   tfidf relevance TF (share of topic's relevance mass) × IDF     (the TF-IDF lens)
 *
 * Env knobs (defaults match the live ETL): MIN_SUPPORT=5, P_THRESHOLD=0.30,
 * RELP_THRESHOLD=0.30, TFIDF_TOPK=15 (per topic).
 */
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { db } from "@/lib/db";

const MIN_SUPPORT = parseInt(process.env.MESH_ANCHOR_MIN_SUPPORT ?? "5", 10);
const P_THRESHOLD = parseFloat(process.env.MESH_ANCHOR_P_THRESHOLD ?? "0.30");
const RELP_THRESHOLD = parseFloat(process.env.MESH_ANCHOR_RELP_THRESHOLD ?? "0.30");
const TFIDF_TOPK = parseInt(process.env.MESH_ANCHOR_TFIDF_TOPK ?? "15", 10);

type Row = {
  descriptor_ui: string; parent_topic_id: string;
  n_both: number; n_desc: number; rel_both: number;
  topic_rel_mass: number; df_topics: number;
};

/** Pure per-(d,t) metric math — the only non-trivial logic, so it gets the check. */
function metrics(r: Row, nTopics: number, relDescTotal: number) {
  const p = r.n_both / r.n_desc;                          // P(topic|descriptor)
  const relP = relDescTotal > 0 ? r.rel_both / relDescTotal : 0;
  const tf = r.topic_rel_mass > 0 ? r.rel_both / r.topic_rel_mass : 0; // share of topic's relevance mass
  const idf = r.df_topics > 0 ? Math.log(nTopics / r.df_topics) : 0;
  return { p, relP, tf, idf, tfidf: tf * idf };
}

assert.deepStrictEqual(
  metrics({ descriptor_ui: "D1", parent_topic_id: "t", n_both: 30, n_desc: 100, rel_both: 6, topic_rel_mass: 12, df_topics: 2 } as Row, 8, 10),
  { p: 0.3, relP: 0.6, tf: 0.5, idf: Math.log(4), tfidf: 0.5 * Math.log(4) },
);

const SCORE_MIN = parseFloat(process.env.MESH_ANCHOR_SCORE_MIN ?? "0"); // paper-relevance floor

async function main() {
  // Calibrate: what does publication_topic.score actually look like? (grounds the 0.9 guess)
  const dist = await db.write.$queryRaw<{ n: bigint; mn: number; mx: number; ge50: bigint; ge70: bigint; ge80: bigint; ge90: bigint; ge95: bigint }[]>`
    SELECT COUNT(*) AS n, CAST(MIN(score) AS DOUBLE) AS mn, CAST(MAX(score) AS DOUBLE) AS mx,
           SUM(score>=0.5) AS ge50, SUM(score>=0.7) AS ge70, SUM(score>=0.8) AS ge80,
           SUM(score>=0.9) AS ge90, SUM(score>=0.95) AS ge95
    FROM publication_topic`;
  const d0 = dist[0];
  console.log(`score dist: n=${d0.n} min=${d0.mn} max=${d0.mx} | ≥0.5=${d0.ge50} ≥0.7=${d0.ge70} ≥0.8=${d0.ge80} ≥0.9=${d0.ge90} ≥0.95=${d0.ge95}`);
  console.log(`SCORE_MIN paper filter = ${SCORE_MIN}\n`);

  const rows = await db.write.$queryRaw<Row[]>`
    WITH pub_descriptors AS (
      SELECT DISTINCT p.pmid, jt.ui AS descriptor_ui
      FROM publication p
      CROSS JOIN JSON_TABLE(p.mesh_terms, '$[*]' COLUMNS (ui VARCHAR(10) PATH '$.ui')) jt
      WHERE jt.ui IS NOT NULL
    ),
    descriptor_totals AS (
      SELECT descriptor_ui, COUNT(DISTINCT pmid) AS n_desc
      FROM pub_descriptors GROUP BY descriptor_ui
    ),
    pub_topics AS (
      SELECT pmid, parent_topic_id, MAX(score) AS rel
      FROM publication_topic GROUP BY pmid, parent_topic_id
      HAVING MAX(score) >= ${SCORE_MIN}
    ),
    topic_mass AS (
      SELECT parent_topic_id, SUM(rel) AS topic_rel_mass FROM pub_topics GROUP BY parent_topic_id
    ),
    co AS (
      SELECT pd.descriptor_ui, pt.parent_topic_id,
             COUNT(DISTINCT pd.pmid) AS n_both, SUM(pt.rel) AS rel_both
      FROM pub_descriptors pd INNER JOIN pub_topics pt USING (pmid)
      GROUP BY pd.descriptor_ui, pt.parent_topic_id
    ),
    spread AS (  -- DF for IDF: # topics where the descriptor clears min support
      SELECT descriptor_ui, COUNT(*) AS df_topics FROM co WHERE n_both >= ${MIN_SUPPORT} GROUP BY descriptor_ui
    )
    SELECT co.descriptor_ui, co.parent_topic_id,
           CAST(co.n_both AS UNSIGNED) AS n_both, CAST(dt.n_desc AS UNSIGNED) AS n_desc,
           CAST(co.rel_both AS DOUBLE) AS rel_both, CAST(tm.topic_rel_mass AS DOUBLE) AS topic_rel_mass,
           CAST(sp.df_topics AS UNSIGNED) AS df_topics
    FROM co
    JOIN descriptor_totals dt USING (descriptor_ui)
    JOIN topic_mass tm USING (parent_topic_id)
    LEFT JOIN spread sp USING (descriptor_ui)
    WHERE co.n_both >= ${MIN_SUPPORT}
    ORDER BY co.descriptor_ui, co.parent_topic_id`;

  const R: Row[] = rows.map((r) => ({
    descriptor_ui: r.descriptor_ui, parent_topic_id: r.parent_topic_id,
    n_both: Number(r.n_both), n_desc: Number(r.n_desc), rel_both: Number(r.rel_both),
    topic_rel_mass: Number(r.topic_rel_mass), df_topics: Number(r.df_topics),
  }));

  const nTopics = new Set(R.map((r) => r.parent_topic_id)).size;
  const relDescTotal = new Map<string, number>();
  for (const r of R) relDescTotal.set(r.descriptor_ui, (relDescTotal.get(r.descriptor_ui) ?? 0) + r.rel_both);

  // curated target set (the 137) — (descriptor_ui|topic). Optional: if the file
  // isn't in this checkout, overlap scoring is skipped and only discoveries show.
  let curated = new Set<string>();
  try {
    curated = new Set(
      readFileSync("etl/mesh-anchors/curated.candidates.csv", "utf8").split(/\r?\n/).slice(1)
        .map((l) => l.split(",").slice(0, 2).join("|")).filter((k) => k.includes("|") && k.length > 2),
    );
  } catch {
    console.log("(no curated.candidates.csv in this checkout — overlap scoring skipped)");
  }

  const key = (r: Row) => `${r.descriptor_ui}|${r.parent_topic_id}`;
  const scored = R.map((r) => ({ r, m: metrics(r, nTopics, relDescTotal.get(r.descriptor_ui) ?? 0) }));

  // selection rules
  const ruleP = new Set(scored.filter((s) => s.m.p >= P_THRESHOLD).map((s) => key(s.r)));
  const ruleRelP = new Set(scored.filter((s) => s.m.relP >= RELP_THRESHOLD).map((s) => key(s.r)));
  const byTopic = new Map<string, typeof scored>();
  for (const s of scored) (byTopic.get(s.r.parent_topic_id) ?? byTopic.set(s.r.parent_topic_id, []).get(s.r.parent_topic_id)!).push(s);
  const ruleTfidf = new Set<string>();
  for (const [, list] of byTopic)
    list.sort((a, b) => b.m.tfidf - a.m.tfidf).slice(0, TFIDF_TOPK).forEach((s) => ruleTfidf.add(key(s.r)));

  const report = (name: string, set: Set<string>) => {
    const hit = [...set].filter((k) => curated.has(k)).length;
    console.log(`${name.padEnd(7)} emits ${String(set.size).padStart(5)} anchors | covers ${hit}/${curated.size} curated | ${set.size - hit} new`);
  };
  console.log(`\nnTopics=${nTopics}  candidate (d,t) pairs ≥${MIN_SUPPORT} support: ${R.length}  curated target: ${curated.size}\n`);
  report("P", ruleP); report("relP", ruleRelP); report("tfidf", ruleTfidf);

  // which of the 137 does NONE of the rules find → still needs manual curation
  const union = new Set([...ruleP, ...ruleRelP, ...ruleTfidf]);
  const missed = [...curated].filter((k) => !union.has(k));
  console.log(`\n=== curated anchors NO rule reproduces (${missed.length}) — manual stays ===`);
  missed.forEach((k) => console.log("  " + k));

  // top free discoveries from the relevance-weighted rule, not already curated
  console.log(`\n=== top 25 relP discoveries NOT in curated (free anchors to review) ===`);
  scored.filter((s) => s.m.relP >= RELP_THRESHOLD && !curated.has(key(s.r)))
    .sort((a, b) => b.m.tfidf - a.m.tfidf).slice(0, 25)
    .forEach((s) => console.log(`  ${s.r.descriptor_ui} → ${s.r.parent_topic_id}  n=${s.r.n_both} relP=${s.m.relP.toFixed(2)} idf=${s.m.idf.toFixed(2)} tfidf=${s.m.tfidf.toFixed(3)}`));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
