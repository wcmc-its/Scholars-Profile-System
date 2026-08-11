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
 * Cancer-relevance only matters today for full-time faculty who could be
 * Cancer Center members — this taxonomy is WCM-wide (not per-center) and not
 * self-service; any authenticated `/edit` session may read it (no center-role
 * check — it's not center-scoped data), matching how it's only ever reached
 * from inside an already-gated Reports tab.
 */
import { type NextResponse } from "next/server";

import { buildTopicDetail, loadCancerTaxonomy } from "@/lib/cancer-taxonomy";
import { db } from "@/lib/db";
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

export async function GET(): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");

  const lookup = await loadCancerTaxonomy(db.read.cancerTaxonomyDescriptor, db.read.meshDescriptor);
  const topics = buildTopicDetail(lookup);
  return editOk({ topics });
}
