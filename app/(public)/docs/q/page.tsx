import type { Metadata } from "next";
import { QuestionBrowser } from "@/components/docs/question-browser";
import { ALL_TAGS, DOCS_QUESTIONS } from "@/lib/docs/docs-content";

/**
 * /docs/q — question hub. Filterable list of the whole question corpus.
 * Force-static; filtering is client-side (QuestionBrowser).
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Questions — Scholars docs",
  description: "Browse and filter the most-asked questions about Scholars at Weill Cornell Medicine.",
  alternates: { canonical: "/docs/q" },
};

export default function QuestionsHubPage() {
  return (
    <main className="mx-auto max-w-[860px] px-6 py-12">
      <h1 className="page-title text-4xl font-semibold leading-tight">Questions</h1>
      <p className="mt-4 text-base text-muted-foreground">
        Short answers to the things people ask most. Filter by keyword or topic.
      </p>
      <QuestionBrowser questions={DOCS_QUESTIONS} tags={ALL_TAGS} />
    </main>
  );
}
