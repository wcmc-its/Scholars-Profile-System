/**
 * GET /api/edit/cancer-center-mesh-taxonomy
 *
 * Read-only detail behind the Reports tab's "How cancer-relevance is
 * determined" modal — the topic-grouped `CancerTaxonomyDescriptor` ruleset
 * (`docs/cancer-taxonomy-ruleset.csv`), grouped by topic bucket with a live
 * count and a capped sample of the descriptors that carry it. Built from
 * `buildTopicDetail`, which reuses the SAME `topicsByUi` lookup the weekly
 * ETL step matches papers against — the modal can never show a broader or
 * narrower set than what's actually counted. No more codes, anchors, or tree
 * numbers: those belonged to the retired 18-code CSV taxonomy this replaces.
 * A relevant-but-untagged descriptor groups under the "unassigned" bucket
 * rather than disappearing.
 *
 * Also returns three summary figures the modal's header/footer surface —
 * `totalRelevant` (free: `topicsByUi.size`), `ruleCount` (the checked-in
 * ruleset's own row count, re-parsed live rather than hand-typed so it can't
 * drift out of sync with the file), and `meshRelease` (the year out of the
 * latest successful CancerTaxonomy `EtlRun`'s `manifestTaxonomyVersion`,
 * packed as `mesh<year>:<sha256 prefix>` by `etl/cancer-taxonomy/index.ts` —
 * only the year is display-worthy here, the sha prefix is CSV-export/audit
 * detail).
 *
 * Cancer-relevance only matters today for full-time faculty who could be
 * Cancer Center members — this taxonomy is WCM-wide (not per-center) and not
 * self-service; any authenticated `/edit` session may read it (no center-role
 * check — it's not center-scoped data), matching how it's only ever reached
 * from inside an already-gated Reports tab.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { type NextResponse } from "next/server";

import { buildTopicDetail, loadCancerTaxonomy } from "@/lib/cancer-taxonomy";
import { parseCsv } from "@/lib/csv";
import { db } from "@/lib/db";
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

const RULESET_PATH = path.join(process.cwd(), "docs/cancer-taxonomy-ruleset.csv");

export async function GET(): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");

  const lookup = await loadCancerTaxonomy(db.read.cancerTaxonomyDescriptor, db.read.meshDescriptor);
  const topics = buildTopicDetail(lookup);

  const ruleCount = parseCsv(readFileSync(RULESET_PATH, "utf8")).length;

  const lastRun = await db.read.etlRun.findFirst({
    where: { source: "CancerTaxonomy", status: "success" },
    orderBy: { completedAt: "desc" },
    select: { manifestTaxonomyVersion: true },
  });
  const meshYear = lastRun?.manifestTaxonomyVersion?.match(/^mesh(\d{4}):/)?.[1];

  return editOk({
    topics,
    totalRelevant: lookup.topicsByUi.size,
    ruleCount,
    meshRelease: meshYear ? `MeSH ${meshYear}` : null,
  });
}
