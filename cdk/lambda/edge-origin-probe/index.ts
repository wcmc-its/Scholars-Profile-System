import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import * as https from "node:https";
import * as tls from "node:tls";

/**
 * Edge origin-leg health probe (#1934).
 *
 * WHY THIS EXISTS. After the 2026-07-25 NetScaler cutover, CloudFront's only
 * dynamic origin is the NetScaler VIP, and NOTHING could see it fail. The
 * `sps-app-unavailable-{env}` composite ORs three ALB/ECS-side leaves
 * (target-5xx rate, unhealthy hosts, task shortfall). If the VIP stops
 * forwarding, requests never reach the ALB at all: `RequestCount` is 0, so the
 * 5xx expression's minimum-count guard returns 0; targets stay healthy because
 * the tasks are fine; the task count is fine. All three leaves stay OK and a
 * total user-facing outage pages nobody. Measured on 2026-07-25: an 8m40s
 * outage produced ZERO datapoints on every 5xx metric, and the composite has
 * never transitioned since it was created.
 *
 * A CloudFront error-RATE alarm does not close that gap either. Prod took
 * roughly one viewer request during that entire window, so there was no
 * denominator to build a rate from. The only detector that works at this
 * traffic level is one that GENERATES its own traffic.
 *
 * WHY NOT SYNTHETICS. A CloudWatch Synthetics canary costs ~$0.0012/run
 * (~$10/mo at this cadence) and cannot read a raw peer certificate, so it
 * would not cover the cert-expiry half. This Lambda does both for effectively
 * nothing at a 5-minute cadence.
 *
 * WHAT IT CANNOT DO, stated so nobody assumes otherwise: it cannot probe the
 * public URL end-to-end. The edge WAF (`sps-edge-{env}-wcm-only`) allows two
 * WCM CIDRs, and this Lambda egresses from an AWS address, so a request to
 * `https://scholars.weill.cornell.edu/` from here is blocked by design. The
 * edge check below therefore asserts only that CloudFront ANSWERS (TLS
 * completes and an HTTP status comes back), which is what detects DNS
 * breakage, viewer-cert expiry and a disabled distribution. Whether the WAF is
 * correctly scoped needs a probe from a WCM address and is out of scope here.
 *
 * Metrics are emitted as CloudWatch Embedded Metric Format on stdout rather
 * than via PutMetricData: no SDK client, no IAM grant, no extra dependency to
 * keep current. CloudWatch Logs extracts them automatically.
 */

/** Namespace for every metric emitted here. Mirrored in observability-stack.ts. */
const METRIC_NAMESPACE = `SPS/Edge-${process.env.ENVIRONMENT ?? "unknown"}`;

/** Per-probe network ceiling. Well under the function timeout. */
const PROBE_TIMEOUT_MS = 8_000;

interface ProbeMetrics {
  /** 1 when the origin leg returned the expected health status, else 0. */
  OriginProbeSuccess: number;
  /** Wall-clock ms for the origin health request. Absent when it failed. */
  OriginProbeLatencyMs?: number;
  /** Whole days until the origin (NetScaler VIP) certificate expires. */
  OriginCertDaysRemaining?: number;
  /** 1 when CloudFront completed TLS and returned any HTTP status, else 0. */
  EdgeReachable: number;
}

/**
 * How long a fetched secret stays cached. NOT an arbitrary number: caching for
 * the container's whole life was a real defect. The origin shared secret is
 * rotatable, and a rotation requires an ordered two-value overlap (add the new
 * value to both ALB rules, flip CloudFront, drop the old). A probe holding the
 * pre-rotation value indefinitely would start failing its health check the
 * moment the old value is dropped and report a FALSE OUTAGE -- paging on-call
 * for a successful rotation -- until something happened to cold-start it.
 *
 * 10 minutes bounds that to two probe cycles while still collapsing the
 * common case to one Secrets Manager call per container per 10 minutes.
 */
const SECRET_TTL_MS = 10 * 60 * 1000;

let cachedSecret: { value: string; fetchedAt: number } | undefined;
let cachedClient: SecretsManagerClient | undefined;

async function getOriginSecret(secretId: string): Promise<string> {
  if (cachedSecret && Date.now() - cachedSecret.fetchedAt < SECRET_TTL_MS) {
    return cachedSecret.value;
  }
  cachedClient ??= new SecretsManagerClient({});
  const res = await cachedClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  // The origin shared secret is a PLAIN string, not JSON (see secrets-stack.ts).
  const value = res.SecretString;
  if (!value) throw new Error("origin shared secret is empty");
  cachedSecret = { value, fetchedAt: Date.now() };
  return value;
}

/**
 * Read the peer certificate's notAfter without issuing an HTTP request.
 *
 * Deliberately separate from the health request below: the cert must be
 * readable even when the origin is returning errors, and a failed health check
 * must not cost us the expiry signal (they are different failures with
 * different runbooks -- one pages, one warns weeks ahead).
 */
function readCertDaysRemaining(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: PROBE_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          reject(new Error("no peer certificate"));
          return;
        }
        const expiresAt = Date.parse(cert.valid_to);
        if (Number.isNaN(expiresAt)) {
          reject(new Error("unparseable certificate validity"));
          return;
        }
        resolve(Math.floor((expiresAt - Date.now()) / 86_400_000));
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("tls timeout"));
    });
    socket.on("error", reject);
  });
}

interface HttpProbeResult {
  readonly status: number;
  readonly latencyMs: number;
}

/** GET a URL, resolving on ANY HTTP status. Rejects only on transport failure. */
function httpProbe(
  url: string,
  headers: Record<string, string>,
): Promise<HttpProbeResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = https.request(
      url,
      { method: "GET", headers, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        // Drain so the socket can be released; the body is never inspected.
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            latencyMs: Date.now() - startedAt,
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("http timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Emit CloudWatch EMF on stdout. One log line becomes one datapoint per metric. */
function emit(environment: string, metrics: ProbeMetrics): void {
  const present = Object.entries(metrics).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v),
  );
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [["Environment"]],
            Metrics: present.map(([name]) => ({
              Name: name,
              Unit: name.endsWith("Ms") ? "Milliseconds" : "None",
            })),
          },
        ],
      },
      Environment: environment,
      ...Object.fromEntries(present),
    }),
  );
}

export async function handler(): Promise<void> {
  const environment = process.env.ENVIRONMENT ?? "unknown";
  const originHostname = process.env.ORIGIN_HOSTNAME;
  // The secret NAME, not a partial ARN. `Secret.fromSecretNameV2(...).secretArn`
  // yields an ARN with the AWS-generated 6-character suffix STRIPPED, and
  // passing that as SecretId is the one identifier form AWS documents as
  // unreliable: the live secret resolved fine but authorization failed against
  // a policy that literally listed both the suffixed and suffix-less ARNs, and
  // `iam simulate-principal-policy` said "allowed" for both. Measured on
  // staging 2026-07-25 across a cold start. A friendly name resolves and
  // authorizes consistently.
  const secretId = process.env.ORIGIN_SECRET_ID;
  const healthPath = process.env.ORIGIN_HEALTH_PATH ?? "/api/health";
  const edgeUrl = process.env.EDGE_URL;

  if (!originHostname || !secretId) {
    // Misconfiguration must be LOUD, not a silent healthy-looking 1. Emitting
    // a 0 here would also be wrong -- it would page on-call for a CDK bug.
    throw new Error(
      "ORIGIN_HOSTNAME and ORIGIN_SECRET_ID are required; refusing to report a health verdict",
    );
  }

  const metrics: ProbeMetrics = { OriginProbeSuccess: 0, EdgeReachable: 0 };

  // Independent try blocks on purpose: each signal must survive the others
  // failing. A dead origin must NOT also suppress the cert-expiry warning.
  try {
    metrics.OriginCertDaysRemaining = await readCertDaysRemaining(originHostname);
  } catch (err) {
    console.error("origin cert read failed", err);
  }

  try {
    const secret = await getOriginSecret(secretId);
    const { status, latencyMs } = await httpProbe(
      `https://${originHostname}${healthPath}`,
      {
        // The ALB's priority-1 rule matches this header; without it the
        // listener's default action returns 403. Probing WITH it means a
        // rotated/mismatched secret also shows up as an origin failure, which
        // is one of the failure modes this exists to catch.
        "X-Origin-Verify": secret,
        // The app is Host-agnostic for /api/health, but send the public host so
        // the request is indistinguishable from a real one at every hop.
        Host: originHostname,
        "User-Agent": `sps-edge-origin-probe/${environment}`,
      },
    );
    metrics.OriginProbeLatencyMs = latencyMs;
    metrics.OriginProbeSuccess = status === 200 ? 1 : 0;
    if (status !== 200) console.error(`origin health returned ${status}`);
  } catch (err) {
    console.error("origin health probe failed", err);
  }

  if (edgeUrl) {
    try {
      // Any status counts as reachable -- a WAF 403 from this AWS-sourced
      // address is the EXPECTED response and still proves CloudFront answered.
      await httpProbe(edgeUrl, { "User-Agent": `sps-edge-probe/${environment}` });
      metrics.EdgeReachable = 1;
    } catch (err) {
      console.error("edge reachability probe failed", err);
    }
  } else {
    // No alias configured for this env: report reachable so the alarm cannot
    // page on an absence of configuration.
    metrics.EdgeReachable = 1;
  }

  emit(environment, metrics);
}
