/**
 * #1119 snippet-calibration analysis: join the workflow's blind judge verdicts
 * (/tmp/methodcontext-eval-verdicts.json) to the withheld mechanical lever flags
 * in the full dataset (/tmp/methodcontext-eval-dataset.json), by id, and compute
 * each lever's precision / recall / collateral-wins-dropped + the tier-conditional
 * win rates that decide opaque-tool gating. Plain node (no tsx / no DB).
 *
 *   node scripts/methodcontext-eval-analyze.mjs
 */
import fs from "node:fs";

const full = JSON.parse(fs.readFileSync("/tmp/methodcontext-eval-dataset.json", "utf8"));
const verdicts = JSON.parse(fs.readFileSync("/tmp/methodcontext-eval-verdicts.json", "utf8"));
const byId = new Map(full.map((r) => [r.id, r]));

// joined judged rows = mechanical flags + judge consensus
const J = verdicts.map((v) => ({ ...byId.get(v.id), ...v })).filter((r) => r.snippet);
const N = J.length;
const pct = (n, d = N) => `${n} (${d ? Math.round((100 * n) / d) : 0}%)`;
const isWin = (r) => r.consensusVerdict === "win";
const isNoise = (r) => r.consensusVerdict === "noise";

console.log(
  `\n${"#".repeat(72)}\n#  #1119 SNIPPET LEVER ANALYSIS — judged sample n=${N}\n${"#".repeat(72)}`,
);

// ---- 0. inter-rater reliability + overall verdict mix ----
const agreed = J.filter((r) => r.agreed).length;
const vc = { win: 0, neutral: 0, noise: 0 };
for (const r of J) vc[r.consensusVerdict] = (vc[r.consensusVerdict] ?? 0) + 1;
const beats = J.filter((r) => r.consensusBeatsPlainName).length;
console.log(
  `\n[0] reliability: A/B agreed on pivotal call = ${pct(agreed)}  (rest broken by adversarial tiebreak)`,
);
console.log(
  `    verdict mix: win=${pct(vc.win)}  neutral=${pct(vc.neutral)}  noise=${pct(vc.noise)}`,
);
console.log(`    beatsPlainName (snippet earns its place) = ${pct(beats)}`);

// ---- 1. TIER-conditional value → lever #3 (opaque-tool gating) ----
console.log(`\n[1] LEVER #3 opaque-tool gating — value by salience tier (S=well-known … B=niche):`);
console.log(`    tier |  n  | win% | beatsName% | nameSelfExplanatory% | medianPubN`);
for (const tier of ["S", "A", "B"]) {
  const g = J.filter((r) => (r.salienceTier ?? "(null)") === tier);
  if (!g.length) continue;
  const w = g.filter(isWin).length,
    bn = g.filter((r) => r.consensusBeatsPlainName).length;
  const se = g.filter((r) => r.nameIsSelfExplanatory).length;
  const pubs = g.map((r) => r.toolPubCount).sort((a, b) => a - b);
  const med = pubs[Math.floor(pubs.length / 2)];
  console.log(
    `     ${tier}   | ${String(g.length).padStart(3)} | ${String(Math.round((100 * w) / g.length)).padStart(3)}% |    ${String(Math.round((100 * bn) / g.length)).padStart(3)}%    |        ${String(Math.round((100 * se) / g.length)).padStart(3)}%         |    ${med}`,
  );
}
// pub_count cut as an alternative opacity signal
for (const [lab, lo, hi] of [
  ["pubN=1", 1, 1],
  ["pubN 2-4", 2, 4],
  ["pubN>=5", 5, 1e9],
]) {
  const g = J.filter((r) => r.toolPubCount >= lo && r.toolPubCount <= hi);
  if (!g.length) continue;
  const w = g.filter(isWin).length,
    bn = g.filter((r) => r.consensusBeatsPlainName).length;
  console.log(
    `    ${lab.padEnd(9)}| ${String(g.length).padStart(3)} | ${String(Math.round((100 * w) / g.length)).padStart(3)}% |    ${String(Math.round((100 * bn) / g.length)).padStart(3)}%    |`,
  );
}

// ---- 2. LEVER #1 clean-sentence filter — mechanical fragmentStart vs judged broken ----
console.log(
  `\n[2] LEVER #1 clean-sentence filter — mechanical fragmentStart vs judge readsAsBrokenFragment:`,
);
const fs1 = J.filter((r) => r.fragmentStart);
const jbroken = J.filter((r) => r.readsAsBrokenFragment);
const tp1 = J.filter((r) => r.fragmentStart && r.readsAsBrokenFragment).length;
console.log(
  `    mechanical fragmentStart flagged: ${pct(fs1.length)};  judge-broken: ${pct(jbroken.length)}`,
);
console.log(
  `    precision P(judge-broken | flagged) = ${fs1.length ? Math.round((100 * tp1) / fs1.length) : 0}%`,
);
console.log(
  `    recall    P(flagged | judge-broken) = ${jbroken.length ? Math.round((100 * tp1) / jbroken.length) : 0}%`,
);
console.log(
  `    COLLATERAL — among fragmentStart-flagged rows: win=${fs1.filter(isWin).length} neutral=${fs1.filter((r) => r.consensusVerdict === "neutral").length} noise=${fs1.filter(isNoise).length}`,
);
console.log(`      → wins a naive drop would wrongly kill: ${fs1.filter(isWin).length}`);

// ---- 3. LEVER #4 subject-not-foil — foilCueNearby vs judged tool_is_foil ----
console.log(
  `\n[3] LEVER #4 subject-not-foil — mechanical foilCueNearby vs judge failureMode=tool_is_foil:`,
);
const foilFlag = J.filter((r) => r.foilCueNearby);
const jfoil = J.filter((r) => r.consensusFailureMode === "tool_is_foil");
const tp4 = J.filter((r) => r.foilCueNearby && r.consensusFailureMode === "tool_is_foil").length;
console.log(
  `    mechanical foilCueNearby: ${pct(foilFlag.length)};  judge tool_is_foil: ${pct(jfoil.length)}`,
);
console.log(
  `    precision P(judge-foil | flagged) = ${foilFlag.length ? Math.round((100 * tp4) / foilFlag.length) : 0}%   recall = ${jfoil.length ? Math.round((100 * tp4) / jfoil.length) : 0}%`,
);
// name-position signal: among judged foils, where does the tool name sit?
const npFoil = jfoil
  .filter((r) => r.namePosition != null)
  .map((r) => r.namePosition)
  .sort((a, b) => a - b);
const npWin = J.filter(isWin)
  .filter((r) => r.namePosition != null)
  .map((r) => r.namePosition)
  .sort((a, b) => a - b);
const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
console.log(
  `    median namePosition: judged-foils=${median(npFoil)}  wins=${median(npWin)}  (higher=name later in sentence)`,
);

// ---- 4. DEDUPE — mechanical snippetReuse vs judge ----
console.log(`\n[4] DEDUPE lever — reused snippets (mechanical snippetReuse>1 in full set):`);
const reused = J.filter((r) => (r.snippetReuse?.rows ?? 1) > 1);
console.log(`    judged rows whose snippet is reused elsewhere: ${pct(reused.length)}`);
console.log(
  `      of those: win=${reused.filter(isWin).length} neutral=${reused.filter((r) => r.consensusVerdict === "neutral").length} noise=${reused.filter(isNoise).length}`,
);

// ---- 5. failure-mode distribution (judge) ----
console.log(`\n[5] judge failureMode distribution (dominant reason NOT a clean win):`);
const fm = {};
for (const r of J) fm[r.consensusFailureMode] = (fm[r.consensusFailureMode] ?? 0) + 1;
for (const k of Object.keys(fm).sort((a, b) => fm[b] - fm[a]))
  console.log(`    ${k.padEnd(24)} ${pct(fm[k])}`);

// ---- 6. EXTRAPOLATION to full population (445 rows) ----
console.log(
  `\n[6] EXTRAPOLATION to full top-10 population (n=${full.length}); rates from judged sample:`,
);
const popFrag = full.filter((r) => r.fragmentStart).length;
const popFoil = full.filter((r) => r.foilCueNearby).length;
const popReuse = full.filter((r) => (r.snippetReuse?.rows ?? 1) > 1).length;
console.log(
  `    fragmentStart prevalence: ${pct(popFrag, full.length)}  | foil: ${pct(popFoil, full.length)} | reused: ${pct(popReuse, full.length)}`,
);

// ---- 7. WORKED EXAMPLES per bucket (for the findings doc) ----
const clip = (s, n = 150) => (s.length > n ? s.slice(0, n) + "…" : s);
const show = (label, rows, k = 4) => {
  console.log(`\n    ${label} (${rows.length}; showing ${Math.min(k, rows.length)})`);
  for (const r of rows.slice(0, k))
    console.log(
      `      [${r.salienceTier}|pubN${r.toolPubCount}] ${r.tool} — ${r.consensusVerdict}/${r.consensusFailureMode}\n         "${clip(r.snippet)}"`,
    );
};
console.log(`\n[7] worked examples:`);
show(
  "WINS (opaque tool, snippet beats name)",
  J.filter((r) => isWin(r) && !r.nameIsSelfExplanatory),
);
show(
  "FAILURE #1 well-known name, snippet=one-paper result",
  J.filter((r) => r.consensusFailureMode === "well_known_name_clear"),
);
show(
  "FAILURE #2 broken fragment",
  J.filter((r) => r.consensusFailureMode === "broken_fragment"),
);
show(
  "FAILURE #4 tool is a foil",
  J.filter((r) => r.consensusFailureMode === "tool_is_foil"),
);
show("WINS that mechanical fragmentStart would WRONGLY drop", fs1.filter(isWin));

console.log(`\n${"#".repeat(72)}\n`);
