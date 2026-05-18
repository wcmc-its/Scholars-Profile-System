/**
 * B01 — SAML SP wiring (issue #100).
 *
 * Wraps @node-saml/node-saml: builds the SAML service-provider instance from
 * `getSamlEnv()` and exposes the three operations the auth routes need — the
 * AuthnRequest redirect URL, SAMLResponse validation, and SP metadata.
 *
 * Node-runtime only. node-saml uses Node `crypto` and XML parsing, so this
 * module — and anything importing it — must never be pulled into the Edge
 * middleware bundle. Middleware deals only with the already-minted session
 * cookie (`lib/auth/session.ts`).
 */
import { SAML, SamlStatusError, ValidateInResponseTo } from "@node-saml/node-saml";
import type { Profile, SamlConfig } from "@node-saml/node-saml";
import { getSamlEnv, type SamlEnv } from "@/lib/auth/config";

let cached: { saml: SAML; env: SamlEnv } | null = null;

/** Build (once) and return the configured SAML SP plus the env it came from. */
function ensureSaml(): { saml: SAML; env: SamlEnv } {
  if (cached) return cached;
  const env = getSamlEnv();
  const config: SamlConfig = {
    // --- IdP ---
    idpCert: env.idpCert,
    entryPoint: env.idpSsoUrl,
    // --- SP ---
    issuer: env.spEntityId,
    callbackUrl: env.spAcsUrl,
    audience: env.spEntityId,
    // --- Security posture ---
    // Require the assertion itself to be signed; whether the response envelope
    // must also be signed is configurable (some IdPs sign only the assertion —
    // B01 plan OQ3).
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: env.wantAuthnResponseSigned,
    acceptedClockSkewMs: env.clockSkewMs,
    // Stateless: no server-side request-ID cache, so InResponseTo is not
    // checked against one (B01 plan OQ6). Replay protection rests on the
    // assertion signature, a tight NotOnOrAfter window, and the audience.
    validateInResponseTo: ValidateInResponseTo.never,
    // Unset SAML_NAMEID_FORMAT => null => request no specific NameID format,
    // the most IdP-compatible default.
    identifierFormat: env.nameIdFormat ?? null,
    ...(env.idpEntityId ? { idpIssuer: env.idpEntityId } : {}),
    ...(env.spPrivateKey
      ? { privateKey: env.spPrivateKey, decryptionPvk: env.spPrivateKey }
      : {}),
    ...(env.spCert ? { publicCert: env.spCert } : {}),
  };
  cached = { saml: new SAML(config), env };
  return cached;
}

/**
 * Build the IdP redirect URL for an AuthnRequest. `relayState` is echoed back
 * by the IdP to the ACS unchanged — B01 carries the post-login return path in
 * it (validated by `lib/auth/return-path.ts`).
 */
export async function getLoginRedirectUrl(relayState: string): Promise<string> {
  return ensureSaml().saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

export type SamlValidationResult =
  | { ok: true; cwid: string }
  | { ok: false; reason: string };

/**
 * Validate a base64 `SAMLResponse` from the ACS POST. node-saml verifies the
 * signature, the NotBefore / NotOnOrAfter window, and the audience; this
 * wrapper adds CWID extraction and maps every failure to a stable `reason`
 * string. It never throws and never leaks assertion internals to the caller.
 */
export async function validateSamlResponse(
  samlResponseB64: string,
): Promise<SamlValidationResult> {
  const { saml, env } = ensureSaml();
  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({
      SAMLResponse: samlResponseB64,
    }));
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof SamlStatusError ? "idp_status_error" : "invalid_saml_response",
    };
  }
  if (!profile) return { ok: false, reason: "no_profile" };
  const cwid = extractCwid(profile, env.cwidAttribute);
  if (!cwid) return { ok: false, reason: "no_cwid" };
  return { ok: true, cwid };
}

/**
 * Pull the CWID from a validated SAML profile: the configured attribute
 * (`SAML_CWID_ATTRIBUTE`), or the assertion NameID when that is unset.
 * Tolerates a single-element array value (multi-valued attributes).
 */
export function extractCwid(
  profile: Profile,
  cwidAttribute: string | undefined,
): string | null {
  const raw: unknown = cwidAttribute ? profile[cwidAttribute] : profile.nameID;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** SP metadata XML — hand the `/api/auth/saml/metadata` URL to WCM identity. */
export function getServiceProviderMetadata(): string {
  const { saml, env } = ensureSaml();
  const cert = env.spCert ?? null;
  return saml.generateServiceProviderMetadata(cert, cert);
}
