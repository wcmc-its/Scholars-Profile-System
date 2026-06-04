/**
 * The department sub-rail: a read-only list of the department's child
 * divisions, each a link into its own editor (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § Sibling-divisions rail). Mounts via
 * `EditShell`'s `subRail` slot, directly below the ATTRIBUTES rail.
 *
 * Visually distinct from the attribute rail — a quieter "Divisions" heading,
 * no active fill, no chevron, no lock glyph — so it reads as cross-navigation
 * rather than the current page's attribute set. Collapses to nothing when the
 * department has no divisions (common for small departments), so the slot adds
 * no empty chrome.
 */
import Link from "next/link";

export type SiblingDivision = {
  code: string;
  name: string;
  slug: string;
};

export function SiblingDivisionsRail({
  divisions,
}: {
  divisions: ReadonlyArray<SiblingDivision>;
}) {
  if (divisions.length === 0) return null;
  return (
    <nav
      aria-label="Divisions"
      className="bg-apollo-rail border-apollo-rail-border rounded-md border p-2"
      data-slot="sibling-divisions-rail"
    >
      <p className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
        Divisions
      </p>
      <ul className="flex flex-col gap-0.5">
        {divisions.map((division) => (
          <li key={division.code}>
            <Link
              href={`/edit/division/${division.code}`}
              data-testid={`sibling-division-${division.code}`}
              className="hover:bg-apollo-rail-hover focus-visible:ring-apollo-ring focus-visible:ring-offset-apollo-rail text-foreground block rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              {division.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
