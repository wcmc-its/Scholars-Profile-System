/**
 * The recency A/B, re-ranked OFFLINE from one capture per fixture.
 *
 * Both arms are produced from the SAME captured payload by the SAME shipped function
 * (`rerankCandidates`), differing only in `recency`:
 *
 *     arm OFF = { recency: "any" }      → ×1 for everyone (contract.ts:200-201), which is
 *                                         exactly what rrfFuse does with no recency map
 *                                         (spine.ts:112, `?? 1`) — i.e. the flag-off ranking.
 *     arm ON  = { recency: "recent" }   → D1's shipped curve, the flag-on ranking.
 *
 * This is a PAIRED design: one LLM concept extraction feeds both arms, so the extractor's
 * ~0.0074 nDCG noise cancels within each pair rather than needing to be cleared by sampling.
 * It is also the only sound option — the flag-flip A/B can serve stale pre-flip payloads,
 * because SPONSOR_MATCH_RECENCY is not in the route's cache key (route.ts:140).
 *
 * The ranker is IMPORTED, never reimplemented: re-deriving the recency math here would grade
 * the ranker against a copy of itself — the same circularity `sponsor-README.md` warns about
 * for MeSH-count grading.
 *
 *   npx tsx scripts/search-eval/sponsor-rerank-ab.ts --selftest    # vs the real rrfFuse, no infra
 *   npx tsx scripts/search-eval/sponsor-rerank-ab.ts captures/draw-1
 *   → captures/draw-1/arm-off.json, arm-on.json   ({"<id>": ["cwid", ...]}, the ACTUAL= shape)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

import {
  rerankCandidates,
  recencyWeight,
  DEFAULT_K,
  type SponsorCandidate,
  type SponsorConcept,
} from "@/lib/api/sponsor-match-contract";
import { rrfFuse } from "@/lib/api/sponsor-match-spine";

/**
 * The recency clock. `currentYear` is the one score input the server does NOT ship on the wire
 * (contract.ts:669 — "not worth shipping a server-year field"); both sides otherwise read
 * `new Date().getUTCFullYear()`. Pin it so a run spanning UTC New Year cannot silently move the
 * ON arm ~4% on the freshest candidate while the OFF arm (×1 regardless) sits still.
 */
const CURRENT_YEAR = Number(process.env.CURRENT_YEAR ?? new Date().getUTCFullYear());

/**
 * Rebuild the server's `firstSeen` tie-break order — the fix without which the OFF arm is
 * quietly wrong.
 *
 * The server breaks exact score ties on first-appearance (spine.ts:115); the client breaks them
 * on INCOMING order (contract.ts:782). Those agree for the ON arm, because the wire arrives in
 * recency-fused order — but for the OFF arm the incoming order is itself recency-sorted, so a
 * naive re-rank leaks the treatment into the control on every exact tie. Ties are not rare: the
 * weight is `centrality**3 × weightFactor` over an LLM-quantized centrality and a 2-valued kind
 * prior, so equal-weight terms collide. Measured 34/500 wrong orders on a tie-dense stress.
 * The bias runs toward zero, which is conservative for a superiority test but ANTI-conservative
 * for the non-inferiority test this gold can actually support — it bites the test we're running.
 *
 * rrfFuse scans term-outer / rank-inner (spine.ts:99-107), and `concepts[]` ships in `rankings`
 * order (the pushes at spine-run.ts:485/:577 are 1:1), so a candidate's first appearance is the
 * lexicographic min of (concept index, rank) over its contributions.
 */
function firstSeenKey(
  candidate: SponsorCandidate,
  conceptIndex: ReadonlyMap<string, number>,
): [number, number] {
  let best: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  for (const { term, rank } of candidate.contributions) {
    const t = conceptIndex.get(term);
    if (t === undefined) continue; // a contribution whose concept was dropped contributes 0
    if (t < best[0] || (t === best[0] && rank < best[1])) best = [t, rank];
  }
  return best;
}

/** Both arms from one payload. The ONLY difference is `recency` — everything else is shared. */
function armsFor(
  concepts: readonly SponsorConcept[],
  candidates: readonly SponsorCandidate[],
  currentYear: number,
) {
  const conceptIndex = new Map(concepts.map((c, i) => [c.term, i]));
  // Pre-sort into reconstructed server-firstSeen order, so the client's index tie-break
  // reproduces the server's firstSeen tie-break for BOTH arms.
  const ordered = [...candidates].sort((a, b) => {
    const ka = firstSeenKey(a, conceptIndex);
    const kb = firstSeenKey(b, conceptIndex);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  return {
    off: rerankCandidates(ordered, concepts, { recency: "any", currentYear }),
    on: rerankCandidates(ordered, concepts, { recency: "recent", currentYear }),
  };
}

// ── selftest: the arms vs the REAL server fuser, no infra ────────────────────────────────────
// Ground truth is `rrfFuse` itself — the actual server function — not a restatement of it here.
if (process.argv[2] === "--selftest") {
  let failed = false;
  const ok = (label: string, cond: boolean, got: string) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}  ${got}`);
    if (!cond) failed = true;
  };

  const YEAR = 2026;
  // TWO EQUAL-WEIGHT CONCEPTS — the tie generator. `weight = centrality^3 × weightFactor`, so
  // identical centrality + identical kind prior ⇒ identical weight ⇒ rank-1 under either term
  // scores exactly w/(K+1). This is not contrived: centrality is LLM-quantized and the kind
  // prior has two values, so equal weights collide routinely on real pastes.
  const concepts = [
    { term: "alpha", kind: "concept", members: ["alpha"], centrality: 0.9, weightFactor: 1.25 },
    { term: "beta", kind: "concept", members: ["beta"], centrality: 0.9, weightFactor: 1.25 },
  ] as unknown as SponsorConcept[];
  const w = 0.9 ** 3 * 1.25;
  const rankings = [
    { term: "alpha", weight: w, ranked: ["x", "z"] },
    { term: "beta", weight: w, ranked: ["y", "z"] },
  ];
  // x is stale, y is fresh ⇒ recency must swap them; z appears under both terms (outranks both).
  const years: Record<string, number> = { x: 2000, y: 2026, z: 2015 };
  const recencyMap = new Map(Object.entries(years).map(([c, yr]) => [c, recencyWeight(yr, YEAR, "recent")]));

  const serverOff = rrfFuse(rankings, DEFAULT_K).map((f) => f.cwid);
  const serverOn = rrfFuse(rankings, DEFAULT_K, recencyMap).map((f) => f.cwid);
  ok("fixture generates an exact tie", serverOff[1] === "x" && serverOff[2] === "y", `serverOff=${serverOff.join(",")}`);
  ok("recency reorders the tie", serverOn.indexOf("y") < serverOn.indexOf("x"), `serverOn=${serverOn.join(",")}`);

  // The wire: staging ships candidates in server-ON order, carrying mostRecentYear.
  const fusedOn = rrfFuse(rankings, DEFAULT_K, recencyMap);
  const wire = fusedOn.map((f) => ({
    cwid: f.cwid,
    fusedScore: f.score,
    contributions: f.contributions,
    mostRecentYear: years[f.cwid],
  })) as unknown as SponsorCandidate[];

  const arms = armsFor(concepts, wire, YEAR);
  ok("arm OFF reproduces the server's flag-off order", JSON.stringify(arms.off.map((c) => c.cwid)) === JSON.stringify(serverOff), `${arms.off.map((c) => c.cwid).join(",")} vs ${serverOff.join(",")}`);
  ok("arm ON reproduces the server's flag-on order", JSON.stringify(arms.on.map((c) => c.cwid)) === JSON.stringify(serverOn), `${arms.on.map((c) => c.cwid).join(",")} vs ${serverOn.join(",")}`);

  // THE FIX MUST BE LOAD-BEARING. Without the firstSeen pre-sort the OFF arm inherits the wire's
  // recency-sorted order on every exact tie — i.e. the treatment leaks into the control. If this
  // ever starts passing, the pre-sort has become dead code and something else changed.
  const naive = rerankCandidates(wire, concepts, { recency: "any", currentYear: YEAR }).map((c) => c.cwid);
  ok("naive (no pre-sort) arm OFF is WRONG — the fix is load-bearing", JSON.stringify(naive) !== JSON.stringify(serverOff), `naive=${naive.join(",")} vs truth=${serverOff.join(",")}`);

  console.log(failed ? "\nselftest FAILED" : "\nselftest PASS");
  process.exit(failed ? 1 : 0);
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: tsx sponsor-rerank-ab.ts <capture-dir>  [CURRENT_YEAR=<yyyy>]");
  console.error("       tsx sponsor-rerank-ab.ts --selftest");
  process.exit(1);
}

// `null` vs a MISSING key is load-bearing in sponsor-eval.sh:
//   missing key → scores as []  → a legitimate nDCG of 0
//   explicit null → unmeasured  → excluded from the mean
// A fixture the capture never got (breaker 502, empty pool) is UNMEASURED, so it must be emitted
// as an explicit null. Leaving it out would score it 0 in both arms and smuggle a fabricated
// Δ=0 pair into the paired test — inflating n with an exact zero the test never measured.
const armOff: Record<string, string[] | null> = {};
const armOn: Record<string, string[] | null> = {};
const report: string[] = [];

// __dirname, not import.meta.dirname — tsx transforms this to CJS, where import.meta is undefined.
const FIX = process.env.FIX ?? join(__dirname, "sponsor-fixtures.json");
const fixtureIds: string[] = JSON.parse(readFileSync(FIX, "utf8")).prompts.map((p: { id: string }) => p.id);

// Drive off the FIXTURE ids, not a directory listing: this dir also holds the arms and the
// scorer's own JSON_OUT (off.json/on.json), and reading one of those as a capture crashes on an
// undefined `candidates`. The fixture set is the authority on what a capture may be named.
const present = new Set(readdirSync(dir).filter((f) => f.endsWith(".json")));
const captured = fixtureIds.filter((id) => present.has(`${id}.json`));
if (captured.length === 0) {
  console.error(`no fixture captures in ${dir}`);
  process.exit(1);
}

for (const id of captured) {
  const body = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as {
    concepts: SponsorConcept[];
    candidates: SponsorCandidate[];
  };
  const { concepts, candidates } = body;

  // Guard the collapse case: no years ⇒ recencyWeight returns 1 for BOTH modes (contract.ts:200)
  // and the arms are identical by construction. That is a dead capture, not a null result.
  const withYear = candidates.filter((c) => c.mostRecentYear != null).length;
  if (withYear === 0) {
    console.error(`✗ ${id}: 0/${candidates.length} candidates carry mostRecentYear — dead capture`);
    process.exit(1);
  }
  if (concepts.length === 0) {
    // The bespoke engine ships concepts: [] and rerankCandidates early-returns (contract.ts:755).
    // Recency is inert there by design; it must never reach the spine A/B.
    console.error(`✗ ${id}: concepts[] empty — that is the bespoke engine, not the spine path`);
    process.exit(1);
  }

  const { off, on } = armsFor(concepts, candidates, CURRENT_YEAR);

  armOff[id] = off.map((c) => c.cwid);
  armOn[id] = on.map((c) => c.cwid);

  // Exact score ties are what the tie-break fix exists for — report them so a reader can see
  // whether the fix was load-bearing on THIS data rather than taking the stress test on faith.
  const ties = off.filter((c, i) => i > 0 && c.fusedScore === off[i - 1].fusedScore).length;
  const moved = armOff[id].findIndex((c, i) => c !== armOn[id][i]);
  report.push(
    `── ${id}  candidates=${candidates.length}  with-year=${withYear}  ` +
      `off-ties=${ties}  first-rank-moved=${moved === -1 ? "none" : `#${moved + 1}`}`,
  );
}

// Every fixture the capture did not produce is UNMEASURED, not a zero. Emit an explicit null.
const uncaptured = fixtureIds.filter((id) => !(id in armOff));
for (const id of uncaptured) {
  armOff[id] = null;
  armOn[id] = null;
  report.push(`── ${id}  NOT CAPTURED → emitted as null (UNMEASURED, excluded — not scored 0)`);
}

writeFileSync(join(dir, "arm-off.json"), JSON.stringify(armOff, null, 2));
writeFileSync(join(dir, "arm-on.json"), JSON.stringify(armOn, null, 2));

console.log(report.join("\n"));
console.log(`\ncurrentYear=${CURRENT_YEAR} (pinned)  captured=${captured.length}/${fixtureIds.length}`);
console.log(`wrote ${join(dir, "arm-off.json")} + arm-on.json`);
console.log(`\nnext:\n  ACTUAL=${dir}/arm-off.json JSON_OUT=${dir}/off.json ./sponsor-eval.sh`);
console.log(`  ACTUAL=${dir}/arm-on.json  JSON_OUT=${dir}/on.json  ./sponsor-eval.sh`);
console.log(`  npx tsx sponsor-ni-test.ts ${dir}/off.json ${dir}/on.json`);
