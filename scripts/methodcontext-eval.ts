/**
 * #1119 method tool-usage SNIPPET calibration harness (measurement-only, no DB writes).
 *
 * Reconstructs the user-facing `ExemplarResult.methodContext` snippet from the LIVE
 * ReciterAI artifact using the PRODUCTION pure mappers verbatim
 * (`buildToolContextIndex` / `selectBestSnippet` / `buildScholarFamilyWritesFromS3`),
 * then enriches each (scholar, family, exemplar-tool) snippet row with the mechanical
 * signals behind each candidate lever, so the judgment phase can decide which levers
 * to adopt with real counts:
 *
 *   - salienceTier / toolPubCount  → lever #3 (opaque-tool gating)
 *   - fragmentStart                → lever #1 (clean-sentence filter)
 *   - namePosition / namesTool / foilCueNearby → lever #2/#4 (subject-not-foil)
 *   - snippetReuse {families,tools,scholars} → dedupe lever
 *
 * Inputs (pinned v2026-06-13; sha256 tools=aeb0a8f1… tool_context=bbd212ed…):
 *   /tmp/tools.json          s3://wcmc-reciterai-artifacts/tools/latest/tools.json
 *   /tmp/tool_context.json   s3://wcmc-reciterai-artifacts/tools/latest/tool_context.json
 *
 * Usage:
 *   npx tsx scripts/methodcontext-eval.ts                       # default seed set (home method chips + 3 explicit cwids)
 *   npx tsx scripts/methodcontext-eval.ts imh2003 mog4005 ...   # explicit cwids
 *   npx tsx scripts/methodcontext-eval.ts --query "CRISPR" ...  # resolve via family/exemplar match
 *
 * Output: writes the full dataset to /tmp/methodcontext-eval-dataset.json and prints a summary.
 */
import fs from "node:fs";
import {
  buildToolContextIndex,
  selectBestSnippet,
  salientNameForms,
} from "../etl/tools/tool-context";
import {
  buildScholarFamilyWritesFromS3,
  type ScholarFamilyWrite,
} from "../etl/tools/scholar-family-mapper-s3";
import type { ToolsArtifactSlice } from "../etl/tools/scholar-tool-mapper-s3";

const tools = JSON.parse(fs.readFileSync("/tmp/tools.json", "utf8"));
const ctx = JSON.parse(fs.readFileSync("/tmp/tool_context.json", "utf8"));
const artifact: ToolsArtifactSlice = { tools: tools.tools, faculty: tools.faculty };
const toolContext = buildToolContextIndex(ctx.tool_context);

// id -> {name, tier, pubCount}; and reverse name -> id[] (display names ~unique, but guard collisions).
const toolById = new Map<string, { name: string; tier: string | null; pubCount: number }>();
const idsByName = new Map<string, string[]>();
for (const t of artifact.tools) {
  if (!t?.canonical_tool_id || typeof t.display_name !== "string") continue;
  const name = t.display_name.trim();
  if (!name) continue;
  toolById.set(t.canonical_tool_id, {
    name,
    tier: typeof t.salience_tier === "string" ? t.salience_tier : null,
    pubCount: typeof t.pub_count === "number" ? t.pub_count : 0,
  });
  (idsByName.get(name) ?? idsByName.set(name, []).get(name)!).push(t.canonical_tool_id);
}

// ---- the method-like home "Try:" chips (handoff §"How to pick scholars") ----
const HOME_METHOD_TERMS = [
  "CRISPR",
  "Base & prime editing",
  "Single-cell RNA sequencing",
  "Spatial transcriptomics",
  "Radiomics",
  "Mendelian randomization",
  "Targeted protein degradation (PROTAC)",
  "Patient-derived organoids",
  "Liquid biopsy",
  "AAV gene therapy",
  "mRNA vaccines",
  "Antisense oligonucleotides",
  "siRNA therapeutics",
  "CAR-T cell therapy",
  "Bispecific antibodies",
  "Antibody-drug conjugates",
  "Oncolytic virotherapy",
  "Exosomes",
  "Deep brain stimulation",
  "Transcatheter aortic valve replacement",
  "Fecal microbiota transplantation",
];
// Explicit cwids from the handoff that surface the generic-method failure modes (#1/#2).
const EXPLICIT_CWIDS = ["imh2003", "mog4005", "chm2042"];

const args = process.argv.slice(2);
let cwids: string[];
let mode: string;
if (args[0] === "--query") {
  mode = "query";
  cwids = resolveByTerms(args.slice(1));
} else if (args.length > 0) {
  mode = "explicit";
  cwids = args;
} else {
  // Default: union of (top scholars per home method chip) + the explicit failure-mode cwids.
  mode = "default(home-chips + explicit)";
  const resolved = resolveByTerms(HOME_METHOD_TERMS, 3);
  cwids = [...new Set([...EXPLICIT_CWIDS, ...resolved])];
}

/** Resolve home/method terms → top scholars (by matching family pub_count). */
function resolveByTerms(rawTerms: string[], topPerTerm = 5): string[] {
  const terms = rawTerms.map((t) => t.toLowerCase());
  const nameById = new Map<string, string>();
  for (const [id, m] of toolById) nameById.set(id, m.name.toLowerCase());
  // term -> [ {cwid, pubCount} ] best per scholar
  const perTerm = terms.map(() => new Map<string, number>());
  for (const [cwid, f] of Object.entries(
    tools.faculty as Record<
      string,
      { families?: Array<{ label?: string; pub_count?: number; exemplar_tool_ids?: string[] }> }
    >,
  )) {
    for (const fam of f.families ?? []) {
      const label = String(fam.label ?? "").toLowerCase();
      const exNames = (fam.exemplar_tool_ids ?? []).map((id: string) => nameById.get(id) ?? "");
      terms.forEach((term, i) => {
        if (label.includes(term) || exNames.some((n: string) => n.includes(term))) {
          const m = perTerm[i];
          m.set(cwid, Math.max(m.get(cwid) ?? 0, fam.pub_count ?? 0));
        }
      });
    }
  }
  const out = new Set<string>();
  perTerm.forEach((m, i) => {
    const top = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topPerTerm)
      .map((x) => x[0]);
    if (top.length === 0) console.error(`  (no scholar matched term "${rawTerms[i]}")`);
    top.forEach((c) => out.add(c));
  });
  return [...out];
}

console.error(`mode=${mode}  scholars=${cwids.length}`);

// Focus each scholar on their signature families (top by pmidCount) — that is
// what would actually surface in search — rather than the 50-deep long tail.
const TOP_FAMILIES_PER_SCHOLAR = 10;
const { writes } = buildScholarFamilyWritesFromS3(artifact, {
  ourCwidSet: new Set(cwids),
  toolContext,
  topNPerScholar: TOP_FAMILIES_PER_SCHOLAR,
});

// Handoff anchor tools (stated wins + stated failures) — pinned into the judge
// sample when present so judges calibrate against the known-good/known-bad cases.
const ANCHOR_TOOLS = new Set(
  [
    "FEMI",
    "wsPurity",
    "cloudrnaSPAdes",
    "NanoTemper Dianthus",
    "Blackbird",
    "Novel-X",
    "Molecular docking",
    "RNA-seq",
    "AUC",
    "TELL-Seq",
    "LoopSeq",
  ].map((s) => s.toLowerCase()),
);

// ---- mechanical lever signals ----
const FOIL_RE =
  /\b(?:cannot be (?:found|detected|identified|done) by|cannot be|compared (?:to|with|against)|unlike|rather than|as opposed to|outperform(?:s|ed)?|instead of|fail(?:s|ed)? to|in contrast to|versus|\bvs\.?\b|other than|whereas)\b/i;

function fragmentStart(s: string): boolean {
  // Begins mid-clause: first alphabetic char is lowercase, OR opens with a continuation word.
  const t = s.trimStart();
  if (/^[a-z]/.test(t)) return true;
  if (
    /^(?:were|was|are|is|been|being|and|but|or|nor|which|that|who|whose|whom|revealing|showing|measuring|comparing|including|yielding|demonstrating|suggesting|indicating|resulting)\b/i.test(
      t,
    )
  )
    return true;
  return false;
}

type Row = {
  id: number;
  cwid: string;
  familyLabel: string;
  supercategory: string;
  familyPmidCount: number;
  tool: string;
  salienceTier: string | null;
  toolPubCount: number;
  snippet: string;
  sourcePmid: string | null;
  // lever signals:
  fragmentStart: boolean; // lever #1
  namesTool: boolean; // lever #2 precondition
  namePosition: number | null; // lever #2/#4 (0=name at very start … 1=name at end; null=not named)
  foilCueNearby: boolean; // lever #4 (foil)
  // dedupe (filled in a second pass):
  snippetReuse?: { rows: number; families: number; tools: number; scholars: number };
};

const rows: Row[] = [];
for (const w of writes as ScholarFamilyWrite[]) {
  const famPmids = new Set(w.pmids);
  for (const tool of w.exemplarTools) {
    const snippet = w.exemplarContexts[tool];
    if (!snippet) continue; // only exemplars that actually carry a snippet
    // map name -> id (pick the id whose production snippet matches; handles rare name collisions)
    const candidateIds = idsByName.get(tool) ?? [];
    let chosenId: string | null = null;
    let sourcePmid: string | null = null;
    for (const id of candidateIds) {
      const best = selectBestSnippet(toolContext, id, {
        displayName: tool,
        scholarPmids: famPmids,
      });
      if (best && best.context === snippet) {
        chosenId = id;
        sourcePmid = best.pmid;
        break;
      }
    }
    const meta = chosenId ? toolById.get(chosenId) : undefined;
    const forms = salientNameForms(tool);
    const lower = snippet.toLowerCase();
    let firstIdx = -1;
    for (const f of forms) {
      const idx = lower.indexOf(f);
      if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
    }
    rows.push({
      id: rows.length,
      cwid: w.cwid,
      familyLabel: w.familyLabel,
      supercategory: w.supercategory,
      familyPmidCount: w.pmidCount,
      tool,
      salienceTier: meta?.tier ?? null,
      toolPubCount: meta?.pubCount ?? 0,
      snippet,
      sourcePmid,
      fragmentStart: fragmentStart(snippet),
      namesTool: firstIdx >= 0,
      namePosition:
        firstIdx >= 0 ? Number((firstIdx / Math.max(1, snippet.length)).toFixed(3)) : null,
      foilCueNearby: FOIL_RE.test(snippet),
    });
  }
}

// ---- dedupe pass: snippet reuse across families / tools / scholars ----
const byNorm = new Map<string, Row[]>();
for (const r of rows) {
  const key = r.snippet.toLowerCase().replace(/\s+/g, " ").trim();
  (byNorm.get(key) ?? byNorm.set(key, []).get(key)!).push(r);
}
for (const [, group] of byNorm) {
  const reuse = {
    rows: group.length,
    families: new Set(group.map((g) => `${g.supercategory}::${g.familyLabel}`)).size,
    tools: new Set(group.map((g) => g.tool)).size,
    scholars: new Set(group.map((g) => g.cwid)).size,
  };
  for (const r of group) r.snippetReuse = reuse;
}

fs.writeFileSync("/tmp/methodcontext-eval-dataset.json", JSON.stringify(rows, null, 2));

// ---- build the JUDGE sample: tier-stratified + scholar round-robin, anchors pinned ----
const PER_TIER = 50;
function stratifiedSample(): Row[] {
  const picked = new Map<number, Row>();
  // 1) pin anchor rows (known wins/failures) regardless of tier quota.
  for (const r of rows) if (ANCHOR_TOOLS.has(r.tool.toLowerCase())) picked.set(r.id, r);
  // 2) per tier, round-robin across scholars for spread, deterministic order.
  for (const tier of ["S", "A", "B", "C", "(null)"]) {
    const tierRows = rows.filter((r) => (r.salienceTier ?? "(null)") === tier);
    const byScholar = new Map<string, Row[]>();
    for (const r of tierRows)
      (byScholar.get(r.cwid) ?? byScholar.set(r.cwid, []).get(r.cwid)!).push(r);
    const queues = [...byScholar.values()];
    let added = [...picked.values()].filter((r) => (r.salienceTier ?? "(null)") === tier).length;
    let i = 0;
    while (added < PER_TIER && queues.some((q) => q.length > 0)) {
      const q = queues[i % queues.length];
      const r = q.shift();
      if (r && !picked.has(r.id)) {
        picked.set(r.id, r);
        added += 1;
      }
      i += 1;
      if (i > tierRows.length * 2 + queues.length) break; // safety
    }
  }
  return [...picked.values()].sort((a, b) => a.id - b.id);
}
const sample = stratifiedSample();
// Blind judge view: snippet + context fields ONLY, mechanical lever flags WITHHELD
// (so judge verdicts are an unbiased ground truth to measure each lever against).
const judgeView = sample.map((r) => ({
  id: r.id,
  cwid: r.cwid,
  tool: r.tool,
  familyLabel: r.familyLabel,
  supercategory: r.supercategory,
  salienceTier: r.salienceTier,
  toolPubCount: r.toolPubCount,
  snippet: r.snippet,
}));
fs.writeFileSync("/tmp/methodcontext-eval-sample.json", JSON.stringify(judgeView, null, 2));

// ---- summary ----
const tierHist: Record<string, number> = {};
for (const r of rows)
  tierHist[r.salienceTier ?? "(null)"] = (tierHist[r.salienceTier ?? "(null)"] ?? 0) + 1;
const frag = rows.filter((r) => r.fragmentStart).length;
const foil = rows.filter((r) => r.foilCueNearby).length;
const notNamed = rows.filter((r) => !r.namesTool).length;
const dupRows = rows.filter((r) => (r.snippetReuse?.rows ?? 1) > 1).length;
const dupCrossFam = rows.filter((r) => (r.snippetReuse?.families ?? 1) > 1).length;

console.log(`\n${"=".repeat(80)}`);
console.log(
  `SNIPPET ROWS: ${rows.length}  (scholars=${new Set(rows.map((r) => r.cwid)).size}, families=${new Set(rows.map((r) => r.supercategory + "::" + r.familyLabel)).size})`,
);
console.log(`tier histogram:`, tierHist);
console.log(`fragmentStart (lever#1 candidate): ${frag}`);
console.log(`foilCueNearby  (lever#4 candidate): ${foil}`);
console.log(`NOT named by snippet (name-bias N/A): ${notNamed}`);
console.log(`reused snippet (dedupe candidate): rows=${dupRows}, cross-family rows=${dupCrossFam}`);
const sTier: Record<string, number> = {};
for (const r of sample)
  sTier[r.salienceTier ?? "(null)"] = (sTier[r.salienceTier ?? "(null)"] ?? 0) + 1;
console.log(
  `\nJUDGE SAMPLE: ${sample.length} rows  (scholars=${new Set(sample.map((r) => r.cwid)).size})  tiers:`,
  sTier,
);
console.log(
  `  sample fragmentStart=${sample.filter((r) => r.fragmentStart).length} foil=${sample.filter((r) => r.foilCueNearby).length} reused=${sample.filter((r) => (r.snippetReuse?.rows ?? 1) > 1).length} anchorsPinned=${sample.filter((r) => ANCHOR_TOOLS.has(r.tool.toLowerCase())).length}`,
);
console.log(
  `wrote /tmp/methodcontext-eval-dataset.json (full ${rows.length}) + /tmp/methodcontext-eval-sample.json (judge ${sample.length})`,
);
console.log(`${"=".repeat(80)}\n`);

// human-readable peek: a few rows per tier
const clip = (s: string, n = 180) => (s.length > n ? s.slice(0, n) + "…" : s);
for (const tier of ["S", "A", "B", "C", "(null)"]) {
  const sample = rows.filter((r) => (r.salienceTier ?? "(null)") === tier).slice(0, 4);
  if (!sample.length) continue;
  console.log(`\n--- tier ${tier} (showing ${sample.length}/${tierHist[tier]}) ---`);
  for (const r of sample) {
    const flags = [
      r.fragmentStart && "FRAG",
      r.foilCueNearby && "FOIL",
      !r.namesTool && "UNNAMED",
      (r.snippetReuse?.rows ?? 1) > 1 && `REUSE×${r.snippetReuse!.rows}`,
    ]
      .filter(Boolean)
      .join(",");
    console.log(
      `  ${r.cwid} · ${r.tool}  [${r.familyLabel}] pubN=${r.toolPubCount}${flags ? " {" + flags + "}" : ""}`,
    );
    console.log(`    → ${clip(r.snippet)}`);
  }
}
