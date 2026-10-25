/**
 * `POST /api/edit/orcid-queue/decide` — one librarian decision on the ORCID
 * queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md).
 *
 * Body `{ cwid, orcid, decision: "confirm" | "dismiss", sampleId?, replace?,
 * dismissOthers? }`.
 *  - confirm: the pair must be in `orcid_candidate_evidence`. Same write as
 *    `POST /api/edit/orcid` (`scholar.orcid`, `orcid_confirmed_at`, the pair's
 *    dismissal deleted) plus `orcid_confirm_method = "librarian"` and
 *    `orcid_confirmed_by` = the real librarian. An iD already on file is a 409;
 *    a DIFFERENT iD on file (Conflicts tab) is a 409 unless `replace: true`,
 *    which also dismisses the replaced iD.
 *  - dismiss: an `orcid_dismissal` row ("Not this person"). On an iD the ETL
 *    email-confirmed it is the Undo: `scholar.orcid` and its confirmation are
 *    cleared too. Any other iD on file is a 409 (that is Remove on /edit).
 *  - `sampleId`: the decision also stamps that sample's row, which must exist
 *    and be undecided. A sampled confirm whose iD went on file by another route
 *    since the sample was drawn (self or proxy confirm, the Identity import, an
 *    `rpm_admin` row) stamps the row confirmed and writes nothing else, so the
 *    sample can still finish. Returns `alreadyOnFile: true` then.
 *  - confirm on a dismissed pair is a 409 `dismissed`: a librarian never
 *    overrides the scholar's own Remove or an earlier Not this person.
 *  - `dismissOthers` (v2, confirm only): the scholar's OTHER candidate iDs to
 *    mark Not this person in the same transaction ("Confirm, and mark the
 *    others not this person" on a card). Each must be one of the scholar's
 *    candidates in the evidence table (404 `other_not_in_queue` rolls the whole
 *    decision back) and gets its own dismissal and audit row.
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
  stampSampleRow,
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

  const { cwid, decision, sampleId, replace } = body;
  if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const orcid = typeof body.orcid === "string" ? normalizeOrcid(body.orcid) : null;
  if (!orcid) return editError(400, "invalid_orcid", "orcid");
  if (decision !== "confirm" && decision !== "dismiss")
    return editError(400, "invalid_body", "decision");
  if (
    sampleId !== undefined &&
    (typeof sampleId !== "string" || sampleId.length === 0 || sampleId.length > 64)
  ) {
    return editError(400, "invalid_body", "sampleId");
  }
  let others: string[] = [];
  if (body.dismissOthers !== undefined) {
    const raw = body.dismissOthers;
    if (decision !== "confirm" || !Array.isArray(raw) || raw.length > MAX_OTHERS)
      return editError(400, "invalid_body", "dismissOthers");
    const ids = raw.map((o) => (typeof o === "string" ? normalizeOrcid(o) : null));
    if (ids.some((o) => o === null)) return editError(400, "invalid_orcid", "dismissOthers");
    others = [...new Set(ids as string[])].filter((o) => o !== orcid);
  }

  const ts = new Date();
  const meta = { actor: realCwid, impersonatedCwid, requestId, ts, sampleId: sampleId ?? null };
  let undid = false;
  let alreadyOnFile = false;
  let dismissed: string[] = [];
  try {
    await db.write.$transaction(async (tx) => {
      if (decision === "confirm") {
        try {
          await confirmPair(tx, { cwid, orcid, replace: replace === true }, meta);
        } catch (err) {
          // confirmPair refuses before any write, so the stamp below is the only write.
          const onFile = err instanceof OrcidQueueRefused && err.code === "already_on_file";
          if (!onFile || typeof sampleId !== "string") throw err;
          alreadyOnFile = true;
        }
        if (others.length > 0) dismissed = await dismissOthers(tx, cwid, orcid, others, meta);
      } else undid = (await dismissPair(tx, { cwid, orcid }, meta)).undid;
      if (typeof sampleId === "string") {
        await stampSampleRow(
          tx,
          { sampleId, cwid, orcid },
          decision === "confirm" ? "confirmed" : "dismissed",
          realCwid,
          ts,
        );
      }
    });
  } catch (err) {
    if (err instanceof OrcidQueueRefused) return editError(err.status, err.code);
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // The iD feeds the profile's JSON-LD sameAs: reflect a change to scholar.orcid.
  if ((decision === "confirm" && !alreadyOnFile) || undid) {
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
    ...(alreadyOnFile ? { alreadyOnFile: true } : {}),
    ...(dismissed.length > 0 ? { dismissed } : {}),
  });
}
