/**
 * The superuser-only pencil next to a report page's `<h1>` (`ReportHeader`)
 * that edits the report's slug, name, one-line summary and rich-text description
 * in place (`report_meta`, `lib/edit/report-meta.ts`). Collapsed: one icon
 * button. Open: an inline form — name, summary, the shared `OverviewEditor`
 * (Tiptap, the same eight-tag schema as the profile bio) — that PUTs
 * `/api/edit/report-meta/[n]` and, on success, closes and `router.refresh()`es
 * so the server-rendered header re-reads the row (no optimistic overlay: the
 * `report-access-popover.tsx` idiom). Errors map the route's codes to one line,
 * as that popover's `errorMessage` does. Receives the current meta as props —
 * this island never imports the server-only loader.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";

import { OverviewEditor } from "@/components/edit/overview-editor";
import { Button } from "@/components/ui/button";
import type { ReportKey } from "@/lib/edit/report-meta";
import { isValidReportSlug } from "@/lib/edit/report-slug";

export type ReportMetaEditorProps = {
  n: ReportKey;
  meta: { slug: string; name: string; summary: string; descriptionHtml: string | null };
};

const GENERIC_ERROR = "That didn't save. Try again.";

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_slug":
      return "Slug: lowercase letters, digits and hyphens (e.g. mentored-publications), not just digits.";
    case "slug_taken":
      return "Another report already uses that slug.";
    case "invalid_name":
      return "Enter a name (up to 120 characters).";
    case "invalid_summary":
      return "Enter a one-line summary (up to 500 characters).";
    case "invalid_description":
    case "description_too_long":
      return "The description is too long.";
    case "not_superuser":
      return "Only a superuser can edit report names and descriptions.";
    case "unknown_report":
      return "This report is not editable.";
    default:
      return GENERIC_ERROR;
  }
}

export function ReportMetaEditor({ n, meta }: ReportMetaEditorProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState(meta.slug);
  const [name, setName] = React.useState(meta.name);
  const [summary, setSummary] = React.useState(meta.summary);
  const [html, setHtml] = React.useState(meta.descriptionHtml ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function openForm(): void {
    setSlug(meta.slug);
    setName(meta.name);
    setSummary(meta.summary);
    setHtml(meta.descriptionHtml ?? "");
    setError(null);
    setOpen(true);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/edit/report-meta/${n}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          summary: summary.trim(),
          descriptionHtml: html,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(errorMessage(data.error));
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Edit report name and description"
        data-testid="report-meta-edit"
        onClick={openForm}
      >
        <Pencil size={16} />
      </Button>
    );
  }

  return (
    <form
      className="border-apollo-border bg-apollo-surface mt-1 flex basis-full flex-col gap-3 rounded-md border p-3 text-sm"
      data-testid="report-meta-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Name</span>
        <input
          type="text"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="border-apollo-border rounded border px-2 py-1"
          data-testid="report-meta-name"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          Slug (the report&rsquo;s address, /edit/reports/&hellip;; lowercase, hyphens)
        </span>
        <input
          type="text"
          value={slug}
          maxLength={64}
          onChange={(e) => setSlug(e.target.value)}
          className="border-apollo-border rounded border px-2 py-1 font-mono"
          autoComplete="off"
          spellCheck={false}
          data-testid="report-meta-slug"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          Summary (one line, shown on the reports index)
        </span>
        <textarea
          value={summary}
          maxLength={500}
          rows={2}
          onChange={(e) => setSummary(e.target.value)}
          className="border-apollo-border rounded border px-2 py-1"
          data-testid="report-meta-summary"
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          Description (shown under &ldquo;About this report&rdquo;; leave empty for none)
        </span>
        <OverviewEditor initialHtml={meta.descriptionHtml ?? ""} onChange={setHtml} />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="apollo"
          size="sm"
          disabled={
            busy || !isValidReportSlug(slug.trim()) || name.trim() === "" || summary.trim() === ""
          }
        >
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-xs" data-testid="report-meta-error">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
