"use client";

/**
 * Export popover for the Publications-tab results header (#89 Phase 1).
 *
 * Renders a single Export button that opens a native <details> popover
 * with two CSV options (Word is grayed out as "coming soon"). On click
 * of an option, POSTs the current filter/sort payload to the
 * /api/export/publications/{granularity} route and triggers a Blob
 * anchor download with the dated filename returned by the server.
 *
 * Limit handling: when `total > EXPORT_MAX_LIMIT`, the option click
 * surfaces a `window.confirm()` warning that the export will be capped.
 * Phase 2 swaps this for a real modal once the codebase has a dialog
 * primitive (today only `<details>`-based popovers exist here).
 *
 * Accessibility: native <details>/<summary> for the menu, real <button>
 * elements for the options. No custom focus trapping needed.
 */
import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import type {
  PublicationsFilters,
  PublicationsSort,
} from "@/lib/api/search";

type Granularity = "authorship" | "article" | "bibliography";

// Per-format ceilings mirror the server-side clamp. CSV ships richer
// data per row and tolerates large exports; Word renders heavier per
// citation (docx XML, hyperlinks, formatted runs) so it caps lower.
const FORMAT_LIMIT: Record<Granularity, number> = {
  authorship: 5000,
  article: 5000,
  bibliography: 1000,
};
const NOUN: Record<Granularity, string> = {
  authorship: "authorships",
  article: "articles",
  bibliography: "citations",
};

export function ExportButton({
  q,
  filters,
  sort,
  total,
}: {
  q: string;
  filters: PublicationsFilters;
  sort: PublicationsSort;
  total: number;
}) {
  const [busy, setBusy] = useState<Granularity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async (granularity: Granularity) => {
    if (busy) return;
    const limit = FORMAT_LIMIT[granularity];
    if (total > limit) {
      const ok = window.confirm(
        `Your current filters match ${total.toLocaleString()} ${NOUN[granularity]}. ` +
          `Scholars will export the first ${limit.toLocaleString()} ` +
          `records, ordered by the active sort. Continue?`,
      );
      if (!ok) return;
    }

    setBusy(granularity);
    setError(null);
    try {
      const resp = await fetch(`/api/export/publications/${granularity}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, filters, sort, limit }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      // Pull filename from server header so the Date stamp matches the row set.
      const disposition = resp.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `${granularity}-export.csv`;

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Couldn't export: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="relative">
      <summary
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-3 py-1 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e] hover:text-[#2c4f6e] [&::-webkit-details-marker]:hidden"
        aria-haspopup="menu"
      >
        <Download aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        Export
      </summary>
      <div
        role="menu"
        className="absolute right-0 z-20 mt-1 w-[280px] rounded-sm border border-[#c8c6be] bg-white p-1 text-[13px] shadow-md"
      >
        <ExportMenuItem
          label="CSV — Authorship report"
          hint="One row per WCM author × article"
          icon="csv"
          busy={busy === "authorship"}
          disabled={busy !== null || total === 0}
          onClick={() => handleExport("authorship")}
        />
        <ExportMenuItem
          label="CSV — Article report"
          hint="One row per article"
          icon="csv"
          busy={busy === "article"}
          disabled={busy !== null || total === 0}
          onClick={() => handleExport("article")}
        />
        <ExportMenuItem
          label="Word — Bibliography"
          hint="Vancouver style; WCM authors bold"
          icon="doc"
          busy={busy === "bibliography"}
          disabled={busy !== null || total === 0}
          onClick={() => handleExport("bibliography")}
        />
        {error ? (
          <p className="mt-1 px-2 py-1 text-[12px] text-[#a0341c]">{error}</p>
        ) : null}
      </div>
    </details>
  );
}

function ExportMenuItem({
  label,
  hint,
  icon,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: "csv" | "doc";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = icon === "csv" ? FileSpreadsheet : FileText;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-[#1a1a1a] hover:bg-[#f5f4ee] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {busy ? (
        <Loader2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#2c4f6e]" />
      ) : (
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[#757575]" strokeWidth={2} />
      )}
      <span className="flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block text-[12px] text-[#757575]">{hint}</span>
      </span>
    </button>
  );
}
