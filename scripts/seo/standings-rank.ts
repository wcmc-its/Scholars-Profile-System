/**
 * Cross-sectional rival standings from a SINGLE rank snapshot.
 *
 *   npm run seo:standings                                   # latest snapshot
 *   npm run seo:standings -- --snapshot data/seo/snapshots/rank-<ts>.json
 *   npm run seo:standings -- --home WCM --csv data/seo/standings-matrix.csv
 *   npm run seo:standings -- --llm-snapshot data/seo/snapshots/llm-rank-<ts>.json
 *
 * Prints a markdown report (institution + platform leaderboards, head-to-head,
 * gap list, matched cohort) to stdout; `--csv` also writes the full institution
 * × query matrix. Intended for a RIVAL basket snapshot (targets carry
 * `institution`/`surfaceType`); on a plain cutover snapshot it still runs but is
 * trivial (groups fall back to target keys). `--llm-snapshot` appends the
 * #594 §6 "LLM-answer" share-of-voice column from a citation-RAG snapshot.
 *
 * Read-only: consumes a snapshot file, no DB and no API calls.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { RankSnapshot } from "@/lib/seo/rank-basket";
import {
  groupByInstitution,
  groupByPlatform,
  computeStandings,
  headToHead,
  gapList,
  matchedCohorts,
  toStandingsMarkdown,
  toHeadToHeadMarkdown,
  toMatchedMarkdown,
  toMatrixCsv,
} from "@/lib/seo/standings";
import type { LlmRankSnapshot } from "@/lib/seo/llm-rank";
import { computeLlmShareOfVoice, toLlmShareMarkdown } from "@/lib/seo/llm-standings";

const SNAPSHOT_DIR = path.resolve(process.cwd(), "data", "seo", "snapshots");

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function latestSnapshot(): Promise<string> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith("rank-") && f.endsWith(".json"))
      .sort();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    throw new Error(
      `No snapshots in ${SNAPSHOT_DIR}. Run seo:track on the rival basket first, or pass --snapshot.`,
    );
  }
  return path.join(SNAPSHOT_DIR, entries[entries.length - 1]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = getFlag(argv, "--home") ?? "WCM";
  const snapPath = getFlag(argv, "--snapshot") ?? (await latestSnapshot());
  const snapshot = JSON.parse(await fs.readFile(snapPath, "utf8")) as RankSnapshot;

  const institutions = groupByInstitution(snapshot.targets, "research-profiles");
  const platforms = groupByPlatform(snapshot.targets, "research-profiles");

  const out: string[] = [];
  out.push(`# Rival standings — ${snapshot.capturedAt}`);
  out.push("");
  out.push(
    `Snapshot: \`${snapPath}\`. Research-profiles surfaces only (clinical excluded). ` +
      `These are RELATIVE standings across institutions on a fixed basket, not absolute rank — broad expert ` +
      `queries are nationally competitive. Rivals' platforms have years of SEO/backlinks; WCM Scholars is new, ` +
      `so "WCM" = the best of its research-profiles surfaces (Scholars + legacy VIVO).`,
  );
  out.push("");

  out.push(
    toStandingsMarkdown(
      computeStandings(snapshot, institutions, "expert"),
      "Institution standings — expert sweep",
    ),
  );
  out.push("");

  const flagship = computeStandings(snapshot, institutions, "flagship");
  if (flagship.some((s) => s.queries > 0)) {
    out.push(toStandingsMarkdown(flagship, "Institution standings — flagship queries"));
    out.push("");
  }

  out.push(
    toStandingsMarkdown(
      computeStandings(snapshot, platforms, "expert"),
      "Platform rollup — expert sweep",
    ),
  );
  out.push("");

  out.push(toHeadToHeadMarkdown(headToHead(snapshot, institutions, home, "expert"), home));
  out.push("");

  const gaps = gapList(snapshot, institutions, home, "expert");
  out.push(`### Gap list — a rival ranks top-10 but ${home} does not (${gaps.length})`);
  out.push("");
  if (gaps.length) {
    out.push(`| Query | ${home} | Best rival |`, "|---|---|---|");
    for (const g of gaps) {
      out.push(
        `| ${g.query} | ${g.home.position ?? "—"} | ${g.bestRival ? `${g.bestRival.label} @ ${g.bestRival.position}` : "—"} |`,
      );
    }
  } else {
    out.push("_None — every query where a rival ranks top-10, WCM does too._");
  }
  out.push("");

  const cohorts = matchedCohorts(snapshot, institutions);
  if (cohorts.length) {
    out.push(toMatchedMarkdown(cohorts));
    out.push("");
  }

  // #594 §6 — append the LLM-answer share-of-voice column from a citation-RAG
  // snapshot. Groups by institution off the LLM snapshot's own targets, so a
  // WCM-only or full-rival LLM snapshot both work.
  const llmPath = getFlag(argv, "--llm-snapshot");
  if (llmPath) {
    const llm = JSON.parse(await fs.readFile(llmPath, "utf8")) as LlmRankSnapshot;
    const llmGroups = groupByInstitution(llm.targets, "research-profiles");
    out.push(
      toLlmShareMarkdown(
        computeLlmShareOfVoice(llm, llmGroups),
        `LLM-answer share of voice — ${llmPath}`,
      ),
    );
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");

  const csvPath = getFlag(argv, "--csv");
  if (csvPath) {
    await fs.mkdir(path.dirname(csvPath), { recursive: true });
    await fs.writeFile(csvPath, toMatrixCsv(snapshot, institutions, "expert"), "utf8");
    console.error(`\n[seo:standings] wrote full institution × query matrix to ${csvPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
