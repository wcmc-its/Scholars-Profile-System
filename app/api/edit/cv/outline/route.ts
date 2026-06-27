/**
 * GET /api/edit/cv/outline (scholar-CV generator, spec §8).
 *
 * Returns the document-ordered OUTLINE of the WCM CV — every template section
 * (A–S) with what Scholars/POPS fills (count + a capped item preview) — so the
 * `/edit` "CV (WCM format)" tool can SHOW the scholar what their download will
 * contain before they generate it. The outline is derived from the same
 * `ProfilePayload`/POPS/mentee data the CV `.docx` is built from (`cvOutline`),
 * minus the §15 LLM summary (which is drafted only at download).
 *
 * Auth + targeting mirror the sibling POPS preview / CV download routes exactly:
 * `?cwid=` defaults to the session cwid (self); a foreign target is gated by the
 * SAME `authorizeOverviewWrite` predicate (no drift). Flag-gated behind
 * `EDIT_CV_EXPORT` (off ⇒ 404). Mentees re-apply the mentor's FERPA hide choices
 * (the loader does not). Read-only; nothing is persisted.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { cvOutline, isCvEnabled, type PopsEnrichment } from "@/lib/edit/cv-export";
import { fetchPops } from "@/lib/edit/pops";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { getScholarFullProfileBySlug } from "@/lib/api/profile";
import { getMenteesForMentor } from "@/lib/api/mentoring";
import { filterHiddenMentees, hiddenMenteeCwids } from "@/lib/mentee-suppression";

const PATH = "/api/edit/cv/outline";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isCvEnabled()) return editError(404, "not_found");

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
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: targetCwid },
      select: { slug: true },
    });
    if (!scholar) return editError(404, "scholar_not_found", "cwid");
    const profile = await getScholarFullProfileBySlug(scholar.slug);
    if (!profile) return editError(404, "scholar_not_found", "cwid");

    // POPS — clinical faculty only, best-effort (a failure just drops clinical rows).
    const pops: PopsEnrichment | null = profile.hasClinicalProfile
      ? await fetchPops(targetCwid).catch(() => null)
      : null;

    // Mentees + FERPA carve: re-apply the mentor's hide choices the loader omits.
    const { mentees: menteesAll } = await getMenteesForMentor(targetCwid, { includeCopubs: false });
    const suppressions =
      menteesAll.length > 0
        ? await db.read.suppression.findMany({
            where: {
              entityType: "mentee",
              entityId: { startsWith: `${targetCwid}:` },
              contributorCwid: null,
              revokedAt: null,
            },
            select: { entityId: true },
          })
        : [];
    const mentees = filterHiddenMentees(menteesAll, hiddenMenteeCwids(targetCwid, suppressions));

    // Historical appointments (#1323) — the CV exports ALL `ED-HISTORICAL` rows
    // regardless of `showOnProfile`; they are not in the active-only payload, so
    // load them directly for the outline to mirror the .docx.
    const historicalRows = await db.read.appointment.findMany({
      where: { cwid: targetCwid, source: "ED-HISTORICAL" },
      select: { title: true, organization: true, startDate: true, endDate: true },
      orderBy: { endDate: "desc" },
    });
    const historicalAppointments = historicalRows.map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isActive: false,
    }));

    return editOk({ outline: cvOutline({ profile, mentees, pops, historicalAppointments }) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
