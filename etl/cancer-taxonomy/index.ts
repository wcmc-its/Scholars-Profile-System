/**
 * Cancer taxonomy generator ETL — versioned redesign, step 1
 * (`2026-08-11-cancer-taxonomy-versioned-redesign-plan.md`). Generates the
 * TWO-axis (`cancer_relevant`, multi-valued `topics`) closure from
 * `docs/cancer-taxonomy-ruleset.csv` against the already-persisted
 * `MeshDescriptor` table and full-replaces `CancerTaxonomyDescriptor`.
 *
 * `etl/cancer-center-collab-report/index.ts`, the "How cancer-relevance is
 * determined" modal, and the per-paper CSV export all read this table
 * directly now (`lib/cancer-taxonomy.ts`) — the old CSV taxonomy and its
 * hand-walked MeSH matching (`lib/cancer-center-mesh-taxonomy.ts`,
 * `docs/cancer-center-disease-taxonomy.csv`) are retired.
 *
 * Versioning: a taxonomy resolution is only reproducible as the COMBINATION
 * of (ruleset content, MeSH release) — either alone is not enough. This
 * step's `EtlRun` row therefore pairs its own ruleset sha256
 * (`manifestSha256`, same convention as `etl/mesh-descriptors/index.ts`)
 * with the MOST RECENT successful MeSH `EtlRun`'s own manifestSha256/year,
 * packed into `manifestTaxonomyVersion` as `mesh<year>:<sha256 prefix>`.
 * Short-circuits (skips the full-replace) when BOTH match the last
 * successful CancerTaxonomy run — cheap, so there's no cost to always
 * chaining this step after `etl:mesh` regardless of whether MeSH itself
 * short-circuited (see the chaining block at the bottom of
 * `etl/mesh-descriptors/index.ts`).
 *
 * Ruleset rot: `generateCancerTaxonomy` (./generate.ts) tracks two distinct
 * failure signals from the closure it just computed:
 *   - `unresolved` — a ruleset row's descriptor name doesn't exist in this
 *     MeSH release AT ALL. Unambiguous rot (renamed/retired heading) — FAILS
 *     the run.
 *   - `emptySubtrees` — a `_subtree` rule's anchor resolved but has ZERO
 *     descendants this release. Real signal, but NOT unambiguous: some
 *     ruleset anchors are legitimately leaf concepts by design (confirmed
 *     empirically against the fixture in tests/unit/cancer-taxonomy-
 *     generate.test.ts — 3 of the fixture's own anchors are genuine leaves,
 *     not rot). Logged loudly as a review signal; does not fail the run.
 *
 * Env:
 *   CANCER_TAXONOMY_FORCE_REPLACE  (set to "1" to bypass the short-circuit)
 */
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { processStartedAt } from "@/lib/etl-run";
import { generateCancerTaxonomy, parseRuleset, type DescriptorInput, type GeneratedRow } from "./generate";

const FORCE_REPLACE = process.env.CANCER_TAXONOMY_FORCE_REPLACE === "1";
const RULESET_PATH = path.join(process.cwd(), "docs/cancer-taxonomy-ruleset.csv");

type JsonStringArray = Prisma.InputJsonValue;
function asJsonStringArray(arr: string[]): JsonStringArray {
  return arr as unknown as JsonStringArray;
}

async function recordRun(args: {
  id: string;
  status: "success" | "failed";
  rowsProcessed: number;
  rulesetSha256?: string;
  pairedMeshLabel?: string;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      id: args.id,
      source: "CancerTaxonomy",
      status: args.status,
      startedAt: processStartedAt,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
      manifestSha256: args.rulesetSha256 ?? null,
      manifestTaxonomyVersion: args.pairedMeshLabel ?? null,
    },
  });
}

async function replaceTable(runId: string, rows: GeneratedRow[]): Promise<number> {
  const CHUNK = 500;
  const chunks: GeneratedRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  await db.write.$transaction(
    async (tx) => {
      await tx.cancerTaxonomyDescriptor.deleteMany({});
      for (const batch of chunks) {
        await tx.cancerTaxonomyDescriptor.createMany({
          data: batch.map((r) => ({
            descriptorUi: r.descriptorUi,
            cancerRelevant: r.cancerRelevant,
            topics: asJsonStringArray(r.topics),
            admittedBy: asJsonStringArray(r.admittedBy),
            reviewFlags: asJsonStringArray(r.reviewFlags),
            taxonomyRunId: runId,
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );

  return rows.length;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = randomUUID();

  const rulesetBytes = readFileSync(RULESET_PATH);
  const rulesetSha256 = createHash("sha256").update(rulesetBytes).digest("hex");

  // Pair with the most recent successful MeSH run — see the module doc
  // comment for why either hash alone is not a reproducible version.
  const meshRun = await db.write.etlRun.findFirst({
    where: { source: "MeSH", status: "success" },
    orderBy: { completedAt: "desc" },
  });
  if (!meshRun?.manifestSha256 || !meshRun.manifestTaxonomyVersion) {
    throw new Error(
      "no successful MeSH EtlRun found — run `npm run etl:mesh` before `npm run etl:cancer-taxonomy`",
    );
  }
  const pairedMeshLabel = `mesh${meshRun.manifestTaxonomyVersion}:${meshRun.manifestSha256.slice(0, 12)}`;

  const lastRun = await db.write.etlRun.findFirst({
    where: { source: "CancerTaxonomy", status: "success" },
    orderBy: { completedAt: "desc" },
  });
  if (!FORCE_REPLACE && lastRun?.manifestSha256 === rulesetSha256 && lastRun?.manifestTaxonomyVersion === pairedMeshLabel) {
    console.log(
      `[CancerTaxonomy] ${JSON.stringify({
        event: "short_circuit",
        ts: Date.now(),
        rulesetSha256,
        pairedMeshLabel,
      })}`,
    );
    await recordRun({ id: runId, status: "success", rowsProcessed: 0, rulesetSha256, pairedMeshLabel });
    return;
  }

  const descriptorRows = await db.write.meshDescriptor.findMany({
    select: { descriptorUi: true, name: true, treeNumbers: true },
  });
  const descriptors: DescriptorInput[] = descriptorRows.map((d) => ({
    ui: d.descriptorUi,
    name: d.name,
    treeNumbers: Array.isArray(d.treeNumbers) ? d.treeNumbers.filter((x): x is string => typeof x === "string") : [],
  }));

  const rules = parseRuleset(rulesetBytes.toString("utf8"));
  const result = generateCancerTaxonomy(rules, descriptors);
  console.log(
    `[CancerTaxonomy] ${JSON.stringify({
      event: "generated",
      ts: Date.now(),
      descriptors: descriptors.length,
      rules: rules.length,
      relevant: result.rows.length,
      unresolved: result.unresolved.length,
      emptySubtrees: result.emptySubtrees.length,
    })}`,
  );

  if (result.emptySubtrees.length > 0) {
    // Review signal, not fatal — see the module doc comment.
    console.warn(
      `[CancerTaxonomy] ${JSON.stringify({
        event: "empty_subtree_rot",
        ts: Date.now(),
        findings: result.emptySubtrees,
      })}`,
    );
  }

  if (result.unresolved.length > 0) {
    const message = `${result.unresolved.length} ruleset rule(s) reference a descriptor name absent from this MeSH release: ${result.unresolved
      .map((u) => `${u.rule}:${u.descriptor}`)
      .join("; ")}`;
    console.error(`[CancerTaxonomy] ${JSON.stringify({ event: "fatal", ts: Date.now(), error: message })}`);
    await recordRun({ id: runId, status: "failed", rowsProcessed: 0, rulesetSha256, pairedMeshLabel, errorMessage: message });
    process.exit(1);
  }

  const rows = await replaceTable(runId, result.rows);
  console.log(`[CancerTaxonomy] ${JSON.stringify({ event: "table_replaced", ts: Date.now(), rows })}`);

  await recordRun({ id: runId, status: "success", rowsProcessed: rows, rulesetSha256, pairedMeshLabel });
  console.log(
    `[CancerTaxonomy] ${JSON.stringify({ event: "done", ts: Date.now(), duration_ms: Date.now() - startedAt })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CancerTaxonomy] ${JSON.stringify({ event: "fatal", ts: Date.now(), error: message })}`);
    // The unresolved-rules failure path above already records+exits before
    // this can fire; this branch is for anything unexpected (DB down, file
    // read failure, ...). Guarded so a SECOND failure here (e.g. the same DB
    // outage) doesn't mask the original error.
    await recordRun({ id: randomUUID(), status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
