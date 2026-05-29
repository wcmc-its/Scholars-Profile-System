import Link from "next/link";
import { DOCS_SECTIONS } from "@/lib/docs/docs-content";

/**
 * /docs section chrome (v0). A thin section nav under the shared public header
 * (from `app/(public)/layout.tsx`). The hybrid SPEC's three-pane layout with a
 * left tree + right TOC is a post-launch refinement; v0 keeps it minimal.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav
        aria-label="Documentation sections"
        className="border-b border-border"
      >
        <div className="mx-auto flex max-w-[860px] flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3 text-sm">
          <Link href="/docs" className="font-semibold">
            Docs
          </Link>
          {DOCS_SECTIONS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="text-muted-foreground hover:text-[var(--color-accent-slate)]"
            >
              {section.label}
            </Link>
          ))}
        </div>
      </nav>
      {children}
    </div>
  );
}
