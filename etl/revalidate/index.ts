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
 * pattern — the internal ALB is accepted only by exact origin equality with
 * `SCHOLARS_INTERNAL_ALB_ORIGIN`, so any accidental redirect to an arbitrary
 * `*.elb.amazonaws.com` host (someone else's tenant ALB) is refused.
 *
 * Failure model
 * -------------
 * Best-effort. Every individual revalidate failure is `console.warn`ed, never
 * thrown — the 6h ISR TTL keeps the cache eventually fresh either way, and we
 * never want a stale-cache lag to fail the cadence and page on-call.
 */
import { db } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { buildSitemapEntries, sitemapChunkCount } from "@/lib/sitemap";
import { ALL_PROFILES_ROUTE } from "@/lib/revalidate-allowlist";

/**
 * Fixed origins from which `/api/revalidate` may be reached. Each entry matches
 * an EXACT URL.origin (scheme + host + port).
 */
const ALLOWED_BASE_ORIGINS: ReadonlyArray<RegExp> = [
  /^http:\/\/localhost:3000$/,
  /^https:\/\/scholars\.weill\.cornell\.edu$/,
];

/**
 * ponytail: transitional fallback for the CDK-auto-named internal ALB, used ONLY
 * when SCHOLARS_INTERNAL_ALB_ORIGIN is unset (#1473 band-aid). ETL code ships on
 * ECR push before the Sps-Etl cdk deploy that sets the var, so dropping it
 * outright would skip revalidations in that gap. Remove after Sps-Etl is
 * deployed in both envs (#1478). Matched lowercase: URL.origin lower-cases.
 */
const LEGACY_INTERNAL_ALB_ORIGIN =
  /^http:\/\/internal-sps-ap-inter-[a-z0-9]+-\d+\.[a-z0-9-]+\.elb\.amazonaws\.com$/;

/** Lowercased URL.origin of `url`, or null when it does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether `baseUrl` parses + matches one of the allowed origins. The internal
 * ALB is accepted only on exact origin equality with
 * SCHOLARS_INTERNAL_ALB_ORIGIN (set by EtlStack from the same SSM param as
 * SCHOLARS_BASE_URL, #1478): any other `*.elb.amazonaws.com` host is refused,
 * and an ALB replacement self-heals on the next Sps-Etl deploy.
 */
export function isAllowedBaseUrl(baseUrl: string): boolean {
  const origin = originOf(baseUrl);
  if (!origin) return false;
  if (ALLOWED_BASE_ORIGINS.some((re) => re.test(origin))) return true;
  const internal = process.env.SCHOLARS_INTERNAL_ALB_ORIGIN;
  if (!internal) return LEGACY_INTERNAL_ALB_ORIGIN.test(origin);
  return origin === originOf(internal);
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
  // Bound every request: a hung POST (unreachable/slow app) must not stall the
  // step. This is best-effort — the 6h ISR TTL is the safety net — so an abort
  // is warned and swallowed like any other failure.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(`${baseUrl}/api/revalidate?path=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.warn(`[Revalidate] ${p} -> ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.warn(`[Revalidate] ${p} threw:`, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the corpus and revalidate every cached surface a cadence run could have
 * dirtied: the home page, every topic page, the browse hub, every department
 * page, and the dynamic sitemap.
 *
 * Profiles: the canonical profile route `app/(public)/[slug]/page.tsx` is ISR
 * (6 h, since the 2026-10-01 load test; it was force-dynamic before). One
 * request for the route pattern `ALL_PROFILES_ROUTE` marks every cached profile
 * stale, so an ETL data change shows on the next view instead of waiting out the
 * TTL; no per-scholar loop. Each stale profile regenerates lazily on its next
 * request (stale-while-revalidate), so this costs no burst of origin renders.
 *
 * The shared Prisma read client is disconnected on every exit path so the
 * process can terminate cleanly.
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

    await requestRevalidate(ALL_PROFILES_ROUTE);
    console.log("[Revalidate] queued all profiles");

    const depts = await db.read.department.findMany({ select: { slug: true } });
    for (const d of depts) {
      await requestRevalidate(`/departments/${d.slug}`);
    }
    console.log(`[Revalidate] queued ${depts.length} department page(s)`);

    await requestRevalidate("/sitemap.xml");
    // #2262 — the index is only shard links; the URLs live in the shards.
    const shards = sitemapChunkCount((await buildSitemapEntries()).length);
    for (let i = 0; i < shards; i++) {
      await requestRevalidate(`/sitemap/${i}.xml`);
    }
    console.log(`[Revalidate] queued /sitemap.xml + ${shards} shard(s)`);
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
  withEtlRun("Revalidate", runRevalidate)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      // Mirror the other cadence entrypoints (etl/ed, etl/dynamodb, etl/asms,
      // etl/coi): withEtlRun opens the db.write pool for the etlRun record, so
      // the process cannot exit until it is disconnected. runRevalidate already
      // closes db.read; without this the task hangs to the 4h step timeout
      // (then retries), turning a best-effort skip into a ~12h nightly stall.
      await db.write.$disconnect();
    });
}
