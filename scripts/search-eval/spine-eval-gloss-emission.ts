// Extractor QA: how often does the LLM emit a gloss, and how far does it drift from the concept's
// own term? Bedrock only — no OpenSearch, no DB, no session cookie, so it runs from the laptop.
//
// Written to answer whether MATCHA_GLOSS_QUERY could matter. It could: 88% of concepts on the 15
// sponsor fixtures carry a gloss and 61% of those share NO token with their own term. That is why
// searching the gloss lost its A/B and the retrieval half was deleted (the gloss is display-only
// now). Kept because the same numbers are the QA signal for the gloss the RAIL shows: a gloss that
// shares no token with its concept is usually a borrowed or context-only gloss (#1799's failure
// mode), and this is how you catch a regression in that.
//
// Run: AWS_REGION=us-east-1 npx tsx scratch-gloss-divergence.ts <pastes.json> [label]
//   pastes.json = [{id, paste}]
import { readFileSync } from "node:fs";
import { extractMatchaConcepts } from "@/lib/api/matcha-extract";

const STOP = new Set(
  "the a an of for to in on and or with by from into via that this these those is are was were be as at we our their its it they research study studies work approach approaches context understanding versus using use based both across within through more most primary secondary".split(
    /\s+/,
  ),
);
const stem = (w: string) =>
  w.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/(ing|ed|ies|es|s)$/, "");
const toks = (s: string) =>
  new Set([...s.split(/[\s/,-]+/).map(stem)].filter((t) => t.length > 2 && !STOP.has(t)));

async function main() {
  const pastes: { id: string; paste: string }[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const label = process.argv[3] ?? "corpus";

  const perPaste: Record<string, unknown>[] = [];
  const diverging: Record<string, unknown>[] = [];
  let nConcepts = 0,
    nGlossed = 0,
    nInertPastes = 0,
    nEmpty = 0;

  for (const { id, paste } of pastes) {
    const { concepts } = await extractMatchaConcepts(paste);
    if (concepts.length === 0) {
      nEmpty++;
      console.error(`!! ${id}: 0 concepts (Bedrock unreachable or empty) — UNMEASURED, not zero`);
      continue;
    }
    nConcepts += concepts.length;
    const glossed = concepts.filter((c) => c.gloss);
    nGlossed += glossed.length;
    if (glossed.length === 0) nInertPastes++;

    for (const c of glossed) {
      // Per-MEMBER arms, which is the unit the spine actually maps over: each member token is
      // independently either replaced by (old) or joined with (new) its own gloss. `members`
      // does not exist pre-clustering (ExtractedConcept is {term, kind, centrality, gloss?}) —
      // clustering adds it — so the concept's own term IS the OFF query for its slot.
      const off = c.term;
      const on = c.gloss!;
      const offT = toks(off);
      const onT = toks(on);
      const added = [...onT].filter((t) => !offT.has(t));
      const dropped = [...offT].filter((t) => !onT.has(t));
      diverging.push({
        pasteId: id,
        term: c.term,
        offQuery: off,
        onQuery: on,
        addedTokens: added,
        // The sharp case: the ON query does not even contain the concept's own token, so BM25
        // moves off the concept entirely rather than merely narrowing it.
        droppedOwnTokens: dropped,
        losesOwnTerm: dropped.length > 0,
      });
    }

    perPaste.push({
      id,
      concepts: concepts.length,
      glossed: glossed.length,
      inert: glossed.length === 0,
    });
    console.error(`ok ${id}: ${concepts.length} concepts, ${glossed.length} glossed`);
  }

  const measured = pastes.length - nEmpty;
  console.log(
    JSON.stringify(
      {
        label,
        measuredPastes: measured,
        unmeasuredPastes: nEmpty,
        totalConcepts: nConcepts,
        glossedConcepts: nGlossed,
        pctConceptsGlossed: nConcepts ? +((100 * nGlossed) / nConcepts).toFixed(1) : null,
        // The headline: pastes where the flag provably cannot change retrieval at all.
        provablyInertPastes: nInertPastes,
        pctPastesInert: measured ? +((100 * nInertPastes) / measured).toFixed(1) : null,
        conceptsLosingOwnTerm: diverging.filter((d) => d.losesOwnTerm).length,
        perPaste,
        diverging,
      },
      null,
      2,
    ),
  );
}

void main();
