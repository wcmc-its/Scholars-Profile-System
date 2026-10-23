"use client";

/**
 * Report 14's client islands: "Send to review" on an award row, and the
 * department table's CSV (aggregates only, no names).
 */
import { useState } from "react";

import { postRequeue } from "@/components/edit/grant-attribution-shared";

export function RequeueButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  if (state === "done")
    return <span className="text-muted-foreground text-[13px]">In To review</span>;
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          setError(null);
          const r = await postRequeue(id);
          if (r.ok) setState("done");
          else {
            setState("idle");
            setError(r.message);
          }
        }}
        className="text-apollo-slate rounded-md px-2 py-1 text-[13px] whitespace-nowrap"
      >
        Send to review
      </button>
      {error ? (
        <span role="alert" className="text-destructive max-w-[220px] text-right text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function DownloadCsvButton({
  filename,
  rows,
}: {
  filename: string;
  rows: ReadonlyArray<ReadonlyArray<string | number>>;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        const csv = rows.map((r) => r.map(cell).join(",")).join("\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="border-apollo-border-strong bg-apollo-surface flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px]"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      Download CSV
    </button>
  );
}
