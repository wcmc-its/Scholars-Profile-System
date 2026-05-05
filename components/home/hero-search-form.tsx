"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { Search } from "lucide-react";

const SUGGESTIONS = [
  "cardio-oncology",
  "CRISPR",
  "long COVID",
  "infectious disease",
  "dean of medicine",
];

export function HeroSearchForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const q = inputRef.current?.value.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="mt-8 w-full max-w-[600px] mx-auto">
      <div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 shadow-sm transition-all focus-within:border-[var(--color-accent-slate)] focus-within:ring-2 focus-within:ring-[var(--color-accent-slate)]/20">
        <Search className="ml-3 h-4 w-4 shrink-0 text-zinc-400" />
        <input
          ref={inputRef}
          type="search"
          placeholder="Search by name, topic, department, or publication…"
          className="flex-1 bg-transparent px-3 py-2.5 text-base text-zinc-900 outline-none placeholder:text-zinc-400"
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoComplete="off"
          aria-label="Search scholars"
        />
        <button
          onClick={submit}
          className="shrink-0 rounded bg-[var(--color-accent-slate)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1f3b53]"
        >
          Search
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-zinc-500">
        <span>Try:</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => router.push(`/search?q=${encodeURIComponent(s)}`)}
            className="rounded-full border border-zinc-200 bg-white px-3 py-0.5 text-zinc-600 transition-colors hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
