/**
 * The /edit/* 403 page (#356 Phase 7 C5, UI-SPEC § States and edge cases row 2,
 * Phase 7 plan §6).
 *
 * Rendered when an authenticated user requests an `/edit/scholar/[other-cwid]`
 * or `/edit/publication/[pmid]` URL they lack permission for (D7.2). The page
 * itself carries the visible 403 message; the wire status is the route
 * handler's responsibility. App Router has no `forbidden()` primitive in
 * Next 15.5 — the page response remains HTTP 200 in v1; the visible UX
 * matches the SPEC's row 2 copy. See Phase 7 plan §6 + §11.
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
   * Which surface the denial is for. `"scholar"` (default) keeps the existing
   * `/edit/scholar/[cwid]` copy + back link; `"unit"` is the #540 unit-curation
   * denial (`/edit/{department,division,center}/[code]`). Diagnostics only —
   * the visible copy never names the unit.
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
        className="mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
        data-slot="forbidden-edit-page"
        data-variant="unit"
        data-target-entity={targetEntity ?? ""}
      >
        <h1 className="page-title">You don&apos;t have permission to edit this unit.</h1>
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
      className="mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
      data-slot="forbidden-edit-page"
      data-target-cwid={targetCwid ?? ""}
    >
      <h1 className="page-title">You don&apos;t have permission to edit this profile.</h1>
      <p className="text-muted-foreground mt-4">
        Only an administrator can edit another scholar&apos;s profile.
      </p>
      <p className="mt-8">
        <Link href="/edit" className="text-apollo-slate hover:underline">
          Go to my own profile editor
        </Link>
      </p>
    </main>
  );
}
