import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getHelpEntry, HELP_ENTRIES, type HelpEntry } from "@/lib/docs/help-content";
import { DOCS_PROSE_CLASS } from "@/lib/docs/prose";

/**
 * /docs/q/[slug] — individual question page. Renders the shipped help corpus
 * entry (reused from `help-content.tsx`). One static template per slug.
 *
 * v0 seam: cross-links *inside* an entry's prose body still point at
 * `/about/help/...` (the body JSX is owned by help-content). Those pages still
 * exist, so links work; the SPEC's migration step rewrites them to /docs/q and
 * adds the 301s. The "Related" footer below links to /docs/q.
 */
export const dynamic = "force-static";
export const revalidate = false;

export function generateStaticParams() {
  return HELP_ENTRIES.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = getHelpEntry(slug);
  if (!entry) return {};
  return {
    title: `${entry.title} — Scholars docs`,
    description: entry.description,
    alternates: { canonical: `/docs/q/${entry.slug}` },
  };
}

const LINK = "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

export default async function DocsQuestionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getHelpEntry(slug);
  if (!entry) notFound();

  const related = entry.related
    .map(getHelpEntry)
    .filter((e): e is HelpEntry => Boolean(e));

  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <p className="text-sm">
        <Link href="/docs/q" className={LINK}>
          &#x2190; All questions
        </Link>
      </p>

      <h1 className="page-title mt-4 text-4xl font-semibold leading-tight">{entry.title}</h1>

      {entry.shortAnswer ? (
        <p className="mt-6 text-base text-muted-foreground">{entry.shortAnswer}</p>
      ) : null}

      <div className={DOCS_PROSE_CLASS}>{entry.body}</div>

      {related.length > 0 ? (
        <section className="mt-12 border-t pt-8">
          <h2 className="text-lg font-semibold">Related</h2>
          <ul className="mt-3 space-y-2">
            {related.map((r) => (
              <li key={r.slug}>
                <Link href={`/docs/q/${r.slug}`} className={`text-base ${LINK}`}>
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
