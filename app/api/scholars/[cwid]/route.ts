import { NextResponse } from "next/server";
import { getScholarByCwid } from "@/lib/api/scholars";

/**
 * GET /api/scholars/:cwid
 *
 * The route file is a thin delegator to a pure function in `lib/api/*` so that
 * if production architecture pivots to a separate Scholar API service (per
 * Mohammad's preliminary preference), the handler lifts cleanly without touching
 * Next.js-specific code. Same shape applies to all forthcoming /api/* routes.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ cwid: string }> },
) {
  const { cwid } = await context.params;
  const result = await getScholarByCwid(cwid);
  if (!result) {
    return NextResponse.json({ error: "Scholar not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
