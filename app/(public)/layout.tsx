import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { PublicationModalProvider } from "@/components/publication/publication-modal";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // PublicationModalProvider wraps the public surfaces so any row (profile,
  // topic feed, search pub tab) can open the #288 PR-B detail modal without
  // prop-drilling. The provider itself is a client component; server-rendered
  // children pass through untouched.
  return (
    <PublicationModalProvider>
      <div className="flex min-h-screen flex-col">
        {/*
          Skip link — first focusable element on every public page so keyboard
          and screen-reader users can bypass the header/nav and jump straight to
          the page content (WCAG 2.4.1 Bypass Blocks, Level A). Visually hidden
          until focused; on-brand colors reuse the design tokens. #575.
        */}
        <a
          href="#main-content"
          className="sr-only rounded focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[100] focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-primary-cornell-red)] focus:shadow-md focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--color-accent-slate)]"
        >
          Skip to main content
        </a>
        <SiteHeader />
        {/*
          Skip-link target. Per-page <main> elements live inside this wrapper, so
          this stays a <div> (not a second <main>) to avoid a nested-landmark
          violation; tabIndex={-1} lets focus land here when the skip link is
          activated. #575.
        */}
        <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </div>
        <SiteFooter />
      </div>
    </PublicationModalProvider>
  );
}
