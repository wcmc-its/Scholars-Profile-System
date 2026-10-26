"use client";

/**
 * The ORCID librarian queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md).
 *
 * Band tabs are links (`?tab=` plus the filter): the server loads one tab's
 * cards and every tab's count. v2: one card per scholar, listing every
 * candidate iD best first; the card sits in its best candidate's tab. Each
 * candidate shows the scholar's and the ORCID record's names side by side with
 * the rule that matched, evidence chips that open in place to the facts behind
 * them (institution pairs, the verified email, the shared papers, competitors,
 * how the iD was discovered), and the record's works not in the scholar's
 * publications, each linked (PubMed, else doi.org, else the work's own URL).
 * v2.1: the preview header splits the new works by ReCiter status, and each
 * work shows its status chip and the Publication Manager link that acts on it:
 * "Review in Publication Manager" (the scholar's curate page) for pending and
 * rejected (rejected flagged for re-review), "Add in Publication Manager" (the
 * curate page's Add tab with the DOI filled in) for a DOI not in PubMed.
 * Confirm and Not this person act per iD; on a card with other candidates,
 * Confirm also marks the others Not this person in the same action unless the
 * card's box is cleared. Email verified also lists the iDs the ETL already
 * confirmed, each with Undo. Conflicts cards hold a different iD on file:
 * Confirm there replaces it (never in bulk).
 *
 * The filter bar (person type, department / division, institution, how
 * discovered) narrows the list, the counts, the sample and bulk confirm.
 * Strong and Shared papers carry the sample gate: "Review a sample of 50"
 * starts a sample under the current filter, which the tab then shows first;
 * each decision on a sampled row stamps it. A passed sample shows "Confirm
 * remaining N" for the same filter only; one "Not this person" locks bulk for
 * the band until "Review another sample".
 *
 * A decided row stays in place, dimmed (no refresh after a decision: the
 * replica may not have the write yet). Starting a sample and a bulk confirm
 * refresh the page. Imports only the pure `@/lib/edit/orcid-queue`.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import { OrcidQueueFilterBar } from "@/components/edit/orcid-queue-filter-bar";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import { ORCID_URL_PREFIX } from "@/lib/edit/orcid";
import {
  isOrcidCandidateSource,
  isOrcidSampleBand,
  ORCID_QUEUE_SAMPLE_SIZE,
  ORCID_QUEUE_TAB_LABEL,
  ORCID_QUEUE_TABS,
  ORCID_SOURCE_LABEL,
  ORCID_SURNAME_RULE_LABEL,
  orcidQueueFilterKey,
  orcidQueueHref,
  pmCurateHref,
  RECITER_WORK_STATUS_LABEL,
  RECITER_WORK_STATUSES,
  sampleStatus,
  workHref,
  type OrcidInstitutionPair,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueRow,
  type OrcidQueueSampleState,
  type OrcidQueueTab,
  type OrcidQueueWork,
  type ReciterWorkStatus,
} from "@/lib/edit/orcid-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

type Outcome = "confirmed" | "dismissed" | "undone";
type ChipKey = "institution" | "email" | "name" | "shared" | "competitor" | "sources";

const CHIP = "rounded-full px-2 py-px text-xs font-medium whitespace-nowrap";
const CHIP_ON = "bg-apollo-slate-tint text-apollo-slate";
const CHIP_OFF = "bg-apollo-surface-2 text-muted-foreground";
const CHIP_WARN = "bg-apollo-amber-tint text-apollo-amber";
const CARD =
  "bg-apollo-surface border-apollo-border-strong rounded-[var(--apollo-radius-card)] border";
const LINK = "text-apollo-slate hover:underline";

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
  if (code === "other_not_in_queue")
    return "One of this scholar's other iDs left the queue since the page loaded. Refresh and try again.";
  if (code === "sample_row_decided") return "Someone already decided this sampled row.";
  if (code === "stale_sample")
    return "This sample is out of date: a newer sample was started, or the band was re-scored since. Refresh the page.";
  if (code === "filter_mismatch")
    return "This sample was drawn under a different filter. Review a sample under this filter to confirm in bulk here.";
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

const pairKey = (r: Pick<OrcidQueueRow, "cwid" | "orcid">) => `${r.cwid}|${r.orcid}`;
const fmt = (n: number) => n.toLocaleString("en-US");

export function OrcidQueue({
  data,
  basePath,
  readOnly,
  facets = null,
  pmBaseUrl = null,
}: {
  data: OrcidQueueData;
  basePath: string;
  /** View as: every control off (the routes refuse impersonated decisions). */
  readOnly: boolean;
  /** The filter bar's person facets; null = unavailable (source filter only). */
  facets?: DataQualityFacets | null;
  /** v2.1: Publication Manager's https base URL (`publicationManagerBaseUrl`);
   *  null = no Publication Manager links. */
  pmBaseUrl?: string | null;
}) {
  const router = useRouter();
  const { tab, cards, counts, filter } = data;
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [sampleDecisions, setSampleDecisions] = useState<Record<string, "confirmed" | "dismissed">>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const canDecide = !readOnly;
  const filterKey = orcidQueueFilterKey(filter);
  const sampleHere = !!data.sample && data.sample.filterKey === filterKey;

  // The sample's live state: the server's, plus decisions made on this page.
  const rows = cards.flatMap((c) => c.candidates);
  const sampled = rows.filter((r) => r.sampleDecision !== undefined);
  const sample: OrcidQueueSampleState | null = data.sample
    ? data.sample.status === "open" && sampleHere
      ? (() => {
          const decisions = sampled.map((r) => ({
            decision: sampleDecisions[pairKey(r)] ?? r.sampleDecision ?? null,
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
      opts: { replace?: boolean; others?: OrcidQueueRow[] } = {},
    ) => {
      if (!canDecide || busy) return;
      const k = pairKey(row);
      setBusy(k);
      setError(null);
      const inSample =
        row.sampleDecision === null &&
        !sampleDecisions[k] &&
        data.sample?.status === "open" &&
        sampleHere;
      const others = opts.others ?? [];
      const r = await post("decide", {
        cwid: row.cwid,
        orcid: row.orcid,
        decision,
        ...(inSample ? { sampleId: data.sample!.id } : {}),
        ...(opts.replace ? { replace: true } : {}),
        ...(others.length > 0 ? { dismissOthers: others.map((o) => o.orcid) } : {}),
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
        ...Object.fromEntries(others.map((x) => [pairKey(x), "dismissed" as const])),
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
            ? `Confirmed. The iD is on file and reaches WCM Identity overnight.${
                others.length > 0
                  ? ` ${others.length === 1 ? "The other iD is" : `The other ${others.length} iDs are`} marked not this person.`
                  : ""
              }`
            : "Marked not this person. The iD won't be suggested again.",
      );
    },
    [canDecide, busy, sampleDecisions, data.sample, sampleHere],
  );

  const startSample = useCallback(
    async (restart: boolean) => {
      if (!canDecide || busy || !isOrcidSampleBand(tab)) return;
      setBusy("sample");
      setError(null);
      const r = await post("sample", { band: tab, filter, ...(restart ? { restart: true } : {}) });
      setBusy(null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    },
    [canDecide, busy, tab, filter, router],
  );

  const bulkConfirm = useCallback(async () => {
    if (!canDecide || busy || !sample || !isOrcidSampleBand(tab)) return;
    setBusy("bulk");
    setError(null);
    const r = await post("bulk-confirm", { band: tab, sampleId: sample.id, filter });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const confirmed = Number(r.data.confirmed ?? 0);
    const skipped = Number(r.data.skipped ?? 0);
    setToast(
      `Confirmed ${fmt(confirmed)}.` +
        (skipped > 0 ? ` Skipped ${fmt(skipped)} that changed since they were scored.` : ""),
    );
    router.refresh();
  }, [canDecide, busy, sample, tab, filter, router]);

  return (
    <div className="flex flex-col gap-[18px]" data-slot="orcid-queue">
      <div
        className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b"
        role="tablist"
      >
        {ORCID_QUEUE_TABS.map((t) => (
          <Link
            key={t}
            href={orcidQueueHref(basePath, t, filter)}
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
              {fmt(counts[t])}
            </span>
          </Link>
        ))}
      </div>

      <OrcidQueueFilterBar facets={facets} filter={filter} tab={tab} basePath={basePath} />

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
          sampleHere={sampleHere}
          remaining={data.remaining}
          bandSize={counts[tab]}
          canDecide={canDecide}
          busy={busy !== null}
          onStart={(restart) => void startSample(restart)}
          onBulk={() => void bulkConfirm()}
        />
      ) : null}

      {cards.length === 0 ? (
        <div
          className={cn(CARD, "text-muted-foreground p-8 text-center text-[14px]")}
          data-testid="orcid-queue-empty"
        >
          Nothing in {ORCID_QUEUE_TAB_LABEL[tab]}
          {filterKey ? " under this filter" : ""}.
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="orcid-queue-list">
          {cards.length < counts[tab] ? (
            <p className="text-muted-foreground m-0 text-[13px]">
              Showing {fmt(cards.length)} of {fmt(counts[tab])} scholars.
            </p>
          ) : null}
          {cards.map((c) => (
            <ScholarCard
              key={c.cwid}
              card={c}
              tab={tab}
              outcomes={outcomes}
              sampleDecisions={sampleDecisions}
              canDecide={canDecide}
              busyKey={busy}
              pmBaseUrl={pmBaseUrl}
              onDecide={(row, decision, opts) => void decide(row, decision, opts)}
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
  sampleHere,
  remaining,
  bandSize,
  canDecide,
  busy,
  onStart,
  onBulk,
}: {
  label: string;
  sample: OrcidQueueSampleState | null;
  /** The sample was drawn under the page's filter. */
  sampleHere: boolean;
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
  } else if (!sampleHere) {
    body = (
      <>
        <span className="min-w-0 flex-1" data-testid="orcid-queue-sample-other-filter">
          The latest {label} sample was drawn under a different filter, so it can&rsquo;t unlock
          bulk confirm here. Reviewing a sample under this filter replaces it.
        </span>
        {start(`Review a sample of ${ORCID_QUEUE_SAMPLE_SIZE}`, true)}
      </>
    );
  } else if (sample.status === "open") {
    body = (
      <>
        <span className="min-w-0 flex-1" data-testid="orcid-queue-sample-open">
          Sample in review: {sample.decided} of {sample.total} decided. The sampled scholars are
          listed first.
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
            Confirm remaining {fmt(remaining)}
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

function ScholarCard({
  card,
  tab,
  outcomes,
  sampleDecisions,
  canDecide,
  busyKey,
  pmBaseUrl,
  onDecide,
}: {
  card: OrcidQueueCard;
  tab: OrcidQueueTab;
  outcomes: Record<string, Outcome>;
  sampleDecisions: Record<string, "confirmed" | "dismissed">;
  canDecide: boolean;
  busyKey: string | null;
  pmBaseUrl: string | null;
  onDecide: (
    row: OrcidQueueRow,
    decision: "confirm" | "dismiss",
    opts: { replace?: boolean; others?: OrcidQueueRow[] },
  ) => void;
}) {
  const [alsoDismiss, setAlsoDismiss] = useState(true);
  const isOpen = (r: OrcidQueueRow) =>
    (r.state === "queue" || r.state === "conflict") &&
    !outcomes[pairKey(r)] &&
    !r.sampleDecision &&
    !sampleDecisions[pairKey(r)];
  const open = card.candidates.filter(isOpen);
  const many = card.candidates.length > 1;
  return (
    <article
      className={cn(CARD, "flex flex-col gap-3 px-5 py-4")}
      data-testid={`orcid-queue-card-${card.cwid}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[15px] font-semibold">
          {card.slug ? (
            <Link href={profilePath(card.slug)} className="hover:underline">
              {card.name}
            </Link>
          ) : (
            card.name
          )}
        </span>
        <span className="text-muted-foreground text-[13px]">
          {[card.title, card.department].filter(Boolean).join(" · ") || "No title on record"}
        </span>
        {many ? (
          <span className="text-muted-foreground ml-auto text-[13px]">
            {card.candidates.length} candidate iDs, best first
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {card.candidates.map((r, i) => (
          <Candidate
            key={pairKey(r)}
            row={r}
            card={card}
            divided={i > 0}
            tab={tab}
            outcome={outcomes[pairKey(r)] ?? null}
            sampleDecision={sampleDecisions[pairKey(r)] ?? r.sampleDecision}
            canDecide={canDecide}
            busy={busyKey === pairKey(r)}
            pmBaseUrl={pmBaseUrl}
            onConfirm={() =>
              onDecide(r, "confirm", {
                replace: r.state === "conflict",
                others: alsoDismiss ? open.filter((o) => o.orcid !== r.orcid) : [],
              })
            }
            onDismiss={() => onDecide(r, "dismiss", {})}
          />
        ))}
      </div>
      {canDecide && open.length > 1 ? (
        <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={alsoDismiss}
            onChange={(e) => setAlsoDismiss(e.target.checked)}
            data-testid="orcid-queue-also-dismiss"
          />
          Confirming one iD also marks this scholar&rsquo;s other {open.length - 1} Not this person
        </label>
      ) : null}
    </article>
  );
}

const STATUS_TONE: Record<ReciterWorkStatus, string> = {
  accepted: CHIP_ON,
  pending: CHIP_ON,
  rejected: CHIP_WARN,
  not_retrieved: CHIP_OFF,
  not_in_pubmed: CHIP_OFF,
  no_ids: CHIP_OFF,
};

/** The Publication Manager action for a new work (v2.1): review a pending or
 *  rejected paper on the scholar's curate page; add a DOI PubMed lacks on its
 *  Add tab. Null otherwise, or without an https PM base. */
function pmActionOf(
  w: OrcidQueueWork,
  cwid: string,
  base: string | null,
): { href: string; label: string } | null {
  if (w.status === "pending" || w.status === "rejected") {
    const href = pmCurateHref(base, cwid);
    return href ? { href, label: "Review in Publication Manager" } : null;
  }
  if (w.status === "not_in_pubmed" && w.doi) {
    const href = pmCurateHref(base, cwid, { doi: w.doi });
    return href ? { href, label: "Add in Publication Manager" } : null;
  }
  return null;
}

const STATUS_SHORT: Record<ReciterWorkStatus, string> = {
  accepted: "accepted",
  pending: "pending",
  rejected: "rejected",
  not_retrieved: "not retrieved",
  not_in_pubmed: "not in PubMed",
  no_ids: "with no identifiers",
};

/** The new works by ReCiter status (v2.1), from the ETL's counts. */
function WorkStatusSummary({ row: r }: { row: OrcidQueueRow }) {
  const ws = r.detail?.workStatus;
  if (!ws || r.newWorks === 0) return null;
  const parts = RECITER_WORK_STATUSES.flatMap((st) =>
    ws.counts[st] ? [`${fmt(ws.counts[st]!)} ${STATUS_SHORT[st]}`] : [],
  );
  if (ws.unknown > 0) parts.push(`${fmt(ws.unknown)} status unknown`);
  const sentences = [
    ...(parts.length > 0 ? [`ReCiter: ${parts.join(" · ")}`] : []),
    ...(ws.acceptedInReciter > 0
      ? [`${fmt(ws.acceptedInReciter)} accepted in ReCiter counted as shared`]
      : []),
    ...(!ws.reciterRead ? ["ReCiter could not be read on the last run"] : []),
    ...((ws.pubmedUnknown ?? 0) > 0
      ? [`PubMed lookup unavailable on the last run for ${fmt(ws.pubmedUnknown!)} DOI-only works`]
      : []),
  ];
  return (
    <div className="text-muted-foreground mt-0.5" data-testid="orcid-queue-work-status-summary">
      {sentences.join(". ")}
    </div>
  );
}

const SOURCE_SIDE: Record<OrcidInstitutionPair["ours"]["source"], string> = {
  wcm: "WCM",
  education: "Education (ASMS)",
  appointment: "External appointment",
  identity: "ReCiter Identity",
};

const years = (start: number | null, end: number | null) =>
  start || end ? ` ${start ?? "?"}–${end ?? "present"}` : "";

function orcidDisplayName(r: OrcidQueueRow): { main: string | null; aka: string[] } {
  const n = r.detail?.names.orcid;
  if (!n) return { main: null, aka: [] };
  const full = [n.given, n.family].filter(Boolean).join(" ") || null;
  const main = n.credit ?? full;
  const aka = [...new Set([...(n.credit && full ? [full] : []), ...n.other])].filter(
    (x) => x && x !== main,
  );
  return { main, aka };
}

function Candidate({
  row: r,
  card,
  divided,
  tab,
  outcome,
  sampleDecision,
  canDecide,
  busy,
  pmBaseUrl,
  onConfirm,
  onDismiss,
}: {
  row: OrcidQueueRow;
  card: OrcidQueueCard;
  divided: boolean;
  tab: OrcidQueueTab;
  outcome: Outcome | null;
  sampleDecision: "confirmed" | "dismissed" | null | undefined;
  canDecide: boolean;
  busy: boolean;
  pmBaseUrl: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  const decided =
    outcome !== null ||
    (r.sampleDecision !== undefined && r.sampleDecision !== null) ||
    r.state === "on_file";
  const d = r.detail;
  const inst = r.instMatch || r.historyMatch;
  const sources = r.sources.filter(isOrcidCandidateSource);
  const orcidName = orcidDisplayName(r);
  const chip = (key: ChipKey, tone: string, text: string, testId?: string) => (
    <button
      type="button"
      className={cn(CHIP, tone, "cursor-pointer")}
      aria-expanded={openChip === key}
      onClick={() => setOpenChip(openChip === key ? null : key)}
      data-testid={testId ?? `orcid-queue-chip-${key}`}
    >
      {text}
    </button>
  );
  return (
    <section
      className={cn(
        "flex flex-col gap-2.5",
        divided && "border-apollo-border border-t pt-3",
        decided && "opacity-55",
      )}
      data-testid={`orcid-queue-row-${r.cwid}-${r.orcid}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <a
          href={`${ORCID_URL_PREFIX}${r.orcid}`}
          target="_blank"
          rel="noreferrer"
          className="text-apollo-slate font-medium tabular-nums hover:underline"
        >
          {r.orcid}
        </a>
        <span className={cn(CHIP, CHIP_OFF)}>{ORCID_QUEUE_TAB_LABEL[r.band]}</span>
        {r.onFileOrcid && r.state === "conflict" ? (
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

      <div
        className="grid gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-[auto_1fr]"
        data-testid="orcid-queue-names"
      >
        <span className="text-muted-foreground">Scholar</span>
        <span>{card.scholarNames.join(" / ") || card.name}</span>
        <span className="text-muted-foreground">ORCID</span>
        <span>
          {orcidName.main ?? "Name not public, or not read yet"}
          {orcidName.aka.length > 0 ? (
            <span className="text-muted-foreground">
              {" "}
              (also known as {orcidName.aka.join("; ")})
            </span>
          ) : null}
          <span className={cn("ml-2", r.nameAgrees ? "text-apollo-slate" : "text-apollo-amber")}>
            {r.nameAgrees
              ? `Agree: ${d?.names.surnameRule ? ORCID_SURNAME_RULE_LABEL[d.names.surnameRule] : "surname"}, full given name`
              : d
                ? `Differ: ${
                    !d.names.givenAgrees && !d.names.surnameRule
                      ? "given name and surname"
                      : !d.names.givenAgrees
                        ? "given name"
                        : "surname"
                  }`
                : "Differ"}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="orcid-queue-chips">
        {sampleDecision !== undefined ? <span className={cn(CHIP, CHIP_WARN)}>Sample</span> : null}
        {chip(
          "institution",
          inst ? CHIP_ON : CHIP_OFF,
          r.instMatch && r.historyMatch
            ? "Institution and history on record"
            : r.historyMatch
              ? "Past institution on record"
              : r.instMatch
                ? "Institution on record"
                : "No institution",
        )}
        {chip(
          "email",
          r.emailVerified ? CHIP_ON : CHIP_OFF,
          r.emailVerified ? "Verified email" : "No verified email",
        )}
        {chip(
          "name",
          r.nameAgrees ? CHIP_ON : CHIP_WARN,
          r.nameAgrees ? "Name agrees" : "Name differs",
        )}
        {chip("shared", r.shared >= 3 ? CHIP_ON : CHIP_OFF, `Shared ${r.shared}`)}
        {r.competitor ? chip("competitor", CHIP_WARN, "Competitor") : null}
        {sources.length > 0
          ? chip(
              "sources",
              sources.length >= 2 ? CHIP_ON : CHIP_OFF,
              sources.length >= 2
                ? `${sources.length} sources agree`
                : ORCID_SOURCE_LABEL[sources[0]!],
            )
          : null}
        {r.autoConfirmed ? <span className={cn(CHIP, CHIP_ON)}>Confirmed by email</span> : null}
      </div>

      {openChip ? (
        <div
          className="bg-apollo-surface-2 rounded-lg px-3 py-2.5 text-[13px] leading-normal"
          data-testid={`orcid-queue-detail-${openChip}`}
        >
          <ChipDetail chip={openChip} row={r} />
        </div>
      ) : null}

      <div className="text-[13px]">
        <span className="text-muted-foreground">
          {fmt(r.newWorks)} of {fmt(r.worksTotal)} publications on the record are not in this
          scholar&rsquo;s publications
          {r.newWorksSample.length > 0 ? ":" : "."}
        </span>
        <WorkStatusSummary row={r} />
        {r.newWorksSample.length > 0 ? (
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {r.newWorksSample.map((w, i) => {
              const href = workHref(w);
              const pm = pmActionOf(w, r.cwid, pmBaseUrl);
              return (
                <li
                  key={i}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                  data-testid="orcid-queue-work"
                >
                  <span className="min-w-0 truncate">
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className={LINK}>
                        {w.title ?? "Untitled work"}
                      </a>
                    ) : (
                      (w.title ?? "Untitled work")
                    )}
                    <span className="text-muted-foreground">
                      {[w.year, w.source].filter(Boolean).length > 0
                        ? ` · ${[w.year, w.source].filter(Boolean).join(" · ")}`
                        : ""}
                    </span>
                  </span>
                  {w.status ? (
                    <span
                      className={cn(CHIP, STATUS_TONE[w.status])}
                      data-testid="orcid-queue-work-status"
                    >
                      {w.status === "rejected"
                        ? "Rejected in ReCiter: re-review"
                        : RECITER_WORK_STATUS_LABEL[w.status]}
                    </span>
                  ) : null}
                  {pm ? (
                    <a
                      href={pm.href}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(LINK, "text-[12.5px]")}
                      data-testid="orcid-queue-work-pm"
                    >
                      {pm.label}
                    </a>
                  ) : null}
                </li>
              );
            })}
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
        ) : r.state === "on_file" ? (
          <span className="text-muted-foreground text-[13px]" data-testid="orcid-queue-outcome">
            On file
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
                {r.state === "conflict" || tab === "conflicts" ? "Replace with this iD" : "Confirm"}
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
    </section>
  );
}

const NO_DETAIL = "The details arrive with the next weekly evidence run.";

function ChipDetail({ chip, row: r }: { chip: ChipKey; row: OrcidQueueRow }) {
  const d = r.detail;
  if (chip === "sources") {
    const sources = r.sources.filter(isOrcidCandidateSource);
    return (
      <p className="m-0">
        Found by {sources.map((s) => ORCID_SOURCE_LABEL[s]).join(" and ")}
        {sources.length >= 2 ? `: ${sources.length} sources agree on this iD.` : "."}
      </p>
    );
  }
  if (!d) return <p className="m-0">{NO_DETAIL}</p>;
  if (chip === "institution") {
    if (d.institutions.length === 0 && !d.institutionEmail)
      return (
        <p className="m-0">
          No employment or education on the public record matches Weill Cornell or this
          scholar&rsquo;s own history (degrees, external appointments, ReCiter Identity).
        </p>
      );
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {d.institutions.map((p, i) => (
          <li key={i}>
            ORCID: {p.orcid.name}, {p.orcid.kind}
            {years(p.orcid.start, p.orcid.end)} ↔ {SOURCE_SIDE[p.ours.source]}: {p.ours.name}
          </li>
        ))}
        {d.institutionEmail ? <li>A Cornell email on the record: {d.institutionEmail}</li> : null}
      </ul>
    );
  }
  if (chip === "email")
    return (
      <p className="m-0">
        {d.email
          ? `${d.email} is on the ORCID record and ORCID marks it verified.`
          : "The record lists no verified email that is this scholar's."}
      </p>
    );
  if (chip === "name") {
    const n = d.names.orcid;
    return (
      <p className="m-0">
        ORCID record: credit name {n.credit ?? "none"}; given names {n.given ?? "none"}; family name{" "}
        {n.family ?? "none"}
        {n.other.length > 0 ? `; also known as ${n.other.join("; ")}` : ""}. Full given name{" "}
        {d.names.givenAgrees ? "agrees" : "differs"}; surname{" "}
        {d.names.surnameRule
          ? `agrees (${ORCID_SURNAME_RULE_LABEL[d.names.surnameRule]})`
          : "differs"}
        .
      </p>
    );
  }
  if (chip === "shared") {
    if (d.shared.length === 0) return <p className="m-0">No papers in common with this scholar.</p>;
    return (
      <>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {d.shared.map((p) => {
            // Our publications' PubMed strings: through the sanctioned sanitizer (#946).
            const label = p.title ? <PubTitle value={p.title} /> : `PMID ${p.pmid}`;
            const href = workHref(p);
            return (
              <li key={p.pmid}>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className={LINK}>
                    {label}
                  </a>
                ) : (
                  label
                )}
                <span className="text-muted-foreground">
                  {p.year ? ` · ${p.year}` : ""}
                  {p.journal ? " · " : ""}
                  {p.journal ? <PubJournal as="span" value={p.journal} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
        {r.shared > d.shared.length ? (
          <p className="text-muted-foreground m-0 mt-1">
            Showing {fmt(d.shared.length)} of {fmt(r.shared)}.
          </p>
        ) : null}
      </>
    );
  }
  // competitor
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {r.competitors.map((c) => (
        <li key={c.cwid}>
          {c.name} ({c.cwid}){" "}
          {c.reason === "same_id"
            ? `is also a candidate for this iD, with ${c.shared ?? "3+"} shared papers.`
            : `has the same surname and holds ${c.shared ?? "3+"} of this record's papers that this scholar does not.`}
        </li>
      ))}
      {r.competitorOrcids.map((o) => (
        <li key={o.orcid}>
          This scholar&rsquo;s other candidate iD {o.orcid}{" "}
          {o.shared === null
            ? "could not be checked this run, so it counts as a competitor."
            : `shares ${o.shared} papers with them.`}
        </li>
      ))}
    </ul>
  );
}
