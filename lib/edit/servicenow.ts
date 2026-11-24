/**
 * ServiceNow "Scholar Profile Request" client (#520). `POST /api/edit/request-change`
 * files an ITS Support request here as a catalog item (RITM) instead of an email.
 *
 * Env (all from `scholars/<env>/servicenow-api`, except the flag):
 *   REQUEST_CHANGE_SERVICENOW=on   kill switch; off → the route behaves as before
 *   SERVICENOW_BASE                instance origin, https://<instance>.service-now.com
 *   SERVICENOW_CLIENT_ID / _SECRET OAuth client-credentials pair
 *
 * The create is never retried: the API has no idempotency key, so a retry after a
 * timeout could file the same request twice. Any failure throws and the route
 * hands the user back to the pre-filled email.
 */

/** The API's cap on `details` (Submission Guide § 7). */
export const SERVICENOW_DETAILS_MAX = 4000;
/** Token + create together; leaves room under CloudFront's 30s cut-off. */
const TIMEOUT_MS = 15_000;

export type ServiceNowConfig = { base: string; clientId: string; clientSecret: string };

/** The config, or null when the flag is off. On but unusable is logged, because
 *  the user-visible result (the pre-filled email) looks the same as off. */
export function serviceNowConfig(
  env: Record<string, string | undefined> = process.env,
): ServiceNowConfig | null {
  if (env.REQUEST_CHANGE_SERVICENOW !== "on") return null;
  const base = env.SERVICENOW_BASE?.replace(/\/+$/, "");
  const clientId = env.SERVICENOW_CLIENT_ID;
  const clientSecret = env.SERVICENOW_CLIENT_SECRET;
  // The client secret is POSTed to `base`; never to anything but a ServiceNow instance.
  const baseOk = /^https:\/\/[a-z0-9-]+\.service-now\.com$/.test(base ?? "");
  if (!base || !baseOk || !clientId || !clientSecret) {
    console.error(JSON.stringify({ event: "servicenow_misconfigured", base_ok: baseOk }));
    return null;
  }
  return { base, clientId, clientSecret };
}

export type ScholarProfileRequest = {
  /** Profile change or correction, or general inquiry. */
  requestType: "option_change" | "option_general";
  /** "Requested for": the scholar the request is about. */
  requestor: string;
  details: string;
  /** CWIDs notified of updates: the filer, when that isn't the scholar. */
  watchList?: string[];
};

async function post(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  // `redirect: "error"` so the secret / token can't follow a redirect elsewhere.
  const res = await fetch(url, { method: "POST", redirect: "error", ...init });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const error = body?.error as { detail?: string; message?: string } | string | undefined;
    const why =
      typeof error === "object" ? (error?.detail ?? error?.message) : (body?.error_description ?? error);
    throw new Error(`ServiceNow ${new URL(url).pathname} ${res.status}: ${String(why ?? "no detail").slice(0, 200)}`);
  }
  return body;
}

/** File one request. Throws unless ServiceNow returns both a REQ and a RITM number. */
export async function createScholarProfileRequest(
  cfg: ServiceNowConfig,
  req: ScholarProfileRequest,
): Promise<{ request: string; ritm: string }> {
  if (req.details.length > SERVICENOW_DETAILS_MAX) {
    throw new Error(`ServiceNow details too long: ${req.details.length}`);
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  // ponytail: a token per request; cache it if volume ever leaves a handful a day.
  const token = await post(`${cfg.base}/oauth_token.do`, {
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
    signal,
  });
  if (typeof token.access_token !== "string") throw new Error("ServiceNow token missing");

  const created = await post(`${cfg.base}/api/wermc/scholars_profile_request`, {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      request_type: req.requestType,
      requestor: req.requestor,
      details: req.details,
      ...(req.watchList?.length ? { watch_list: req.watchList.join(",") } : {}),
    }),
    signal,
  });
  const result = created.result as { Request?: unknown; RITM?: unknown } | undefined;
  const { Request: request, RITM: ritm } = result ?? {};
  if (typeof request !== "string" || !/^REQ\d+$/.test(request)) throw new Error("ServiceNow REQ missing");
  if (typeof ritm !== "string" || !/^RITM\d+$/.test(ritm)) throw new Error("ServiceNow RITM missing");
  return { request, ritm };
}
