/**
 * No-op stub for the `server-only` / `client-only` marker packages (#637).
 *
 * Both packages exist purely as build-time guards: Next.js aliases `server-only`
 * to an empty module in the server bundle and makes its client-bundle entry throw
 * (and vice versa for `client-only`), so importing a server module into the
 * client — or the reverse — fails the build. They ship no runtime behaviour.
 *
 * Under plain Vitest there is no bundler to resolve those aliases, so a bare
 * `import "server-only"` (e.g. `lib/auth/session-server.ts`) is an unresolved
 * module and the whole suite fails to collect. `vitest.config.ts` aliases both
 * marker packages to this empty module, restoring Next's "no-op at runtime"
 * semantics for the test environment. The seam these guards protect is still
 * exercised by the real modules; only the build-time marker is neutralised.
 */
export {};
