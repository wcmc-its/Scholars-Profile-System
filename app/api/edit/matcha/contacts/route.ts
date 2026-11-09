/**
 * `/api/edit/matcha/contacts` — Matcha contact: the email addresses of researchers the officer
 * picked on one search, for a `mailto:` Bcc (or a copied address list). Nothing is sent from SPS.
 *
 * POST `{ submissionId, cwids[] }` → `{ contacts: [{ cwid, name, email }], missing: [{ cwid, name }],
 *   officer: { name, email } }`. Called on click only, so addresses never sit in the page.
 *
 * Gate: exactly the brief-drafting gate (superuser / developer; an observer gets 403) behind the
 * same `MATCHA` + `MATCHA_BRIEF` flags (404 when off).
 *
 * TRUST BOUNDARY, as the brief POST: the client names a submission (in the caller's scope) and
 * PIs; a cwid absent from that search's SAVED result is refused (400), so this cannot be used as a
 * general directory lookup. At most `SCHOLAR_EXPORT_CAP` (50) people per request: more is REFUSED
 * with 400, never truncated (the scholar-export policy cap).
 *
 * Address rule: the #847 SCOPE-export rule, not the unit-roster one — the officer is not these
 * researchers' unit admin, so the audience matches the capped scope export
 * (`lib/api/export-scholars.ts`): `exportEmailCell` (the `SCHOLAR_LIST_EXPORT_EMAIL` kill switch
 * and the hidden-role carve) AND the release-code filter (`isEmailExportableByReleaseCode`, live
 * where `PROFILE_EMAIL_RELEASE_GATE` is on), on ACTIVE Scholar rows only. Anyone without an address comes back in `missing`, never silently
 * dropped. Addresses are never written to the report page or any stored row.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isMatchaEnabled } from "@/lib/api/matcha";
import {
  canWriteMatchaBriefs,
  isMatchaBriefEnabled,
  loadStoredResult,
  matchaSubmissionScope,
} from "@/lib/api/matcha-brief";
import { loadOfficerContact } from "@/lib/api/matcha-report";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  exportEmailCell,
  isEmailExportableByReleaseCode,
} from "@/lib/profile/email-visibility-flags";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/matcha/contacts";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(isMatchaEnabled() && isMatchaBriefEnabled()))
    return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!canWriteMatchaBriefs(session)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_contact",
    });
    return editError(403, "not_developer_contact");
  }

  const { submissionId, cwids } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }
  if (
    !Array.isArray(cwids) ||
    cwids.length === 0 ||
    !cwids.every((c) => typeof c === "string" && c.length > 0 && c.length <= 32)
  ) {
    return editError(400, "invalid_cwids", "cwids");
  }
  const wanted = [...new Set(cwids as string[])];
  // Refused whole above the policy cap — never truncated to fit.
  if (wanted.length > SCHOLAR_EXPORT_CAP) return editError(400, "over_contact_cap", "cwids");

  try {
    const sub = await db.read.sponsorMatchSubmission.findUnique({
      where: { id: submissionId, ...matchaSubmissionScope(session) },
      select: { descriptionHash: true },
    });
    if (!sub) return editError(404, "not_found");
    const stored = await loadStoredResult(sub.descriptionHash, wanted);
    if (!stored) return editError(409, "no_stored_result");
    const byCwid = new Map(stored.candidates.map((c) => [c.cwid, c]));
    if (!wanted.every((c) => byCwid.has(c))) {
      return editError(400, "cwid_not_in_results", "cwids");
    }

    const [rows, officer] = await Promise.all([
      db.read.scholar.findMany({
        where: { cwid: { in: wanted }, deletedAt: null, status: "active" },
        select: {
          cwid: true,
          preferredName: true,
          email: true,
          roleCategory: true,
          emailVisibility: true,
        },
      }),
      loadOfficerContact(realCwid),
    ]);
    const rowBy = new Map(rows.map((r) => [r.cwid, r]));

    const contacts: { cwid: string; name: string; email: string }[] = [];
    const missing: { cwid: string; name: string }[] = [];
    for (const cwid of wanted) {
      const r = rowBy.get(cwid);
      const name = r?.preferredName ?? byCwid.get(cwid)!.name;
      const email =
        r && isEmailExportableByReleaseCode(r.emailVisibility)
          ? exportEmailCell({ email: r.email?.trim() || null, roleCategory: r.roleCategory })
          : "";
      if (email) contacts.push({ cwid, name, email });
      else missing.push({ cwid, name });
    }

    const res = editOk({
      contacts,
      missing,
      officer: {
        name: officer.name === realCwid ? "" : officer.name,
        email: officer.email,
        dept: officer.dept,
      },
    });
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) {
    logEditFailure(`${PATH}#post`, err);
    return editError(500, "contacts_unavailable");
  }
}
