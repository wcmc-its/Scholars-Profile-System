import type { Metadata } from "next";

/**
 * /docs/glossary (v0 seed). Plain one-line definitions of the terms used across
 * Scholars. In the hybrid SPEC the glossary also absorbs the (removed) concept
 * tier; v0 ships a seed set, anchor-addressable for future <Term> cross-links.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Glossary — Scholars docs",
  description: "Plain definitions of the terms used across Scholars at Weill Cornell Medicine.",
  alternates: { canonical: "/docs/glossary" },
};

function slugify(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const TERMS: { term: string; def: React.ReactNode }[] = [
  {
    term: "Impact score",
    def: "A 0–100 score ReciterAI assigns to a publication from citation, journal, and recency signal. It describes the paper, not your role on it — the same publication shows the same Impact for every co-author. Shown as “Impact: NN”.",
  },
  {
    term: "Author Position",
    def: "Your place in a publication's author list (first, middle, senior), shown next to each publication. This — not the Impact score — conveys your role on a paper.",
  },
  {
    term: "ReCiter",
    def: "WCM's author-disambiguation engine. It reads PubMed and decides which publications are yours.",
  },
  {
    term: "ReciterAI",
    def: "WCM's pipeline that derives a publication's topics and subtopics, its Impact score, and its one-line synopsis.",
  },
  {
    term: "ReciterDB",
    def: "The nightly/weekly ETL that lands ReCiter and ReciterAI output into the data Scholars displays.",
  },
  {
    term: "MeSH",
    def: "Medical Subject Headings — the National Library of Medicine's controlled vocabulary for indexing biomedical literature. Scholars search is MeSH-aware.",
  },
  {
    term: "Topic / Subtopic",
    def: "Research themes ReciterAI assigns to publications and scholars, organized into a parent-topic / subtopic hierarchy.",
  },
  {
    term: "Synopsis",
    def: "A one-sentence, plain-language summary ReciterAI generates for a publication, shown in the publication detail view.",
  },
  {
    term: "Suppression",
    def: "Hiding a misattributed publication (or other entity) from a profile. Reversible and recorded.",
  },
  {
    term: "CWID",
    def: "Your WCM Center-Wide ID — the canonical identifier that links your records across systems.",
  },
  {
    term: "Enterprise Directory (ED)",
    def: "WCM's directory/HR system of record for your name, CWID, primary department, and institutional affiliation.",
  },
  {
    term: "iCite",
    def: "The NIH tool Scholars uses as its sole source of citation counts and the cites / cited-by record. (Scholars does not use Scopus.)",
  },
];

export default function GlossaryPage() {
  const sorted = [...TERMS].sort((a, b) => a.term.localeCompare(b.term));
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">Glossary</h1>
      <p className="mt-6 text-base text-muted-foreground">
        Plain definitions of the terms you&apos;ll see across Scholars.
      </p>
      <dl className="mt-8 space-y-6">
        {sorted.map(({ term, def }) => (
          <div key={term} id={slugify(term)} className="scroll-mt-24">
            <dt className="text-base font-semibold">{term}</dt>
            <dd className="mt-1 text-base text-muted-foreground">{def}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
