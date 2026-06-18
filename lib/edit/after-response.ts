/**
 * Schedule best-effort work to run AFTER the HTTP response is sent, off the
 * request path (#955 finding #6).
 *
 * Post-commit cache reflection — the CloudFront `CreateInvalidation` and the
 * OpenSearch fast-path — is durably backstopped by the #353 CDN outbox and the
 * #393 search reconciler (ADR-005 failure-model layer 3). So once the write has
 * committed and the durable backstop row exists, the edit POST need not WAIT for
 * those network round-trips before returning: the purge / reindex lands right
 * after the response, and a reconciler catches anything the deferred run misses.
 *
 * Uses Next's `after()` (stable in 15.x), which runs the callback once the
 * response has finished streaming, within the same invocation. Calling `after()`
 * outside a request scope throws synchronously — which happens for a direct
 * unit-test call or any non-route caller — so we fall back to a detached
 * best-effort run, swallowing rejection so a deferred failure can never surface
 * as an unhandled rejection (the reflectors already log their own failures).
 */
import { after } from "next/server";

export function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    // No request scope (e.g. a direct test/script call) — run it now, detached.
    void task().catch(() => {});
  }
}
