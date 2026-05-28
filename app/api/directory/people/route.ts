/**
 * GET /api/directory/people — SSO-gated WCM directory lookup backing the
 * unit-curation typeaheads (#540 Phase 7, `unit-curation-edit-ui-spec.md` § 13).
 *
 * Two modes (exactly one per request):
 *   - `?q=<fragment>`   name-fragment search (min 2 chars), capped at 20 rows.
 *   - `?cwids=a,b,c`    batch hydration of up to 50 CWIDs to name/title/dept.
 *
 * Reads the enterprise directory (ED/LDAP) — NOT the Scholars corpus — because
 * grantees and leaders are often administrative staff with no Scholar profile.
 * Minimal attribute list (name + title + dept); never PII. This is a read
 * endpoint, so no audit row. Any authenticated `/edit/*` user may call it;
 * the directory is already an internal resource and carries no editable state.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEditSession } from "@/lib/auth/superuser";
import {
  fetchDirectoryPeopleByCwid,
  searchDirectoryPeopleByName,
  type DirectoryPerson,
} from "@/lib/sources/ldap";

export const dynamic = "force-dynamic";

const CWID_PATTERN = /^[A-Za-z0-9]{3,16}$/;
const MAX_CWIDS = 50;
const MIN_QUERY_LENGTH = 2;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEditSession();
  if (!session) return jsonError(401, "unauthenticated");

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const cwidsParam = searchParams.get("cwids");

  // Exactly one mode.
  if ((q === null) === (cwidsParam === null)) {
    return jsonError(400, "exactly_one_of_q_or_cwids");
  }

  let people: DirectoryPerson[];
  try {
    if (q !== null) {
      const trimmed = q.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) return jsonError(400, "query_too_short");
      people = await searchDirectoryPeopleByName(trimmed);
    } else {
      const cwids = (cwidsParam ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cwids.length === 0) return jsonError(400, "no_cwids");
      if (cwids.length > MAX_CWIDS) return jsonError(400, "too_many_cwids");
      if (!cwids.every((c) => CWID_PATTERN.test(c))) return jsonError(400, "invalid_cwid");
      people = await fetchDirectoryPeopleByCwid(cwids);
    }
  } catch {
    // The LDAP module throws on unset config or an unreachable directory. A 503
    // lets the typeahead show a "Search failed" state without leaking detail.
    return jsonError(503, "directory_unavailable");
  }

  return NextResponse.json({ ok: true, people }, { headers: NO_STORE });
}
