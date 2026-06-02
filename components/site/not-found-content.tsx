import Link from "next/link";

/**
 * Shared branded 404 body (#668 §2). Rendered by both 404 catch sites:
 *   - `app/not-found.tsx` (root) — wraps this in SiteHeader/SiteFooter itself.
 *   - `app/(public)/not-found.tsx` — chrome comes from `(public)/layout`.
 *
 * The primary recovery affordance is a plain GET search form posting to
 * `/search?q=…` (no JS required — works even if hydration fails). Browse links
 * point only at routes that actually have an index page (`/search`, `/browse`,
 * `/about`); `/departments`, `/centers`, `/topics`, `/scholars` have only
 * dynamic `[slug]` routes, so linking them here would 404 again.
 *
 * `isVivo` tailors the copy for dead legacy VIVO profile URLs — the SEO-
 * sensitive cutover traffic — and autofocuses the search box for them.
 */
export function NotFoundContent({ isVivo = false }: { isVivo?: boolean }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="page-title text-3xl font-semibold">
        {isVivo ? "This profile may have moved" : "Page not found"}
      </h1>
      <p className="mt-4 text-zinc-600 dark:text-zinc-400">
        {isVivo
          ? "Scholar profiles have a new home. Search for the person by name to find their current profile."
          : "We couldn't find the page you were looking for. Try a search, or browse below."}
      </p>

      <form action="/search" method="get" role="search" className="mx-auto mt-8 flex max-w-md gap-2">
        <label htmlFor="nf-search" className="sr-only">
          Search scholars
        </label>
        <input
          id="nf-search"
          type="search"
          name="q"
          autoFocus={isVivo}
          placeholder="Search by name, topic, or department"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[var(--color-primary-cornell-red)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary-cornell-red)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="rounded-md bg-[var(--color-primary-cornell-red)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Search
        </button>
      </form>

      <nav
        aria-label="Browse"
        className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm"
      >
        <Link href="/" className="underline">
          Home
        </Link>
        <Link href="/search" className="underline">
          Search scholars
        </Link>
        <Link href="/browse" className="underline">
          Browse A–Z
        </Link>
        <Link href="/about" className="underline">
          About
        </Link>
      </nav>
    </main>
  );
}
