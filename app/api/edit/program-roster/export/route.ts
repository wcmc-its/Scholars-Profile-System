/**
 * GET /api/edit/program-roster/export?program=<id>[&year=]: one program of
 * the internal roster as an `.xlsx` (People, Mentors, Criteria), all years or
 * one. The page's search is left out on purpose: a trainee's name in a URL
 * would be kept in access logs.
 *
 * Gate: `canViewProgramRoster`, the page's own, checked before anything is
 * read; 404 for anyone else. A list of people, so `SCHOLAR_EXPORT_CAP` applies:
 * above it the download is refused, never truncated. The log line says who took
 * the file and how many rows, never who is in it.
 */
import { NextResponse, type NextRequest } from "next/server";

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { db } from "@/lib/db";
import { filterEntries, mentorCounts, peopleCount } from "@/lib/edit/program-roster";
import { canViewProgramRoster } from "@/lib/edit/program-roster-access";
import { buildProgramRosterWorkbook } from "@/lib/edit/program-roster-xlsx";
import { loadProgramRoster } from "@/lib/edit/program-roster.server";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");
  const { session, realCwid, impersonatedCwid } = identity;
  if (!canViewProgramRoster(session)) return editError(404, "not_found");

  const sp = request.nextUrl.searchParams;
  const year = sp.get("year");
  if (year && !/^\d{4}$/.test(year)) return editError(400, "invalid_year", "year");
  const filter = { year: year ? Number(year) : null, query: "" };

  const roster = await loadProgramRoster(db.read);
  const program = roster.programs.find((p) => p.id === sp.get("program"));
  if (!program) return editError(404, "program_not_found", "program");
  const inProgram = roster.entries.filter((e) => e.programId === program.id);
  const entries = filterEntries(inProgram, filter);
  if (peopleCount(entries) > SCHOLAR_EXPORT_CAP) return editError(409, "over_scholar_export_cap");

  const generatedAt = new Date();
  const buffer = await buildProgramRosterWorkbook(
    program,
    filter,
    entries,
    mentorCounts(inProgram, filter),
    generatedAt,
  );
  console.log(
    JSON.stringify({
      event: "export_program_roster",
      realCwid,
      impersonatedCwid,
      programId: program.id,
      rows: entries.length,
      ts: generatedAt.toISOString(),
    }),
  );
  const label = program.shortLabel.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "program";
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${label} roster ${generatedAt.toISOString().slice(0, 10)}.xlsx"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
