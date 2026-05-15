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
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </div>
    </PublicationModalProvider>
  );
}
