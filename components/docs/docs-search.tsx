"use client";

import { useState } from "react";
import Link from "next/link";
import type { DocsQuestion } from "@/lib/docs/docs-content";

/**
 * Landing-page search. v0 = client-side filter over the in-memory question
 * index (no search backend yet; the hybrid SPEC's real index is post-launch).
 * Empty query shows nothing here — the server page renders "Popular questions"
 * beneath for the no-query state.
 */
export function DocsSearch({ questions }: { questions: DocsQuestion[] }) {
  const [value, setValue] = useState("");
  const query = value.trim().toLowerCase();
  const results = query
    ? questions.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.shortAnswer.toLowerCase().includes(query) ||
          item.tags.some((tag) => tag.includes(query)),
      )
    : [];

  return (
    <div className="mt-6">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search the docs — e.g. impact, missing publication, where my data comes from"
        aria-label="Search Scholars documentation"
        className="w-full rounded-md border border-border px-4 py-3 text-base focus:border-[var(--color-accent-slate)] focus:outline-none"
      />
      {query ? (
        <ul className="mt-5 space-y-4">
          {results.length === 0 ? (
            <li className="text-base text-muted-foreground">
              No matches. Browse{" "}
              <Link
                href="/docs/q"
                className="text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
              >
                all questions
              </Link>{" "}
              instead.
            </li>
          ) : (
            results.map((item) => (
              <li key={item.slug}>
                <Link
                  href={`/docs/q/${item.slug}`}
                  className="text-base font-medium text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline"
                >
                  {item.title}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">{item.shortAnswer}</p>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
