/**
 * Structured error / not-found telemetry (#668 §6).
 *
 * Single-line JSON events, consistent with the app's logging vocabulary
 * (see docs/logging-reference.md and lib/analytics/vivo-pattern.ts).
 *
 * Sink note: emitters called from a Server Component / server action reach
 * stdout → CloudWatch (`/aws/ecs/sps-app-${env}`). Emitters called from a
 * Client Component error boundary (`error.tsx` / `global-error.tsx`) reach the
 * browser console and are a browser-RUM signal (#595). The authoritative
 * SERVER record of a thrown render is Next.js's own error+digest log; the
 * `error_boundary` / `global_error` events here are the client/RUM correlate,
 * keyed by the same `digest`.
 *
 * Privacy: never log query strings or PII. Search logs query *length* only
 * (matches the vivo-pattern threat model — path/length only, never content).
 */

export type ErrorKind = "db" | "search" | "unknown";
export type NotFoundPattern = "vivo" | "profile" | "other";

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, ts: new Date().toISOString() }));
}

/** A segment `error.tsx` rendered. `kind` is reliable only where the boundary
 *  location implies it (e.g. the `/search` boundary passes `"search"`). */
export function logErrorBoundary(fields: {
  digest?: string;
  route?: string;
  kind?: ErrorKind;
}): void {
  emit("error_boundary", {
    digest: fields.digest ?? null,
    route: fields.route ?? null,
    kind: fields.kind ?? "unknown",
  });
}

/** The root `global-error.tsx` rendered (root-layout failure — should be rare). */
export function logGlobalError(fields: { digest?: string; kind?: ErrorKind }): void {
  emit("global_error", { digest: fields.digest ?? null, kind: fields.kind ?? "unknown" });
}

/** A 404 was served. Generalizes `vivo_404` (which is kept, unchanged, for
 *  continuity of the redirect-map-pruning signal — see the SPEC's resolved
 *  decisions). Server-side callers (`not-found.tsx`) reach CloudWatch. */
export function logNotFound(fields: { path: string; pattern: NotFoundPattern }): void {
  emit("not_found", { path: fields.path, pattern: fields.pattern });
}

/** The `/search` backend (OpenSearch) failed. Emitted server-side from the
 *  search page so the outage is visible in logs independent of the AWS-side
 *  `ClusterStatus.red` alarm. Logs query length only, never the query text. */
export function logSearchDegraded(fields: { qLen: number; reason?: string }): void {
  emit("search_degraded", {
    q_len: fields.qLen,
    reason: fields.reason ?? "search_backend_error",
  });
}
