import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { FeedbackBadge } from "@/components/site/feedback-badge";
import { FeedbackBadgeProvider } from "@/components/site/feedback-badge-context";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002",
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
          {children}
          {showFeedbackBadge ? <FeedbackBadge /> : null}
        </FeedbackBadgeProvider>
      </body>
    </html>
  );
}
