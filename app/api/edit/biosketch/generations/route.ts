/**
 * GET / DELETE /api/edit/biosketch/generations (#917 v6, handoff §6; #1992).
 *
 * Returns — and prunes — a scholar's biosketch generation history for the `/edit` "Earlier
 * biosketches" panel. Unlike the overview, the biosketch has no save-to-profile flow, so there
 * is NO provenance half — just the list of prior generations (newest first, capped).
 *
 * Target: the `?cwid=` query param (the scholar being edited), defaulting to the effective
 * session cwid (self). A FOREIGN target is authorized by the SAME `authorizeOverviewWrite`
 * predicate the generate route uses. A signed-out caller gets a `401`; an unauthorized
 * foreign read a `403`. Flag-gated behind `EDIT_BIOSKETCH_GENERATE` (off ⇒ 404), mirroring
 * the generate route's dormancy.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import { coerceEntries, listBiosketchGenerations } from "@/lib/edit/biosketch-provenance";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import {
  editError,
  editOk,
  logEditFailure,
  readEditRequest,
  resolveEditIdentity,
} from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/biosketch/generations";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isBiosketchGenerateEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  // Target defaults to self; a present `?cwid` selects a foreign read, authorized by the
  // SAME predicate as the generate WRITE (no drift).
  const requested = new URL(request.url).searchParams.get("cwid")?.trim();
  const targetCwid = requested && requested.length > 0 ? requested : session.cwid;

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: targetCwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  try {
    const generations = await listBiosketchGenerations(targetCwid);
    return editOk({
      generations: generations.map((g) => ({
        id: g.id,
        mode: g.mode,
        entries: g.entries,
        projectTitle: g.projectTitle,
        projectAims: g.projectAims,
        model: g.model,
        promptVersion: g.promptVersion,
        params: g.params,
        products: g.products,
        sources: g.sources,
        // Audit "who ran it": the accountable human, plus the impersonation overlay (if any).
        createdByCwid: g.createdByCwid,
        impersonatedCwid: g.impersonatedCwid,
        createdAt: g.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}

/**
 * DELETE `{ generationId }` — erase one generation run from the history (#1992).
 *
 * History grew forever with no way to prune it, so a scholar who ran a dozen exploratory drafts
 * was stuck browsing all of them. The row is HARD-deleted: no `deletedAt`, no schema migration,
 * nothing left behind. That is deliberate — a biosketch draft is a copy/export artifact with no
 * downstream consumer, so a soft delete would only be prose the scholar asked us to stop keeping.
 *
 * WHICH MEANS THE AUDIT ROW IS THE WHOLE ACCOUNTABILITY TRAIL. `biosketch_generation` carries
 * `created_by_cwid` / `impersonated_cwid` precisely so "who drafted this NIH text, and on whose
 * behalf" survives the artifact — and a delegate, unit-admin curator or superuser may delete a
 * scholar's runs, so the deletion itself is an act that has to be attributable. The B03 row is
 * appended INSIDE the same transaction as the delete: either both land or neither does, so there
 * is no path that erases a run without recording it. `beforeValues` carries what IDENTIFIES the
 * erased run (mode, prompt version, model, entry count, when, who ran it) and never the generated
 * narrative — re-persisting the prose in the audit log would defeat the delete.
 *
 * UNLIKE the Matcha DELETE, which fans out over `descriptionHash` because the officer names a
 * PASTE and every re-run of it carries the sponsor's verbatim words, here the run IS the unit the
 * scholar names: each row is a distinct draft with its own settings and output, and the button
 * sits on that row. So the delete is keyed on the row `id`, exactly one row.
 *
 * AUTHORIZATION IS KEYED ON THE ROW'S OWN `cwid`, read back before the predicate runs — never a
 * caller-supplied target. Nothing in the request body names a scholar, so there is no target to
 * aim: an actor can only delete a run belonging to someone they may already edit.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work (as GET does).
  if (!isBiosketchGenerateEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  const { generationId } = body;
  if (typeof generationId !== "string" || generationId.length === 0 || generationId.length > 64) {
    return editError(400, "invalid_generation_id", "generationId");
  }

  // The row is read BEFORE authorization because its `cwid` IS the authorization key.
  let row: {
    id: string;
    cwid: string;
    mode: string;
    model: string;
    promptVersion: string | null;
    entries: unknown;
    createdByCwid: string;
    impersonatedCwid: string | null;
    createdAt: Date;
  } | null;
  try {
    row = await db.read.biosketchGeneration.findUnique({
      where: { id: generationId },
      select: {
        id: true,
        cwid: true,
        mode: true,
        model: true,
        promptVersion: true,
        entries: true,
        createdByCwid: true,
        impersonatedCwid: true,
        createdAt: true,
      },
    });
  } catch (err) {
    logEditFailure(`${PATH}#delete`, err);
    return editError(500, "read_failed");
  }
  // Already gone is the 404 the client expects on a double-click or a retry, not a 500 — and it
  // is also what a caller probing another scholar's id sees, which tells them nothing.
  if (!row) return editError(404, "not_found");

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: row.cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: row.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  const deleted = row;
  try {
    await db.write.$transaction(async (tx) => {
      await tx.biosketchGeneration.delete({ where: { id: deleted.id } });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "biosketch_generation",
        targetEntityId: deleted.id,
        action: "biosketch_generation_delete",
        fieldsChanged: null,
        // Identity of the erased run ONLY — enough to say what was deleted and to reconcile it
        // against a generate-time record, with none of the drafted prose.
        beforeValues: {
          cwid: deleted.cwid,
          mode: deleted.mode,
          model: deleted.model,
          promptVersion: deleted.promptVersion,
          entryCount: coerceEntries(deleted.entries).length,
          createdByCwid: deleted.createdByCwid,
          impersonatedCwid: deleted.impersonatedCwid,
          createdAt: deleted.createdAt.toISOString(),
          // Amendment 4 — a unit-admin curator's edit records the unit it rode in on.
          ...(authz.viaUnitAdminUnit
            ? {
                edited_via: "unit_admin",
                via_unit_type: authz.viaUnitAdminUnit.kind,
                via_unit_code: authz.viaUnitAdminUnit.code,
              }
            : {}),
        },
        afterValues: null,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(`${PATH}#delete`, err);
    return editError(500, "write_failed");
  }

  return editOk({ deleted: deleted.id });
}
