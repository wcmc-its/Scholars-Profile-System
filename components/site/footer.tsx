import Link from "next/link";

/** Site-wide footer on the warm near-black bar (home refinements mockup, 2026-09-24). */
export function SiteFooter() {
  return (
    <footer className="bg-apollo-bar mt-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-sm text-[#d9d2cc] sm:flex-row sm:items-center sm:justify-between">
        <div className="font-serif text-base text-white">Scholars @ Weill Cornell Medicine</div>
        <div className="flex items-center gap-4">
          <Link
            href="/about"
            className="text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Help &amp; support
          </Link>
          <span className="text-xs">Phase 1 prototype</span>
        </div>
      </div>
    </footer>
  );
}
