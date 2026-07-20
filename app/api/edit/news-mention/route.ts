/**
 * /api/edit/news-mention — the scholar-facing curation of their own PUBLISHED
 * news mentions (`news_mention`, docs/2026-07-18-news-mentions-plan.md):
 *
 *   GET  ?cwid=<target>  — list the target's published mentions (defaults to self).
 *   POST { action, id }  — one write:
 *       - `hide`   — drop the mention from the public profile (showOnProfile=false)
 *       - `show`   — restore it (showOnProfile=true)
 *       - `reject` — "not me": mark the mention rejected (terminal, hidden)
 *
 * Authorization rides the SAME `authorizeOverviewWrite` predicate as the bio /
 * honors / self-asserted-appointment surfaces (self OR superuser OR comms_steward
 * OR granted proxy OR org-unit owner/curator), keyed on the mention's OWNING
 * scholar. Approving a PENDING name-match is NOT here — that is the comms queue
 * (`/edit/news-queue`), deliberately blocked from the `self` leg so a scholar can
 * never self-confirm a mention onto their own profile.
 *
 * Every write sets `entered_by_cwid` (marking the row human-touched, so the ETL
 * never reverts it), appends one B03 audit row (`news_mention_update`), and
 * reflects the owner's profile page. `news_mention` is profile-only, so the
 * reflection is complete.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import {
  editError,
  editOk,
  logEditFailure,
  readEditRequest,
  resolveEditIdentity,
} from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

const PATH = "/api/edit/news-mention";

const WRITE_ACTIONS = ["hide", "show", "reject"] as const;
type WriteAction = (typeof WRITE_ACTIONS)[number];
function isWriteAction(value: string): value is WriteAction {
  return (WRITE_ACTIONS as readonly string[]).includes(value);
}

type StoredRow = {
  id: string;
  cwid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  status: string;
  source: string;
  showOnProfile: boolean;
};

function serialize(row: StoredRow) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString().slice(0, 10) : null,
    status: row.status,
    source: row.source,
    showOnProfile: row.showOnProfile,
  };
}

// ---------------------------------------------------------------------------
// GET — the target's PUBLISHED mentions (hidden ones included so the card can
// un-hide). Pending/rejected rows are the queue's concern, not the profile card.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

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
    const rows = await db.read.newsMention.findMany({
      where: { cwid: targetCwid, status: "published" },
      orderBy: [{ publishedAt: "desc" }],
    });
    return editOk({ news: rows.map(serialize) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}

// ---------------------------------------------------------------------------
// POST — hide / show / reject one mention.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { action } = body;
  if (typeof action !== "string" || !isWriteAction(action)) {
    return editError(400, "invalid_action", "action");
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    return editError(400, "invalid_id", "id");
  }
  const rowId = body.id;

  const existing = (await db.read.newsMention.findUnique({
    where: { id: rowId },
  })) as StoredRow | null;
  if (!existing) return editError(404, "news_mention_not_found", "id");

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: existing.cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: existing.cwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  const before = { status: existing.status, showOnProfile: existing.showOnProfile };
  const patch =
    action === "reject"
      ? { status: "rejected" as const, fieldsChanged: ["status"] }
      : { showOnProfile: action === "show", fieldsChanged: ["showOnProfile"] };
  const { fieldsChanged, ...data } = patch;

  let updated: StoredRow;
  try {
    updated = await db.write.$transaction(async (tx) => {
      const row = await tx.newsMention.update({
        where: { id: rowId },
        // entered_by_cwid marks the row human-touched so the ETL never reverts it.
        data: { ...data, enteredByCwid: realCwid },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "news_mention",
        targetEntityId: rowId,
        action: "news_mention_update",
        fieldsChanged,
        beforeValues: before,
        afterValues: { status: row.status, showOnProfile: row.showOnProfile },
        ts: new Date(),
        requestId,
      });
      return row as StoredRow;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectOwnerProfile(existing.cwid);
  return editOk({ action, news: serialize(updated) });
}

/** Reflect the owner's profile page post-commit — the only surface these rows
 *  render on (no aggregate serializer reads `news_mention`). */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
