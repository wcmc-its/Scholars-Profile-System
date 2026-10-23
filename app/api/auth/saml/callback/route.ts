import { NextResponse, type NextRequest } from "next/server";
import { getDefaultReturnPath } from "@/lib/auth/config";
import { safeReturnPath } from "@/lib/auth/return-path";
import { createSessionCookie } from "@/lib/auth/session";
import { validateSamlResponse, type SamlValidationResult } from "@/lib/auth/saml";
import { markAssertionConsumed } from "@/lib/auth/saml-assertion-store";

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

/** Real SAML POST-binding responses are tens of KB; anything past this is not one. */
const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

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

/**
 * Read the body as text, giving up once it passes `limit` bytes, so a chunked
 * body with no (or a lying) Content-Length never reaches URLSearchParams or the
 * XML parser past the cap. Returns null when the cap is exceeded.
 *
 * This bounds what THIS handler holds and parses, not what the server ingests:
 * see the note in POST about the proxy's body clone.
 */
async function readBodyCapped(request: NextRequest, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

function bodyTooLarge(): NextResponse {
  console.warn(JSON.stringify({ event: "saml_callback_failed", reason: "body_too_large" }));
  return errorPage(413, "The sign-in response was too large.");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Cap the body BEFORE parsing: the XML is parsed ahead of the signature
  // check, so an unauthenticated multi-MB POST would otherwise cost CPU and
  // memory in URLSearchParams and the XML parser. Reject an oversize declared
  // Content-Length before the handler touches the body, and enforce the same
  // cap while streaming for chunked or under-declared bodies.
  //
  // What this does NOT bound is ingestion. proxy.ts's matcher covers this path,
  // and for any proxied POST Next 16 clones the body (one copy for the proxy,
  // one buffered for the handler) and waits for the client to finish sending
  // before the handler runs, so up to experimental.proxyClientMaxBodySize
  // (default 10 MiB; not set in next.config.ts) is already in memory, twice,
  // by the time this check runs (next-server runMiddleware: cloneBodyStream +
  // finalize). That cost applies to every proxied POST route, not just this one.
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > MAX_CALLBACK_BODY_BYTES) return bodyTooLarge();

  // The POST binding is an auto-submitted urlencoded HTML form, never multipart.
  // Non-form content types were already a 400 under request.formData().
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return errorPage(400, "The sign-in response was malformed.");
  }

  let form: URLSearchParams;
  try {
    const body = await readBodyCapped(request, MAX_CALLBACK_BODY_BYTES);
    if (body === null) return bodyTooLarge();
    form = new URLSearchParams(body);
  } catch {
    return errorPage(400, "The sign-in response was malformed.");
  }

  const samlResponse = form.get("SAMLResponse");
  if (!samlResponse) {
    return errorPage(400, "The sign-in response was missing.");
  }

  let result: SamlValidationResult;
  try {
    result = await validateSamlResponse(samlResponse);
  } catch {
    // getSamlEnv() threw — SAML is not configured on this deployment.
    return errorPage(500, "Sign-in is temporarily unavailable.");
  }

  if (!result.ok) {
    console.warn(
      JSON.stringify({ event: "saml_callback_failed", reason: result.reason }),
    );
    return errorPage(401, "Your sign-in could not be verified. Please try again.");
  }

  // Enforce single-use of the assertion before minting a session (#1439). The
  // ledger is shared across Fargate tasks, so a duplicate SAMLResponse — even
  // one routed to a different task than the original — is caught here. Fail
  // closed: if the assertion cannot be durably recorded, do not sign in.
  let consumed: { duplicate: boolean };
  try {
    consumed = await markAssertionConsumed(result.assertion);
  } catch {
    console.warn(
      JSON.stringify({
        event: "saml_callback_failed",
        reason: "assertion_store_unavailable",
      }),
    );
    return errorPage(500, "Sign-in is temporarily unavailable.");
  }
  if (consumed.duplicate) {
    console.warn(
      JSON.stringify({ event: "saml_callback_failed", reason: "assertion_reused" }),
    );
    return errorPage(401, "Your sign-in could not be verified. Please try again.");
  }

  const dest = safeReturnPath(form.get("RelayState"), getDefaultReturnPath());
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
