"use client";

import { useState } from "react";
import Link from "next/link";
import type { DocsQuestion } from "@/lib/docs/docs-content";

/**
 * /docs/q hub browser. Text filter + tag chips over the full question corpus.
 * Empty state shows everything. Tag chips toggle off when re-clicked (the SPS
 * deselect convention). v0: in-page state only — URL-synced `?tag=` deep links
 * are a post-launch item.
 */
export function QuestionBrowser({
  questions,
  tags,
}: {
  questions: DocsQuestion[];
  tags: string[];
}) {
  const [value, setValue] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const query = value.trim().toLowerCase();

  const filtered = questions.filter((item) => {
    const matchesQuery =
      !query ||
      item.title.toLowerCase().includes(query) ||
      item.shortAnswer.toLowerCase().includes(query) ||
      item.tags.some((tag) => tag.includes(query));
    const matchesTag = !activeTag || item.tags.includes(activeTag);
    return matchesQuery && matchesTag;
  });

  return (
    <div className="mt-6">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Filter questions"
        aria-label="Filter questions"
        className="w-full rounded-md border border-border px-4 py-3 text-base focus:border-[var(--color-accent-slate)] focus:outline-none"
      />

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
        {tags.map((tag) => {
          const isActive = tag === activeTag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveTag(isActive ? null : tag)}
              className={
                "rounded-full border px-3 py-1 text-sm " +
                (isActive
                  ? "border-[var(--color-accent-slate)] text-[var(--color-accent-slate)]"
                  : "border-border text-muted-foreground hover:border-[var(--color-accent-slate)]")
              }
            >
              {tag}
            </button>
          );
        })}
      </div>

      <ul className="mt-6 space-y-4">
        {filtered.length === 0 ? (
          <li className="text-base text-muted-foreground">No questions match that filter.</li>
        ) : (
          filtered.map((item) => (
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
    </div>
  );
}
