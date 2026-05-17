/**
 * B01 — SSO configuration (issue #100).
 *
 * Env-driven config for the Shibboleth SAML SP and the session cookie. Every
 * value is read lazily inside a getter, never at module load: importing this
 * file must never throw, so `next build` (which imports route modules to
 * collect metadata) and the Edge-runtime middleware bundle both stay safe —
 * the same discipline `lib/db.ts` applies to `DATABASE_URL`. A missing-config
 * error surfaces only when a getter is actually called.
 *
 * No library imports here: `config.ts` is plain `process.env` → object
 * mapping, so it is safe to import from Edge middleware. `lib/auth/saml.ts`
 * maps `getSamlEnv()` onto `@node-saml/node-saml`; `lib/auth/session.ts`
 * consumes `getSessionConfig()`.
 *
 * Production sources these from AWS Secrets Manager (B06 #105); the interim is
 * `process.env` per the repo credential policy.
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`B01 SSO: required environment variable ${name} is not set`);
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function envInt(name: string, fallback: number): number {
  const v = optionalEnv(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`B01 SSO: ${name} must be an integer, got "${v}"`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = optionalEnv(name);
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

/** Hard ceiling on session lifetime — #100 AC: "max session lifetime ≤ 8h". */
export const MAX_SESSION_TTL_SECONDS = 8 * 60 * 60; // 28800

export interface SessionConfig {
  /** Cookie name. `__Secure-` prefixed by default; override for local http. */
  cookieName: string;
  /** iron-session encryption password; must be ≥ 32 chars. */
  secret: string;
  /** Session lifetime in seconds; capped at {@link MAX_SESSION_TTL_SECONDS}. */
  ttlSeconds: number;
  /** Cookie `Domain`; omitted in local dev (no `scholars.weill.cornell.edu`). */
  cookieDomain: string | undefined;
  /** Cookie `Secure`; true in prod, set false for local http. */
  cookieSecure: boolean;
}

/**
 * Session-cookie config. Edge-safe — called by middleware and the auth routes.
 * Throws if `SESSION_COOKIE_SECRET` is missing or shorter than 32 chars.
 */
export function getSessionConfig(): SessionConfig {
  const secret = requireEnv("SESSION_COOKIE_SECRET");
  if (secret.length < 32) {
    throw new Error(
      "B01 SSO: SESSION_COOKIE_SECRET must be at least 32 characters (iron-session requirement)",
    );
  }
  const ttl = envInt("SESSION_MAX_AGE_SECONDS", MAX_SESSION_TTL_SECONDS);
  return {
    cookieName: optionalEnv("SESSION_COOKIE_NAME") ?? "__Secure-sps_session",
    secret,
    // ≤ 8h hard cap regardless of the env value (#100 AC); never 0 / unbounded.
    ttlSeconds: Math.min(Math.max(ttl, 1), MAX_SESSION_TTL_SECONDS),
    cookieDomain: optionalEnv("SESSION_COOKIE_DOMAIN"),
    cookieSecure: envBool("SESSION_COOKIE_SECURE", true),
  };
}

export interface SamlEnv {
  /** IdP signing certificate (PEM) — verifies the SAMLResponse signature. */
  idpCert: string;
  /** IdP entityID — verifies the assertion `Issuer`. */
  idpEntityId: string | undefined;
  /** IdP SSO service URL — where the AuthnRequest is sent. */
  idpSsoUrl: string;
  /** SP entityID — our identifier; also the expected assertion `Audience`. */
  spEntityId: string;
  /** SP Assertion Consumer Service URL — where the IdP POSTs the response. */
  spAcsUrl: string;
  /** SP private key (PEM) — signs AuthnRequests, decrypts encrypted assertions. */
  spPrivateKey: string | undefined;
  /** SP certificate (PEM) — published in SP metadata. */
  spCert: string | undefined;
  /**
   * SAML attribute carrying the CWID; when unset the assertion NameID is used.
   * Config-driven so the WCM-identity answer (B01 plan OQ1) is a config change,
   * not a code change.
   */
  cwidAttribute: string | undefined;
  /** Require the response envelope (not only the assertion) to be signed. */
  wantAuthnResponseSigned: boolean;
  /** Accepted clock skew between SP and IdP, in milliseconds. */
  clockSkewMs: number;
  /** Requested NameID format; unset lets the IdP choose. */
  nameIdFormat: string | undefined;
}

/**
 * SAML SP/IdP config, consumed by `lib/auth/saml.ts`. Throws if a required
 * `SAML_*` variable is missing — so the SAML routes fail loud on a
 * misconfigured deployment rather than half-authenticating.
 */
export function getSamlEnv(): SamlEnv {
  return {
    idpCert: requireEnv("SAML_IDP_CERT"),
    idpEntityId: optionalEnv("SAML_IDP_ENTITY_ID"),
    idpSsoUrl: requireEnv("SAML_IDP_SSO_URL"),
    spEntityId: requireEnv("SAML_SP_ENTITY_ID"),
    spAcsUrl: requireEnv("SAML_SP_ACS_URL"),
    spPrivateKey: optionalEnv("SAML_SP_PRIVATE_KEY"),
    spCert: optionalEnv("SAML_SP_CERT"),
    cwidAttribute: optionalEnv("SAML_CWID_ATTRIBUTE"),
    wantAuthnResponseSigned: envBool("SAML_WANT_AUTHN_RESPONSE_SIGNED", false),
    clockSkewMs: envInt("SAML_CLOCK_SKEW_MS", 5000),
    nameIdFormat: optionalEnv("SAML_NAMEID_FORMAT"),
  };
}

/**
 * Default post-login destination, used when RelayState is absent or fails the
 * open-redirect guard (see `lib/auth/return-path.ts`).
 */
export function getDefaultReturnPath(): string {
  return optionalEnv("SAML_DEFAULT_RETURN_PATH") ?? "/edit";
}
