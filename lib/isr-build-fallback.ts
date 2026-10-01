/**
 * `.catch` handler for data loaders on ISR pages.
 *
 * During `next build` (the Docker image build has no database) it returns
 * `fallback` so the prerender still succeeds. That build-time output is never
 * served on staging/prod: the S3 cacheHandler can't write at build, so the
 * first runtime request regenerates the page against the real DB.
 *
 * At runtime it rethrows. A degraded render on an ISR page is CACHED (origin
 * and CloudFront) until the next revalidate, so a transient DB blip would
 * blank the section for the whole window. Throwing instead makes Next keep
 * serving the last good page; only a cold cache (first render after a deploy)
 * surfaces the error, and the next request retries.
 */
export function isrBuildFallback<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (process.env.NEXT_PHASE === "phase-production-build") return fallback;
    throw err;
  };
}
