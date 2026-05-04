import { headers } from "next/headers";
import Link from "next/link";
import { logVivoFourOhFour } from "@/lib/analytics/vivo-pattern";

/**
 * Global 404 (Next.js App Router file convention).
 * Logs ANALYTICS-04 vivo_404 telemetry when the failing path matches
 * the VIVO legacy profile URL pattern. Renders a minimal 404 UI.
 *
 * Header source for incoming pathname: tries x-invoke-path,
 * x-nextjs-matched-path, x-matched-path, x-pathname in order. If none
 * are present (very old Next.js or unusual deploy), falls back to the
 * referer header path. This belt-and-suspenders approach handles the
 * unstable-header risk noted in RESEARCH.md Pitfall 2.
 */
export default async function NotFound() {
  const h = await headers();
  const pathname =
    h.get("x-invoke-path") ??
    h.get("x-nextjs-matched-path") ??
    h.get("x-matched-path") ??
    h.get("x-pathname") ??
    extractPathFromReferer(h.get("referer")) ??
    "";

  logVivoFourOhFour(pathname);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-4 text-zinc-600 dark:text-zinc-400">
        We couldn&apos;t find the page you were looking for.
      </p>
      <p className="mt-6">
        <Link href="/" className="underline">Return home</Link>
        {" · "}
        <Link href="/search" className="underline">Search scholars</Link>
      </p>
    </main>
  );
}

function extractPathFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).pathname;
  } catch {
    return null;
  }
}
