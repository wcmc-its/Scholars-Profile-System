import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getHelpEntry, HELP_ENTRIES, type HelpEntry } from "@/lib/docs/help-content";

/**
 * Per-entry help page (#515). One static template renders every entry in the
 * help corpus. Force-static + generateStaticParams: each of the eight slugs is
 * prerendered at build, no DB, CloudFront-cacheable like the rest of `/about`.
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
    title: `${entry.title} — Scholars at WCM`,
    description: entry.description,
    alternates: { canonical: `/about/help/${entry.slug}` },
  };
}

/**
 * Typographic styling for the semantic body JSX lives here (not in the content
 * module), applied once via Tailwind descendant variants so prose stays
 * decoupled from presentation. Mirrors the type scale of `/about/methodology`.
 */
const PROSE_CLASS = [
  "mt-8",
  "[&_p]:mt-4 [&_p]:text-base",
  "[&_ul]:mt-4 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:text-base",
  "[&_ol]:mt-4 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:text-base",
  "[&_li]:mt-1.5",
  "[&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_a]:text-[var(--color-accent-slate)] [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:no-underline",
  "[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border-b [&_th]:border-border [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:align-top [&_th]:font-semibold",
  "[&_td]:border-b [&_td]:border-border [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top",
].join(" ");

export default async function HelpEntryPage({
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
        <Link
          href="/about/help"
          className="text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
        >
          &#x2190; Help &amp; FAQ
        </Link>
      </p>

      <h1 className="page-title mt-4 text-4xl font-semibold leading-tight">{entry.title}</h1>

      {entry.shortAnswer ? (
        <p className="mt-6 text-base text-muted-foreground">{entry.shortAnswer}</p>
      ) : null}

      <div className={PROSE_CLASS}>{entry.body}</div>

      {related.length > 0 ? (
        <section className="mt-12 border-t pt-8">
          <h2 className="text-lg font-semibold">Related</h2>
          <ul className="mt-3 space-y-2">
            {related.map((r) => (
              <li key={r.slug}>
                <Link
                  href={`/about/help/${r.slug}`}
                  className="text-base text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
                >
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
