/**
 * Run the #742 overview-statement generator over a small, deliberately varied
 * faculty sample and write a results doc for the operator to grade — the SPEC's
 * gated "Validation run (build gate — do this first)".
 *
 *   npm run edit:overview-validate -- --dry-run    # assemble facts + print the
 *                                                  # prompt; NO Bedrock call, no
 *                                                  # AWS credentials needed
 *   npm run edit:overview-validate                 # live run — calls Claude on
 *                                                  # Bedrock with your AWS creds
 *   npm run edit:overview-validate -- --cwids abc1234,def5678   # override sample
 *
 * This proves the metadata-grounded approach produces publishable quality
 * (exercising the prompt, voice, length, and faithfulness guards) on a varied
 * sample, at the cost of ~5 LLM calls and ZERO DB writes — the script never
 * touches `field_override`; it only reads facts and emits prose to a markdown
 * doc. The pass bar (see the SPEC): ≥4 of 5 drafts "publishable with light
 * edits" and ZERO faithfulness violations across the set. The generator flag
 * (SELF_EDIT_OVERVIEW_GENERATE) stays OFF in deployed envs until that bar is met.
 *
 * Default sample = the SPEC's validation set: a rich/leadership case, a
 * computational case, a clinical/non-bench case, and a sparse-tail case so
 * graceful degradation is exercised too. Output (operator-graded, NOT committed
 * to git history by this script): docs/overview-coverage/validation-run-results.md
 *
 * `--dry-run` makes zero API calls; the live path calls Claude on Amazon Bedrock
 * through the overview generator, authenticating with the AWS credential chain
 * (your shell creds locally) — institutional billing, no API key.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { assembleOverviewFacts, type OverviewFacts } from "@/lib/edit/overview-facts";
import {
  buildOverviewUserPrompt,
  generateOverviewDraft,
  OVERVIEW_SYSTEM_PROMPT,
} from "@/lib/edit/overview-generator";
import { DEFAULT_OVERVIEW_PARAMS } from "@/lib/edit/overview-params";

/**
 * The SPEC's validation sample — a deliberate spread across the faculty types
 * the generator must cover. Each cwid is from the net-new / gap list and has
 * ReciterAI data; the labels mirror the SPEC's sample table so the results doc
 * reads against it directly. The sparse-tail case is a placeholder the operator
 * overrides with a real `E_tail` gap cwid via --cwids (graceful degradation is a
 * required pass, not an optional one).
 */
interface SampleCase {
  cwid: string;
  label: string;
}

const DEFAULT_SAMPLE: SampleCase[] = [
  { cwid: "rgcryst", label: "High-output basic/translational, leadership (rich data)" },
  { cwid: "imh2003", label: "Computational / data-science (metadata beats a thin bio)" },
  { cwid: "gbm9002", label: "Clinical / non-bench leader (low-bench-pub, policy/clinical)" },
  { cwid: "E_TAIL_PLACEHOLDER", label: "Sparse data — tail tier (graceful degradation)" },
];

const RESULTS_DOC = path.resolve(
  process.cwd(),
  "docs",
  "overview-coverage",
  "validation-run-results.md",
);

interface Args {
  cwids: SampleCase[];
  dryRun: boolean;
  out: string;
  model: string | undefined;
  temperature: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwidsRaw = get("--cwids");
  const cwids = cwidsRaw
    ? cwidsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((cwid) => ({ cwid, label: "operator-supplied" }))
    : DEFAULT_SAMPLE;
  const tempRaw = get("--temperature");
  return {
    cwids,
    dryRun: argv.includes("--dry-run"),
    out: get("--out") ?? RESULTS_DOC,
    model: get("--model"),
    temperature: tempRaw === undefined ? undefined : Number(tempRaw),
  };
}

/** Whitespace-delimited word count, matching the SPEC's ~120–180-word band. */
function wordCount(text: string): number {
  const stripped = text.replace(/<[^>]+>/g, " ");
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** First line of an error message, for a compact per-case failure note. */
function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0].slice(0, 300);
}

/**
 * A compact, human-readable summary of the assembled facts so a grader can see
 * exactly what the model was (and was not) given — the only legitimate ground
 * truth for the faithfulness verdict.
 */
function renderFactsSummary(facts: OverviewFacts): string {
  const lines: string[] = [];
  lines.push(`- **Name / Title / Dept:** ${facts.name} — ${facts.title ?? "(no title)"} — ${facts.department ?? "(no dept)"}`);
  lines.push(
    `- **Publications:** ${facts.publicationCount} confirmed; active ` +
      `${facts.yearsActive.first ?? "?"}–${facts.yearsActive.last ?? "?"}`,
  );
  if (facts.topics.length > 0) {
    lines.push(`- **Topics:** ${facts.topics.map((t) => t.label).join(", ")}`);
  } else {
    lines.push(`- **Topics:** (none)`);
  }
  if (facts.representativePublications.length > 0) {
    lines.push(`- **Representative publications:**`);
    for (const p of facts.representativePublications) {
      const venue = [p.venue, p.year].filter(Boolean).join(" ");
      const impact = p.impact != null ? ` · impact ${p.impact}` : "";
      lines.push(`  - ${p.title}${venue ? ` (${venue})` : ""}${impact}`);
      // #742 — the ReciterAI distilled signals (synopsis / impact justification /
      // topic rationale) the generator is DESIGNED to ground on. Rendering them is
      // load-bearing for the faithfulness verdict: a draft specific that traces to a
      // synopsis is GROUNDED, and omitting them made the validation read grounded
      // findings (e.g. "60-90% systemic distribution", "STORK-A") as fabrications.
      for (const d of [p.synopsis, p.impactJustification, p.topicRationale]) {
        if (d) lines.push(`    - _grounding:_ ${d}`);
      }
    }
  } else {
    lines.push(`- **Representative publications:** (none)`);
  }
  if (facts.activeGrants.length > 0) {
    lines.push(`- **Active grants:**`);
    for (const g of facts.activeGrants) {
      // The grant TITLE is a grounding source (a draft may name the disease/aim it
      // states); funder-only rendering hid it and read grounded diseases as invented.
      lines.push(
        `  - ${g.role} · ${g.funderLabel}${g.title ? ` — "${g.title}"` : " (no title)"}${g.mechanism ? ` [${g.mechanism}]` : ""}`,
      );
    }
  } else {
    lines.push(`- **Active grants:** (none)`);
  }
  if (facts.education.length > 0) {
    lines.push(
      `- **Education:** ` +
        facts.education
          .map(
            (e) =>
              `${e.degree}${e.field ? `, ${e.field}` : ""} — ${e.institution}${e.year ? ` (${e.year})` : ""}`,
          )
          .join("; "),
    );
  } else {
    lines.push(`- **Education:** (none)`);
  }
  // #742 — methods + facultyMetrics ARE in the FACTS the model sees (serialized in
  // the user turn), but were omitted from this summary, so a grader could not tell a
  // grounded tool name ("Blackbird") or a real metric ("h-index 27") from a
  // fabrication. Render them: they are legitimate ground truth for the faithfulness
  // verdict, and the #742 prompt-hardening naming rules depend on them.
  if (facts.methods.length > 0) {
    lines.push(
      `- **Methods / tools:** ` +
        facts.methods
          .map((m) => {
            const ex =
              m.examples && m.examples.length > 0
                ? ` (e.g. ${m.examples.slice(0, 3).join(", ")})`
                : "";
            return `${m.name}${m.category ? ` [${m.category}]` : ""}${ex}`;
          })
          .join("; "),
    );
  } else {
    lines.push(`- **Methods / tools:** (none)`);
  }
  if (facts.facultyMetrics) {
    const m = facts.facultyMetrics;
    lines.push(
      `- **Faculty metrics:** h-index ${m.hIndex ?? "—"}; scored pubs ${m.scoredPubCount ?? "—"}; ` +
        `first-author ${m.firstAuthorCount ?? "—"}; last-author ${m.lastAuthorCount ?? "—"}`,
    );
  } else {
    lines.push(`- **Faculty metrics:** (none)`);
  }
  lines.push(
    `- **existingBio:** ${facts.existingBio ? `present (source: ${facts.existingBio.source})` : "none"}`,
  );
  return lines.join("\n");
}

/** The operator's per-draft acceptance table — the SPEC's six dimensions, blank. */
function acceptanceChecklist(): string {
  return [
    "| Dimension | Pass? | Notes |",
    "|---|---|---|",
    "| **Faithfulness** (zero invented awards/positions/dates/affiliations/degree fields — the hard gate) |  |  |",
    "| **Specificity** (names ≥1 real contribution grounded in an abstract/impact/synopsis, not just topic labels) |  |  |",
    "| **Voice** (third person, person-centric — not \"the lab\" as subject throughout) |  |  |",
    "| **Length** (~120–180 words; a shorter sparse draft is a pass) |  |  |",
    "| **Currency** (uses the current ED title; no stale title, no \"currently…\") |  |  |",
    "| **Artifacts** (no scrape typos, no embedded citations, no raw lists) |  |  |",
    "| **Overall** (publishable with light edits?) |  |  |",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Live runs call Claude on Bedrock via the overview generator, which resolves
  // AWS credentials from the standard chain (your shell creds locally). No key to
  // check here; a missing/expired credential surfaces as a clear AWS error on the
  // first generate call below.

  const now = new Date().toISOString();
  const doc: string[] = [];
  doc.push(`# Overview-statement generator — validation run results`);
  doc.push("");
  doc.push(
    `Run: ${now}${args.dryRun ? " (dry-run — facts + prompt only, no drafts generated)" : ""}.`,
  );
  doc.push(
    `Generated by \`npm run edit:overview-validate\` (#742). This is the SPEC's ` +
      `gated build-of-record validation note. **Pass bar:** ≥4 of ${args.cwids.length} ` +
      `drafts "publishable with light edits" and **zero** faithfulness violations ` +
      `across the set. The \`SELF_EDIT_OVERVIEW_GENERATE\` flag stays OFF in deployed ` +
      `envs until this bar is met.`,
  );
  doc.push("");
  if (!args.dryRun) {
    doc.push(`Model: \`${args.model ?? "(default)"}\`, temperature: ${args.temperature ?? "(default)"}.`);
    doc.push("");
  }
  doc.push(`---`);
  doc.push("");

  let ok = 0;
  let skippedMissing = 0;
  let failed = 0;

  for (const { cwid, label } of args.cwids) {
    console.log(`[edit:overview-validate] ${cwid} — ${label}`);
    doc.push(`## ${cwid} — ${label}`);
    doc.push("");

    let facts: OverviewFacts | null;
    try {
      facts = await assembleOverviewFacts(cwid);
    } catch (err) {
      failed++;
      console.warn(`  facts assembly failed: ${shortErr(err)}`);
      doc.push(`> **Facts assembly failed:** ${shortErr(err)}`);
      doc.push("");
      continue;
    }

    if (!facts) {
      skippedMissing++;
      console.warn(`  scholar not found (or placeholder cwid) — supply a real cwid via --cwids`);
      doc.push(
        `> **Scholar not found.** Replace this placeholder with a real cwid via ` +
          `\`--cwids\` (the sparse-tail slot expects an \`E_tail\` gap faculty member).`,
      );
      doc.push("");
      continue;
    }

    doc.push(`### Assembled facts`);
    doc.push("");
    doc.push(renderFactsSummary(facts));
    doc.push("");

    if (args.dryRun) {
      doc.push(`### Prompt (dry-run — not sent)`);
      doc.push("");
      doc.push("```text");
      doc.push(`SYSTEM:`);
      doc.push(OVERVIEW_SYSTEM_PROMPT);
      doc.push("");
      doc.push(`USER:`);
      doc.push(buildOverviewUserPrompt(facts, DEFAULT_OVERVIEW_PARAMS));
      doc.push("```");
      doc.push("");
      ok++;
      console.log(`  facts assembled; prompt rendered (dry-run, no Bedrock call)`);
      continue;
    }

    let draft: string;
    let model: string;
    try {
      // Phase A: the default params drive the validation run — the same shape
      // the v1 fixed prompt produced (third person, formal, standard length).
      const result = await generateOverviewDraft(facts, DEFAULT_OVERVIEW_PARAMS, {
        model: args.model,
        temperature: args.temperature,
      });
      draft = result.draft;
      model = result.model;
    } catch (err) {
      failed++;
      console.warn(`  generation failed: ${shortErr(err)}`);
      doc.push(`> **Generation failed (Bedrock error/timeout):** ${shortErr(err)}`);
      doc.push("");
      continue;
    }

    const words = wordCount(draft);
    ok++;
    console.log(`  draft generated (${words} words, model ${model})`);

    doc.push(`### Generated draft (sanitized HTML — ${words} words · model \`${model}\`)`);
    doc.push("");
    doc.push("```html");
    doc.push(draft);
    doc.push("```");
    doc.push("");
    doc.push(`### Operator verdict`);
    doc.push("");
    doc.push(acceptanceChecklist());
    doc.push("");
  }

  doc.push(`---`);
  doc.push("");
  doc.push(`## Summary`);
  doc.push("");
  doc.push(
    `- Cases attempted: ${args.cwids.length}` +
      ` · ${args.dryRun ? "facts/prompt rendered" : "drafts generated"}: ${ok}` +
      ` · scholar-not-found: ${skippedMissing}` +
      ` · failed: ${failed}`,
  );
  doc.push("");
  if (!args.dryRun) {
    doc.push(
      `**Operator: fill in each draft's verdict table above, then record the overall ` +
        `result here.** Proceed to build only on ≥4/${args.cwids.length} publishable ` +
        `AND zero faithfulness violations. Any faithfulness violation → fix the ` +
        `prompt/grounding and re-run before building.`,
    );
    doc.push("");
  }

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, doc.join("\n") + "\n", "utf8");

  console.log(`[edit:overview-validate] wrote ${args.out}`);
  if (skippedMissing > 0) {
    console.warn(
      `[edit:overview-validate] ${skippedMissing} case(s) had no scholar — ` +
        `supply real cwids via --cwids (notably the sparse-tail slot).`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
