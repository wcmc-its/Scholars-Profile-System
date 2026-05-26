/**
 * Connection-URL tuning for the mariadb driver pool. Kept in its own
 * side-effect-free module (no Prisma / adapter imports) so it can be unit
 * tested without constructing a PrismaClient.
 *
 * The `@prisma/adapter-mariadb` driver adapter bypasses Prisma's own
 * connection pool and uses the mariadb driver's pool, so the
 * `connection_limit` / `pool_timeout` URL params that docs/PRODUCTION.md
 * prescribes (Prisma-pool params) are inert here — the driver reads its own
 * option names instead.
 *
 * - connectTimeout: the mariadb driver defaults to 1000ms to open a socket
 *   (mariadb/lib/config/connection-options.js). Aurora TLS + cold-connection
 *   setup intermittently exceeds that, surfacing as "failed to create socket
 *   after 1000ms" and cascading into "pool failed to retrieve a connection
 *   from pool" — the low-grade 5xx trickle behind the 2026-05-26 alarm flap.
 *   5000ms absorbs the handshake and stays under the 10000ms acquireTimeout,
 *   which the driver would otherwise clamp it to.
 * - connectionLimit: the driver defaults to 10; 15 matches the documented
 *   per-task budget (docs/PRODUCTION.md) and stays well under Aurora's ceiling.
 *
 * Only params absent from the URL are added, so a value baked into the secret
 * still wins. The adapter rewrites the `mysql:` scheme to `mariadb:` and keeps
 * the query string, so these survive to `mariadb.createPool`.
 */
export const MARIADB_POOL_PARAMS: Readonly<Record<string, string>> = {
  connectTimeout: "5000",
  connectionLimit: "15",
};

/**
 * Return `rawUrl` with the {@link MARIADB_POOL_PARAMS} applied as query
 * parameters, leaving any param already present on the URL untouched.
 * Non-URL inputs are returned unchanged rather than risk corrupting the
 * connection string.
 */
export function withMariadbPoolParams(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(MARIADB_POOL_PARAMS)) {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
