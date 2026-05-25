import { NextResponse, type NextRequest } from "next/server";
import { getDefaultReturnPath } from "@/lib/auth/config";
import { safeReturnPath } from "@/lib/auth/return-path";
import { createSessionCookie } from "@/lib/auth/session";
import { validateSamlResponse, type SamlValidationResult } from "@/lib/auth/saml";

/**
 * POST /api/auth/saml/callback — the SAML Assertion Consumer Service (B01 #100).
 *
 * The IdP delivers the SAMLResponse here as an auto-submitted form POST. On a
 * valid assertion: mint the session cookie for the CWID and 302-redirect to
 * the RelayState path (re-confined to the `/edit` surface). On any failure: a
 * minimal error page and no session — the failure reason is logged, never
 * shown, so a probe learns nothing about which check failed.
 */
export const dynamic = "force-dynamic";

/** `message` must always be a fixed literal — it is interpolated into HTML. */
function errorPage(status: number, message: string): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a">
<h1 style="font-size:1.25rem">Sign-in could not be completed</h1>
<p>${message}</p>
<p><a href="/edit">Return to sign-in</a></p>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, "The sign-in response was malformed.");
  }

  const samlResponse = form.get("SAMLResponse");
  if (typeof samlResponse !== "string" || samlResponse.length === 0) {
    return errorPage(400, "The sign-in response was missing.");
  }

  let result: SamlValidationResult;
  try {
    result = await validateSamlResponse(samlResponse);
  } catch {
    // getSamlEnv() threw — SAML is not configured on this deployment.
    return errorPage(503, "Sign-in is temporarily unavailable.");
  }

  if (!result.ok) {
    console.warn(
      JSON.stringify({ event: "saml_callback_failed", reason: result.reason }),
    );
    return errorPage(401, "Your sign-in could not be verified. Please try again.");
  }

  const relayState = form.get("RelayState");
  const dest = safeReturnPath(
    typeof relayState === "string" ? relayState : null,
    getDefaultReturnPath(),
  );
  // Relative Location, NOT new URL(dest, request.url): behind CloudFront -> ALB
  // -> Fargate, request.url is the container's internal address
  // (e.g. http://ip-10-0-0-0.ec2.internal:3000) -- absolutizing against it sends
  // the browser to an unreachable host after a successful login. A relative
  // Location is resolved by the browser against the public URL it actually
  // requested (the registered ACS host). `dest` is already validated to a safe,
  // same-origin path by safeReturnPath (leading slash, no CR/LF), so a relative
  // Location cannot become an open redirect.
  const response = new NextResponse(null, {
    status: 302,
    headers: { Location: dest },
  });
  const cookie = await createSessionCookie(result.cwid);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
