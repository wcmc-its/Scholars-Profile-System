"use client";

/**
 * #3071 — pieces the grant attribution queue and report 14 share: the
 * RePORTER name line, the weekly check's summary strip, and the requeue call.
 * Mockup: Projects/Scholars-Profile-System/mockups (Grant Attribution
 * Showcase canvas). Imports only the pure `@/lib/edit/grant-attribution-queue`.
 */
import { useState } from "react";

import {
  reporterNameParts,
  type GrantAttributionRunTotals,
} from "@/lib/edit/grant-attribution-queue";
import { cn } from "@/lib/utils";

/** The report's address, by its stable number. */
export const GRANT_ATTRIBUTION_REPORT_HREF = "/edit/reports/14";

/** "RePORTER: Pat D. Example", the words that differ from the scholar's
 *  names on record marked in red. Nothing when the run recorded no name. */
export function ReporterNameLine({
  reporterName,
  scholarNames,
  className,
}: {
  reporterName: string | null;
  scholarNames: ReadonlyArray<string>;
  className?: string;
}) {
  if (!reporterName) return null;
  const parts = reporterNameParts(reporterName, scholarNames);
  const differs = parts.some((p) => p.differs);
  return (
    <span
      className={cn("text-muted-foreground text-[12.5px]", className)}
      data-testid="reporter-name-line"
    >
      RePORTER:{" "}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          {p.differs ? (
            <mark className="text-destructive bg-transparent font-medium">{p.text}</mark>
          ) : (
            p.text
          )}
        </span>
      ))}
      {differs ? <span className="sr-only"> (differs from the scholar&rsquo;s name)</span> : null}
    </span>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

function runDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/** The queue page's "This week's check" strip. `onConfirmed` opens the
 *  Confirmed tab on its auto-confirmed rows (the recovered ones); the shown
 *  total links to report 14's shown list. */
export function GrantAttributionStrip({
  runs,
  pending,
  onConfirmed,
}: {
  runs: ReadonlyArray<GrantAttributionRunTotals>;
  pending: number;
  onConfirmed: () => void;
}) {
  const [howOpen, setHowOpen] = useState(false);
  const run = runs[0];
  if (!run) return null;
  const prev = runs[1];
  const total = run.show + run.hide + run.queue;
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");
  return (
    <section
      aria-label="This week's check"
      className="bg-apollo-surface border-apollo-border relative flex flex-col gap-3.5 rounded-xl border px-5 py-[18px]"
      data-testid="grant-attribution-strip"
    >
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
        <span className="text-muted-foreground text-xs font-medium tracking-[0.06em] uppercase">
          This week&rsquo;s check
        </span>
        <span className="text-[14px] text-[#3a3532]">
          {fmt(total)} NIH awards matched by name, across {fmt(run.scholars)} scholars · run{" "}
          {runDate(run.ranAt)}
        </span>
        <button
          type="button"
          aria-expanded={howOpen}
          onClick={() => setHowOpen((o) => !o)}
          className="border-apollo-border-strong bg-apollo-surface ml-auto flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px]"
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
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          How we check
        </button>
      </div>

      <div
        className="bg-apollo-surface-2 flex h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={`${fmt(run.show)} confirmed, ${fmt(run.hide)} hidden, ${fmt(run.queue)} need a curator`}
      >
        <div className="bg-apollo-slate" style={{ width: pct(run.show) }} />
        <div className="bg-apollo-border-strong" style={{ width: pct(run.hide) }} />
        <div className="bg-apollo-amber min-w-1.5" style={{ width: pct(run.queue) }} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        <div className="bg-apollo-surface-2 flex flex-col gap-0.5 rounded-lg px-3 py-2.5">
          <a
            href={`${GRANT_ATTRIBUTION_REPORT_HREF}?outcome=show`}
            className="text-foreground flex flex-col gap-0.5 no-underline hover:underline"
          >
            <span className="flex items-center gap-2 text-[13px] text-[#3a3532]">
              <span className="bg-apollo-slate size-2 rounded-[2px]" aria-hidden="true" />
              Confirmed automatically
            </span>
            <span className="text-2xl font-semibold tabular-nums">{fmt(run.show)}</span>
          </a>
          {run.recovered > 0 ? (
            <button
              type="button"
              onClick={onConfirmed}
              className="text-apollo-slate self-start text-left text-[12.5px] hover:underline"
              data-testid="grant-attribution-strip-confirmed"
            >
              incl. {fmt(run.recovered)} recovered from hidden this run
            </button>
          ) : (
            <span className="text-muted-foreground text-[12.5px]">
              none recovered from hidden this run
            </span>
          )}
        </div>
        <a
          href={`${GRANT_ATTRIBUTION_REPORT_HREF}?outcome=hide`}
          className="bg-apollo-surface-2 hover:bg-apollo-rail-hover text-foreground flex flex-col gap-0.5 rounded-lg px-3 py-2.5 no-underline hover:no-underline"
        >
          <span className="flex items-center gap-2 text-[13px] text-[#3a3532]">
            <span className="bg-apollo-border-strong size-2 rounded-[2px]" aria-hidden="true" />
            Hidden as someone else&rsquo;s
          </span>
          <span className="text-2xl font-semibold tabular-nums">{fmt(run.hide)}</span>
          <span className="text-muted-foreground text-[12.5px]">
            off profiles; any curator can bring one back
          </span>
        </a>
        <div className="bg-apollo-amber-tint border-apollo-amber-tint-border flex flex-col gap-0.5 rounded-lg border px-3 py-2.5">
          <span className="flex items-center gap-2 text-[13px] text-[#3a3532]">
            <span className="bg-apollo-amber size-2 rounded-[2px]" aria-hidden="true" />
            Need a curator
          </span>
          <span className="text-2xl font-semibold tabular-nums">{fmt(pending)}</span>
          <span className="text-[12.5px] text-[#3a3532]">
            {prev ? `${prev.queue} queued the run before` : "in To review below"}
          </span>
        </div>
      </div>
      <a href={GRANT_ATTRIBUTION_REPORT_HREF} className="text-apollo-slate self-start text-[13px]">
        Open the full report →
      </a>

      {howOpen ? (
        <div
          role="dialog"
          aria-label="How we check"
          className="bg-apollo-surface border-apollo-border-strong absolute top-14 right-5 z-10 flex w-[380px] max-w-[calc(100%-40px)] flex-col gap-2.5 rounded-[10px] border px-[18px] py-4 shadow-[0_10px_30px_rgba(31,27,25,.14)]"
        >
          <div className="text-[14px] font-semibold">How we check an award</div>
          <HowWeCheck />
          <button
            type="button"
            onClick={() => setHowOpen(false)}
            className="text-apollo-slate self-end text-[13px]"
          >
            Close
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The plain-language account of the check, shared with the report. */
export function HowWeCheck() {
  return (
    <>
      <p className="m-0 text-[13px] leading-normal text-[#3a3532]">
        NIH RePORTER links awards to people by name, so some belong to a namesake. Each week every
        such award is weighed against:
      </p>
      <ul className="m-0 pl-[18px] text-[13px] leading-relaxed text-[#3a3532]">
        <li>Papers in the scholar&rsquo;s confirmed publications that cite the award</li>
        <li>
          Whether the scholar&rsquo;s accepted papers already link them to the award&rsquo;s NIH
          profile
        </li>
        <li>Co-investigators who co-author with the scholar</li>
        <li>Where and when the scholar trained and worked</li>
        <li>WCM records of who holds the award, and whether anyone else at WCM shares the name</li>
        <li>How many NIH investigators share the name</li>
      </ul>
      <p className="m-0 text-[13px] leading-normal text-[#3a3532]">
        Clear evidence shows or hides the award on its own. Anything in between waits in the queue
        for a curator.
      </p>
    </>
  );
}

/** Send an award the check settled on its own back to the queue. */
export async function postRequeue(
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/requeue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 409 && data?.error === "already_pending")
      return { ok: false, message: "This award is already in To review." };
    if (res.status === 409 && data?.error === "decided") {
      return {
        ok: false,
        message: "A curator has decided this award. Use Move back to review on its row instead.",
      };
    }
    if (res.status === 409 && data?.error === "hidden_by_age") {
      return {
        ok: false,
        message: "This award is hidden because it is old, so reviewing it would not show it.",
      };
    }
    if (res.status === 403)
      return { ok: false, message: "Your role can read this queue but not decide it." };
    return { ok: false, message: "We couldn't send that award to review. Please try again." };
  } catch {
    return { ok: false, message: "We couldn't send that award to review. Please try again." };
  }
}
