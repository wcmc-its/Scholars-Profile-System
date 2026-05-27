import type { Metadata } from "next";
import Link from "next/link";
import { HELP_ENTRIES, HELP_GROUPS } from "@/lib/docs/help-content";

/**
 * Help & FAQ hub (#515). Lists the launch-MVP help corpus grouped by topic.
 * Force-static like the rest of `/about` — no DB, no fetches; chrome comes
 * from app/(public)/layout.tsx.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Help — Scholars at WCM",
  description:
    "Answers to common questions about Scholars at Weill Cornell Medicine — Impact scores, publications, search, where the data comes from, and how to request a correction.",
  alternates: { canonical: "/about/help" },
};

const LINK_CLASS =
  "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

export default function HelpHubPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">Help &amp; FAQ</h1>
      <p className="mt-6 text-base text-muted-foreground">
        Answers to the questions we hear most often about how Scholars at Weill Cornell Medicine
        works &mdash; what the Impact score means, why a publication is (or isn&apos;t) on a profile,
        how search and the underlying data work, and how to request a correction.
      </p>

      {HELP_GROUPS.map((group) => {
        const entries = HELP_ENTRIES.filter((e) => e.group === group.id);
        if (entries.length === 0) return null;
        return (
          <section key={group.id} className="mt-10">
            <h2 className="text-lg font-semibold">{group.label}</h2>
            <ul className="mt-3 space-y-2">
              {entries.map((entry) => (
                <li key={entry.slug}>
                  <Link href={`/about/help/${entry.slug}`} className={`text-base ${LINK_CLASS}`}>
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <p className="mt-12 text-base">
        <Link href="/about/methodology" className={LINK_CLASS}>
          How algorithmic surfaces work &#x2192;
        </Link>
      </p>
    </main>
  );
}
