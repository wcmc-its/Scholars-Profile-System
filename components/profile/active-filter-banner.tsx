"use client";

import type { ScholarKeyword } from "@/lib/api/profile";

export function ActiveFilterBanner({
  count,
  selected,
  onClearAll,
}: {
  count: number;
  selected: ScholarKeyword[];
  onClearAll: () => void;
}) {
  if (selected.length === 0) return null;
  const labels = selected.map((s) => s.displayLabel);
  const buttonLabel = selected.length === 1 ? "Clear filter" : "Clear all";
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-2.5"
      style={{
        backgroundColor: "color-mix(in oklab, var(--color-accent-slate) 8%, transparent)",
        borderColor: "color-mix(in oklab, var(--color-accent-slate) 25%, transparent)",
        color: "var(--color-accent-slate)",
      }}
    >
      <span className="text-sm">
        Filtered to{" "}
        <strong className="font-semibold">
          {count} {count === 1 ? "publication" : "publications"}
        </strong>
        {labels.length === 1 ? (
          <>
            {" "}using <strong className="font-semibold">{labels[0]}</strong>
          </>
        ) : labels.length === 2 ? (
          <>
            {" "}using{" "}
            <strong className="font-semibold">{labels[0]}</strong>
            {" "}or{" "}
            <strong className="font-semibold">{labels[1]}</strong>
          </>
        ) : (
          <>
            {" "}using any of:{" "}
            {labels.map((l, i) => (
              <span key={l}>
                <strong className="font-semibold">{l}</strong>
                {i < labels.length - 1 ? ", " : ""}
              </span>
            ))}
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onClearAll}
        className="text-sm font-medium underline-offset-4 hover:underline"
        style={{ color: "var(--color-accent-slate)" }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
