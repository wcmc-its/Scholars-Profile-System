/**
 * ISR revalidation sweep — extracted from etl/orchestrate.ts so each cadence
 * Step Function can invoke it as a standalone closing step (#479, follow-on to
 * #451 / PR #478).
 *
 * Why a dedicated entrypoint
 * --------------------------
 * `orchestrate.ts` does an in-process revalidate sweep as the closing block of
 * `npm run etl:daily`. The AWS cadence state machines do NOT run orchestrate.ts
 * — they run per-source `etl:<src>` scripts directly — so the sweep never fires
 * in staging/prod. After a nightly/weekly cadence completes, profile / home /
 * topic / department pages only refresh on their ISR TTL (6h). This module is
 * the cadence-callable peer of the orchestrator's inline block.
 *
 * Security surface (B04 / #103)
 * -----------------------------
 * The sweep POSTs to `/api/revalidate?path=...` with a shared bearer token. To
 * keep the token from leaking if `SCHOLARS_BASE_URL` is misconfigured or
 * injected, every effective origin is checked against a small fixed allowlist
 * before the fetch fires. The allowlist intentionally avoids a wildcard ELB
 * pattern — it pins to our exact internal-ALB naming convention so that any
 * accidental redirect to an arbitrary `*.elb.amazonaws.com` host (someone
 * else's tenant ALB) is refused, not allowed.
 *
 * Failure model
 * -------------
 * Best-effort. Every individual revalidate failure is `console.warn`ed, never
 * thrown — the 6h ISR TTL keeps the cache eventually fresh either way, and we
 * never want a stale-cache lag to fail the cadence and page on-call.
 */
import { db } from "@/lib/db";

/**
 * Origins from which `/api/revalidate` may be reached. Each entry matches an
 * EXACT URL.origin (scheme + host + port). The internal-ALB pattern is pinned
 * to our own load-balancer naming convention (`sps-internal-{env}-...`); a
 * generic `*.elb.amazonaws.com` would accept any tenant's ALB and is rejected.
 */
const ALLOWED_BASE_ORIGINS: ReadonlyArray<RegExp> = [
  /^http:\/\/localhost:3000$/,
  /^https:\/\/scholars\.weill\.cornell\.edu$/,
  // The VPC-private internal ALB the ETL task talks to (HTTP on :80; the
  // internal listener has no TLS). The trailing `\d+` is the LB suffix the
  // ALB construct appends to keep the name unique within an account/region.
  /^http:\/\/sps-internal-(?:staging|prod)-\d+\.[a-z0-9-]+\.elb\.amazonaws\.com$/,
];

/** Whether `baseUrl` parses + matches one of the allowed origins. */
export function isAllowedBaseUrl(baseUrl: string): boolean {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return false;
  }
  return ALLOWED_BASE_ORIGINS.some((re) => re.test(origin));
}

/**
 * POST `/api/revalidate?path={p}` with `SCHOLARS_REVALIDATE_TOKEN` as a bearer.
 * Best-effort: a missing token, a disallowed base URL, or a non-2xx response
 * is `console.warn`ed and swallowed — the 6h ISR TTL is the safety net.
 */
async function requestRevalidate(p: string): Promise<void> {
  const token = process.env.SCHOLARS_REVALIDATE_TOKEN;
  const baseUrl = process.env.SCHOLARS_BASE_URL ?? "http://localhost:3000";
  if (!token) {
    console.warn(`[Revalidate] SCHOLARS_REVALIDATE_TOKEN unset; skipping ${p}`);
    return;
  }
  if (!isAllowedBaseUrl(baseUrl)) {
    console.warn(
      `[Revalidate] SCHOLARS_BASE_URL "${baseUrl}" not in allowed list; skipping ${p}`,
    );
    return;
  }
  try {
    const resp = await fetch(`${baseUrl}/api/revalidate?path=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      console.warn(`[Revalidate] ${p} -> ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.warn(`[Revalidate] ${p} threw:`, err);
  }
}

/**
 * Walk the corpus and revalidate every cached surface a cadence run could have
 * dirtied: the home page, every topic page, the browse hub, every department
 * page, and the dynamic sitemap. Per-scholar `/scholars/{slug}` revalidations
 * are still emitted by the source-system ETLs that touch individual scholar
 * records — blanket per-CWID HTTP calls (8,900+ profiles) are wasteful when
 * most are unchanged. The shared Prisma read client is disconnected on every
 * exit path so the process can terminate cleanly.
 */
export async function runRevalidate(): Promise<void> {
  console.log("\n=== Revalidate ISR caches ===");
  await requestRevalidate("/");
  try {
    const topics = await db.read.topic.findMany({ select: { id: true } });
    for (const t of topics) {
      await requestRevalidate(`/topics/${t.id}`);
    }
    console.log(`[Revalidate] queued / + ${topics.length} topic page(s)`);

    await requestRevalidate("/browse");
    console.log("[Revalidate] queued /browse");

    const depts = await db.read.department.findMany({ select: { slug: true } });
    for (const d of depts) {
      await requestRevalidate(`/departments/${d.slug}`);
    }
    console.log(`[Revalidate] queued ${depts.length} department page(s)`);

    await requestRevalidate("/sitemap.xml");
    console.log("[Revalidate] queued /sitemap.xml");
  } catch (err) {
    console.warn("[Revalidate] could not enumerate paths:", err);
  } finally {
    await db.read.$disconnect();
  }
}

// Self-invoke when run as `npm run etl:revalidate` (the cadence state-machine
// entrypoint). Importing this module from orchestrate.ts must NOT trigger main.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  runRevalidate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
