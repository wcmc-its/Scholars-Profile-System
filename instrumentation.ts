/**
 * Next.js OTel registration hook.
 *
 * Next.js 15 calls `register()` exactly once at server boot, before any
 * route module is imported. That's the lifecycle phase
 * `@prisma/instrumentation` needs to patch the Prisma client engine
 * before the first query runs. Routing the boot through a one-line
 * dynamic import keeps the heavy OTel deps off the client bundle and
 * off any edge runtime that doesn't support them; the gated check on
 * `NEXT_RUNTIME === "nodejs"` is the canonical pattern documented by
 * Next.js for server-only instrumentation.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { initTracing } = await import("./lib/tracing/init");
  initTracing();

  // Startup cache + connection-pool warm-up (see lib/warmup.ts). Skip the
  // production BUILD phase — register() can fire there, and there are no live
  // dependencies to warm. Fire-and-forget: warmUp() self-bounds and always
  // flips the readiness latch, so boot is never blocked on it and a rejection
  // can't escape (the trailing .catch is belt-and-suspenders).
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { warmUp } = await import("./lib/warmup");
    void warmUp().catch(() => {});
  }
}
