/**
 * POST /api/edit/biosketch/suggest-pubs (#1569).
 *
 * The DETERMINISTIC counterpart to the biosketch generator: given the user's OWN written
 * statement/themes, rank ALL of the scholar's confirmed publications by term overlap (stemmed
 * words + acronyms, against title, synopsis, abstract and MeSH) and return the top matches.
 * There is NO model / AI-Gateway call (`suggestPubsFromStatement`), and every returned pmid is
 * one of the scholar's own publications. The output is a copy/reference aid; nothing is written to the profile or recorded.
 *
 * Reuses the generator's flag (`EDIT_BIOSKETCH_GENERATE`, off ⇒ 404) and the SHARED bio-write
 * authorization — a caller who may generate a biosketch may also get pub suggestions, and no new
 * surface leaks another scholar's data.
 */
import { type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import {
  suggestPubsFromStatement,
  type StatementCandidatePub,
} from "@/lib/edit/biosketch-products";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { extractMeshLabels } from "@/lib/search-index-docs";
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

  // --- candidate load (DB read only; no rate limit, there is no gateway cost to run up). EVERY
  //     confirmed publication, not the <=25-item overview selection the generator grounds on:
  //     a statement should be able to surface any of the scholar's papers. Abstract + MeSH ride
  //     along so the matcher sees more than the title. ---
  let candidates: StatementCandidatePub[];
  try {
    const authorships = await db.read.publicationAuthor.findMany({
      where: { cwid: entityId, isConfirmed: true },
      select: { pmid: true },
    });
    const rows = await db.read.publication.findMany({
      where: { pmid: { in: authorships.map((a) => a.pmid) } },
      select: {
        pmid: true,
        title: true,
        journal: true,
        year: true,
        impactScore: true,
        citationCount: true,
        synopsis: true,
        abstract: true,
        meshTerms: true,
      },
    });
    candidates = rows.map((r) => ({
      pmid: r.pmid,
      title: r.title,
      venue: r.journal,
      year: r.year,
      impact: r.impactScore == null ? null : Number(r.impactScore),
      citationCount: r.citationCount,
      synopsis: r.synopsis,
      abstract: r.abstract,
      meshTerms: extractMeshLabels(r.meshTerms),
    }));
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ pubs: suggestPubsFromStatement(candidates, statement, SUGGESTED_PUB_LIMIT) });
}
