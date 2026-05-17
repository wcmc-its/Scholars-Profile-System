import { NextResponse } from "next/server";
import { getServiceProviderMetadata } from "@/lib/auth/saml";

/**
 * GET /api/auth/saml/metadata — the SAML SP metadata XML (B01 #100).
 *
 * Hand this URL to the WCM identity team to register the service provider.
 * Never cached — the CloudFront `/api/auth/*` behavior is `CachingDisabled`
 * (B01 plan §6) and the document reflects the live SP config.
 */
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  let xml: string;
  try {
    xml = getServiceProviderMetadata();
  } catch {
    // SAML_* not yet configured — the SP cannot be registered until it is.
    return NextResponse.json(
      { error: "SAML SP is not configured" },
      { status: 503 },
    );
  }
  return new NextResponse(xml, {
    status: 200,
    headers: {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
