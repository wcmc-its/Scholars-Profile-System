/**
 * Browse hub anchor strip — UI-SPEC §6.2.
 * Server Component: three in-page anchors + one cross-link.
 * No JS scroll-spy (UI-SPEC §8.1). "Research areas →" targets
 * /#research-areas because /topics listing does not exist
 * (RESEARCH.md Pitfall 3).
 */
import Link from "next/link";

export function BrowseAnchorStrip() {
  const anchorClass =
    "rounded-md px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-accent text-foreground";
  return (
    <div className="mb-10">
      <nav
        aria-label="Browse sections"
        className="flex items-center gap-2 bg-muted rounded-lg px-4 py-2"
      >
        <a href="#departments" className={anchorClass}>
          Departments
        </a>
        <a href="#centers" className={anchorClass}>
          Centers &amp; Institutes
        </a>
        <a href="#az-directory" className={anchorClass}>
          A&ndash;Z Directory
        </a>
      </nav>
      <div className="mt-2 text-right">
        <Link
          href="/#research-areas"
          className="text-sm text-[var(--color-accent-slate)] hover:underline"
        >
          Or browse by research area &#x2192;
        </Link>
      </div>
    </div>
  );
}
