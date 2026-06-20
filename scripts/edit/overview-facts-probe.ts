/**
 * READ-ONLY probe: assemble OverviewFacts for a set of cwids (plus an auto-
 * discovered sparse-tail faculty case) and print them as JSON between markers.
 *
 * Companion to `scripts/edit/overview-generate-from-facts.ts` for the #742
 * model+prompt validation (Opus 4.8 + v4). The staging app/RDS VPC is not
 * reachable from a laptop, so facts are assembled IN-VPC here (run via
 * `scripts/run-staging-probe.sh`, which executes this against the staging DB and
 * tails the output), and the captured JSON is fed to the local generate script
 * which calls Bedrock with shell creds.
 *
 *   scripts/run-staging-probe.sh scripts/edit/overview-facts-probe.ts staging
 *
 * Override the named sample with the CWIDS env (comma-separated). Reads only;
 * never writes. No `dotenv` import — DATABASE_URL is supplied by the in-VPC
 * task definition, and the deployed container does not bundle `dotenv`.
 */
import { db } from "@/lib/db";
import { assembleOverviewFacts, type OverviewFacts } from "@/lib/edit/overview-facts";
import { hasSparseResearchSignal } from "@/lib/edit/overview-generator";

const NAMED = (process.env.CWIDS ?? "rgcryst,imh2003,gbm9002")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface FactsRecord {
  cwid: string;
  label: string;
  sparse: boolean | null;
  facts: OverviewFacts | null;
}

/** Find one real sparse-tail faculty member (THINNEST research signal) the prompt
 *  must degrade gracefully on. `hasSparseResearchSignal` is strict (zero topics AND
 *  zero rep pubs) and almost no real faculty trips it, so instead we scan a pool of
 *  low-/un-scored titled scholars and return the one with the smallest combined
 *  signal (topics + rep pubs + grants + methods) — a genuinely thin profile. */
async function findSparseTail(
  exclude: Set<string>,
): Promise<{ cwid: string; facts: OverviewFacts; signal: number } | null> {
  const candidates = await db.read.scholar.findMany({
    where: {
      primaryTitle: { not: null },
      OR: [{ scoredPubCount: { lte: 8 } }, { scoredPubCount: null }],
    },
    select: { cwid: true },
    orderBy: { scoredPubCount: "asc" },
    take: 40,
  });
  let best: { cwid: string; facts: OverviewFacts; signal: number } | null = null;
  let scanned = 0;
  for (const { cwid } of candidates) {
    if (exclude.has(cwid)) continue;
    if (scanned >= 25) break;
    scanned++;
    const facts = await assembleOverviewFacts(cwid);
    if (!facts) continue;
    const signal =
      facts.topics.length +
      facts.representativePublications.length +
      facts.activeGrants.length +
      facts.methods.length;
    if (best === null || signal < best.signal) best = { cwid, facts, signal };
    if (signal === 0) break; // can't get thinner than empty
  }
  return best;
}

async function main(): Promise<void> {
  const out: FactsRecord[] = [];
  const seen = new Set<string>();

  for (const cwid of NAMED) {
    seen.add(cwid);
    const facts = await assembleOverviewFacts(cwid);
    out.push({
      cwid,
      label: "named",
      sparse: facts ? hasSparseResearchSignal(facts) : null,
      facts,
    });
    console.warn(`[facts-probe] ${cwid}: ${facts ? "ok" : "NOT FOUND"}`);
  }

  const sparse = await findSparseTail(seen);
  if (sparse) {
    out.push({
      cwid: sparse.cwid,
      label: `sparse-tail (auto, thinnest signal=${sparse.signal})`,
      sparse: hasSparseResearchSignal(sparse.facts),
      facts: sparse.facts,
    });
    console.warn(`[facts-probe] sparse-tail = ${sparse.cwid} (signal=${sparse.signal})`);
  } else {
    console.warn(`[facts-probe] no sparse-tail candidate found`);
  }

  // Machine-readable payload between markers so the tail can be extracted from
  // the CloudWatch log stream.
  console.log("__OVERVIEW_FACTS_JSON__");
  console.log(JSON.stringify(out));
  console.log("__END_OVERVIEW_FACTS_JSON__");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
