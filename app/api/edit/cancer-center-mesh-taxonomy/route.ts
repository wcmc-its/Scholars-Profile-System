/**
 * GET /api/edit/cancer-center-mesh-taxonomy
 *
 * Read-only detail behind the Reports tab's "How cancer-relevance is
 * determined" modal — the 18-code taxonomy (`docs/cancer-center-disease-
 * taxonomy.csv`), each code's real MeSH anchor term(s) + tree number(s), and
 * a live-computed sample of the descendant MeSH terms that actually fall
 * under it. Built from `buildTaxonomyDetail`, which reuses the same
 * `codeByUi` the weekly ETL step matches papers against — the modal can
 * never show a broader or narrower subtree than what's actually counted.
 *
 * Cancer-relevance only matters today for full-time faculty who could be
 * Cancer Center members — this taxonomy is WCM-wide (not per-center) and not
 * self-service; any authenticated `/edit` session may read it (no center-role
 * check — it's not center-scoped data), matching how it's only ever reached
 * from inside an already-gated Reports tab.
 */
import { type NextResponse } from "next/server";

import { buildTaxonomyDetail, loadTaxonomy } from "@/lib/cancer-center-mesh-taxonomy";
import { db } from "@/lib/db";
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

export async function GET(): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");

  const { codeByUi, descriptors, taxonomy } = await loadTaxonomy(db.read.meshDescriptor);
  const codes = buildTaxonomyDetail(taxonomy, descriptors, codeByUi);
  return editOk({ codes });
}
