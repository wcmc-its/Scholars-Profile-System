import type { Metadata } from "next";

/**
 * /docs/changelog (v0 stub). End-user "what's new". Seeded with the launch
 * entry; in the hybrid SPEC this is the version surface for the single-live
 * docs site.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "What's new — Scholars docs",
  description: "Notable changes to Scholars at Weill Cornell Medicine and its documentation.",
  alternates: { canonical: "/docs/changelog" },
};

const ENTRIES: { date: string; items: string[] }[] = [
  {
    date: "Launch",
    items: [
      "Documentation site introduced: searchable questions, a per-section data-provenance map, and a glossary.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">What&apos;s new</h1>
      <p className="mt-6 text-base text-muted-foreground">
        Notable changes to Scholars and these docs.
      </p>
      <div className="mt-8 space-y-8">
        {ENTRIES.map((entry) => (
          <section key={entry.date}>
            <h2 className="text-lg font-semibold">{entry.date}</h2>
            <ul className="mt-3 ml-6 list-disc space-y-1.5 text-base">
              {entry.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
