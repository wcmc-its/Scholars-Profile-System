/**
 * /api/edit/training — add or remove a scholar-entered postgraduate training row
 * (`training`, source SELF / CURATOR). ASMS rows are ETL-owned: they can only be
 * hidden (the `education` suppression, via /api/edit/suppress), never removed.
 *
 *   POST { action: "create", cwid, type, institution, specialty?, yearFrom?, yearTo? }
 *   POST { action: "delete", externalId }
 *
 * Authorization is the same `authorizeOverviewWrite` predicate the
 * self-asserted appointments use (/api/edit/appointment), keyed on the owning
 * scholar. Each write is one transaction with an audit row.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { CWID_PATTERN } from "@/lib/cwid";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type EditableUnit, type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { type TrainingInput, validateTrainingInput } from "@/lib/edit/training";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

const PATH = "/api/edit/training";

type Row = {
  externalId: string;
  cwid: string;
  type: string;
  institution: string;
  specialty: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  source: string;
};

function snapshot(row: Row, unit: EditableUnit | null): Record<string, unknown> {
  const values: Record<string, unknown> = {
    type: row.type,
    institution: row.institution,
    specialty: row.specialty,
    yearFrom: row.yearFrom,
    yearTo: row.yearTo,
    source: row.source,
  };
  return unit
    ? { ...values, edited_via: "unit_admin", via_unit_type: unit.kind, via_unit_code: unit.code }
    : values;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  let ownerCwid: string;
  let existing: Row | null = null;
  if (body.action === "create") {
    if (typeof body.cwid !== "string" || !CWID_PATTERN.test(body.cwid)) {
      return editError(400, "invalid_cwid", "cwid");
    }
    ownerCwid = body.cwid;
  } else if (body.action === "delete") {
    if (typeof body.externalId !== "string" || body.externalId.length === 0) {
      return editError(400, "invalid_external_id", "externalId");
    }
    existing = (await db.read.training.findUnique({
      where: { externalId: body.externalId },
    })) as Row | null;
    if (!existing) return editError(404, "training_not_found", "externalId");
    // ASMS rows come back every night; the scholar hides them instead.
    if (existing.source === "ASMS") return editError(409, "source_row_hide_instead", "externalId");
    ownerCwid = existing.cwid;
  } else {
    return editError(400, "invalid_action", "action");
  }

  let input: TrainingInput | null = null;
  if (body.action === "create") {
    const parsed = validateTrainingInput(body);
    if (!parsed.ok) return editError(400, parsed.error, parsed.field);
    input = parsed.value;
  }

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: ownerCwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: ownerCwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  let created: Row | null = null;
  try {
    created = await db.write.$transaction(async (tx) => {
      if (existing) {
        await tx.training.delete({ where: { externalId: existing.externalId } });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "training",
          targetEntityId: existing.externalId,
          action: "training_delete",
          fieldsChanged: null,
          beforeValues: snapshot(existing, authz.viaUnitAdminUnit),
          afterValues: null,
          ts: new Date(),
          requestId,
        });
        return null;
      }
      const row = (await tx.training.create({
        data: {
          ...(input as TrainingInput),
          cwid: ownerCwid,
          externalId: `SPS-TRAIN-${randomUUID()}`,
          // SELF when the owner enters it (incl. a "View as" overlay), else CURATOR.
          source: session.cwid === ownerCwid ? "SELF" : "CURATOR",
          enteredByCwid: realCwid,
        },
      })) as Row;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "training",
        targetEntityId: row.externalId,
        action: "training_create",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: snapshot(row, authz.viaUnitAdminUnit),
        ts: new Date(),
        requestId,
      });
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  const affected = await resolveAffectedProfiles("scholar", ownerCwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
  return created
    ? editOk({ action: "create", training: created })
    : editOk({ action: "delete", externalId: existing!.externalId, changed: true });
}
