import { NextResponse, type NextRequest } from "next/server";
import { getDefaultReturnPath } from "@/lib/auth/config";
import { safeReturnPath } from "@/lib/auth/return-path";
import { getLoginRedirectUrl } from "@/lib/auth/saml";

/**
 * GET /api/auth/saml/login — begin SSO (B01 #100).
 *
 * Builds a SAML AuthnRequest and 302-redirects the browser to the WCM
 * Shibboleth IdP. The post-login destination travels in RelayState: the
 * `?return=` query, confined to the `/edit` surface by `safeReturnPath` (an
 * off-site or non-`/edit` value falls back to the default). The IdP echoes
 * RelayState back to the callback unchanged.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const relayState = safeReturnPath(
    request.nextUrl.searchParams.get("return"),
    getDefaultReturnPath(),
  );
  let redirectUrl: string;
  try {
    redirectUrl = await getLoginRedirectUrl(relayState);
  } catch {
    // getSamlEnv() threw — SAML is not configured on this deployment.
    return NextResponse.json(
      { error: "SAML SP is not configured" },
      { status: 503 },
    );
  }
  return NextResponse.redirect(redirectUrl, 302);
}
