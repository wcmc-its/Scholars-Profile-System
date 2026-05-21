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
  /**
   * IdP signing certificate(s) (PEM) — verifies the SAMLResponse signature.
   * A single PEM is returned as a string; multiple PEMs concatenated in the
   * env value (the rollover format — see `parseIdpCert`) come back as an
   * array. node-saml accepts either shape on `SamlConfig.idpCert`.
   */
  idpCert: string | string[];
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

const PEM_CERT_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Parse `SAML_IDP_CERT` as either a single PEM or a list of concatenated PEMs.
 * Concatenated form is how an IdP rollover is delivered: two (or more)
 * `-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----` blocks separated
 * by whitespace, each trusted as a signing key until the older one expires.
 * Returns the original input when exactly one block is found (so node-saml
 * sees the same `string` it always has), an array of trimmed blocks when
 * more than one is found, and throws if no well-formed block is present.
 */
export function parseIdpCert(raw: string): string | string[] {
  const blocks = raw.match(PEM_CERT_PATTERN);
  if (!blocks || blocks.length === 0) {
    throw new Error(
      "B01 SSO: SAML_IDP_CERT must contain at least one PEM-encoded certificate (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)",
    );
  }
  return blocks.length === 1 ? raw : blocks.map((b) => b.trim());
}

/**
 * SAML SP/IdP config, consumed by `lib/auth/saml.ts`. Throws if a required
 * `SAML_*` variable is missing — so the SAML routes fail loud on a
 * misconfigured deployment rather than half-authenticating.
 */
export function getSamlEnv(): SamlEnv {
  return {
    idpCert: parseIdpCert(requireEnv("SAML_IDP_CERT")),
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

export interface SuperuserConfig {
  /**
   * cn of the Enterprise Directory group that confers the superuser tier
   * (B02 #101) — e.g. `ITS:Library:Scholars/superuser-role`. `undefined` until
   * the group is provisioned; `isSuperuser()` then resolves `false` for
   * everyone, leaving the admin features dormant rather than erroring.
   */
  groupCn: string | undefined;
}

/**
 * Superuser-tier config. The `SCHOLARS_LDAP_*` bind itself is read by
 * `lib/sources/ldap.ts`; this getter adds only the group cn B02 needs. The
 * mapping is plain `process.env`, but its only consumer — `lib/auth/superuser.ts`
 * — is Node-only for the LDAP query.
 */
export function getSuperuserConfig(): SuperuserConfig {
  return { groupCn: optionalEnv("SCHOLARS_SUPERUSER_GROUP_CN") };
}
