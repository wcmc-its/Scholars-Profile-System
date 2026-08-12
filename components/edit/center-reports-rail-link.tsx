/**
 * The center editor's "Reports" rail entry (cancer-center-reports-
 * consolidation) — a single link OUT to the top-level `/edit/reports`
 * console, which replaced the old in-page `?attr=reports` / `?attr=nci-2a`
 * tabs (Collaboration & Cancer-Relevance, NCI Table 2A). Mounts via
 * `EditShell`'s `subRail` slot, directly below the ATTRIBUTES rail — the same
 * slot `SiblingDivisionsRail` uses on a department, mutually exclusive with it
 * (a center never has sibling divisions).
 *
 * Deliberately NOT a `RailItem` in `AttributeRail`: that component's links are
 * always `{basePath}?attr={key}`, an in-page tab selector with no notion of an
 * external target. This is cross-navigation to a different console page, so
 * it gets its own small block — styled to read as one more rail row (same
 * link treatment as `RailLink`) rather than a visually distinct affordance.
 */
import Link from "next/link";

export function CenterReportsRailLink({ centerCode }: { centerCode: string }) {
  return (
    <nav
      aria-label="Reports"
      className="bg-apollo-rail border-apollo-rail-border rounded-md border p-2"
      data-slot="center-reports-rail-link"
    >
      <ul className="flex flex-col gap-0.5">
        <li>
          <Link
            href={`/edit/reports?center=${encodeURIComponent(centerCode)}`}
            data-testid="rail-reports-link"
            className="hover:bg-apollo-rail-hover hover:border-apollo-maroon focus-visible:ring-apollo-ring focus-visible:ring-offset-apollo-rail text-foreground flex min-h-11 items-center rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none md:min-h-9"
          >
            Reports
          </Link>
        </li>
      </ul>
    </nav>
  );
}
