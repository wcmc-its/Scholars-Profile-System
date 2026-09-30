/**
 * GET /api/edit/effective-flags — the feature-flag values this running task
 * actually has, plus the deployed build SHA (#1765). Compare the response with
 * the per-env block in `cdk/lib/app-stack.ts`: a flag that is set in source but
 * `null` here is merged-but-dark, waiting on `cdk deploy Sps-App-<env>`.
 *
 * Superuser-only, re-checked live on every GET against the effective session,
 * like `GET /api/edit/slugs`. It is deliberately NOT on the public `/api/health`
 * route. It reports only the names in the generated flag inventory, never the
 * whole environment.
 */
import { type NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { readEffectiveFlags } from "@/lib/diagnostics/effective-flags";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/effective-flags";

export async function GET(): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!session.isSuperuser) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: session.cwid, path: PATH, reason: "not_superuser" });
    return editError(403, "not_superuser");
  }
  const res = editOk({ ...readEffectiveFlags() });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
