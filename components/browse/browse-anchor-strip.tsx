/**
 * /browse anchor strip — two in-page anchors + one cross-link.
 * Server Component, no JS scroll-spy. The A–Z anchor used to live here;
 * surname-finding now lives on /search's empty People tab per
 * docs/browse-vs-search.md. "Research areas →" targets the home-page section
 * #browse-all-research-areas because no /topics index page exists yet.
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
      </nav>
      <div className="mt-2 text-right">
        <Link
          href="/#browse-all-research-areas"
          className="text-sm text-[var(--color-accent-slate)] hover:underline"
        >
          Or browse by research area &#x2192;
        </Link>
      </div>
    </div>
  );
}
