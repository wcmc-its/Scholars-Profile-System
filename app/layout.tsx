import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
