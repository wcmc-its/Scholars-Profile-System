/**
 * `POST /api/edit/orcid-queue/undo` — a librarian undoes their own recent
 * decisions on the ORCID queue (`/edit/orcid-queue`): the toast's Undo after a
 * Confirm, Not this person or None of these, or after a bulk confirm.
 *
 * Body `{ items: [{ cwid, confirmed?, dismissed? }] }`, at most
 * `ORCID_BULK_MAX` items. Each item is one scholar: `confirmed` the iD this
 * librarian confirmed (cleared from `scholar.orcid`), `dismissed` the iDs they
 * marked Not this person (their dismissal rows deleted). Only the actor's own
 * writes, within `ORCID_UNDO_WINDOW_MS` (`undoLibrarianDecision`). Each item is
 * its own transaction with an `orcid_librarian_undo` audit row, so one refused
 * item (409 `state_changed` / `undo_expired`) does not block the rest.
 *
 * Gates as `decide`: the queue flag (404), the shared preamble, View as (403),
 * `isSuperuser` (403).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { normalizeOrcid } from "@/lib/edit/orcid";
import { isOrcidLibrarianQueueEnabled, ORCID_BULK_MAX } from "@/lib/edit/orcid-queue";
import { OrcidQueueRefused, undoLibrarianDecision } from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/undo";
const MAX_DISMISSED = 20;

type Item = { cwid: string; confirmed: string | null; dismissed: string[] };

function parseItems(raw: unknown): Item[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORCID_BULK_MAX) return null;
  const out: Item[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { cwid, confirmed, dismissed } = r as Record<string, unknown>;
    if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32) return null;
    const c =
      confirmed === undefined || confirmed === null ? null : normalizeOrcid(String(confirmed));
    if (confirmed !== undefined && confirmed !== null && !c) return null;
    const d = dismissed === undefined ? [] : dismissed;
    if (!Array.isArray(d) || d.length > MAX_DISMISSED) return null;
    const ids = d.map((o) => (typeof o === "string" ? normalizeOrcid(o) : null));
    if (ids.some((o) => o === null)) return null;
    if (!c && ids.length === 0) return null;
    out.push({ cwid, confirmed: c, dismissed: ids as string[] });
  }
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidLibrarianQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (impersonatedCwid !== null) return editError(403, "impersonation_refused");
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "orcid-queue",
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  const items = parseItems(body.items);
  if (!items) return editError(400, "invalid_body", "items");

  const ts = new Date();
  const meta = { actor: realCwid, impersonatedCwid, requestId, ts };
  const results: Array<{ cwid: string; ok: boolean; code?: string }> = [];
  for (const item of items) {
    try {
      await db.write.$transaction((tx) => undoLibrarianDecision(tx, item, meta));
      results.push({ cwid: item.cwid, ok: true });
    } catch (err) {
      if (err instanceof OrcidQueueRefused) {
        results.push({ cwid: item.cwid, ok: false, code: err.code });
        continue;
      }
      logEditFailure(PATH, err);
      results.push({ cwid: item.cwid, ok: false, code: "write_failed" });
    }
  }

  // The iD feeds the profile's JSON-LD sameAs: reflect a cleared scholar.orcid.
  for (const item of items) {
    if (!item.confirmed || !results.find((r) => r.cwid === item.cwid)?.ok) continue;
    try {
      const s = await db.read.scholar.findUnique({
        where: { cwid: item.cwid },
        select: { slug: true },
      });
      if (s) await reflectOverviewEdit(s.slug);
    } catch (err) {
      logEditFailure(`${PATH}#reflect`, err);
    }
  }

  return editOk({ results });
}
