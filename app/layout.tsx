import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
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
    <html lang="en">
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
