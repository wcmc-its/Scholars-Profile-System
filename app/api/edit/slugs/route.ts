/**
 * GET /api/edit/slugs — backs the slug-registry "is this slug available?"
 * checker (#497, the superuser `/edit/slugs` view). Returns the live
 * `resolveSlugStatus(slug)` verdict — the SAME format/reserved/collision checks
 * the `POST /api/edit/field` write path uses, so the answer can never disagree
 * with what an actual override write would do.
 *
 * Superuser-only, re-checked live on every GET (never cached). A read has no
 * CSRF surface and a cross-origin read can't see the response (CORS), so — like
 * `GET /api/edit/slug-request` — the session + `isSuperuser` re-check is the
 * whole gate. NOT flag-gated behind `SELF_EDIT_SLUG_REQUEST`: the namespace
 * (active/historical/override/reserved) exists regardless of the request queue.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk } from "@/lib/edit/request";
import { resolveSlugStatus } from "@/lib/api/slug-registry";

const PATH = "/api/edit/slugs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!session.isSuperuser) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: session.cwid, path: PATH, reason: "not_superuser" });
    return editError(403, "not_superuser");
  }

  const slug = request.nextUrl.searchParams.get("slug");
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return editError(400, "missing_slug", "slug");
  }

  const status = await resolveSlugStatus(slug, db.read);
  return editOk({ status });
}
