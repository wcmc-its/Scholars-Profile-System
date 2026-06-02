import Link from "next/link";

/**
 * Shared branded error body (#668 §1). Rendered inside the normal page chrome
 * by the segment `error.tsx` boundaries. Presentational only — the boundary
 * owns the `reset()` wiring and the telemetry; this renders the markup.
 *
 * No raw error text is shown. A short `reference` (Next's `error.digest`) may
 * be surfaced so a user can quote it to support — it correlates with the
 * server-side error log.
 */
export function ErrorContent({
  title = "Something went wrong",
  message = "We hit an unexpected error loading this page. This is usually temporary — please try again.",
  onRetry,
  reference,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  reference?: string;
}) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="page-title text-3xl font-semibold">{title}</h1>
      <p className="mt-4 text-zinc-600 dark:text-zinc-400">{message}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-[var(--color-primary-cornell-red)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Try again
          </button>
        ) : null}
        <Link href="/" className="underline">
          Return home
        </Link>
        <Link href="/search" className="underline">
          Search scholars
        </Link>
      </div>
      {reference ? (
        <p className="mt-8 text-xs text-zinc-400 dark:text-zinc-500">Reference: {reference}</p>
      ) : null}
    </main>
  );
}
