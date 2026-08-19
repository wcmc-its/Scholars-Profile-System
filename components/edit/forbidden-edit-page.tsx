/**
 * The /edit/* 403 page (#356 Phase 7 C5, UI-SPEC § States and edge cases row 2,
 * Phase 7 plan §6).
 *
 * Rendered when an authenticated user requests an `/edit/*` URL they lack
 * permission for. Originally worded for its first two callers only
 * (`/edit/scholar/[other-cwid]`, `/edit/publication/[pmid]` — "edit this
 * profile" / "edit another scholar's profile"), but `ForbiddenEditPage` is the
 * shared 403 for the ~20 `ConsoleShell`-wrapped list/queue/dashboard pages too
 * (`/edit/scholars`, `/edit/usage`, `/edit/find-researchers`, …), most of which
 * aren't about editing any specific profile at all — a `development`-role
 * viewer denied `/edit/scholars` was never trying to "edit another scholar's
 * profile", they were trying to browse a roster their role doesn't cover. The
 * "scholar" variant's copy (2026-08-19) is now generic enough to be true for
 * both: it names no specific action and no specific role. The wire status is
 * the route handler's responsibility — App Router has no `forbidden()`
 * primitive in Next 15.5, so the page response remains HTTP 200 in v1.
 *
 * Server component (no interactivity, no state).
 */
import Link from "next/link";

export type ForbiddenEditPageProps = {
  /**
   * For diagnostics only — currently used as a `data-target-cwid` attribute so
   * a test or screen-recording can confirm which cwid the user was denied for.
   * The visible copy never names the target.
   */
  targetCwid?: string;
  /**
   * Which surface the denial is for. `"scholar"` (default) is the generic
   * console 403 — every list/queue/dashboard/editor page except unit pages;
   * `"unit"` is the #540 unit-curation denial (`/edit/{department,division,
   * center}/[code]`), which keeps its own more specific copy since it always
   * has an Owner/Curator/administrator answer. Diagnostics only — the visible
   * copy never names the unit.
   */
  variant?: "scholar" | "unit";
  /** Unit denials: the unit code, surfaced as `data-target-entity` for tests. */
  targetEntity?: string;
};

export function ForbiddenEditPage({
  targetCwid,
  variant = "scholar",
  targetEntity,
}: ForbiddenEditPageProps) {
  if (variant === "unit") {
    return (
      <main
        className="bg-apollo-page min-h-screen mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
        data-slot="forbidden-edit-page"
        data-variant="unit"
        data-target-entity={targetEntity ?? ""}
      >
        <h1 className="page-title font-bold">You don&apos;t have permission to edit this unit.</h1>
        <p className="text-muted-foreground mt-4">
          Only an Owner, Curator, or administrator can edit this unit.
        </p>
        <p className="mt-8">
          <Link href="/" className="text-apollo-slate hover:underline">
            Return to Scholars
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main
      className="bg-apollo-page min-h-screen mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
      data-slot="forbidden-edit-page"
      data-target-cwid={targetCwid ?? ""}
    >
      <h1 className="page-title font-bold">You don&apos;t have access to this page.</h1>
      <p className="text-muted-foreground mt-4">Your account&apos;s role doesn&apos;t include it.</p>
      <p className="mt-8">
        <Link href="/edit" className="text-apollo-slate hover:underline">
          Go to your own console
        </Link>
      </p>
    </main>
  );
}
