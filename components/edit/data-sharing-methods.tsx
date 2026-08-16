"use client";

/**
 * "Methods" dialog for `/edit/data-sharing` — originally (08-16 follow-up
 * pass) three hardcoded prose blocks collecting the methodology notes that
 * used to sit inline on §1, plus the "One paragraph for reporting" copy
 * block.
 *
 * v3 (2026-08-16 stakeholder pass): the hardcoded prose was replaced by
 * rendering `buildMethodsDoc`'s sections — ONE source of methods text shared
 * with the `?section=methods` markdown download, so the dialog and the file a
 * stakeholder forwards can't drift. The dashboard server component builds the
 * doc (`buildMethodsDoc(report, { shareRateYearFloor })`) and passes it down
 * whole; this stays a client island only for the Radix dialog and receives
 * everything as props — it must NEVER import the report lib or anything that
 * constructs prisma (the manageable-units trap in CLAUDE.md). The one
 * `MethodsDoc` import below is type-only against a pure module (no prisma/db
 * — see `lib/edit/data-sharing-methods-doc.ts`'s header), which is why it's
 * allowed. Widened to `max-w-2xl` for the eight-section content; the Glossary
 * section's body is `\n`-delimited "Term — definition" lines, rendered as a
 * plain list here (full text — the dotted `DefinedTerm` hovers are the
 * on-page affordance, this dialog is where someone reads it all).
 */
import { CopyButton } from "@/components/publication/copy-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { MethodsDoc } from "@/lib/edit/data-sharing-methods-doc";

export function DataSharingMethodsDialog({
  doc,
}: {
  /** Built server-side by the dashboard via `buildMethodsDoc` — see the
   *  module header for why it arrives as a prop rather than being built here. */
  doc: MethodsDoc;
}) {
  return (
    <Dialog>
      <DialogTrigger className="text-sm hover:underline">Methods</DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Methods</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {doc.sections.map((section) => (
            <div key={section.heading}>
              <h3 className="font-medium">{section.heading}</h3>
              {/* Only the Glossary body carries newlines (one term per line);
                  every other section splits into a single paragraph — one
                  generic renderer, no per-section special case to drift. */}
              <div className="text-muted-foreground mt-1 space-y-1">
                {section.body.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </div>
          ))}

          <div className="border-apollo-border rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">One paragraph for reporting</h3>
              <span className="inline-flex items-center gap-1 text-xs">
                <CopyButton value={doc.paragraph} label="Copy paragraph text" />
                Copy paragraph
              </span>
            </div>
            <p className="mt-2">{doc.paragraph}</p>
          </div>

          {/* Plain <a>, not <Link>, same rationale as the dashboard's
              DownloadLink: the target is a download route handler, and
              <Link>'s client nav + prefetch would fetch the file itself. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/edit/data-sharing/export?section=methods" className="text-xs hover:underline">
            Download methods
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
