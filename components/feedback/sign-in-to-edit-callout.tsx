/**
 * Viewer-correct sign-in-to-edit callout (#538, docs/feedback-badge-spec.md
 * § "Sign-in-to-edit callout").
 *
 * The original copy ("Spot something wrong on **your** profile?") silently
 * presumed the viewer owns the profile they're on — wrong for the
 * majority of Scholars traffic, where patients, journalists, and other
 * scholars are reading someone else's page. The interrogative copy
 * ("Is this your profile?") is load-bearing: a non-owner reads "no" and
 * moves on; a profile owner reads "yes" and clicks.
 *
 * Shown ONLY when (mode === "contextual") AND (pageRoute ===
 * "/scholars/[slug]"). The parent component is responsible for the gate;
 * this component just renders.
 */
import Link from "next/link";
import { PencilLine } from "lucide-react";

export function SignInToEditCallout() {
  return (
    <div
      role="note"
      className="mb-5 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
    >
      <PencilLine
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-700"
      />
      <div className="text-amber-900">
        <strong className="block font-semibold text-amber-950">
          Is this your profile?
        </strong>
        <span>
          If the profile is about you, you can sign in and edit it directly —
          corrections to your own profile are faster than general feedback.{" "}
          <Link
            href="/edit"
            className="font-semibold text-[var(--color-primary-cornell-red)] underline-offset-2 hover:underline"
          >
            Sign in to edit &rarr;
          </Link>
        </span>
      </div>
    </div>
  );
}
