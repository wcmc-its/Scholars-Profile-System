import type { Metadata } from "next";
import Link from "next/link";

/**
 * /docs/methodology index (v0 stub). The hybrid SPEC's deep, citable
 * reviewer-facing methodology pages are a post-launch build (they need named
 * per-pipeline reviewers + audit blocks). For now this lists the planned set
 * and links to the existing /about/methodology overview.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Methodology — Scholars docs",
  description:
    "How Scholars works under the hood — author attribution, topic extraction, Impact scoring, and search. Deep, citable methodology pages are in progress.",
  alternates: { canonical: "/docs/methodology" },
};

const LINK = "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

const PLANNED = [
  "Author disambiguation (ReCiter)",
  "Topic & subtopic extraction (ReciterAI)",
  "Impact scoring (ReciterAI)",
  "Publication scoring (ReciterAI)",
  "Synopsis generation (ReciterAI)",
  "Search ranking",
  "MeSH-aware search",
];

export default function MethodologyIndexPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">Methodology</h1>
      <p className="mt-6 text-base text-muted-foreground">
        These pages explain how Scholars produces what you see &mdash; how publications are
        attributed to you, how topics and Impact scores are derived, and how search ranks results.
        They are written to be accurate enough for an external reviewer to read, dispute, and cite.
      </p>
      <p className="mt-4 text-base">
        The full set is in progress. In the meantime, see{" "}
        <Link href="/about/methodology" className={LINK}>
          how algorithmic surfaces work
        </Link>
        .
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Planned pages</h2>
        <ul className="mt-3 space-y-2">
          {PLANNED.map((label) => (
            <li key={label} className="text-base text-muted-foreground">
              {label} <span className="text-sm">&mdash; coming</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
