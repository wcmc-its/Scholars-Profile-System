/**
 * #3115 — "Connect your ORCID iD": ORCID's three-legged OAuth with the
 * `/authenticate` scope, so the scholar proves which iD is theirs instead of us
 * inferring it. `GET /api/edit/orcid/connect` sends them to ORCID with a random
 * `state` held in a short-lived httpOnly cookie; ORCID sends them back to
 * `GET /api/edit/orcid/callback`, which checks the state, exchanges the code and
 * writes the iD (`scholar.orcid`, method `authenticated`) plus the
 * `orcid_authentication` row.
 *
 * Env (all from `scholars/<env>/orcid-api`, except the flag and base):
 *   ORCID_CONNECT=on                  kill switch; off → both routes 404, no button
 *   ORCID_CONNECT_BASE                https://sandbox.orcid.org (staging) | https://orcid.org
 *   ORCID_CONNECT_CLIENT_ID / _SECRET the member API client
 *   ORCID_CONNECT_TOKEN_KEY           32 bytes, base64 — encrypts the stored token
 *   SITE_URL                          origin of the registered redirect URI
 *
 * The access token is stored encrypted and never read: an `/authenticate` token
 * reads only the public record, and any wider scope needs fresh consent anyway.
 * It is kept because ORCID's member minimum requires storing it.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_COOKIE = "orcid_connect_state";
export const STATE_MAX_AGE_S = 600;
export const CALLBACK_PATH = "/api/edit/orcid/callback";
/** Where both routes land the scholar: their own Identifiers & Profiles tab. */
export const RETURN_PATH = "/edit?attr=identifiers-profiles";

export function isOrcidConnectEnabled(): boolean {
  return process.env.ORCID_CONNECT === "on";
}

export type OrcidConnectConfig = {
  base: string;
  clientId: string;
  clientSecret: string;
  tokenKey: Buffer;
  redirectUri: string;
  sandbox: boolean;
};

/** The config, or null when anything is missing — the routes then 500 rather than half-work. */
export function orcidConnectConfig(
  env: Record<string, string | undefined> = process.env,
): OrcidConnectConfig | null {
  const base = env.ORCID_CONNECT_BASE?.replace(/\/+$/, "");
  const clientId = env.ORCID_CONNECT_CLIENT_ID;
  const clientSecret = env.ORCID_CONNECT_CLIENT_SECRET;
  const key = env.ORCID_CONNECT_TOKEN_KEY ? Buffer.from(env.ORCID_CONNECT_TOKEN_KEY, "base64") : null;
  const site = env.SITE_URL?.replace(/\/+$/, "");
  if (!base || !clientId || !clientSecret || !key || key.length !== 32 || !site) return null;
  if (base !== "https://orcid.org" && base !== "https://sandbox.orcid.org") return null;
  return {
    base,
    clientId,
    clientSecret,
    tokenKey: key,
    redirectUri: `${site}${CALLBACK_PATH}`,
    sandbox: base === "https://sandbox.orcid.org",
  };
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time compare of the cookie's state to the one ORCID echoed back. */
export function stateMatches(cookie: string | undefined, echoed: string | null): boolean {
  if (!cookie || !echoed) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(echoed);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeUrl(cfg: OrcidConnectConfig, state: string): string {
  const u = new URL(`${cfg.base}/oauth/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "/authenticate");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export type OrcidTokenResponse = {
  orcid: string;
  name: string | null;
  accessToken: string;
  scope: string;
  expiresInS: number | null;
};

/** Exchange the authorization code. Throws on any non-200 or a body without an iD + token. */
export async function exchangeCode(
  cfg: OrcidConnectConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OrcidTokenResponse> {
  const res = await fetchImpl(`${cfg.base}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ORCID token exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  if (typeof j.orcid !== "string" || typeof j.access_token !== "string") {
    throw new Error("ORCID token response missing orcid/access_token");
  }
  return {
    orcid: j.orcid,
    name: typeof j.name === "string" && j.name.trim() ? j.name.trim() : null,
    accessToken: j.access_token,
    scope: typeof j.scope === "string" ? j.scope : "/authenticate",
    expiresInS: typeof j.expires_in === "number" ? j.expires_in : null,
  };
}

/** AES-256-GCM; stored as base64url `iv.tag.ciphertext`. */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

/** Only the unit test calls this; nothing in the app reads the token back. */
export function decryptToken(stored: string, key: Buffer): string {
  const [iv, tag, ct] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
