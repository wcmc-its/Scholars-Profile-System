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
import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { SAML, SamlStatusError, ValidateInResponseTo } from "@node-saml/node-saml";
import type { Profile, SamlConfig } from "@node-saml/node-saml";
import { getSamlEnv, type SamlEnv } from "@/lib/auth/config";
import type { AssertionIdentity } from "@/lib/auth/saml-assertion-store";

let cached: { saml: SAML; env: SamlEnv } | null = null;

/**
 * Longest we accept an assertion after its IdP `IssueInstant` (plus clock
 * skew). The POST binding auto-submits within seconds; 5 minutes leaves room
 * for a slow browser without accepting a captured assertion much later.
 */
export const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;

const BEARER_METHOD = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

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
    // Caps the Conditions window at IssueInstant + this. Also enforced, with
    // the Recipient/Destination binding, in `checkResponseBinding`, because
    // node-saml skips time checks when an assertion has no Conditions.
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    // InResponseTo is not validated against a stored request id (B01 plan OQ6).
    // node-saml's request-id check is backed by an in-process cache, which does
    // not hold across the 1–2 Fargate tasks staging/prod run: an AuthnRequest
    // minted on one task and a response validated on another would spuriously
    // fail. Single-use of each assertion is enforced instead by a shared,
    // instance-independent store (`lib/auth/saml-assertion-store.ts`, #1439),
    // which is the load-bearing single-use guard; the assertion signature, a
    // tight NotOnOrAfter window, and the audience remain the other layers.
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
  | { ok: true; cwid: string; assertion: AssertionIdentity }
  | { ok: false; reason: string };

/**
 * Validate a base64 `SAMLResponse` from the ACS POST. node-saml verifies the
 * signature, the NotBefore / NotOnOrAfter window, and the audience; this
 * wrapper adds the ACS binding and age check (`checkResponseBinding`), CWID
 * extraction, and maps every failure to a stable `reason`
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
  // Bind the response to THIS environment's ACS and bound its age. node-saml
  // 5.x checks neither Recipient nor Destination, and staging and prod share
  // one SP entity ID, so the audience check cannot tell them apart.
  const bindingError = checkResponseBinding(profile, {
    acsUrl: env.spAcsUrl,
    now: new Date(),
    clockSkewMs: env.clockSkewMs,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
  });
  if (bindingError) return { ok: false, reason: bindingError };
  // Primary: the WCM-direct `CWID` attribute (or NameID when unconfigured).
  // Fallback: the eppn local-part for federated (NYP / WCM-Q) logins, which
  // arrive without a `CWID` attribute — gated by the trusted-scope allowlist.
  const cwid =
    extractCwid(profile, env.cwidAttribute) ??
    extractCwidFromEppn(profile, env.eppnAttribute, env.eppnTrustedScopes);
  if (!cwid) return { ok: false, reason: "no_cwid" };
  // Dedup key for the single-use guard (#1439). The caller records it before
  // minting a session; a second presentation of the same assertion is rejected.
  const assertion = extractAssertionIdentity(profile, samlResponseB64, {
    now: new Date(),
    clockSkewMs: env.clockSkewMs,
  });
  return { ok: true, cwid, assertion };
}

/** First non-empty, trimmed string from a SAML value (tolerates a single-element array). */
function firstStringValue(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
  return firstStringValue(raw);
}

/**
 * CWID fallback for federated logins: take the local-part of an eppn
 * (`<cwid>@<scope>`) ONLY when its scope is in `trustedScopes`. The WCM SAML
 * proxy passes NYP / WCM-Q assertions through without a `CWID` attribute but
 * with eppn (e.g. `paa2013@nyp.org`); the local-part is the bare WCM CWID for
 * upstreams that provision it that way. The scope allowlist is the security
 * boundary — it prevents an untrusted IdP's `username@evil.example` from being
 * accepted as CWID `username` and editing a same-named scholar's record. The
 * value itself is trusted only because it rode in on a signature-verified
 * assertion from our IdP proxy. Returns null when the attribute is absent,
 * malformed (not exactly one `@`, empty local-part), or out-of-scope.
 */
export function extractCwidFromEppn(
  profile: Profile,
  eppnAttribute: string,
  trustedScopes: string[],
): string | null {
  if (!eppnAttribute || trustedScopes.length === 0) return null;
  const eppn = firstStringValue(profile[eppnAttribute]);
  if (!eppn) return null;
  const at = eppn.lastIndexOf("@");
  // Need a non-empty local-part and a scope, and exactly one `@`.
  if (at <= 0 || at === eppn.length - 1) return null;
  const local = eppn.slice(0, at);
  if (local.includes("@")) return null;
  const scope = eppn.slice(at + 1).toLowerCase();
  return trustedScopes.includes(scope) ? local : null;
}

/**
 * Fallback horizon for the single-use ledger row when the assertion carries no
 * parseable `NotOnOrAfter` (SAML makes it optional). Only controls pruning, so
 * over-retaining is harmless; it must merely exceed any realistic reuse window
 * (node-saml independently rejects an assertion older than its own timestamps).
 */
const ASSERTION_FALLBACK_WINDOW_MS = 60 * 60 * 1000; // 1h

/** A plain (non-array) object, or undefined. Tolerates node-saml's xml2js shapes. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First element of an xml2js array node (or the value itself if not arrayed). */
function firstElement(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Read a string XML attribute (`node.$.<attr>`) from an xml2js element. */
function xmlAttr(node: unknown, attr: string): string | undefined {
  const dollar = asRecord(asRecord(node)?.["$"]);
  const value = dollar?.[attr];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse a SAML timestamp to epoch ms, or null if absent/unparseable. */
function timestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Derive a stable single-use dedup key and prune horizon for a validated
 * assertion (#1439). Preference order for the key:
 *
 *   1. `assn:<Assertion/@ID>` — the assertion's own id. It is inside the
 *      signed element, so it cannot be altered without breaking the signature,
 *      and a byte-for-byte re-presentation carries the exact same id.
 *   2. `resp:<Response/@ID>` — the response id, when the assertion id is
 *      somehow absent.
 *   3. `hash:<sha256(raw SAMLResponse)>` — last-resort content hash.
 *
 * The prune horizon is the latest `NotOnOrAfter` on the assertion (Conditions
 * or SubjectConfirmationData) plus the accepted clock skew, mirroring the
 * window node-saml itself will still accept; it falls back to a generous fixed
 * window when no timestamp is present. This function is pure and never throws —
 * the same profile + response always yields the same key.
 */
export function extractAssertionIdentity(
  profile: Profile,
  samlResponseB64: string,
  opts: { now: Date; clockSkewMs: number; fallbackWindowMs?: number },
): AssertionIdentity {
  const parsed =
    typeof profile.getAssertion === "function" ? profile.getAssertion() : undefined;
  const assertionNode = firstElement(asRecord(parsed)?.["Assertion"]);

  const assertionId = xmlAttr(assertionNode, "ID");
  const responseId = firstStringValue(profile.ID);
  const id = assertionId
    ? `assn:${assertionId}`
    : responseId
      ? `resp:${responseId}`
      : `hash:${createHash("sha256").update(samlResponseB64).digest("hex")}`;

  const conditionsNode = firstElement(asRecord(assertionNode)?.["Conditions"]);
  const subjectNode = firstElement(asRecord(assertionNode)?.["Subject"]);
  const confirmationNode = firstElement(
    asRecord(subjectNode)?.["SubjectConfirmation"],
  );
  const confirmationData = firstElement(
    asRecord(confirmationNode)?.["SubjectConfirmationData"],
  );

  const horizons = [
    timestampMs(xmlAttr(conditionsNode, "NotOnOrAfter")),
    timestampMs(xmlAttr(confirmationData, "NotOnOrAfter")),
  ].filter((t): t is number => t !== null);

  const fallbackMs = opts.fallbackWindowMs ?? ASSERTION_FALLBACK_WINDOW_MS;
  const expiresAt =
    horizons.length > 0
      ? new Date(Math.max(...horizons) + opts.clockSkewMs)
      : new Date(opts.now.getTime() + fallbackMs);

  return { id, expiresAt };
}

/** Every element of an xml2js array node (or the single value), as a list. */
function allElements(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** The root `Destination` attribute of the raw SAML Response XML, if any. */
function responseDestination(profile: Profile): string | undefined {
  const xml =
    typeof profile.getSamlResponseXml === "function"
      ? profile.getSamlResponseXml()
      : undefined;
  if (!xml) return undefined;
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const value = doc.documentElement?.getAttribute("Destination");
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reject a signature-valid assertion that was not issued for this environment
 * or is too old (2026-10-23 security audit, finding 12). Returns a fixed
 * reason string (safe to log: no assertion content, no PII), or null to pass.
 *
 *   - Response `Destination`, when present, must equal `acsUrl` exactly.
 *   - At least one bearer `SubjectConfirmationData/@Recipient` must equal
 *     `acsUrl` exactly. A missing Recipient is rejected: the SAML Web Browser
 *     SSO profile (saml-profiles-2.0 section 4.1.4.2) requires it on the
 *     bearer confirmation. The Recipient is inside the signed assertion, so it
 *     is the check that stops a response issued for one environment's ACS
 *     from being replayed to the other's.
 *   - Assertion `IssueInstant` must be present, not later than now plus
 *     `clockSkewMs`, and no older than `maxAssertionAgeMs + clockSkewMs`.
 */
export function checkResponseBinding(
  profile: Profile,
  opts: { acsUrl: string; now: Date; clockSkewMs: number; maxAssertionAgeMs: number },
): string | null {
  const destination = responseDestination(profile);
  if (destination !== undefined && destination !== opts.acsUrl) {
    return "destination_mismatch";
  }

  const parsed =
    typeof profile.getAssertion === "function" ? profile.getAssertion() : undefined;
  const assertionNode = firstElement(asRecord(parsed)?.["Assertion"]);
  const subjectNode = firstElement(asRecord(assertionNode)?.["Subject"]);
  const recipients: string[] = [];
  for (const confirmation of allElements(asRecord(subjectNode)?.["SubjectConfirmation"])) {
    if (xmlAttr(confirmation, "Method") !== BEARER_METHOD) continue;
    for (const data of allElements(asRecord(confirmation)?.["SubjectConfirmationData"])) {
      const recipient = xmlAttr(data, "Recipient");
      if (recipient) recipients.push(recipient);
    }
  }
  if (recipients.length === 0) return "recipient_missing";
  if (!recipients.includes(opts.acsUrl)) return "recipient_mismatch";

  const issuedAt = timestampMs(xmlAttr(assertionNode, "IssueInstant"));
  if (issuedAt === null) return "issue_instant_missing";
  const nowMs = opts.now.getTime();
  if (issuedAt > nowMs + opts.clockSkewMs) return "assertion_not_yet_valid";
  if (nowMs > issuedAt + opts.maxAssertionAgeMs + opts.clockSkewMs) {
    return "assertion_too_old";
  }
  return null;
}

/** SP metadata XML — hand the `/api/auth/saml/metadata` URL to WCM identity. */
export function getServiceProviderMetadata(): string {
  const { saml, env } = ensureSaml();
  const cert = env.spCert ?? null;
  return saml.generateServiceProviderMetadata(cert, cert);
}
