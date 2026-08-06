/**
 * Headshot-presence probe (Data Quality dashboard, #data-quality-dashboard).
 *
 * The app never reads `Scholar.headshot_url` at render — it derives the WCM
 * directory URL from the cwid (`lib/headshot.ts`, `identityImageEndpoint`), which
 * returns the photo (200) or 404s when none exists (`returnGenericOn404=false`).
 * So "does this scholar have a headshot?" is only knowable by hitting that
 * endpoint. `etl/headshot` calls `probeHeadshot` per active scholar weekly and
 * persists the verdict to `Scholar.has_headshot`, turning an external, per-request
 * unknown into an exact, sortable/filterable column.
 *
 * Pure + injectable (no `server-only`, fetch is a parameter) so the classify
 * mapping and probe are unit-testable without a network.
 */
import { identityImageEndpoint } from "@/lib/headshot";

/**
 * A headshot presence verdict:
 *   - `true`  → the directory has a photo for this cwid (200/206)
 *   - `false` → the directory has no photo (404)
 *   - `null`  → indeterminate (5xx, 403, timeout, network) — the caller MUST NOT
 *               overwrite a previously-known value with this.
 */
export type HeadshotVerdict = boolean | null;

/**
 * How stale a persisted verdict may be before `etl/headshot` re-probes it in
 * incremental mode (#2210).
 *
 * MUST be strictly LESS than the 7-day weekly cadence
 * (`cron(0 12 ? * SUN *)`, `cdk/lib/etl-stack.ts`), and the margin is
 * load-bearing in two ways:
 *
 *  1. **Refresh actually happens.** Run N stamps `headshot_checked_at` a few
 *     minutes AFTER its 12:00 UTC start. At run N+1, exactly 7 days later, a
 *     7-day cutoff lands a few minutes BEFORE that stamp, so every row reads
 *     as fresh and the whole cohort is skipped — the refresh would silently
 *     halve to fortnightly. 6 days absorbs the in-run drift plus a late start.
 *  2. **Staleness is bounded by the cadence, not by a number nobody re-derived
 *     when the cadence was chosen.** The previous value was 30 days, which on a
 *     weekly cron means each row is re-probed every 30–37 days, so a scholar who
 *     gains a directory photo shows `has_headshot = 0` on the Data Quality
 *     dashboard for up to five weeks. That is exactly #2210: prod's column was a
 *     single 2026-07-06 full-backfill snapshot and the QA pass that found the
 *     wrong row ran on day 30 of that window.
 *
 * Note this does NOT increase the peak load on the directory — the whole cohort
 * is stamped in one run and therefore comes due in one run either way. It only
 * changes how often that ~4-minute wave runs (weekly instead of monthly).
 */
export const HEADSHOT_STALE_DAYS = 6;

/**
 * The `headshot_checked_at` cutoff for incremental mode: rows checked strictly
 * before this instant (plus rows never checked) are due for a re-probe.
 */
export function headshotStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - HEADSHOT_STALE_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Map an HTTP status from the directory headshot endpoint to a presence verdict.
 * 200/206 → present; 404 → absent; anything else → indeterminate (`null`), so a
 * transient directory problem never flips a known value to a wrong one.
 * (206 because the probe sends a `Range: bytes=0-0` header to avoid downloading
 * the full image; a Range-honoring server replies 206 Partial Content.)
 */
export function classifyHeadshotStatus(status: number): HeadshotVerdict {
  if (status === 200 || status === 206) return true;
  if (status === 404) return false;
  return null;
}

/**
 * Probe the directory for one cwid's headshot. Never throws — a timeout or
 * network error resolves to `null` (indeterminate). Sends `Range: bytes=0-0` so a
 * present photo costs one byte, not the whole PNG; falls back gracefully if the
 * server ignores Range (a 200 with the full body is still classified present).
 */
export async function probeHeadshot(
  cwid: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<HeadshotVerdict> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(identityImageEndpoint(cwid), {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "manual",
      signal: controller.signal,
    });
    return classifyHeadshotStatus(res.status);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
