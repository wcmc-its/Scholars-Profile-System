import type { Metadata } from "next";

/**
 * About — ABOUT-01 hub page.
 *
 * Brief platform overview that introduces the Scholars system and links
 * to the launch-blocker methodology page. Force-static — no DB, no fetches.
 *
 * Lead paragraph copy is locked by UI-SPEC §7 "About Index Page (exact copy)".
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "About — Scholars at WCM",
  description:
    "About the Scholars at Weill Cornell Medicine faculty profiles platform.",
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="font-serif text-4xl font-semibold leading-tight">
        About Scholars at WCM
      </h1>
      <p className="mt-6 text-base">
        Scholars at Weill Cornell Medicine is the public faculty profiles
        platform for WCM&apos;s research community. It surfaces faculty work
        drawn from authoritative WCM source systems &mdash; employment records,
        grant databases, publication records, and the ReCiterAI scoring pipeline.
      </p>
      <a
        href="/about/methodology"
        className="mt-6 block text-base text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
      >
        How algorithmic surfaces work &#x2192;
      </a>
    </main>
  );
}
