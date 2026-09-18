/**
 * Biosketch prompt regression harness (#2653 — the v8 ship gate, Phase 2 spec "Evaluation
 * harness"). Drafts the same scholars under two prompt versions and reports the gate metrics:
 *
 *   - unsupported-claim rate per draft (spans the faithfulness pass removed / sentences)
 *   - out-of-list reference count and URL count (raw = what the model wrote, before the v8
 *     validator; final = what is left in the returned text), and full-citation tells
 *   - em-dash count
 *   - cost and latency, p50 / p95 per version
 *   - role separation: for one scholar and one aims set, PD/PI vs Co-Investigator vs Mentor
 *     statements as a BLINDED CSV for a human reader, plus the answer key
 *
 * The verdict (`compareVersions`) applies the issue's thresholds: unsupported-claim rate must not
 * rise, out-of-list references / URLs / em dashes must be zero for the candidate, cost and latency
 * p50/p95 within ±10% of the baseline. The human read of 10 drafts and the blinded role read are
 * NOT automated; the CSVs are their input.
 *
 * Runs against a live DB + Bedrock, so it runs where the app's credentials are (the ETL task
 * family via `run-staging-probe.sh`, or a shell with `DATABASE_URL` + AWS creds):
 *
 *   npx tsx scripts/biosketch-harness.ts --cwids=<cwid,...> --versions=v7,v8 --out=<dir> \
 *     --title="<project title>" --aims="<specific aims>" [--mode=personal_statement|contributions|both]
 *     [--role=pd_pi] [--separation-cwid=<cwid>] [--no-faithfulness]
 *
 * Every metric function is PURE and unit-tested with fixtures (`tests/unit/biosketch-harness.test.ts`);
 * `main` is the only thing that touches the DB or the gateway. The public repo rule applies to the
 * OUTPUT directory too: the CSVs carry real draft text and cwids — keep them out of the repo.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { BiosketchResult } from "@/lib/edit/biosketch-generator";
import type { BiosketchApplicationRole, BiosketchMode } from "@/lib/edit/biosketch-params";
import type { BiosketchPromptVersionId } from "@/lib/edit/biosketch-prompt-versions";
import {
  scanReferenceIssues,
  URL_RE,
  type BiosketchProductRef,
} from "@/lib/edit/biosketch-references";

// ---------------------------------------------------------------------------
// Metrics (pure)
// ---------------------------------------------------------------------------

/** One drafted run's measurements. */
export type HarnessRun = {
  cwid: string;
  version: BiosketchPromptVersionId;
  mode: BiosketchMode;
  role: BiosketchApplicationRole | null;
  latencyMs: number;
  /** Estimated USD; see {@link estimateRunCostUsd}. */
  costUsd: number | null;
  chars: number;
  sentences: number;
  removedSpans: number;
  unsupportedClaimRate: number;
  emDashes: number;
  /** Reference violations the model WROTE (pre-validator for v8; a scan of the text for v7). */
  outOfListRaw: number;
  urlsRaw: number;
  fullCitationTells: number;
  /** What remains in the returned text. */
  outOfListFinal: number;
  urlsFinal: number;
  referencesKept: number;
};

export function countEmDashes(text: string): number {
  return (text.match(/\u2014/g) ?? []).length;
}

export function countUrls(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

/** Sentence count: terminal punctuation followed by whitespace or end of text. Never 0 for
 *  non-empty prose (a fragment with no terminal mark counts as one). */
export function countSentences(text: string): number {
  const t = text.trim();
  if (t.length === 0) return 0;
  return Math.max(1, (t.match(/[.!?](?=\s|$)/g) ?? []).length);
}

/** Every entry body joined; the text the metrics scan. */
export function resultText(result: Pick<BiosketchResult, "entries">): string {
  return result.entries.map((e) => e.body).join("\n\n");
}

/**
 * Estimated USD for one draft: the main draft call's input (system + user prompt) and output at
 * ~4 characters per token, priced with `estimateCostUsd`. ponytail: the generator does not
 * surface billed token usage, so this is a size estimate of the draft call only (the
 * faithfulness calls are the same count under both versions and differ only by the prompt
 * delta); it is fit for the RELATIVE ±10% comparison the gate asks for, not for billing.
 */
export function estimateRunCostUsd(
  priceFn: (modelId: string, opts: { inputTokens: number; outputTokens: number }) => number | null,
  modelId: string,
  promptChars: number,
  outputChars: number,
): number | null {
  return priceFn(modelId, {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
  });
}

/** Build one run's metrics from a generator result. `refs` is the referenceable product list
 *  for the same (facts, params) — for v7 it lets the scan count the references the model wrote
 *  on the same footing as v8's validator. */
export function measureRun(
  base: Pick<HarnessRun, "cwid" | "version" | "mode" | "role" | "latencyMs" | "costUsd">,
  result: Pick<BiosketchResult, "entries" | "removed" | "references">,
  refs: readonly BiosketchProductRef[],
): HarnessRun {
  const text = resultText(result);
  const sentences = countSentences(text);
  const finalIssues = scanReferenceIssues(text, refs);
  // v8 reports what it stripped; v7 has no validator, so its raw count IS the final scan.
  const raw = result.references?.issues ?? finalIssues;
  return {
    ...base,
    chars: text.length,
    sentences,
    removedSpans: result.removed.length,
    unsupportedClaimRate: sentences === 0 ? 0 : result.removed.length / sentences,
    emDashes: countEmDashes(text),
    outOfListRaw: raw.filter((i) => i.kind === "out_of_list").length,
    urlsRaw: raw.filter((i) => i.kind === "url").length,
    fullCitationTells: raw.filter((i) => i.kind === "full_citation").length,
    outOfListFinal: finalIssues.filter((i) => i.kind === "out_of_list").length,
    urlsFinal: countUrls(text),
    referencesKept: result.references?.kept ?? 0,
  };
}

/** Nearest-rank percentile (p in 0..100) of a numeric sample; NaN for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export type VersionSummary = {
  version: BiosketchPromptVersionId;
  runs: number;
  unsupportedClaimRateMean: number;
  outOfListRaw: number;
  outOfListFinal: number;
  urlsRaw: number;
  urlsFinal: number;
  fullCitationTells: number;
  emDashes: number;
  latencyP50: number;
  latencyP95: number;
  costP50: number;
  costP95: number;
};

export function summarizeVersion(
  version: BiosketchPromptVersionId,
  runs: readonly HarnessRun[],
): VersionSummary {
  const mine = runs.filter((r) => r.version === version);
  const sum = (f: (r: HarnessRun) => number) => mine.reduce((acc, r) => acc + f(r), 0);
  const costs = mine.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return {
    version,
    runs: mine.length,
    unsupportedClaimRateMean:
      mine.length === 0 ? 0 : sum((r) => r.unsupportedClaimRate) / mine.length,
    outOfListRaw: sum((r) => r.outOfListRaw),
    outOfListFinal: sum((r) => r.outOfListFinal),
    urlsRaw: sum((r) => r.urlsRaw),
    urlsFinal: sum((r) => r.urlsFinal),
    fullCitationTells: sum((r) => r.fullCitationTells),
    emDashes: sum((r) => r.emDashes),
    latencyP50: percentile(
      mine.map((r) => r.latencyMs),
      50,
    ),
    latencyP95: percentile(
      mine.map((r) => r.latencyMs),
      95,
    ),
    costP50: percentile(costs, 50),
    costP95: percentile(costs, 95),
  };
}

export type GateCheck = { name: string; pass: boolean; detail: string };

/** The issue's ship gate for `candidate` against `baseline`. Cost/latency use ±10%; a NaN
 *  percentile (no runs) fails the check rather than passing vacuously. */
export function compareVersions(baseline: VersionSummary, candidate: VersionSummary): GateCheck[] {
  const within10 = (b: number, c: number) =>
    Number.isFinite(b) && Number.isFinite(c) && c <= b * 1.1;
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "n/a");
  return [
    {
      name: "unsupported-claim rate does not rise",
      pass: candidate.unsupportedClaimRateMean <= baseline.unsupportedClaimRateMean,
      detail: `${baseline.version} ${fmt(baseline.unsupportedClaimRateMean)} → ${candidate.version} ${fmt(candidate.unsupportedClaimRateMean)}`,
    },
    {
      name: "out-of-list references in final text are zero",
      pass: candidate.outOfListFinal === 0,
      detail: `${candidate.outOfListFinal} in final text (${candidate.outOfListRaw} written by the model, stripped)`,
    },
    {
      name: "URLs in final text are zero",
      pass: candidate.urlsFinal === 0,
      detail: `${candidate.urlsFinal} in final text (${candidate.urlsRaw} written by the model, stripped)`,
    },
    {
      name: "em-dash count is zero",
      pass: candidate.emDashes === 0,
      detail: `${candidate.emDashes} (baseline ${baseline.emDashes})`,
    },
    {
      name: "latency p50 within +10%",
      pass: within10(baseline.latencyP50, candidate.latencyP50),
      detail: `${fmt(baseline.latencyP50)} ms → ${fmt(candidate.latencyP50)} ms`,
    },
    {
      name: "latency p95 within +10%",
      pass: within10(baseline.latencyP95, candidate.latencyP95),
      detail: `${fmt(baseline.latencyP95)} ms → ${fmt(candidate.latencyP95)} ms`,
    },
    {
      name: "cost p50 within +10%",
      pass: within10(baseline.costP50, candidate.costP50),
      detail: `$${fmt(baseline.costP50)} → $${fmt(candidate.costP50)}`,
    },
    {
      name: "cost p95 within +10%",
      pass: within10(baseline.costP95, candidate.costP95),
      detail: `$${fmt(baseline.costP95)} → $${fmt(candidate.costP95)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Role separation (pure)
// ---------------------------------------------------------------------------

/** The three roles the issue's acceptance test contrasts. */
export const SEPARATION_ROLES: readonly BiosketchApplicationRole[] = [
  "pd_pi",
  "co_investigator",
  "mentor_sponsor",
];

export type RoleDraft = {
  cwid: string;
  role: BiosketchApplicationRole;
  text: string;
  /** The product labels (e.g. "Smith 2019") the draft references, in order of first use. */
  cited: string[];
};

export function leadSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}

/** The listed product labels a draft references, in order of first appearance. A label can
 *  open a parenthetical ("(Smith 2019") or follow another in a group ("; Smith 2019"). */
export function citedLabels(text: string, refs: readonly BiosketchProductRef[]): string[] {
  return refs
    .map((r) => {
      const at = [text.indexOf(`(${r.label}`), text.indexOf(`; ${r.label}`)].filter((i) => i >= 0);
      return { label: r.label, at: at.length > 0 ? Math.min(...at) : -1 };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.label);
}

/** RFC-4180-enough CSV cell quoting. */
export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Deterministic shuffle (mulberry32) so a rerun with the same seed reproduces the blinding. */
export function seededOrder(n: number, seed: number): number[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/**
 * The blinded manual-review CSV (id, lead sentence, cited records, full text — NO role) and its
 * answer key (id → cwid, role). A reader names the role per id; the key scores it. Also reports,
 * per cwid, whether the three drafts differ in lead sentence and in cited records (the
 * automated half of the acceptance test).
 */
export function roleSeparationCsvs(
  drafts: readonly RoleDraft[],
  seed = 2653,
): {
  blinded: string;
  key: string;
  distinct: { cwid: string; leadSentences: boolean; cited: boolean }[];
} {
  const order = seededOrder(drafts.length, seed);
  const blindedRows = order.map((di, i) => {
    const d = drafts[di]!;
    return [`R${i + 1}`, leadSentence(d.text), d.cited.join("; "), d.text];
  });
  const keyRows = order.map((di, i) => [`R${i + 1}`, drafts[di]!.cwid, drafts[di]!.role]);
  const byCwid = new Map<string, RoleDraft[]>();
  for (const d of drafts) byCwid.set(d.cwid, [...(byCwid.get(d.cwid) ?? []), d]);
  const distinct = [...byCwid.entries()].map(([cwid, ds]) => ({
    cwid,
    leadSentences: new Set(ds.map((d) => leadSentence(d.text))).size === ds.length,
    cited: new Set(ds.map((d) => d.cited.join("|"))).size === ds.length,
  }));
  return {
    blinded: toCsv(["id", "lead_sentence", "cited_records", "text"], blindedRows),
    key: toCsv(["id", "cwid", "role"], keyRows),
    distinct,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type HarnessArgs = {
  cwids: string[];
  versions: BiosketchPromptVersionId[];
  out: string;
  mode: "personal_statement" | "contributions" | "both";
  title: string;
  aims: string;
  role: BiosketchApplicationRole;
  separationCwid: string | null;
  faithfulness: boolean;
};

export function parseArgs(argv: readonly string[]): HarnessArgs {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
  const list = (k: string) =>
    get(k)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const versions = list("versions");
  return {
    cwids: list("cwids"),
    versions: (versions.length > 0 ? versions : ["v7", "v8"]) as BiosketchPromptVersionId[],
    out: get("out") || "biosketch-harness-out",
    mode: (get("mode") || "personal_statement") as HarnessArgs["mode"],
    title: get("title"),
    aims: get("aims"),
    role: (get("role") || "pd_pi") as BiosketchApplicationRole,
    separationCwid: get("separation-cwid") || null,
    faithfulness: !argv.includes("--no-faithfulness"),
  };
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.cwids.length === 0) throw new Error("--cwids=<cwid,...> is required");
  if (args.mode !== "contributions" && (!args.title || !args.aims)) {
    throw new Error("--title and --aims are required for personal_statement runs");
  }
  // Lazy imports: everything below needs the DB / gateway; the pure metrics above do not.
  const [{ db }, facts, deltas, gen, params, products, refsMod, pricing, versionsMod] =
    await Promise.all([
      import("@/lib/db"),
      import("@/lib/edit/overview-facts"),
      import("@/lib/edit/overview-selection-store"),
      import("@/lib/edit/biosketch-generator"),
      import("@/lib/edit/biosketch-params"),
      import("@/lib/edit/biosketch-products"),
      import("@/lib/edit/biosketch-references"),
      import("@/lib/llm/pricing"),
      import("@/lib/edit/biosketch-prompt-versions"),
    ]);
  const { normalizeOverviewSelection } = await import("@/lib/edit/overview-params");
  for (const v of args.versions) {
    if (!versionsMod.isValidBiosketchPromptVersionId(v)) throw new Error(`unknown version ${v}`);
  }
  mkdirSync(args.out, { recursive: true });

  const modes: BiosketchMode[] =
    args.mode === "both" ? ["personal_statement", "contributions"] : [args.mode];
  const runs: HarnessRun[] = [];
  const skipped: string[] = [];
  const roleDrafts: RoleDraft[] = [];
  const separationCwid = args.separationCwid ?? args.cwids[0]!;

  const draft = async (
    f: NonNullable<Awaited<ReturnType<typeof facts.assembleOverviewFacts>>>,
    cwid: string,
    version: BiosketchPromptVersionId,
    mode: BiosketchMode,
    role: BiosketchApplicationRole | null,
  ) => {
    const p = params.normalizeBiosketchParams({
      mode,
      promptVersion: version,
      projectTitle: args.title,
      aims: args.aims,
      applicationRole: role,
    });
    // The referenceable list for the SAME inputs: v8's keyed list, or (v7) the list its
    // author-year parentheticals are scanned against. Same deterministic selection either way.
    const refs = refsMod.productReferenceList(
      products.selectBiosketchProducts(f, p),
      f.representativePublications,
    );
    const promptChars =
      gen.resolveBiosketchPromptImpl(version).systemPrompt.length +
      gen.buildBiosketchUserPrompt(f, p, { groundsImpact: true }).length;
    const t0 = Date.now();
    const result = await gen.generateBiosketch(f, p, { faithfulnessPass: args.faithfulness });
    const latencyMs = Date.now() - t0;
    const text = resultText(result);
    const run = measureRun(
      {
        cwid,
        version,
        mode,
        role,
        latencyMs,
        costUsd: estimateRunCostUsd(
          pricing.estimateCostUsd,
          result.model,
          promptChars,
          text.length,
        ),
      },
      result,
      refs,
    );
    runs.push(run);
    console.log(
      `${cwid} ${version} ${mode}${role ? ` ${role}` : ""}: ${latencyMs} ms, ${run.sentences} sentences, ` +
        `${run.removedSpans} removed, refs kept ${run.referencesKept}, out-of-list raw/final ` +
        `${run.outOfListRaw}/${run.outOfListFinal}, urls ${run.urlsRaw}/${run.urlsFinal}, em-dashes ${run.emDashes}`,
    );
    return { result, refs, text };
  };

  // Role separation: the candidate version (last listed), three roles, one aims set, one scholar.
  const candidate = args.versions[args.versions.length - 1]!;
  const separates =
    args.mode !== "contributions" && versionsMod.biosketchVersionUsesApplicationRole(candidate);

  try {
    for (const cwid of args.cwids) {
      const d = await deltas.loadOverviewSelectionDeltas(cwid);
      const f = await facts.assembleOverviewFacts(cwid, normalizeOverviewSelection({}), {
        deltas: d,
      });
      if (!f || !facts.hasSufficientFacts(f)) {
        skipped.push(cwid);
        console.warn(`${cwid}: skipped (${f ? "insufficient facts" : "not found"})`);
        continue;
      }
      for (const version of args.versions) {
        for (const mode of modes) {
          const role = mode === "personal_statement" ? args.role : null;
          const { text, refs } = await draft(f, cwid, version, mode, role);
          if (separates && cwid === separationCwid && version === candidate && role) {
            roleDrafts.push({ cwid, role, text, cited: citedLabels(text, refs) });
          }
        }
      }
      if (separates && cwid === separationCwid) {
        for (const role of SEPARATION_ROLES) {
          if (role === args.role) continue; // captured from the main pass above
          const { text, refs } = await draft(f, cwid, candidate, "personal_statement", role);
          roleDrafts.push({ cwid, role, text, cited: citedLabels(text, refs) });
        }
      }
    }
  } finally {
    await db.write.$disconnect();
    await db.read.$disconnect();
  }

  const summaries = args.versions.map((v) => summarizeVersion(v, runs));
  const gate =
    summaries.length >= 2 ? compareVersions(summaries[0]!, summaries[summaries.length - 1]!) : [];
  writeFileSync(join(args.out, "runs.json"), JSON.stringify(runs, null, 2));
  writeFileSync(
    join(args.out, "summary.json"),
    JSON.stringify({ summaries, gate, skipped }, null, 2),
  );
  if (roleDrafts.length > 0) {
    const sep = roleSeparationCsvs(roleDrafts);
    writeFileSync(join(args.out, "role-separation-blinded.csv"), sep.blinded);
    writeFileSync(join(args.out, "role-separation-key.csv"), sep.key);
    writeFileSync(
      join(args.out, "role-separation-distinct.json"),
      JSON.stringify(sep.distinct, null, 2),
    );
  }
  console.table(summaries);
  for (const g of gate) console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}`);
  if (skipped.length > 0) console.log(`skipped: ${skipped.join(", ")}`);
  console.log(`written to ${args.out}`);
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
