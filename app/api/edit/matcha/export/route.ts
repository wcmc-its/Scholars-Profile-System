/**
 * POST /api/edit/matcha/export: the Matcha researcher list as an `.xlsx`.
 *
 * The panel posts the rows it shows (its own re-ranked, filtered list; a server re-run would
 * only know the default ranking) and gets the workbook back. Same gate as `POST
 * /api/edit/matcha`: `MATCHA` on, `readEditRequest`, then `canUseMatchaForWrite`.
 *
 * The body is untrusted: size capped at the read, shape checked here (row count, field types,
 * string lengths), unknown keys dropped. The workbook writes no formulas and links only
 * http(s) URLs (`lib/edit/matcha-xlsx.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isMatchaEnabled } from "@/lib/api/matcha";
import { logEditDenial } from "@/lib/edit/authz";
import { canUseMatchaForWrite } from "@/lib/edit/matcha-access";
import { matchaExportFilename } from "@/lib/edit/matcha-export";
import { buildMatchaWorkbook } from "@/lib/edit/matcha-xlsx";
import { editError, logEditFailure, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/matcha/export";

/** Far above a real export (a few hundred rows, briefs on a shortlist), far below abuse. */
const EXPORT_MAX_BYTES = 4 * 1024 * 1024;
const EXPORT_MAX_ROWS = 5000;

const text = (max: number) => z.string().max(max);

const RowSchema = z.object({
  rank: z.number().int().min(0).max(1_000_000),
  cwid: text(64),
  name: text(500),
  title: text(1000).nullable(),
  department: text(1000).nullable(),
  fit: text(64),
  matchedConcepts: z.array(text(500)).max(500),
  technologyCount: z.number().int().min(0).max(100_000),
  careerStage: text(100),
  clinician: text(16),
  personType: text(200),
  researcherType: text(100),
  researchKind: text(200),
  profileUrl: text(2000),
  eligible: text(16).optional(),
  briefWhy: text(20_000).optional(),
  briefAngle: text(20_000).optional(),
  briefTopics: text(40_000).optional(),
});

const ExportBodySchema = z.object({
  rows: z.array(RowSchema).max(EXPORT_MAX_ROWS),
  eligibility: z.boolean().optional(),
  brief: z.boolean().optional(),
  shortlist: z.boolean().optional(),
  title: text(500).nullable().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isMatchaEnabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request, { maxBytes: EXPORT_MAX_BYTES });
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!(await canUseMatchaForWrite(session))) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_post",
    });
    return editError(403, "not_developer_post");
  }

  const parsed = ExportBodySchema.safeParse(body);
  if (!parsed.success) return editError(400, "invalid_export", "rows");
  const { rows, eligibility, brief, shortlist, title } = parsed.data;

  try {
    const generatedAt = new Date();
    const buffer = await buildMatchaWorkbook(rows, { eligibility, brief }, generatedAt);
    const filename = matchaExportFilename(title, shortlist === true, generatedAt);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(buffer.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "export_failed");
  }
}
