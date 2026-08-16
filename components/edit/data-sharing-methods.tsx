"use client";

/**
 * "Methods" dialog for `/edit/data-sharing` — collects the methodology prose
 * that used to sit inline on §1 (extraction/attribution note, coverage skew,
 * share-rate caveats) plus the "One paragraph for reporting" copy block,
 * folded in per the 08-16 follow-up pass. Client island only for the Radix
 * dialog; all content arrives as props so this file never imports the report
 * lib (keeps prisma/db out of the client bundle — see the manageable-units
 * trap in CLAUDE.md).
 */
import { CopyButton } from "@/components/publication/copy-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DataSharingMethodsDialog({
  paragraph,
  shareRateYearFloor,
}: {
  /** The computed one-paragraph summary (built server-side from the report). */
  paragraph: string;
  shareRateYearFloor: number;
}) {
  return (
    <Dialog>
      <DialogTrigger className="text-sm hover:underline">Methods</DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Methods</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div>
            <h3 className="font-medium">Extraction and attribution</h3>
            <p className="text-muted-foreground mt-1">
              Extracted from PubMed DataBankList and full-text Data Availability statements,
              attributed via ReCiter disambiguation, deposit-vs-use classified. Counts are a floor,
              not a census — confirmed deposits only, not an estimate of the ceiling.
            </p>
          </div>

          <div>
            <h3 className="font-medium">Coverage skew</h3>
            <p className="text-muted-foreground mt-1">
              The full-text scan only sees full text that is actually retrievable. A department
              publishing more in low-PMC-coverage venues will look like it shares less than it does
              — state this on any cross-department comparison.
            </p>
          </div>

          <div>
            <h3 className="font-medium">Share rate caveats</h3>
            <p className="text-muted-foreground mt-1">
              The denominator only counts publications from {shareRateYearFloor} onward — the
              extraction pipeline never scanned earlier pubs, so including them would manufacture
              &quot;no detected deposit&quot; for papers that were simply never checked. Deposit
              detection today also only covers full-time faculty, an extraction-pipeline scope
              rather than an SPS filter — a non-full-time scholar&apos;s rate will read 0/0, or a
              low denominator with a zero numerator, by construction, not as a finding about their
              sharing behavior.
            </p>
          </div>

          <div className="border-apollo-border rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">One paragraph for reporting</h3>
              <span className="inline-flex items-center gap-1 text-xs">
                <CopyButton value={paragraph} label="Copy paragraph text" />
                Copy paragraph
              </span>
            </div>
            <p className="mt-2">{paragraph}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
