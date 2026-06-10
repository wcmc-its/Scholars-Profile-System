import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { FeedbackBadge } from "@/components/site/feedback-badge";
import { FeedbackBadgeProvider } from "@/components/site/feedback-badge-context";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  // `SITE_URL` is a RUNTIME env var (set per-env in the ECS task def) read at
  // server startup — unlike `NEXT_PUBLIC_SITE_URL`, which Next inlines at BUILD
  // time, so a deployed (build-time-unset) image baked the localhost fallback
  // into every canonical. Prefer the runtime value; keep NEXT_PUBLIC_/localhost
  // as the local-dev fallback chain.
  metadataBase: new URL(
    process.env.SITE_URL ??
      process.env.NEXT_PUBLIC_SITE_URL ??
      "http://localhost:3002",
  ),
  title: {
    default: "Scholars @ Weill Cornell Medicine",
    template: "%s — Scholars @ Weill Cornell Medicine",
  },
  description: "Search scholars at Weill Cornell Medicine.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // #538 — render the feedback badge on every page when the flag is on.
  // The server-side decision is made here so the client component is
  // never even shipped to the browser when the flag is off.
  const showFeedbackBadge = process.env.FEEDBACK_BADGE_ENABLED === "on";
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-background text-foreground antialiased">
        <FeedbackBadgeProvider>
          {/* #637 — "View as" banner above all chrome. Client-probed (T6) and
              self-gating: renders nothing unless a live overlay is present, so
              it is inert on every non-impersonated page and when the flag is
              off. Placed before {children} (which contains the sticky header)
              so it sits at the very top and pushes content down. */}
          <ImpersonationBanner />
          {children}
          {showFeedbackBadge ? <FeedbackBadge /> : null}
        </FeedbackBadgeProvider>
      </body>
    </html>
  );
}
