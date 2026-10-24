"use client";

/**
 * The ORCID librarian queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md).
 *
 * Band tabs are links (`?tab=`): the server loads one tab's rows and every
 * tab's count. Each row shows the scholar beside the candidate iD, the
 * evidence chips etl/orcid-evidence computed, the record's works that are not
 * in the scholar's publications, and any competing scholar or iD, with
 * Confirm and Not this person. Email verified also lists the iDs the ETL
 * already confirmed, each with Undo. Conflicts rows hold a different iD on
 * file: Confirm there replaces it (never in bulk).
 *
 * Strong and Shared papers carry the sample gate: "Review a sample of 50"
 * starts a sample the tab then shows first; each decision on a sampled row
 * stamps it. A passed sample shows "Confirm remaining N"; one "Not this
 * person" locks bulk for the band until "Review another sample".
 *
 * A decided row stays in place, dimmed (no refresh after a decision: the
 * replica may not have the write yet). Starting a sample and a bulk confirm
 * refresh the page. Imports only the pure `@/lib/edit/orcid-queue`.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import { Button } from "@/components/ui/button";
import { ORCID_URL_PREFIX } from "@/lib/edit/orcid";
import {
  isOrcidSampleBand,
  ORCID_QUEUE_SAMPLE_SIZE,
  ORCID_QUEUE_TAB_LABEL,
  ORCID_QUEUE_TABS,
  sampleStatus,
  type OrcidQueueData,
  type OrcidQueueRow,
  type OrcidQueueSampleState,
  type OrcidQueueTab,
} from "@/lib/edit/orcid-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

type Outcome = "confirmed" | "dismissed" | "undone";

const CHIP = "rounded-full px-2 py-px text-xs font-medium whitespace-nowrap";
const CHIP_ON = "bg-apollo-slate-tint text-apollo-slate";
const CHIP_OFF = "bg-apollo-surface-2 text-muted-foreground";
const CHIP_WARN = "bg-apollo-amber-tint text-apollo-amber";
const CARD =
  "bg-apollo-surface border-apollo-border-strong rounded-[var(--apollo-radius-card)] border";

function errorMessage(status: number, code: string | undefined): string {
  if (code === "already_on_file") return "This iD is already on file for this scholar.";
  if (code === "on_file_differs")
    return "This scholar now has a different iD on file. Refresh to see it under Conflicts.";
  if (code === "on_file")
    return "This iD was confirmed by the scholar or a librarian. Remove it from the scholar's own editor.";
  if (code === "dismissed")
    return "This iD was removed by the scholar or marked Not this person, so it can't be confirmed here.";
  if (code === "state_changed")
    return "This row changed since the page loaded. Refresh to see where it is now.";
  if (code === "sample_row_decided") return "Someone already decided this sampled row.";
  if (code === "stale_sample")
    return "This sample is out of date: a newer sample was started, or the band was re-scored since. Refresh the page.";
  if (code === "sample_locked")
    return "A sampled row was marked Not this person, so bulk confirm is off for this band.";
  if (code === "sample_not_passed") return "Decide every sampled row first.";
  if (status === 403) return "Only a superuser, signed in as themselves, can decide this queue.";
  return "We couldn't record that. Please try again.";
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/edit/orcid-queue/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: data ?? {} };
    return { ok: false, message: errorMessage(res.status, data?.error as string | undefined) };
  } catch {
    return { ok: false, message: "We couldn't record that. Please try again." };
  }
}

export function OrcidQueue({
  data,
  basePath,
  readOnly,
}: {
  data: OrcidQueueData;
  basePath: string;
  /** View as: every control off (the routes refuse impersonated decisions). */
  readOnly: boolean;
}) {
  const router = useRouter();
  const { tab, rows, counts } = data;
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [sampleDecisions, setSampleDecisions] = useState<Record<string, "confirmed" | "dismissed">>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const canDecide = !readOnly;
  const key = (r: Pick<OrcidQueueRow, "cwid" | "orcid">) => `${r.cwid}|${r.orcid}`;

  // The sample's live state: the server's, plus decisions made on this page.
  const sampled = rows.filter((r) => r.sampleDecision !== undefined);
  const sample: OrcidQueueSampleState | null = data.sample
    ? data.sample.status === "open"
      ? (() => {
          const decisions = sampled.map((r) => ({
            decision: sampleDecisions[key(r)] ?? r.sampleDecision ?? null,
          }));
          return {
            ...data.sample,
            decided: decisions.filter((d) => d.decision !== null).length,
            dismissed: decisions.filter((d) => d.decision === "dismissed").length,
            status: sampleStatus(decisions),
          };
        })()
      : data.sample
    : null;

  const decide = useCallback(
    async (
      row: OrcidQueueRow,
      decision: "confirm" | "dismiss",
      opts: { replace?: boolean } = {},
    ) => {
      if (!canDecide || busy) return;
      const k = key(row);
      setBusy(k);
      setError(null);
      const inSample =
        row.sampleDecision === null && !sampleDecisions[k] && data.sample?.status === "open";
      const r = await post("decide", {
        cwid: row.cwid,
        orcid: row.orcid,
        decision,
        ...(inSample ? { sampleId: data.sample!.id } : {}),
        ...(opts.replace ? { replace: true } : {}),
      });
      setBusy(null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const undone = decision === "dismiss" && row.autoConfirmed;
      setOutcomes((o) => ({
        ...o,
        [k]: undone ? "undone" : decision === "confirm" ? "confirmed" : "dismissed",
      }));
      if (inSample)
        setSampleDecisions((s) => ({
          ...s,
          [k]: decision === "confirm" ? "confirmed" : "dismissed",
        }));
      setToast(
        undone
          ? "Undone. The iD is off file and won't be suggested again."
          : decision === "confirm"
            ? "Confirmed. The iD is on file and reaches WCM Identity overnight."
            : "Marked not this person. The iD won't be suggested again.",
      );
    },
    [canDecide, busy, sampleDecisions, data.sample],
  );

  const startSample = useCallback(
    async (restart: boolean) => {
      if (!canDecide || busy || !isOrcidSampleBand(tab)) return;
      setBusy("sample");
      setError(null);
      const r = await post("sample", { band: tab, ...(restart ? { restart: true } : {}) });
      setBusy(null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    },
    [canDecide, busy, tab, router],
  );

  const bulkConfirm = useCallback(async () => {
    if (!canDecide || busy || !sample || !isOrcidSampleBand(tab)) return;
    setBusy("bulk");
    setError(null);
    const r = await post("bulk-confirm", { band: tab, sampleId: sample.id });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const confirmed = Number(r.data.confirmed ?? 0);
    const skipped = Number(r.data.skipped ?? 0);
    setToast(
      `Confirmed ${confirmed.toLocaleString("en-US")}.` +
        (skipped > 0
          ? ` Skipped ${skipped.toLocaleString("en-US")} that changed since they were scored.`
          : ""),
    );
    router.refresh();
  }, [canDecide, busy, sample, tab, router]);

  return (
    <div className="flex flex-col gap-[18px]" data-slot="orcid-queue">
      <div
        className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b"
        role="tablist"
      >
        {ORCID_QUEUE_TABS.map((t) => (
          <Link
            key={t}
            href={`${basePath}?tab=${t}`}
            role="tab"
            aria-selected={tab === t}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
              tab === t
                ? "border-apollo-maroon text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-testid={`orcid-queue-tab-${t}`}
          >
            {ORCID_QUEUE_TAB_LABEL[t]}
            <span
              className={cn(
                "rounded-full px-[7px] py-px text-xs font-semibold tabular-nums",
                t === "conflicts"
                  ? "bg-apollo-amber-tint text-apollo-amber"
                  : "bg-apollo-surface-2 text-foreground",
              )}
            >
              {counts[t].toLocaleString("en-US")}
            </span>
          </Link>
        ))}
      </div>

      {readOnly ? (
        <p className="border-apollo-border-strong bg-apollo-surface-2 m-0 rounded-lg border px-3 py-[9px] text-[13.5px] text-[#3a3532]">
          Read-only while viewing as someone else. Decisions are recorded under your own sign-in.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="border-destructive bg-apollo-red-tint text-destructive flex items-center gap-3 rounded-lg border px-3 py-[9px] text-[13.5px]"
          data-testid="orcid-queue-error"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto text-[13px]">
            Dismiss
          </button>
        </div>
      ) : null}

      {isOrcidSampleBand(tab) ? (
        <SamplePanel
          label={ORCID_QUEUE_TAB_LABEL[tab]}
          sample={sample}
          remaining={data.remaining}
          bandSize={counts[tab]}
          canDecide={canDecide}
          busy={busy !== null}
          onStart={(restart) => void startSample(restart)}
          onBulk={() => void bulkConfirm()}
        />
      ) : null}

      {rows.length === 0 ? (
        <div
          className={cn(CARD, "text-muted-foreground p-8 text-center text-[14px]")}
          data-testid="orcid-queue-empty"
        >
          Nothing in {ORCID_QUEUE_TAB_LABEL[tab]}.
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="orcid-queue-list">
          {rows.length < counts[tab] ? (
            <p className="text-muted-foreground m-0 text-[13px]">
              Showing {rows.length.toLocaleString("en-US")} of {counts[tab].toLocaleString("en-US")}
              .
            </p>
          ) : null}
          {rows.map((r) => (
            <Row
              key={key(r)}
              row={r}
              tab={tab}
              outcome={outcomes[key(r)] ?? null}
              sampleDecision={sampleDecisions[key(r)] ?? r.sampleDecision}
              canDecide={canDecide}
              busy={busy === key(r)}
              onConfirm={() => void decide(r, "confirm", { replace: tab === "conflicts" })}
              onDismiss={() => void decide(r, "dismiss")}
            />
          ))}
        </div>
      )}

      {toast ? (
        <DecisionStatusBar
          text={toast}
          canUndo={false}
          undoing={false}
          onUndo={() => {}}
          onDismiss={() => setToast(null)}
          testId="orcid-queue-status"
          className="fixed bottom-5 left-1/2 z-20 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 shadow-[0_6px_20px_rgba(0,0,0,.18)]"
        />
      ) : null}
    </div>
  );
}

function SamplePanel({
  label,
  sample,
  remaining,
  bandSize,
  canDecide,
  busy,
  onStart,
  onBulk,
}: {
  label: string;
  sample: OrcidQueueSampleState | null;
  remaining: number | null;
  bandSize: number;
  canDecide: boolean;
  busy: boolean;
  onStart: (restart: boolean) => void;
  onBulk: () => void;
}) {
  const start = (text: string, restart = false) =>
    canDecide ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || bandSize === 0}
        onClick={() => onStart(restart)}
        className="text-[13px]"
        data-testid="orcid-queue-start-sample"
      >
        {text}
      </Button>
    ) : null;
  let body: React.ReactNode;
  if (!sample) {
    body = (
      <>
        <span className="min-w-0 flex-1">
          Bulk confirm for {label} unlocks after a review of {ORCID_QUEUE_SAMPLE_SIZE} random rows
          with none marked Not this person.
        </span>
        {start(`Review a sample of ${ORCID_QUEUE_SAMPLE_SIZE}`)}
      </>
    );
  } else if (sample.status === "open") {
    body = (
      <>
        <span className="min-w-0 flex-1" data-testid="orcid-queue-sample-open">
          Sample in review: {sample.decided} of {sample.total} decided. The sampled rows are listed
          first.
        </span>
        {start("Start a new sample", true)}
      </>
    );
  } else if (sample.status === "locked") {
    body = (
      <>
        <span className="text-apollo-amber min-w-0 flex-1" data-testid="orcid-queue-sample-locked">
          A sampled row was marked Not this person, so bulk confirm is off for {label}. Keep
          deciding rows one at a time, or review another sample.
        </span>
        {start("Review another sample")}
      </>
    );
  } else if (sample.stale) {
    body = (
      <>
        <span className="min-w-0 flex-1" data-testid="orcid-queue-sample-stale">
          The sample passed, but {label} was re-scored since it was drawn. Review a new sample to
          unlock bulk confirm.
        </span>
        {start("Review another sample")}
      </>
    );
  } else {
    body = (
      <>
        <span className="min-w-0 flex-1" data-testid="orcid-queue-sample-passed">
          Sample passed: all {sample.total} confirmed.
        </span>
        {canDecide && remaining !== null && remaining > 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onBulk}
            className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white"
            data-testid="orcid-queue-bulk-confirm"
          >
            Confirm remaining {remaining.toLocaleString("en-US")}
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <div
      className={cn(CARD, "flex flex-wrap items-center gap-3 px-4 py-3 text-[13.5px]")}
      data-testid="orcid-queue-sample"
    >
      {body}
    </div>
  );
}

function Row({
  row: r,
  tab,
  outcome,
  sampleDecision,
  canDecide,
  busy,
  onConfirm,
  onDismiss,
}: {
  row: OrcidQueueRow;
  tab: OrcidQueueTab;
  outcome: Outcome | null;
  sampleDecision: "confirmed" | "dismissed" | null | undefined;
  canDecide: boolean;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const decided = outcome !== null || (r.sampleDecision !== undefined && r.sampleDecision !== null);
  return (
    <article
      className={cn(CARD, "flex flex-col gap-3 px-5 py-4", decided && "opacity-55")}
      data-testid={`orcid-queue-row-${r.cwid}-${r.orcid}`}
    >
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">
            {r.slug ? (
              <Link href={profilePath(r.slug)} className="hover:underline">
                {r.name}
              </Link>
            ) : (
              r.name
            )}
          </span>
          <span className="text-muted-foreground text-[13px]">
            {[r.title, r.department].filter(Boolean).join(" · ") || "No title on record"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 text-[13px]">
          <a
            href={`${ORCID_URL_PREFIX}${r.orcid}`}
            target="_blank"
            rel="noreferrer"
            className="text-apollo-slate font-medium tabular-nums hover:underline"
          >
            {r.orcid}
          </a>
          {tab === "conflicts" && r.onFileOrcid ? (
            <span className="text-muted-foreground">
              On file:{" "}
              <a
                href={`${ORCID_URL_PREFIX}${r.onFileOrcid}`}
                target="_blank"
                rel="noreferrer"
                className="tabular-nums hover:underline"
              >
                {r.onFileOrcid}
              </a>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="orcid-queue-chips">
        {sampleDecision !== undefined ? <span className={cn(CHIP, CHIP_WARN)}>Sample</span> : null}
        <span className={cn(CHIP, r.instMatch ? CHIP_ON : CHIP_OFF)}>
          {r.instMatch ? "Institution on record" : "No institution"}
        </span>
        <span className={cn(CHIP, r.emailVerified ? CHIP_ON : CHIP_OFF)}>
          {r.emailVerified ? "Verified email" : "No verified email"}
        </span>
        <span className={cn(CHIP, r.nameAgrees ? CHIP_ON : CHIP_WARN)}>
          {r.nameAgrees ? "Name agrees" : "Name differs"}
        </span>
        <span className={cn(CHIP, r.shared >= 3 ? CHIP_ON : CHIP_OFF)}>Shared {r.shared}</span>
        {r.competitor ? <span className={cn(CHIP, CHIP_WARN)}>Competitor</span> : null}
        {r.autoConfirmed ? <span className={cn(CHIP, CHIP_ON)}>Confirmed by email</span> : null}
      </div>

      {r.competitor && (r.competitors.length > 0 || r.competitorOrcids.length > 0) ? (
        <p className="text-apollo-amber m-0 text-[13px]">
          {r.competitors.length > 0 ? (
            <>Also matches {r.competitors.map((c) => `${c.name} (${c.cwid})`).join(", ")}. </>
          ) : null}
          {r.competitorOrcids.length > 0 ? (
            <>Other iDs with shared papers: {r.competitorOrcids.join(", ")}.</>
          ) : null}
        </p>
      ) : null}

      <div className="text-[13px]">
        <span className="text-muted-foreground">
          {r.newWorks.toLocaleString("en-US")} of {r.worksTotal.toLocaleString("en-US")} works on
          the record are not in this scholar&rsquo;s publications
          {r.newWorksSample.length > 0 ? ":" : "."}
        </span>
        {r.newWorksSample.length > 0 ? (
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {r.newWorksSample.map((w, i) => (
              <li key={i} className="truncate">
                {w.title ?? "Untitled work"}
                <span className="text-muted-foreground">
                  {[w.year, w.source].filter(Boolean).length > 0
                    ? ` · ${[w.year, w.source].filter(Boolean).join(" · ")}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {outcome ? (
          <span className="text-muted-foreground text-[13px]" data-testid="orcid-queue-outcome">
            {outcome === "confirmed"
              ? "Confirmed"
              : outcome === "undone"
                ? "Undone"
                : "Not this person"}
          </span>
        ) : r.sampleDecision ? (
          <span className="text-muted-foreground text-[13px]" data-testid="orcid-queue-outcome">
            {r.sampleDecision === "confirmed"
              ? "Confirmed in the sample"
              : "Not this person (sample)"}
          </span>
        ) : canDecide ? (
          r.autoConfirmed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onDismiss}
              className="text-[13px]"
            >
              Undo
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={onConfirm}
                className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white"
                data-testid="orcid-queue-confirm"
              >
                {tab === "conflicts" ? "Replace with this iD" : "Confirm"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onDismiss}
                className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
                data-testid="orcid-queue-dismiss"
              >
                Not this person
              </Button>
            </>
          )
        ) : null}
      </div>
    </article>
  );
}
