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
