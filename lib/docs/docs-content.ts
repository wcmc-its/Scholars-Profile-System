/**
 * /docs v0 skeleton — content index.
 *
 * Reuses the shipped launch-MVP help corpus (`help-content.tsx`) as the
 * question corpus, exposing a *serializable* projection (no JSX `body`) so it
 * can be passed to client search/filter components. The full entries (with
 * rendered `body`) are still read directly from `help-content` by the
 * server-rendered question page.
 *
 * This is the typed/fast substrate for v0; the hybrid SPEC's target substrate
 * is MDX. Routes and IA here are stable across that future swap — only the
 * content loader changes. See `.planning/drafts/SPEC-docs-site-hybrid.md`.
 */
import { HELP_ENTRIES } from "@/lib/docs/help-content";

export interface DocsQuestion {
  slug: string;
  title: string;
  shortAnswer: string;
  tags: string[];
  group: string;
}

/** Serializable projection of the help corpus (safe to pass to client components). */
export const DOCS_QUESTIONS: DocsQuestion[] = HELP_ENTRIES.map((e) => ({
  slug: e.slug,
  title: e.title,
  shortAnswer: e.shortAnswer ?? e.description,
  tags: e.tags,
  group: e.group,
}));

/** Flat tag allowlist, derived from the corpus (SPEC §3.4 question-tags). */
export const ALL_TAGS: string[] = Array.from(
  new Set(DOCS_QUESTIONS.flatMap((q) => q.tags)),
).sort();

/** Curated landing ordering (the `popular-questions.json` analog; v0 = static). */
export const POPULAR_SLUGS: string[] = [
  "what-does-impact-mean",
  "why-is-this-publication-on-my-profile",
  "where-does-the-data-come-from",
  "why-isnt-my-publication-showing-up-in-search",
  "request-a-correction",
  "why-is-impact-missing",
];

export function popularQuestions(): DocsQuestion[] {
  return POPULAR_SLUGS.map((slug) => DOCS_QUESTIONS.find((q) => q.slug === slug)).filter(
    (q): q is DocsQuestion => Boolean(q),
  );
}

export interface DocsSection {
  href: string;
  label: string;
  blurb: string;
}

/** Top-level browse sections (SPEC §3.1 IA, v0 subset). */
export const DOCS_SECTIONS: DocsSection[] = [
  {
    href: "/docs/q",
    label: "Questions",
    blurb: "Short answers to the things people ask most often.",
  },
  {
    href: "/docs/how-to",
    label: "How-to guides",
    blurb: "Step-by-step: edit your overview, hide a publication, request a change.",
  },
  {
    href: "/docs/data/sources",
    label: "Where your data comes from",
    blurb: "Every part of your profile, its source system, and how to correct it.",
  },
  {
    href: "/docs/methodology",
    label: "Methodology",
    blurb: "How attribution, topics, Impact, and search actually work.",
  },
  {
    href: "/docs/glossary",
    label: "Glossary",
    blurb: "Plain definitions of the terms used across Scholars.",
  },
];
