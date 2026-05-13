import { NextResponse, type NextRequest } from "next/server";
import { suggestEntities } from "@/lib/api/search";
import { hashSessionId, logAutocompleteShown } from "@/lib/api/suggest-log";

export const dynamic = "force-dynamic";

// Anonymous session cookie used only to group telemetry events from the
// same typing burst per #231 §8.b / #236 fixture-sampling requirements.
// Not auth. The cookie value is a v4 UUID; the hashed form lands in the
// log line — the raw value never does.
const TELEMETRY_COOKIE = "sps_telemetry_session";
const TELEMETRY_COOKIE_MAX_AGE_S = 24 * 60 * 60;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";

  let rawSession = request.cookies.get(TELEMETRY_COOKIE)?.value;
  let shouldMint = false;
  if (!rawSession) {
    rawSession = crypto.randomUUID();
    shouldMint = true;
  }
  const sessionId = hashSessionId(rawSession);

  const t0 = Date.now();
  const suggestions = await suggestEntities(q);
  const latencyMs = Date.now() - t0;

  logAutocompleteShown({
    query: q,
    resultCount: suggestions.length,
    latencyMs,
    sessionId,
    userAgent: request.headers.get("user-agent"),
  });

  const response = NextResponse.json({ suggestions });
  if (shouldMint) {
    response.cookies.set({
      name: TELEMETRY_COOKIE,
      value: rawSession,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: TELEMETRY_COOKIE_MAX_AGE_S,
      path: "/",
    });
  }
  return response;
}
