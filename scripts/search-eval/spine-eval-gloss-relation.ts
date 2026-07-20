// Extractor QA: WHAT KIND of relation does each gloss bear to its own concept term, and how
// often is a concept a CONJUNCTION that MeSH cannot express as one descriptor?
//
// Supersedes the token-overlap measure in `spine-eval-gloss-emission.ts`, which could only say
// "these strings differ" — a scalar that CONFLATES the two cases you must tell apart. A gloss
// that NARROWS its term ("pediatric glioma" under "glioma") is the valuable case; a gloss that
// borrows a neighbour's context is #1799's failure mode. Both score "divergent". Only a TYPED
// relation routes them differently:
//
//   direct         gloss restates the term            → adds nothing
//   narrower       gloss is a SUBTYPE of the term     → a real restriction; the useful case
//   broader        gloss is a SUPERTYPE of the term   → dilution (the #1814 gloss-query failure)
//   related        adjacent, not containment          → borrowed/context-only; the rail should omit
//   conjunction    an INTERSECTION of 2+ concepts     → MeSH cannot pre-coordinate this
//
// WHY THIS IS CHECKABLE, unlike a similarity score. `narrower`/`broader` are MeSH's own tree
// relations, so the taxonomy is an INDEPENDENT ORACLE for them: containment is a tree-number
// prefix test on a dot boundary (NOT `descendantUis` — see `treeNumbersOf` for why that is a trap).
// We report the LLM/tree agreement rate rather than ASSUMING, either way, whether a model can
// grade its own output. Set GLOSS_RELATION_MODEL to grade with a different model than the one
// that wrote the gloss and compare the two rates — that is the empirical form of that question,
// and it is cheap enough that there is no reason to argue it instead.
//
// The oracle has ONE structural blind spot, and it is the interesting one. MeSH is FACETED:
// "pediatric glioma" is not a descriptor, it is post-coordinated from Glioma (C04, disease axis)
// + Child (M01, population axis). There is NO tree path between them, so a naive check would
// score a correct `narrower` call as wrong. Hence `conjunction` is its own label AND its own
// oracle outcome, detected by the components resolving to DIFFERENT top-level branches.
//
// This matters beyond labelling. The spine RRF-fuses per-concept rankings weighted by
// `centrality ** 3` (CENTRALITY_GAMMA, matcha-contract.ts:142). Split "pediatric glioma" into
// glioma@1.0 + child@0.4 and the qualifying axis carries 0.4**3 = 0.064 of the weight — against
// a K=30 RRF term, a contribution too small to reorder anything. A conjunctive ask is decided
// almost entirely by whichever half the extractor scored 1.0. `splitConjunctions` below measures
// how often that happens in practice; it is the number that says whether that is a live defect.
//
// Bedrock + the taxonomy tables. No OpenSearch, no session cookie, no deployed env.
//
// Run: AWS_REGION=us-east-1 npx tsx scripts/search-eval/spine-eval-gloss-relation.ts <pastes.json> [label]
//   pastes.json = [{id, paste}]  (e.g. spine-eval-divergent-pastes.json)
import { readFileSync } from "node:fs";
import { generateObject } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { z } from "zod";
import {
  extractMatchaConcepts,
  EXTRACT_MODEL,
  EXTRACT_MAX_TOKENS,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_TEMPERATURE,
  buildExtractPrompt,
} from "@/lib/api/matcha-extract";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { prisma } from "@/lib/db";

// The AI SDK writes its warning banner to STDOUT, which corrupts the JSON document this script
// emits there — a complete run that will not parse. Silence it rather than asking every caller to
// remember a redirect.
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

// ponytail: fourth copy of this factory. `matcha-extract.ts:115` already notes "no shared export
// exists to import"; a QA script is not the reason to introduce one.
const bedrock = () =>
  createAmazonBedrock({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentialProvider: fromNodeProviderChain(),
  });

const RELATIONS = ["direct", "narrower", "broader", "related", "conjunction"] as const;

const RelationSchema = z.object({
  judgments: z.array(
    z.object({
      term: z.string(),
      relation: z.enum(RELATIONS),
      // The components ONLY when relation is `conjunction` — each should be independently
      // MeSH-resolvable, which is what makes the cross-axis oracle check possible.
      components: z.array(z.string()).nullish(),
      why: z.string(),
    }),
  ),
  // Conjunctions the EXTRACTOR broke apart: one phrase in the source that arrived as 2+ separate
  // concepts. This is the γ=3 flattening case and it is invisible from the concept list alone,
  // which is why the source paste is in the prompt.
  splitConjunctions: z.array(
    z.object({ sourcePhrase: z.string(), splitInto: z.array(z.string()) }),
  ),
});

// Direction is PINNED in the label text, deliberately clumsily. "Subtype" alone is ambiguous
// about which side is narrower, and that ambiguity would silently invert the retrieval decision
// the whole measurement exists to inform.
const RELATION_SYSTEM_PROMPT = [
  "You classify the RELATION between a research CONCEPT TERM and its GLOSS — the funder's own",
  "words for what they meant by that term. Both come from the same funding description.",
  "",
  "For each concept, return exactly one relation:",
  '  "direct"       — the gloss restates the term; same scope, different words.',
  '  "narrower"     — the GLOSS IS NARROWER THAN THE TERM. The gloss restricts it to a subtype,',
  "                   population, site, or stage. Example: term \"glioma\", gloss \"pediatric",
  '                   glioma" — the gloss admits strictly fewer things than the term.',
  '  "broader"      — the GLOSS IS BROADER THAN THE TERM. The gloss generalizes it to a parent',
  "                   category. The gloss admits strictly MORE things than the term.",
  '  "related"      — adjacent but NOT containment. The gloss describes something the concept is',
  "                   used for, occurs in, or sits beside — a neighbour, a setting, a consequence",
  "                   — rather than characterizing the concept itself. If the gloss would make",
  "                   sense as a description of a DIFFERENT concept in the same description, it is",
  '                   "related", not "narrower".',
  '  "conjunction"  — the concept (or gloss) is an INTERSECTION of two or more distinct concepts',
  "                   that a single medical-subject-heading cannot express: a disease crossed with",
  '                   a population, a method crossed with a disease, and so on. "pediatric glioma"',
  '                   = glioma × childhood. "health equity in cancer screening" = health equity ×',
  "                   early detection of cancer. When you use this, list the components — each one",
  "                   must be independently lookup-able as a standard medical subject heading.",
  "",
  'Prefer "conjunction" over "narrower" when the restriction comes from a DIFFERENT axis (a',
  "population, a setting, a time period) rather than from being a kind-of the term. A childhood",
  "cancer is not a kind of cancer in the way that an astrocytoma is.",
  "",
  "Also report SPLIT CONJUNCTIONS: places where the ORIGINAL DESCRIPTION contained one",
  "intersectional phrase that has arrived in the concept list as two or more SEPARATE concepts.",
  'Report the source phrase and the concepts it became. If there are none, return an empty list.',
  "",
  "Judge only what the text supports. Do not invent a relation for a gloss that is absent.",
].join("\n");

const GRADER_MODEL =
  process.env.GLOSS_RELATION_MODEL ??
  process.env.MATCHA_EXTRACT_MODEL ??
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

/** Resolve a surface form the way the SPINE does, so the oracle judges the descriptor Matcha
 *  would actually have used. `descendantUis` is precomputed prefix-subsumption (search-taxonomy
 *  :167-174) and always leads with the descriptor itself — so containment is a set membership
 *  test and no tree-number string surgery is needed. */
async function resolve(term: string) {
  const res = (await matchQueryToTaxonomy(term)).meshResolution;
  if (!res?.descriptorUi) return null;
  return { ui: res.descriptorUi, name: res.name, treeNumbers: await treeNumbersOf(res.descriptorUi) };
}

/**
 * Tree numbers straight off the descriptor row.
 *
 * NOT `MeshResolution.descendantUis`, which looks like the obvious containment test and is a trap:
 * it is bounded by DESCENDANT_HARD_CAP = 200 (search-taxonomy:167-174), so a broad descriptor
 * silently omits most of its subtree. `Neoplasms` does not list `Glioma`. Testing containment by
 * membership there produces FALSE AGREEMENTS — the oracle would rubber-stamp a wrong `broader`
 * call because it could not see the relation it was asked about. The selftest below pins this.
 */
async function treeNumbersOf(ui: string): Promise<string[]> {
  const row = await prisma.meshDescriptor.findUnique({
    where: { descriptorUi: ui },
    select: { treeNumbers: true },
  });
  const tns = Array.isArray(row?.treeNumbers) ? row.treeNumbers : [];
  return tns.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/** MeSH containment: a descendant's tree number is PREFIXED by its ancestor's, on a DOT boundary.
 *  The boundary matters — "C04.5" must not read as an ancestor of "C04.55". Uncapped, unlike
 *  `descendantUis`. */
const isUnder = (childTns: string[], parentTns: string[]) =>
  childTns.some((c) => parentTns.some((p) => c !== p && c.startsWith(`${p}.`)));

/** Top-level MeSH axis = the leading letter of a tree number (C = Diseases, M = Named Groups,
 *  E = Techniques…). Two descriptors on different letters can never be ancestor/descendant — which
 *  is exactly why "pediatric glioma" (C04 × M01) has no tree path and cannot be a subtype.
 *  `MeshResolution` carries no tree numbers, so this reads them straight off the descriptor row. */
const axesOf = (treeNumbers: string[]) => new Set(treeNumbers.map((t) => t.slice(0, 1)));

/**
 * The oracle. Returns `null` — NOT a disagreement — whenever the tree genuinely has no opinion.
 * An unresolvable phrase and a cross-axis pair are both "cannot decide"; scoring those as the
 * model being wrong is how you manufacture a bad agreement rate and reject a working classifier.
 * That distinction is the whole reason this is a calibration instrument rather than a scold.
 */
async function adjudicate(term: string, gloss: string | null, relation: string, components: string[] | null) {
  if (relation === "conjunction") {
    if (!components || components.length < 2) return null;
    const resolved = (await Promise.all(components.map(resolve))).filter((r) => r !== null);
    if (resolved.length < 2) return null;
    // Two independent confirmations, and they can disagree with each other:
    //  - cross-axis (different top-level branches) ⇒ genuinely un-pre-coordinatable
    //  - NOT containment ⇒ if one component subsumes the other it is a subtype, not a conjunction
    const axes = axesOf(resolved.flatMap((r) => r.treeNumbers));
    const [a, b] = resolved;
    const contained = isUnder(a.treeNumbers, b.treeNumbers) || isUnder(b.treeNumbers, a.treeNumbers);
    if (contained) return { verdict: "disagree", detail: `${a.ui}/${b.ui} are ancestor-descendant` };
    return {
      verdict: axes.size > 1 ? "agree" : "indecisive",
      detail: `axes=${[...axes].sort().join(",")}`,
    };
  }
  if (relation !== "narrower" && relation !== "broader") return null;
  if (!gloss) return null;
  // A gloss is prose and usually will NOT resolve to a heading — that is the faceted blind spot,
  // reported as indecisive rather than counted against the model.
  const [t, g] = await Promise.all([resolve(term), resolve(gloss)]);
  if (!t || !g || t.ui === g.ui) return null;
  const glossUnderTerm = isUnder(g.treeNumbers, t.treeNumbers);
  const termUnderGloss = isUnder(t.treeNumbers, g.treeNumbers);
  if (!glossUnderTerm && !termUnderGloss) {
    return { verdict: "indecisive", detail: `${t.ui} and ${g.ui} unrelated in-tree` };
  }
  const truth = glossUnderTerm ? "narrower" : "broader";
  return { verdict: truth === relation ? "agree" : "disagree", detail: `tree says ${truth}` };
}

// ── Gate 0: can the EXTRACTOR emit its own coordinations? ────────────────────────────────────
//
// The relation run above proves an INDEPENDENT GRADER can identify coordinations. That is a
// DIFFERENT claim from the one the conjunction-weighting spec rests on, which is that the
// extractor can mark them in the call it already makes. Gate 0 measures the second.
//
// It runs the REAL extractor prompt (imported, never copied — a duplicated prompt would drift and
// then this would measure a prompt nobody ships) plus an addendum, against an augmented schema.
// Production `ConceptsSchema` is untouched: the gate decides whether to change it.

const GROUP_ADDENDUM = [
  "",
  "Finally, mark COORDINATIONS. Sometimes ONE phrase in the description names an intersection that",
  "no single medical subject heading can express — a disease crossed with a population, a method",
  "crossed with a disease, an outcome crossed with a setting. You will have returned its parts as",
  "SEPARATE concepts, because each part is separately looked up. Keep doing that.",
  "",
  "But also give every concept that came from ONE such phrase the SAME `coordinateGroup` label — a",
  "short slug naming the joint idea. Concepts that did not come from an intersectional phrase get",
  "no `coordinateGroup` at all.",
  "",
  'Example: "cognitive decline in older adults" yields concepts "cognitive decline" and "aged",',
  'both with coordinateGroup "cognitive-decline-in-aging". A concept merely mentioned nearby is NOT',
  "part of the coordination — only the parts of that one phrase.",
  "",
  "Most descriptions contain few or no coordinations. Do not manufacture them.",
].join("\n");

const GroupedConceptsSchema = z.object({
  concepts: z.array(
    z.object({
      term: z.string(),
      centrality: z.number(),
      gloss: z.string().nullish(),
      coordinateGroup: z.string().nullish(),
    }),
  ),
});

/** Normalize for comparing a grader's component phrase against an extractor's term. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function gate0(pastes: { id: string; paste: string }[]) {
  let graderCoordinations = 0,
    matched = 0,
    extractorGroups = 0,
    extractorGroupsCorroborated = 0;
  const detail: Record<string, unknown>[] = [];

  for (const { id, paste } of pastes) {
    // The extractor's own attempt, real prompt + addendum.
    let grouped;
    try {
      grouped = (
        await generateObject({
          model: bedrock()(EXTRACT_MODEL),
          schema: GroupedConceptsSchema,
          system: EXTRACT_SYSTEM_PROMPT + GROUP_ADDENDUM,
          prompt: buildExtractPrompt(paste),
          maxOutputTokens: EXTRACT_MAX_TOKENS * 2, // the addendum widens the output
          abortSignal: AbortSignal.timeout(60_000),
          temperature: EXTRACT_TEMPERATURE,
        })
      ).object;
    } catch (err) {
      console.error(`!! ${id}: grouped extraction failed — ${String(err)} — UNMEASURED`);
      continue;
    }

    // The grader must judge THE SAME concept list the grouped call produced. Grading a separate
    // production extraction instead compares two independently-generated vocabularies by string
    // equality — the extractor says "aged", the other call says "older adults", and a CORRECT
    // grouping scores zero. That flaw produced a 0% false negative on the first run of this gate.
    const concepts = grouped.concepts;
    if (concepts.length === 0) {
      console.error(`!! ${id}: 0 concepts — UNMEASURED`);
      continue;
    }
    const judged = (
      await generateObject({
        model: bedrock()(GRADER_MODEL),
        schema: RelationSchema,
        system: RELATION_SYSTEM_PROMPT,
        prompt: [
          "ORIGINAL DESCRIPTION:",
          paste,
          "",
          "CONCEPTS EXTRACTED FROM IT:",
          ...concepts.map((c) => `- term: ${c.term}\n  gloss: ${c.gloss ?? "(none)"}`),
        ].join("\n"),
        abortSignal: AbortSignal.timeout(60_000),
        temperature: 0,
      })
    ).object;

    // Extractor groups, as sets of normalized terms.
    const byGroup = new Map<string, Set<string>>();
    for (const c of grouped.concepts) {
      if (!c.coordinateGroup) continue;
      const g = byGroup.get(c.coordinateGroup) ?? new Set<string>();
      g.add(norm(c.term));
      byGroup.set(c.coordinateGroup, g);
    }
    // A "group" of one is not a coordination — it is a stray label.
    const realGroups = [...byGroup.entries()].filter(([, m]) => m.size >= 2);
    extractorGroups += realGroups.length;

    // RECALL: for each coordination the grader found, did the extractor co-group its parts?
    // Counted per split the grader reported, since that is the case the spec's weighting fixes.
    // A "split" with one member is not a split. The grader emits these; counting them inflates the
    // denominator with cases that can never match, since a group needs >=2 members by definition.
    for (const s of judged.splitConjunctions.filter((x) => x.splitInto.length >= 2)) {
      graderCoordinations++;
      const want = s.splitInto.map(norm);
      const hit = realGroups.some(([, m]) => want.filter((w) => m.has(w)).length >= 2);
      if (hit) matched++;
      detail.push({ pasteId: id, sourcePhrase: s.sourcePhrase, splitInto: s.splitInto, grouped: hit });
    }
    // PRECISION: does each extractor group correspond to something the grader saw as joint?
    const graderJoint = judged.splitConjunctions
      .filter((s) => s.splitInto.length >= 2)
      .map((s) => s.splitInto.map(norm));
    for (const [label, m] of realGroups) {
      const ok = graderJoint.some((j) => j.filter((w) => m.has(w)).length >= 2);
      if (ok) extractorGroupsCorroborated++;
      else detail.push({ pasteId: id, extractorOnlyGroup: label, members: [...m] });
    }
    console.error(`ok ${id}: extractor groups=${realGroups.length}, grader splits=${judged.splitConjunctions.length}`);
  }

  const recallPct = graderCoordinations ? +((100 * matched) / graderCoordinations).toFixed(1) : null;
  const precisionPct = extractorGroups
    ? +((100 * extractorGroupsCorroborated) / extractorGroups).toFixed(1)
    : null;
  console.log(
    JSON.stringify(
      {
        gate: "0 — extractor self-emitted coordinations",
        extractModel: EXTRACT_MODEL,
        graderModel: GRADER_MODEL,
        graderCoordinations,
        matchedByExtractor: matched,
        // THE GATE. Spec threshold: stop below 70%. Reweighting on a signal the producer cannot
        // emit reliably moves rankings for the WRONG asks, which is worse than not reweighting.
        recallPct,
        extractorGroups,
        extractorGroupsCorroborated,
        precisionPct,
        detail,
      },
      null,
      2,
    ),
  );
}

/**
 * The oracle is the only part of this script that can be silently WRONG rather than loudly
 * broken — a bad axis or containment rule still emits a plausible agreement rate. Costs one DB
 * round-trip and no Bedrock call.
 *
 *   npx tsx scripts/search-eval/spine-eval-gloss-relation.ts --selftest
 */
async function selftest() {
  const glioma = await resolve("glioma");
  const child = await resolve("child");
  const neoplasms = await resolve("neoplasms");
  if (!glioma || !child || !neoplasms) throw new Error("selftest: taxonomy unreachable");

  // Cross-axis: Glioma is C04 (disease), Child is M01 (named group). No tree path — this is the
  // faceted case the whole `conjunction` label exists for.
  const crossAxis = axesOf([...glioma.treeNumbers, ...child.treeNumbers]);
  if (crossAxis.size < 2) throw new Error(`selftest: expected cross-axis, got ${[...crossAxis]}`);

  // Containment must hold in exactly ONE direction, or `narrower`/`broader` are interchangeable
  // and the oracle would rubber-stamp both.
  // Neoplasms is exactly the descriptor whose `descendantUis` is truncated by the 200-cap, so this
  // pair is the regression guard against ever "simplifying" back to a membership test.
  if (!isUnder(glioma.treeNumbers, neoplasms.treeNumbers)) throw new Error("selftest: glioma ⊄ neoplasms");
  if (isUnder(neoplasms.treeNumbers, glioma.treeNumbers)) throw new Error("selftest: containment symmetric");

  // Same-axis components are NOT evidence of a conjunction — must decline, not agree.
  const sameAxis = await adjudicate("glioma", null, "conjunction", ["glioma", "neoplasms"]);
  if (sameAxis?.verdict !== "disagree") throw new Error(`selftest: ancestor pair → ${sameAxis?.verdict}`);

  console.error("selftest OK — cross-axis, one-way containment, ancestor-pair rejection");
}

async function main() {
  if (process.argv[2] === "--selftest") {
    await selftest();
    await prisma.$disconnect();
    process.exit(0);
  }
  if (process.argv[2] === "--gate0") {
    await gate0(JSON.parse(readFileSync(process.argv[3], "utf8")));
    await prisma.$disconnect();
    process.exit(0);
  }
  const pastes: { id: string; paste: string }[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const label = process.argv[3] ?? "corpus";

  const perConcept: Record<string, unknown>[] = [];
  const splits: Record<string, unknown>[] = [];
  const relationCounts: Record<string, number> = Object.fromEntries(RELATIONS.map((r) => [r, 0]));
  let nConcepts = 0,
    nGlossed = 0,
    nEmpty = 0,
    nUngradable = 0;

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

    let judged;
    try {
      judged = (
        await generateObject({
          model: bedrock()(GRADER_MODEL),
          schema: RelationSchema,
          system: RELATION_SYSTEM_PROMPT,
          prompt: [
            "ORIGINAL DESCRIPTION:",
            paste,
            "",
            "CONCEPTS EXTRACTED FROM IT:",
            ...concepts.map(
              (c) => `- term: ${c.term}${c.gloss ? `\n  gloss: ${c.gloss}` : "\n  gloss: (none)"}`,
            ),
          ].join("\n"),
          abortSignal: AbortSignal.timeout(60_000),
          temperature: 0,
        })
      ).object;
    } catch (err) {
      // Same posture as the extractor: a grader failure is UNMEASURED, never a zero. Scoring a
      // Bedrock blip as "no conjunctions found" would understate the exact thing we are counting.
      nUngradable += concepts.length;
      console.error(`!! ${id}: grader failed — ${String(err)} — UNMEASURED`);
      continue;
    }

    for (const j of judged.judgments) {
      relationCounts[j.relation] = (relationCounts[j.relation] ?? 0) + 1;
      const src = concepts.find((c) => c.term === j.term);
      const oracle = await adjudicate(j.term, src?.gloss ?? null, j.relation, j.components ?? null);
      perConcept.push({
        pasteId: id,
        term: j.term,
        gloss: src?.gloss ?? null,
        centrality: src?.centrality ?? null,
        relation: j.relation,
        components: j.components ?? null,
        why: j.why,
        oracle,
      });
    }
    for (const s of judged.splitConjunctions) {
      // The γ=3 cost, made concrete per split: the weight the qualifying axis actually carries.
      const weights = s.splitInto.map((t) => {
        const c = concepts.find((x) => x.term === t);
        return { term: t, centrality: c?.centrality ?? null, weight: c ? c.centrality ** 3 : null };
      });
      splits.push({ pasteId: id, sourcePhrase: s.sourcePhrase, splitInto: weights });
    }
    console.error(`ok ${id}: ${concepts.length} concepts, ${judged.splitConjunctions.length} splits`);
  }

  const oracled = perConcept.filter((p) => p.oracle !== null);
  const decisive = oracled.filter(
    (p) => (p.oracle as { verdict: string }).verdict !== "indecisive",
  );
  const agreed = decisive.filter((p) => (p.oracle as { verdict: string }).verdict === "agree");

  console.log(
    JSON.stringify(
      {
        label,
        graderModel: GRADER_MODEL,
        measuredPastes: pastes.length - nEmpty,
        unmeasuredPastes: nEmpty,
        ungradableConcepts: nUngradable,
        totalConcepts: nConcepts,
        glossedConcepts: nGlossed,
        relationCounts,
        // The headline. A high split rate means the γ=3 flattening is live in production on
        // every intersectional ask — a bigger finding than the gloss-display question.
        splitConjunctions: splits.length,
        conjunctionConcepts: relationCounts.conjunction,
        // Agreement is reported over the DECISIVE subset only, with the indecisive count beside
        // it. A denominator that silently includes "the tree had no opinion" is not an accuracy.
        oracleDecisive: decisive.length,
        oracleAgreed: agreed.length,
        oracleAgreementPct: decisive.length
          ? +((100 * agreed.length) / decisive.length).toFixed(1)
          : null,
        oracleIndecisive: oracled.length - decisive.length,
        splits,
        perConcept,
      },
      null,
      2,
    ),
  );

  // MUST exit explicitly: the Prisma pool holds the event loop open and the process would hang
  // after the JSON is written — the same trap the in-VPC spine-eval runner documents.
  await prisma.$disconnect();
  process.exit(0);
}

void main();
