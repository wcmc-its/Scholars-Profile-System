# Handoff — evaluating the #1119 method tool-usage *snippet* approach (before more code)

**Goal of the next session:** look at many more real (scholar, method-family) examples and
**decide which calibration levers to adopt** for the tool-usage snippet, *then* write code.
This is a measurement/judgment phase, not an implementation phase. Pick scholars from the
home-page search suggestions (see below) so the sample matches what users actually search.

## Where things stand

- **PR #1122** (branch `feat/1119-tool-context`, open against `master`, CI green) ingests the
  ReciterAI `tool_context.json` artifact and surfaces a best per-(family, exemplar-tool) **usage
  snippet**. Everything is **dark** (flags off both envs; the snippet columns are NULL until the
  tools ETL runs).
- Two distinct `methodContext` things (don't conflate):
  1. **Indexed `methodContext` field** (`lib/search-index-docs.ts` → `lib/search.ts`) — used for
     **ranking only**, a scoring-only `should` clause behind `SEARCH_PEOPLE_METHOD_CONTEXT`. Never displayed.
  2. **`ExemplarResult.methodContext`** (`lib/api/method-exemplar.ts`) — the `{tool, context}` shown in the
     **expandable** method-match result card (`components/search/people-result-card.tsx`), "How *X* is used: …",
     behind `METHODS_LENS_TOOL_CONTEXT`. This is the user-facing **snippet** we're evaluating.
- The collapsed one-line evidence still shows family label + tool names (today's behavior). Whether the
  snippet should move onto that collapsed line is one of the open levers.

## The question we're calibrating

The snippet **clearly wins for opaque, specific tools** and **loses / adds noise for common methods**,
plus has extraction-quality issues. Confirmed against the live artifact for `imh2003`, `mog4005`, `chm2042`:

**Wins (name is meaningless without the snippet):**
- FEMI → "a foundation model trained on ~18 million time-lapse embryo images… ploidy prediction, blastocyst quality scoring…"
- wsPurity → "accurately quantify tumor purity within a digitally captured H&E stained histological slide"
- cloudrnaSPAdes → "assembling full-length isoforms from barcoded RNA-seq linked-read data in a reference-free fashion"
- NanoTemper Dianthus → "binding is detected as temperature-dependent fluorescence intensity changes… under an infrared-mediated thermal gradient"

**Failure modes (the cases that make it NOT trump the plain tool name):**
1. **Well-known method, name already clear** → snippet is one paper's result, not a definition.
   `Molecular docking` → "…revealing that A9 forms hydrophobic and hydrogen-bonding interactions within a defined pocket of the CHI3L1 structure". `RNA-seq` → "RNA-seq analysis of E. coli K12 revealed 447 differentially expressed genes…".
2. **Sentence fragment** (extraction starts mid-clause) → reads broken standalone.
   `AUC` → "**were compared measuring** accuracy and area under the receiver operating characteristic curve (AUC)".
3. **Redundant / duplicated** across exemplars and even across families (same sentence for TELL-Seq under "Next-gen sequencing" and LoopSeq under "Long-read sequencing").
4. **Tool named only as a foil** (sentence is about a *different* tool).
   `short-read methods` → "Novel-X finds many non-reference sequences that **cannot be found by** … short-read methods."

## Candidate levers (decide which to adopt → then code)

| Lever | Kills | Where it'd live |
|---|---|---|
| **Clean-sentence filter** — drop snippets that don't begin at a sentence boundary | #2 | pure mapper `etl/tools/tool-context.ts` (`selectBestSnippet`/junk filter) |
| **Subject-not-foil name-bias** — require the tool be the grammatical subject, not just present | #4 | `selectBestSnippet` name-bias pass |
| **Opaque-tool gating** — only surface a snippet when the tool name is non-obvious (low-frequency / not a well-known method); suppress for generic families | #1 + most noise | mapper + a "is this tool opaque?" signal (tier? frequency? family suppression already helps) |
| **Dedupe** across a family's exemplars (and the search blob) | #3 | family mapper `resolveExemplarContexts` / index build |
| **Display placement** — snippet stays in the expandable disclosure (label leads) vs. moves onto the collapsed evidence line | makes residual noise low-cost | `lib/api/result-evidence.ts` + `people-result-card.tsx` (+ `_source` if on the line) |

Mitigant already in place: **#800 suppression** hides the most generic families, so the worst #1 cases
(descriptive stats, etc.) never reach search — but common-yet-unsuppressed methods (molecular docking,
RNA-seq, virtual screening) still would.

## How to pick scholars (next session) — seed from the home "Try:" chips

The home-page suggestion chips are sampled from `lib/hero-search-suggestions.ts` (rendered by
`components/home/try-suggestions-chips.tsx` → `/search?q=<chip>`). Take the **method/tool-like** entries
(not the pure disease/topic ones) and resolve each to a representative scholar:

> CRISPR · Base & prime editing · Single-cell RNA sequencing · Spatial transcriptomics · Radiomics ·
> Mendelian randomization · Targeted protein degradation (PROTAC) · Patient-derived organoids ·
> Liquid biopsy · AAV gene therapy · mRNA vaccines · Antisense oligonucleotides · siRNA therapeutics ·
> CAR-T cell therapy · Bispecific antibodies · Antibody-drug conjugates · Oncolytic virotherapy ·
> Exosomes · Deep brain stimulation · Transcatheter aortic valve replacement · Fecal microbiota transplantation

For each query term, find families whose **label** or an **exemplar tool name** matches, then pick the
top scholars by `pmidCount` — that approximates who'd rank for the home-page search. (Goal: ~15–20
(scholar, family) rows spanning specific↔generic so we see wins and failures across real search entry points.)

## Reproduction recipe (no DB writes — reconstruct from the artifact)

The DB columns aren't populated, so reconstruct with the **real pure mappers** against the live artifact.
Needs a checkout of `feat/1119-tool-context` with `node_modules` + `npx tsx` (e.g. the worktree
`~/worktrees/sps-1119`, or `git worktree add … origin/feat/1119-tool-context` + CoW-clone node_modules).

```bash
# 1) artifact (S3, ~25MB; version v2026-06-13)
aws s3 cp s3://wcmc-reciterai-artifacts/tools/latest/tools.json        /tmp/tools.json          # sha256 aeb0a8f1…
aws s3 cp s3://wcmc-reciterai-artifacts/tools/latest/tool_context.json /tmp/tool_context.json   # sha256 bbd212ed…
# 2) run the eval harness (below)
npx tsx scripts/methodcontext-eval.ts imh2003 mog4005 chm2042          # explicit cwids, or:
npx tsx scripts/methodcontext-eval.ts --query "CRISPR" "spatial transcriptomics"   # resolve via home suggestions
```

Eval harness (recreate as `scripts/methodcontext-eval.ts`; uses the production mappers verbatim):

```ts
import fs from "node:fs";
import { buildToolContextIndex } from "../etl/tools/tool-context";
import { buildScholarFamilyWritesFromS3, type ScholarFamilyWrite } from "../etl/tools/scholar-family-mapper-s3";
import type { ToolsArtifactSlice } from "../etl/tools/scholar-tool-mapper-s3";

const tools = JSON.parse(fs.readFileSync("/tmp/tools.json", "utf8"));
const ctx = JSON.parse(fs.readFileSync("/tmp/tool_context.json", "utf8"));
const artifact: ToolsArtifactSlice = { tools: tools.tools, faculty: tools.faculty };
const toolContext = buildToolContextIndex(ctx.tool_context);

const args = process.argv.slice(2);
let cwids: string[];
if (args[0] === "--query") {
  // Resolve each home-suggestion term → families whose label / exemplar-tool name matches,
  // then the top scholars by pub_count in those families.
  const terms = args.slice(1).map((t) => t.toLowerCase());
  const toolName = new Map<string, string>();
  for (const t of tools.tools) if (t?.canonical_tool_id && t?.display_name) toolName.set(t.canonical_tool_id, String(t.display_name));
  const hits = new Map<string, number>(); // cwid -> best pub_count among matching families
  for (const [cwid, f] of Object.entries(tools.faculty as Record<string, { families?: any[] }>)) {
    for (const fam of f.families ?? []) {
      const label = String(fam.label ?? "").toLowerCase();
      const exNames = (fam.exemplar_tool_ids ?? []).map((id: string) => (toolName.get(id) ?? "").toLowerCase());
      const match = terms.some((term) => label.includes(term) || exNames.some((n: string) => n.includes(term)));
      if (match) hits.set(cwid, Math.max(hits.get(cwid) ?? 0, fam.pub_count ?? 0));
    }
  }
  cwids = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
  console.log("resolved cwids:", cwids.join(", "));
} else {
  cwids = args.length ? args : ["imh2003"];
}

const { writes } = buildScholarFamilyWritesFromS3(artifact, { ourCwidSet: new Set(cwids), toolContext });
const byCwid = new Map<string, ScholarFamilyWrite[]>();
for (const w of writes) (byCwid.get(w.cwid) ?? byCwid.set(w.cwid, []).get(w.cwid)!).push(w);
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);
for (const cwid of cwids) {
  const fams = (byCwid.get(cwid) ?? []).slice(0, 8);
  console.log(`\n${"=".repeat(90)}\nSCHOLAR ${cwid} — top ${fams.length} of ${(byCwid.get(cwid) ?? []).length} families`);
  for (const f of fams) {
    console.log(`\n  ▸ ${f.familyLabel} [${f.supercategory}] (${f.pmidCount} pubs)`);
    console.log(`    TODAY: ${f.exemplarTools.join(" · ") || "(no exemplar tools)"}`);
    const e = Object.entries(f.exemplarContexts);
    if (!e.length) console.log("    NEW: (none)");
    else for (const [tool, snip] of e) console.log(`    NEW · ${tool}: ${clip(snip)}`);
  }
}
```

## Key files

- Pure best-snippet logic: `etl/tools/tool-context.ts` (junk filter, name-bias, longest, clamp) — **where levers #1/#2/#4 land**.
- Family resolution: `etl/tools/scholar-family-mapper-s3.ts` (`resolveExemplarContexts`).
- Search index field: `lib/search-index-docs.ts` (`methodContext` build) + `lib/search.ts` (mapping + boosts).
- Search ranking use: `lib/api/search.ts` (scoring-only `should`).
- Display: `lib/api/method-exemplar.ts` (`pickMethodContext`) + `components/search/people-result-card.tsx`.
- Flags: `lib/profile/methods-lens-flags.ts`, `lib/api/search-flags.ts`.
- Rollout: `docs/tool-context-rollout.md`. Issue **#1119**, PR **#1122**. Lineage: `docs/search-snippet-handoff.md` (#967/#1056, #1060 method-exemplar hover).

## Caveats for the analyst
- Reconstruction shows ALL families incl. ones #800 would suppress in prod (so some weak rows wouldn't reach search).
- Aurora MySQL re-sorts JSON object keys on storage; read paths order off the `exemplarTools` array, not `exemplar_contexts` key order (already handled).
- Deferred review finding (pre-flip): the snippet bypasses per-pub ADR-005 suppression immediacy (source pmid not stored) — see rollout doc.
- Decide the levers FIRST; then implement in the pure mapper with unit tests (cheap to test, no DB).
