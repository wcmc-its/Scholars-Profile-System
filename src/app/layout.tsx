import type { Metadata } from "next";
import { Inter } from 'next/font/google';
import "./globals.css";
import Footer from "./components/Footer";
import Header from "./components/Header";

const geistSans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});


export const metadata: Metadata = {
  title: "VIVO",
  description: "vivo application",
  icons:{
   icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable}  antialiased`}>
        <Header/>
          <main className="min-h-screen max-w-screen-lg mx-auto px-4 py-6">
          {children}
        </main>
        <Footer/>
      </body>
    </html>
  );
}
