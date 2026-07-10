/**
 * POST /api/edit/biosketch/suggest-pubs (#1569).
 *
 * The DETERMINISTIC counterpart to the biosketch generator: given the user's OWN written
 * statement/themes, rank the scholar's publications by token overlap and return the top matches.
 * There is NO model / AI-Gateway call — the ranking is pure token overlap
 * (`suggestPubsFromStatement`, reusing the same `tokenize()` / `aimsOverlapScore()` machinery the
 * Products "related" bucket uses), and every returned pmid is one of the scholar's own indexed
 * publications. The output is a copy/reference aid; nothing is written to the profile or recorded.
 *
 * Reuses the generator's flag (`EDIT_BIOSKETCH_GENERATE`, off ⇒ 404) and the SHARED bio-write
 * authorization — a caller who may generate a biosketch may also get pub suggestions, and no new
 * surface leaks another scholar's data.
 */
import { type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts } from "@/lib/edit/overview-facts";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import { suggestPubsFromStatement } from "@/lib/edit/biosketch-products";
import { normalizeOverviewSelection } from "@/lib/edit/overview-params";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/biosketch/suggest-pubs";

/** The most publications the suggest mode returns — the NIH biosketch lists ~5 products per
 *  contribution, so ~10 gives the user a comfortable pool to pick from. */
const SUGGESTED_PUB_LIMIT = 10;

export async function POST(request: NextRequest): Promise<Response> {
  // Flag first — a dormant feature 404s before doing any work, matching the generate route.
  if (!isBiosketchGenerateEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid } = req.ctx;

  const { entityId } = req.ctx.body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  // The user's own free-text statement/themes — never trusted, defaulted to empty. An empty or
  // token-less statement simply yields no suggestions (the ranking returns []).
  const statement = typeof req.ctx.body.statement === "string" ? req.ctx.body.statement : "";

  // --- authorization: the SHARED bio-write predicate, exactly as the generate route uses. ---
  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- facts assembly (DB read only; no rate limit — there is no gateway cost to run up). The
  //     scholar's standing curation (empty posted selection ⇒ the assembler default) plus the
  //     durable three-state deltas, identical to the generate route. ---
  let facts: Awaited<ReturnType<typeof assembleOverviewFacts>>;
  try {
    const deltas = await loadOverviewSelectionDeltas(entityId);
    facts = await assembleOverviewFacts(entityId, normalizeOverviewSelection({}), { deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // A missing scholar row is a 404.
  if (!facts) return editError(404, "scholar_not_found", "entityId");

  const pubs = suggestPubsFromStatement(
    facts.representativePublications,
    statement,
    SUGGESTED_PUB_LIMIT,
  );
  return editOk({ pubs });
}
