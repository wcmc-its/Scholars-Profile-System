"use client";

/**
 * The disease-review side sheet for one center roster member (Edit Center
 * redesign; replaces the inline expanded panel). Every disease row for the
 * member, ranked by evidence: tier, confidence, a one-line evidence summary
 * with a Details expander (Publications / Grants / Trials), and Confirm /
 * Reject / Undo. "Confirm N high-confidence" confirms every undecided
 * high-confidence row in one click; "+ Add a disease" attaches a code the
 * generator never suggested.
 *
 * Every decision goes through the card's `onDecide`, which POSTs the existing
 * `/api/edit/center/[code]/disease-assignments` route one (cwid, disease) pair
 * at a time, so each one writes its own `disease_assignment_decision` audit
 * row. The bulk confirm is that same call per pair, not a new endpoint or
 * audit action.
 *
 * In a review queue the header shows "Review queue · i of N" and the footer
 * "Next: <name> →" (the card owns the queue; this only renders it).
 *
 * A failed decision's message (`error`) renders INSIDE the sheet: the sheet is
 * modal and covers the card, so an alert in the card would go unseen.
 */
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { DiseaseCodeOption, RosterDiseaseRow } from "@/lib/api/unit-edit-context";
import {
  FOCUS_LABEL,
  diseaseLabel,
  evidenceSummary,
  pendingDiseaseRows,
  type DiseaseDecisionKind,
} from "@/components/edit/center-roster-diseases";

const CONFIDENCE_BADGE_CLASS: Record<string, string> = {
  high: "bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border",
  medium: "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border",
  low: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Medium",
  low: "Low",
};

export type ReviewSheetMember = {
  cwid: string;
  name: string;
  title: string | null;
  programLabel: string | null;
  diseases: ReadonlyArray<RosterDiseaseRow>;
};

export type ReviewQueueState = {
  /** 1-based position of this member in the queue. */
  position: number;
  total: number;
  /** The next member in the queue that still has rows to review. */
  nextName: string | null;
  onNext: () => void;
};

/** Publications / Grants / Trials, the Details expander. Grants and trials
 *  show "N led" plus "N supported" when there are any; the data has no
 *  notion of an "active" grant, so the mockup's "N active" is relabelled. */
function EvidenceColumns({ a }: { a: NonNullable<RosterDiseaseRow["assignment"]> }) {
  const authored = a.leadPubs + a.secondPubs + a.middlePubs;
  const years = a.firstYear && a.lastYear ? ` (${a.firstYear}–${a.lastYear})` : "";
  const ledSupported = (led: number, support: number) =>
    led + support === 0 ? (
      <p className="text-muted-foreground">None</p>
    ) : (
      <>
        <p>{led} led</p>
        {support > 0 && <p className="text-muted-foreground">{support} supported</p>}
      </>
    );
  const heading = "text-muted-foreground text-[11px] font-semibold tracking-wider uppercase";
  return (
    <div className="bg-apollo-surface border-apollo-border mt-2.5 grid grid-cols-1 gap-3 rounded-lg border p-3 text-[13px] sm:grid-cols-3">
      <div>
        <p className={heading}>Publications</p>
        <p className="mt-0.5 font-semibold">{authored} authored</p>
        <p className="text-muted-foreground mt-0.5 leading-snug">
          {a.leadPubs} lead · {a.secondPubs} second · {a.middlePubs} middle. {a.recentPubs} recent{years}.
        </p>
      </div>
      <div>
        <p className={heading}>Grants</p>
        <div className="mt-0.5">{ledSupported(a.grantsLed, a.grantsSupport)}</div>
      </div>
      <div>
        <p className={heading}>Trials</p>
        <div className="mt-0.5">{ledSupported(a.trialsLed, a.trialsSupport)}</div>
      </div>
    </div>
  );
}

/** "+ Add a disease" — offers only codes not already on the member's list.
 *  Picking one POSTs `"confirmed"` with no backing assignment row. */
function AddDisease({
  cwid,
  diseases,
  diseaseOptions,
  onAdd,
}: {
  cwid: string;
  diseases: ReadonlyArray<RosterDiseaseRow>;
  diseaseOptions: ReadonlyArray<DiseaseCodeOption>;
  onAdd: (diseaseCode: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const already = new Set(diseases.map((d) => d.diseaseCode));
  const available = diseaseOptions.filter((o) => !already.has(o.code));
  const q = search.trim().toLowerCase();
  const shown = available.filter((o) => !q || o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-apollo-slate mt-3.5 text-sm font-medium hover:underline"
          data-testid={`disease-add-trigger-${cwid}`}
        >
          + Add a disease
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" data-testid={`disease-add-menu-${cwid}`}>
        <Input
          type="text"
          placeholder="Search diseases…"
          aria-label="Search diseases"
          className="mb-2 h-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid={`disease-add-search-${cwid}`}
        />
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-muted-foreground px-1.5 py-1 text-xs">
              {available.length === 0 ? "Every disease is already listed for this member." : "No diseases match."}
            </p>
          ) : (
            shown.map((o) => (
              <button
                key={o.code}
                type="button"
                className="hover:bg-accent rounded px-1.5 py-1.5 text-left text-sm"
                onClick={() => {
                  onAdd(o.code);
                  setOpen(false);
                }}
                data-testid={`disease-add-option-${cwid}-${o.code}`}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DiseaseReviewRow({
  cwid,
  row,
  busy,
  expanded,
  onToggle,
  onAct,
}: {
  cwid: string;
  row: RosterDiseaseRow;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAct: (decision: DiseaseDecisionKind) => void;
}) {
  const a = row.assignment;
  const decision = row.decision?.decision as "confirmed" | "rejected" | undefined;
  // A manual add never had a suggestion to lose — distinct from a decision
  // whose backing assignment later disappeared (real drift).
  const isManualAdd = !a && row.decision !== null && row.decision.scoreAtDecision === null;
  const code = row.diseaseCode;

  const titleLine = (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="min-w-0 text-[15px] font-semibold">{diseaseLabel(code)}</span>
      {a && <span className="text-muted-foreground text-xs">{FOCUS_LABEL[a.focus] ?? a.focus}</span>}
      {a ? (
        <Badge
          variant="outline"
          className={`rounded px-1.5 py-0 text-[11px] font-semibold ${CONFIDENCE_BADGE_CLASS[a.confidence] ?? ""}`}
        >
          {CONFIDENCE_LABEL[a.confidence] ?? a.confidence}
        </Badge>
      ) : (
        <Badge variant="outline" className="rounded px-1.5 py-0 text-[11px]">
          {isManualAdd ? "Manually added" : "No longer suggested"}
        </Badge>
      )}
      {row.drifted && (
        <Badge
          variant="outline"
          className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded px-1.5 py-0 text-[11px]"
          title="The evidence behind this decision has changed since it was made."
          data-testid={`disease-drift-${cwid}-${code}`}
        >
          Evidence changed
        </Badge>
      )}
    </div>
  );

  return (
    <li
      className={`border-apollo-border border-b py-3 ${decision === "rejected" ? "opacity-60" : ""}`}
      data-testid={`disease-card-${cwid}-${code}`}
      data-decision={decision ?? "pending"}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="text-muted-foreground w-6 shrink-0 pt-px text-[13px] tabular-nums">
          {a ? `#${a.rank}` : ""}
        </div>
        <div className="min-w-0 flex-1 basis-48">
          {a ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="block w-full text-left leading-snug"
              data-testid={`disease-details-toggle-${cwid}-${code}`}
            >
              {titleLine}
              <span className="mt-0.5 block text-[13px]">
                {evidenceSummary(a)}{" "}
                <span className="text-apollo-slate">{expanded ? "Hide details" : "Details"}</span>
              </span>
            </button>
          ) : (
            titleLine
          )}
          {a && expanded && <EvidenceColumns a={a} />}
        </div>
        <div className="ml-9 flex shrink-0 items-center gap-1.5 sm:ml-0">
          {!decision ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onAct("rejected")}
                data-testid={`disease-reject-${cwid}-${code}`}
              >
                Reject
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => onAct("confirmed")}
                data-testid={`disease-confirm-${cwid}-${code}`}
              >
                Confirm
              </Button>
            </>
          ) : (
            <>
              <span
                className={`text-xs font-semibold whitespace-nowrap ${
                  decision === "confirmed" ? "text-apollo-slate" : "text-muted-foreground"
                }`}
                data-testid={`disease-decision-${cwid}-${code}`}
              >
                {decision === "confirmed" ? "Confirmed" : "Rejected"}
              </span>
              <button
                type="button"
                disabled={busy}
                className="text-apollo-slate text-xs hover:underline disabled:opacity-50"
                onClick={() => onAct("clear")}
                data-testid={`disease-undo-${cwid}-${code}`}
              >
                Undo
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function CenterDiseaseReviewSheet({
  member,
  onClose,
  diseaseOptions,
  onDecide,
  queue,
  error = null,
}: {
  /** The member under review; `null` closes the sheet. */
  member: ReviewSheetMember | null;
  onClose: () => void;
  diseaseOptions: ReadonlyArray<DiseaseCodeOption>;
  onDecide: (cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) => Promise<void>;
  queue: ReviewQueueState | null;
  /** The card's latest write error, shown in the sheet (see the docblock). */
  error?: string | null;
}) {
  return (
    <Sheet open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="bg-apollo-page gap-0 p-0 sm:max-w-[560px]"
        data-testid="disease-review-sheet"
      >
        {/* Keyed by member so the Details / busy state resets when "Next" moves on. */}
        {member && (
          <SheetBody
            key={member.cwid}
            member={member}
            onClose={onClose}
            diseaseOptions={diseaseOptions}
            onDecide={onDecide}
            queue={queue}
            error={error}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  member,
  onClose,
  diseaseOptions,
  onDecide,
  queue,
  error,
}: {
  member: ReviewSheetMember;
  onClose: () => void;
  diseaseOptions: ReadonlyArray<DiseaseCodeOption>;
  onDecide: (cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) => Promise<void>;
  queue: ReviewQueueState | null;
  error: string | null;
}) {
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const { cwid, diseases } = member;

  const pending = pendingDiseaseRows(diseases);
  const high = pending.filter((d) => d.assignment?.confidence === "high");
  const nConfirmed = diseases.filter((d) => d.decision?.decision === "confirmed").length;
  const nRejected = diseases.filter((d) => d.decision?.decision === "rejected").length;
  const summary = `${pending.length} to review · ${nConfirmed} confirmed${nRejected ? ` · ${nRejected} rejected` : ""}`;
  const sub = [member.title, `CWID ${cwid}`, member.programLabel].filter(Boolean).join(" · ");

  async function act(codes: ReadonlyArray<string>, decision: DiseaseDecisionKind) {
    setBusy((b) => new Set([...b, ...codes]));
    try {
      await Promise.all(codes.map((code) => onDecide(cwid, code, decision)));
    } finally {
      setBusy((b) => new Set([...b].filter((c) => !codes.includes(c))));
    }
  }

  return (
    <>
      <SheetHeader className="border-apollo-border bg-apollo-surface gap-1 px-6 pt-5 pb-4">
        {queue && (
          <p
            className="text-apollo-amber text-xs font-semibold tracking-wider uppercase tabular-nums"
            data-testid="disease-review-queue-position"
          >
            Review queue · {queue.position} of {queue.total}
          </p>
        )}
        <SheetTitle className="pr-6 text-lg font-semibold">{member.name}</SheetTitle>
        <SheetDescription>{sub}</SheetDescription>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <span className="text-[13px] tabular-nums" data-testid="disease-review-summary">
            {summary}
          </span>
          <span className="flex-1" />
          {high.length > 0 && (
            <Button
              type="button"
              size="sm"
              disabled={high.some((d) => busy.has(d.diseaseCode))}
              onClick={() =>
                act(
                  high.map((d) => d.diseaseCode),
                  "confirmed",
                )
              }
              data-testid="disease-confirm-high"
            >
              Confirm {high.length} high-confidence
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs">
          Ranked by evidence. Your decision is kept even if the evidence is later re-seeded.
        </p>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-4">
        {error && (
          <Alert variant="destructive" className="mt-2" data-testid="disease-review-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {diseases.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">No disease assignments for this member yet.</p>
        ) : (
          <ul>
            {diseases.map((d) => (
              <DiseaseReviewRow
                key={d.diseaseCode}
                cwid={cwid}
                row={d}
                busy={busy.has(d.diseaseCode)}
                expanded={expanded === d.diseaseCode}
                onToggle={() => setExpanded((e) => (e === d.diseaseCode ? null : d.diseaseCode))}
                onAct={(decision) => act([d.diseaseCode], decision)}
              />
            ))}
          </ul>
        )}
        <AddDisease
          cwid={cwid}
          diseases={diseases}
          diseaseOptions={diseaseOptions}
          onAdd={(code) => act([code], "confirmed")}
        />
      </div>

      {/* Wraps, and the Next label truncates, so a long name can't push the
          footer past a 390px phone. */}
      <SheetFooter className="border-apollo-border bg-apollo-surface flex-row flex-wrap items-center justify-between gap-2 px-6 py-3.5">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="disease-review-close">
          Close
        </Button>
        {queue?.nextName && (
          <Button
            type="button"
            variant="apollo"
            size="sm"
            className="max-w-full min-w-0 shrink"
            onClick={queue.onNext}
            data-testid="disease-review-next"
          >
            <span className="truncate">Next: {queue.nextName}</span>{" "}
            <span aria-hidden>→</span>
          </Button>
        )}
      </SheetFooter>
    </>
  );
}
