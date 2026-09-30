/**
 * POST /api/edit/reports/article-count/cwid-list — store a pasted CWID list
 * for report 8's "CWID list" filter and return its id; the rail then submits
 * `list=<id>` (`lib/edit/cwid-list.ts`, `report_cwid_list`).
 *
 * Body: `{ text: string }` — the CWIDs, any separator (`parseCwidText`,
 * `lib/cwid-list-text.ts`; the rail sends them space-separated). The shared
 * preamble (`readEditRequest`: origin / content-type / session / 64 KB body)
 * runs first, then the report's own gate (`canViewArticleCountReport`: whoever
 * can open report 8 can make a list for it) ⇒ 403, then validation ⇒ 400:
 * `no_cwids` (nothing CWID-shaped), `invalid_cwids` (with the offending
 * tokens, so the rail can say which), `too_many_cwids` (over `CWID_LIST_MAX`).
 * Responds `{ ok: true, id, count }`; `created_by` is the real user, never
 * the "View as" target. Not audited: a list grants and changes
 * nothing (see the module comment in `lib/edit/cwid-list.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { canViewArticleCountReport } from "@/lib/edit/article-count-report";
import { CWID_LIST_MAX, createCwidList } from "@/lib/edit/cwid-list";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { parseCwidText } from "@/lib/cwid-list-text";

const PATH = "/api/edit/reports/article-count/cwid-list";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!(await canViewArticleCountReport(session))) return editError(403, "forbidden");

  if (typeof body.text !== "string") return editError(400, "invalid_text", "text");
  const { cwids, invalid } = parseCwidText(body.text);
  if (invalid.length > 0) {
    return NextResponse.json({ ok: false, error: "invalid_cwids", invalid: invalid.slice(0, 50) }, { status: 400 });
  }
  if (cwids.length === 0) return editError(400, "no_cwids", "text");
  if (cwids.length > CWID_LIST_MAX) return editError(400, "too_many_cwids", "text");

  try {
    // `created_by` is the human (never the "View as" target), like every
    // other /edit attribution.
    const id = await createCwidList(cwids, realCwid);
    return editOk({ id, count: cwids.length });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
