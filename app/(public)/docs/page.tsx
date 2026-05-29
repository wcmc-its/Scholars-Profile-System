import type { Metadata } from "next";
import Link from "next/link";
import { DocsSearch } from "@/components/docs/docs-search";
import { DOCS_QUESTIONS, DOCS_SECTIONS, popularQuestions } from "@/lib/docs/docs-content";

/**
 * /docs landing (v0). Search-first per the hybrid SPEC: a search input is the
 * primary element, with popular questions and the section list beneath.
 * Force-static — no DB, no fetches; chrome from app/(public)/layout.tsx +
 * app/(public)/docs/layout.tsx.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Documentation — Scholars at WCM",
  description:
    "Search the Scholars at Weill Cornell Medicine documentation — what Impact means, why a publication is on your profile, where the data comes from, and how to request a correction.",
  alternates: { canonical: "/docs" },
};

const LINK = "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

export default function DocsLandingPage() {
  const popular = popularQuestions();

  return (
    <main className="mx-auto max-w-[860px] px-6 py-12">
      <h1 className="page-title text-4xl font-semibold leading-tight">Scholars documentation</h1>
      <p className="mt-4 text-base text-muted-foreground">
        Search for an answer below, or browse by section. Scholars assembles each profile from
        authoritative WCM and external systems &mdash; these docs explain how that works and how to
        fix anything that looks wrong.
      </p>

      <DocsSearch questions={DOCS_QUESTIONS} />

      <section className="mt-12">
        <h2 className="text-lg font-semibold">Popular questions</h2>
        <ul className="mt-4 space-y-4">
          {popular.map((item) => (
            <li key={item.slug}>
              <Link href={`/docs/q/${item.slug}`} className={`text-base font-medium ${LINK}`}>
                {item.title}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">{item.shortAnswer}</p>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-base">
          <Link href="/docs/q" className={LINK}>
            All questions &#x2192;
          </Link>
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-lg font-semibold">Browse</h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {DOCS_SECTIONS.map((section) => (
            <li key={section.href} className="rounded-lg border border-border p-4">
              <Link href={section.href} className={`text-base font-medium ${LINK}`}>
                {section.label}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">{section.blurb}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
