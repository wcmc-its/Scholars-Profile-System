/**
 * `POST /api/edit/orcid-queue/decide` — one librarian decision on the ORCID
 * queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md).
 *
 * Body `{ cwid, orcid, decision: "confirm" | "dismiss", replace?,
 * dismissOthers?, noneOfThese? }`.
 *  - confirm: the pair must be in `orcid_candidate_evidence`. Same write as
 *    `POST /api/edit/orcid` (`scholar.orcid`, `orcid_confirmed_at`, the pair's
 *    dismissal deleted) plus `orcid_confirm_method = "librarian"` and
 *    `orcid_confirmed_by` = the real librarian. An iD already on file is a 409;
 *    a DIFFERENT iD on file (Conflicts tab) is a 409 unless `replace: true`,
 *    which also dismisses the replaced iD.
 *  - dismiss: an `orcid_dismissal` row ("Not this person"). On an iD the ETL
 *    email-confirmed it is the Undo: `scholar.orcid` and its confirmation are
 *    cleared too. Any other iD on file is a 409 (that is Remove on /edit).
 *  - confirm on a dismissed pair is a 409 `dismissed`: a librarian never
 *    overrides the scholar's own Remove or an earlier Not this person.
 *  - `dismissOthers` (v2): the scholar's OTHER candidate iDs to mark Not this
 *    person in the same transaction ("Also mark the others Not this person" on
 *    a confirm; v3 "None of these" is a dismiss with the rest here and
 *    `noneOfThese: true`, which the audit rows record). Each must be one of the
 *    scholar's candidates in the evidence table (404 `other_not_in_queue`
 *    rolls the whole decision back) and gets its own dismissal and audit row.
 * One transaction with its audit row (`orcid_librarian_confirm` /
 * `orcid_librarian_dismiss`); the profile is re-reflected after commit.
 *
 * Gates, in order: `ORCID_LIBRARIAN_QUEUE` (404 when off), the shared preamble
 * (session, live superuser re-check, same-origin), View as (403: an
 * impersonated decision would never be the librarian's), `isSuperuser` (403).
 * The cwid is not shape-checked: Cornell NetIDs come later.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { normalizeOrcid } from "@/lib/edit/orcid";
import { isOrcidLibrarianQueueEnabled } from "@/lib/edit/orcid-queue";
import {
  confirmPair,
  dismissOthers,
  dismissPair,
  OrcidQueueRefused,
} from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/decide";
/** A scholar's candidate iDs are a handful; more is a malformed body. */
const MAX_OTHERS = 20;

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

  const { cwid, decision, replace } = body;
  if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const orcid = typeof body.orcid === "string" ? normalizeOrcid(body.orcid) : null;
  if (!orcid) return editError(400, "invalid_orcid", "orcid");
  if (decision !== "confirm" && decision !== "dismiss")
    return editError(400, "invalid_body", "decision");
  const noneOfThese = body.noneOfThese === true;
  if (noneOfThese && decision !== "dismiss") return editError(400, "invalid_body", "noneOfThese");
  let others: string[] = [];
  if (body.dismissOthers !== undefined) {
    const raw = body.dismissOthers;
    if (!Array.isArray(raw) || raw.length > MAX_OTHERS || (decision === "dismiss" && !noneOfThese))
      return editError(400, "invalid_body", "dismissOthers");
    const ids = raw.map((o) => (typeof o === "string" ? normalizeOrcid(o) : null));
    if (ids.some((o) => o === null)) return editError(400, "invalid_orcid", "dismissOthers");
    others = [...new Set(ids as string[])].filter((o) => o !== orcid);
  }

  const ts = new Date();
  const meta = { actor: realCwid, impersonatedCwid, requestId, ts, noneOfThese };
  let undid = false;
  let dismissed: string[] = [];
  try {
    await db.write.$transaction(async (tx) => {
      if (decision === "confirm")
        await confirmPair(tx, { cwid, orcid, replace: replace === true }, meta);
      else undid = (await dismissPair(tx, { cwid, orcid }, meta)).undid;
      if (others.length > 0) dismissed = await dismissOthers(tx, cwid, orcid, others, meta);
    });
  } catch (err) {
    if (err instanceof OrcidQueueRefused) return editError(err.status, err.code);
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // The iD feeds the profile's JSON-LD sameAs: reflect a change to scholar.orcid.
  if (decision === "confirm" || undid) {
    try {
      const s = await db.read.scholar.findUnique({ where: { cwid }, select: { slug: true } });
      if (s) await reflectOverviewEdit(s.slug);
    } catch (err) {
      logEditFailure(`${PATH}#reflect`, err);
    }
  }

  return editOk({
    decision,
    undid,
    ...(dismissed.length > 0 ? { dismissed } : {}),
  });
}
