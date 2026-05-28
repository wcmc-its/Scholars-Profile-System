/**
 * Post-submit confirmation block — replaces the form in place after a
 * successful submission (#538 PR-2, docs/feedback-badge-spec.md §
 * "Confirmation"). Names the originating page so the "Return" button
 * deep-links the user back to where they were.
 */
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

export function FeedbackConfirmation({
  returnTo,
}: {
  returnTo: string | null;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-4 rounded-md border border-emerald-200 bg-emerald-50/60 p-8 text-center"
    >
      <CheckCircle2 aria-hidden="true" className="size-10 text-emerald-700" />
      <div>
        <h2 className="text-lg font-semibold text-emerald-950">
          Thank you. Your feedback has been recorded.
        </h2>
        <p className="mt-1 text-sm text-emerald-900/80">
          Your response goes to the Scholars project lead for review.
        </p>
      </div>
      {returnTo ? (
        <Link
          href={returnTo}
          className="rounded-md bg-[var(--color-primary-cornell-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-primary-cornell-red)]/90"
        >
          Return to where you were &rarr;
        </Link>
      ) : (
        <Link
          href="/"
          className="rounded-md bg-[var(--color-primary-cornell-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-primary-cornell-red)]/90"
        >
          Back to Scholars home &rarr;
        </Link>
      )}
    </div>
  );
}
