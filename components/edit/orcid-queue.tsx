"use client";

/**
 * The ORCID librarian queue (`/edit/orcid-queue`, v3 —
 * Roadmap/orcid-queue-v3-redesign-plan.md, PR A).
 *
 * Master–detail. The scholar list on the left holds every scholar in the
 * queue (the page's summaries); J / K moves between them. Each row carries a
 * 5-step "Match evidence" meter taken from the scholar's best iD (Weak 1 …
 * Email verified 5); a competitor blocks steps 3–5, drawn amber. Search (name,
 * CWID, iD with or without dashes), Confidence, Decision and Possible errors
 * run here over the summaries; person type, department, institution and how
 * discovered run on the server (`orcid-queue-filter-bar.tsx`).
 *
 * The right panel loads the selected scholar's card
 * (`GET /api/edit/orcid-queue/scholar`): one table row per candidate iD, a
 * column per signal, best first. Opening a row shows its evidence (the
 * competitor rule that fired and who, names, signals, and publications ORCID
 * vs. ReCiter) and the one decision bar: Confirm (Replace with this iD when a
 * different iD is on file), Not this person, and "Also mark the other N Not
 * this person". "None of these" marks every open iD. An email auto-confirmed
 * iD shows Undo.
 *
 * Decision defaults to Unassigned (no decision yet). A scholar decided here
 * stays in the list until you move on. Decisions are not re-read after the
 * write (the replica may lag); they show in place. Imports only the pure
 * `@/lib/edit/orcid-queue`.
 */
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Lock, Minus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import {
  OrcidQueueFilterBar,
  type OrcidQueueClientFilter,
} from "@/components/edit/orcid-queue-filter-bar";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import { ORCID_URL_PREFIX } from "@/lib/edit/orcid";
import {
  bandLevel,
  compareSummaries,
  COMPETITOR_CAP_LEVEL,
  competitorRules,
  isOrcidCandidateSource,
  matchesQueueSearch,
  ORCID_QUEUE_BAND_LABEL,
  ORCID_QUEUE_SORT_LABEL,
  ORCID_QUEUE_SORTS,
  ORCID_SOURCE_LABEL,
  ORCID_SURNAME_RULE_LABEL,
  pmCurateHref,
  RECITER_WORK_STATUS_LABEL,
  RECITER_WORK_STATUSES,
  workHref,
  type OrcidInstitutionPair,
  type OrcidOnFile,
  type OrcidQueueBand,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueRow,
  type OrcidQueueSort,
  type OrcidQueueSummary,
  type OrcidQueueWork,
  type ReciterWorkStatus,
} from "@/lib/edit/orcid-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

type Outcome = "confirmed" | "dismissed" | "undone";

const CARD =
  "bg-apollo-surface border-apollo-border-strong rounded-[var(--apollo-radius-card)] border";
const LINK = "text-apollo-slate hover:underline";
const EYEBROW = "text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase";
const CHIP = "rounded-full px-2 py-px text-xs font-medium whitespace-nowrap";
const MONO = "font-mono text-[0.92em]";

function errorMessage(status: number, code: string | undefined): string {
  if (code === "already_on_file") return "This iD is already on file for this scholar.";
  if (code === "on_file_differs")
    return "This scholar now has a different iD on file. Reload to see it as a possible error.";
  if (code === "on_file")
    return "This iD was confirmed by the scholar or a librarian. Remove it from the scholar's own editor.";
  if (code === "dismissed")
    return "This iD was removed by the scholar or marked Not this person, so it can't be confirmed here.";
  if (code === "state_changed")
    return "This scholar changed since the page loaded. Reload to see where they are now.";
  if (code === "other_not_in_queue")
    return "One of this scholar's other iDs left the queue since the page loaded. Reload and try again.";
  if (status === 403) return "Only a superuser, signed in as themselves, can decide this queue.";
  return "We couldn't record that. Please try again.";
}

async function postDecision(
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/orcid-queue/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, message: errorMessage(res.status, data?.error) };
  } catch {
    return { ok: false, message: "We couldn't record that. Please try again." };
  }
}

const pairKey = (cwid: string, orcid: string) => `${cwid}|${orcid}`;
const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The scholar's open candidates: not decided on this page, not the ETL's. */
const openRows = (card: OrcidQueueCard, outcomes: Record<string, Outcome>) =>
  card.candidates.filter((r) => !r.autoConfirmed && !outcomes[pairKey(r.cwid, r.orcid)]);

/** Decided: the ETL confirmed an iD, or every candidate was decided here, or
 *  one was confirmed here. Pure over the summary (the card may not be loaded). */
function isResolved(s: OrcidQueueSummary, outcomes: Record<string, Outcome>): boolean {
  const o = (orcid: string) => outcomes[pairKey(s.cwid, orcid)];
  if (s.candidates.some((c) => o(c.orcid) === "confirmed")) return true;
  if (s.autoConfirmed && !s.candidates.some((c) => o(c.orcid) === "undone")) return true;
  return s.candidates.length > 0 && s.candidates.every((c) => o(c.orcid) !== undefined);
}

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
  const { summaries, filter } = data;
  const [view, setView] = useState<OrcidQueueClientFilter>({
    q: "",
    bands: [],
    decision: "open",
    errorsOnly: false,
  });
  const [sort, setSort] = useState<OrcidQueueSort>("strong");
  const [sel, setSel] = useState<string | null>(null);
  /** The scholar just decided: kept in the list until you move on. */
  const [sticky, setSticky] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [cards, setCards] = useState<Record<string, OrcidQueueCard | "error" | "gone">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const canDecide = !readOnly;

  const list = useMemo(
    () =>
      summaries
        .filter((s) => {
          if (s.cwid === sticky) return true;
          if (!matchesQueueSearch(s, view.q)) return false;
          if (
            view.bands.length > 0 &&
            !(s.candidates[0] && view.bands.includes(s.candidates[0].band))
          )
            return false;
          if (view.errorsOnly && !s.conflict) return false;
          if (view.decision === "open") return !isResolved(s, outcomes);
          if (view.decision === "email") return s.autoConfirmed;
          return true;
        })
        .sort(compareSummaries(sort)),
    [summaries, view, sort, outcomes, sticky],
  );
  const current = list.find((s) => s.cwid === sel) ?? list[0] ?? null;

  const detailRef = useRef<HTMLElement>(null);
  const select = useCallback((cwid: string) => {
    setSel(cwid);
    setSticky(null);
    setError(null);
    // A scholar picked from further down the page starts at their header.
    if ((detailRef.current?.getBoundingClientRect().top ?? 0) < 0)
      detailRef.current?.scrollIntoView({ block: "start" });
  }, []);

  // J / K move through the list.
  const listRef = useRef(list);
  listRef.current = list;
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (e.key !== "j" && e.key !== "k") return;
      const l = listRef.current;
      if (l.length === 0) return;
      const i = Math.max(
        0,
        l.findIndex((s) => s.cwid === currentRef.current?.cwid),
      );
      const next = l[Math.min(l.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))]!;
      select(next.cwid);
      document
        .querySelector(`[data-testid="orcid-queue-item-${next.cwid.replace(/["\\]/g, "")}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  // The selected scholar's card, fetched once.
  const cwid = current?.cwid ?? null;
  const card = cwid ? cards[cwid] : undefined;
  useEffect(() => {
    if (!cwid || card !== undefined) return;
    let live = true;
    fetch(`/api/edit/orcid-queue/scholar?cwid=${encodeURIComponent(cwid)}`)
      .then(async (res) => {
        const v = res.ok
          ? ((await res.json()) as OrcidQueueCard)
          : res.status === 404
            ? "gone"
            : "error";
        if (live) setCards((c) => ({ ...c, [cwid]: v }));
      })
      .catch(() => live && setCards((c) => ({ ...c, [cwid]: "error" })));
    return () => {
      live = false;
    };
  }, [cwid, card]);

  const decide = useCallback(
    async (
      c: OrcidQueueCard,
      row: OrcidQueueRow,
      decision: "confirm" | "dismiss",
      opts: { others?: OrcidQueueRow[]; noneOfThese?: boolean } = {},
    ): Promise<boolean> => {
      if (!canDecide || busy) return false;
      setBusy(true);
      setError(null);
      const others = opts.others ?? [];
      const r = await postDecision({
        cwid: row.cwid,
        orcid: row.orcid,
        decision,
        ...(decision === "confirm" && row.state === "conflict" ? { replace: true } : {}),
        ...(others.length > 0 ? { dismissOthers: others.map((o) => o.orcid) } : {}),
        ...(opts.noneOfThese ? { noneOfThese: true } : {}),
      });
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return false;
      }
      const undone = decision === "dismiss" && row.autoConfirmed;
      setOutcomes((o) => ({
        ...o,
        [pairKey(row.cwid, row.orcid)]: undone
          ? "undone"
          : decision === "confirm"
            ? "confirmed"
            : "dismissed",
        ...Object.fromEntries(others.map((x) => [pairKey(x.cwid, x.orcid), "dismissed" as const])),
      }));
      setSticky(c.cwid);
      setSel(c.cwid);
      setToast(
        undone
          ? "Undone. The iD is off file and won't be suggested again."
          : opts.noneOfThese
            ? `Marked ${others.length === 0 ? "the iD" : `all ${others.length + 1} iDs`} not this person. They won't be suggested again.`
            : decision === "confirm"
              ? `${row.state === "conflict" ? "Replaced" : "Confirmed"}. The iD is on file and reaches WCM Identity overnight.${
                  others.length > 0
                    ? ` ${others.length === 1 ? "The other iD is" : `The other ${others.length} iDs are`} marked not this person.`
                    : ""
                }`
              : "Marked not this person. The iD won't be suggested again.",
      );
      return true;
    },
    [canDecide, busy],
  );

  const moveNext = () => {
    const i = list.findIndex((s) => s.cwid === current?.cwid);
    const next = list[i + 1];
    if (next) select(next.cwid);
    else setSticky(null);
  };

  return (
    <div className="flex flex-col gap-4" data-slot="orcid-queue">
      <OrcidQueueFilterBar
        facets={facets}
        filter={filter}
        basePath={basePath}
        view={view}
        onView={(v) => {
          setView(v);
          setSel(null);
          setSticky(null);
        }}
        summaries={summaries}
      />

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

      <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ScholarList
          list={list}
          current={current}
          outcomes={outcomes}
          sort={sort}
          onSort={setSort}
          onSelect={select}
        />
        <section
          ref={detailRef}
          className={cn(CARD, "min-w-0 scroll-mt-[72px]")}
          data-testid="orcid-queue-detail"
        >
          {!current ? (
            <p
              className="text-muted-foreground m-0 p-8 text-center text-[14px]"
              data-testid="orcid-queue-empty"
            >
              No scholars match these filters.
            </p>
          ) : card === undefined ? (
            <p className="text-muted-foreground m-0 p-8 text-[14px]">Loading {current.name}…</p>
          ) : card === "error" ? (
            <p className="text-destructive m-0 p-8 text-[14px]" role="alert">
              We couldn&rsquo;t load {current.name}. Reload the page to try again.
            </p>
          ) : card === "gone" ? (
            <p className="text-muted-foreground m-0 p-8 text-[14px]" data-testid="orcid-queue-gone">
              {current.name} left the queue since the page loaded: someone decided their iDs, or the
              weekly evidence run dropped them.
            </p>
          ) : (
            <ScholarDetail
              key={card.cwid}
              card={card}
              outcomes={outcomes}
              canDecide={canDecide}
              busy={busy}
              pmBaseUrl={pmBaseUrl}
              hasNext={list.findIndex((s) => s.cwid === card.cwid) < list.length - 1}
              onDecide={(row, decision, opts) => decide(card, row, decision, opts)}
              onNext={moveNext}
            />
          )}
        </section>
      </div>

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

/** The 5-step meter: filled to the band's level; with a competitor, the steps
 *  it blocks (above Moderate) are amber. */
export function EvidenceMeter({
  band,
  competitor,
  className,
}: {
  band: OrcidQueueBand;
  competitor: boolean;
  className?: string;
}) {
  const n = bandLevel(band);
  return (
    <span
      className={cn("inline-flex gap-[2px]", className)}
      role="img"
      aria-label={`${ORCID_QUEUE_BAND_LABEL[band]}, ${n} of 5${competitor ? ", capped by a competitor" : ""}`}
      data-testid="orcid-queue-meter"
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={cn(
            "h-[14px] w-[6px] rounded-[1.5px]",
            i <= n
              ? "bg-apollo-slate"
              : competitor && i > COMPETITOR_CAP_LEVEL
                ? "bg-apollo-amber-tint border-apollo-amber-tint-border border"
                : "bg-apollo-rail-border",
          )}
        />
      ))}
    </span>
  );
}

function ScholarList({
  list,
  current,
  outcomes,
  sort,
  onSort,
  onSelect,
}: {
  list: OrcidQueueSummary[];
  current: OrcidQueueSummary | null;
  outcomes: Record<string, Outcome>;
  sort: OrcidQueueSort;
  onSort: (s: OrcidQueueSort) => void;
  onSelect: (cwid: string) => void;
}) {
  const [sortOpen, setSortOpen] = useState(false);
  return (
    <aside
      className={cn(CARD, "bg-apollo-surface-2 overflow-hidden lg:sticky lg:top-[72px]")}
      data-testid="orcid-queue-list"
    >
      <div className="border-apollo-border flex flex-col gap-1.5 border-b px-4 pt-3.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13.5px] font-semibold" data-testid="orcid-queue-count">
            {plural(list.length, "scholar")}
          </span>
          <span className="text-muted-foreground flex items-center gap-1 text-[12px]">
            <kbd className="border-apollo-border-strong bg-apollo-surface rounded border px-1.5 font-sans text-[11px]">
              J
            </kbd>
            <kbd className="border-apollo-border-strong bg-apollo-surface rounded border px-1.5 font-sans text-[11px]">
              K
            </kbd>
            to move
          </span>
        </div>
        <Popover open={sortOpen} onOpenChange={setSortOpen}>
          <PopoverTrigger
            className="text-muted-foreground inline-flex w-max items-center gap-1 text-[12.5px]"
            data-testid="orcid-queue-sort"
          >
            Sort:{" "}
            <span className="text-foreground font-semibold">
              {ORCID_QUEUE_SORT_LABEL[sort].label}
            </span>
            <ChevronDown className="size-3.5" strokeWidth={2.4} aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="border-apollo-border-strong bg-apollo-surface flex w-[300px] flex-col rounded-[10px] p-1"
          >
            {ORCID_QUEUE_SORTS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  onSort(k);
                  setSortOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2.5 py-2 text-left",
                  sort === k ? "bg-apollo-slate-tint" : "hover:bg-apollo-surface-2",
                )}
                data-testid={`orcid-queue-sort-${k}`}
              >
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    sort === k ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
                <span className="flex flex-col">
                  <span className="text-[13.5px] font-medium">
                    {ORCID_QUEUE_SORT_LABEL[k].label}
                  </span>
                  <span className="text-muted-foreground text-[12px]">
                    {ORCID_QUEUE_SORT_LABEL[k].hint}
                  </span>
                </span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <div
        className="max-h-[calc(100vh-170px)] overflow-y-auto"
        role="listbox"
        aria-label="Scholars"
      >
        {list.map((s) => {
          const best = s.candidates[0];
          const selected = s.cwid === current?.cwid;
          const resolved = isResolved(s, outcomes);
          return (
            <button
              key={s.cwid}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(s.cwid)}
              className={cn(
                "border-apollo-border flex w-full items-start gap-3 border-b border-l-[3px] px-4 py-3 text-left",
                selected
                  ? "border-l-apollo-slate bg-apollo-slate-tint"
                  : "hover:bg-apollo-surface border-l-transparent",
              )}
              data-testid={`orcid-queue-item-${s.cwid}`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn("truncate text-[14px]", selected ? "font-semibold" : "font-medium")}
                >
                  {s.name}
                </span>
                <span className="text-muted-foreground truncate text-[12.5px]">
                  {s.department ? `${s.department} · ` : ""}
                  <span className={MONO}>{s.cwid}</span>
                </span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  {resolved
                    ? s.autoConfirmed &&
                      !s.candidates.some((c) => outcomes[pairKey(s.cwid, c.orcid)])
                      ? "Confirmed by email · automatic"
                      : "Decided"
                    : plural(s.candidates.length, "candidate iD")}
                  {s.conflict ? (
                    <span className="border-apollo-border-strong inline-flex items-center gap-1 rounded border px-1.5 text-[11px]">
                      <Lock className="size-2.5" aria-hidden />
                      iD on file
                    </span>
                  ) : null}
                </span>
              </span>
              {best ? (
                <span
                  className={cn("flex shrink-0 flex-col items-end gap-1", resolved && "opacity-40")}
                >
                  <EvidenceMeter band={best.band} competitor={best.competitor} />
                  <span className="text-muted-foreground flex items-center gap-1 text-[12.5px]">
                    {best.competitor ? (
                      <ArrowLeftRight
                        className="text-apollo-amber size-3"
                        aria-label="Competitor"
                      />
                    ) : null}
                    {ORCID_QUEUE_BAND_LABEL[best.band]}
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

const INST_LONG = (r: OrcidQueueRow) =>
  r.instMatch && r.historyMatch
    ? "Institution and history on record"
    : r.historyMatch
      ? "Past institution on record"
      : r.instMatch
        ? "Institution on record"
        : "No institution";
const INST_SHORT = (r: OrcidQueueRow) =>
  r.instMatch && r.historyMatch
    ? "On record + history"
    : r.historyMatch
      ? "History only"
      : r.instMatch
        ? "On record"
        : "None";

function foundBy(r: OrcidQueueRow): string {
  const sources = r.sources.filter(isOrcidCandidateSource);
  if (sources.length >= 2) return `${sources.length} sources agree`;
  return sources[0] ? ORCID_SOURCE_LABEL[sources[0]] : "Unknown";
}

function nameVerdict(r: OrcidQueueRow): string {
  const d = r.detail;
  if (r.nameAgrees)
    return `same ${d?.names.surnameRule ? ORCID_SURNAME_RULE_LABEL[d.names.surnameRule].replace(/^same /, "") : "surname"}, full given name`;
  if (!d) return "names differ";
  return !d.names.givenAgrees && !d.names.surnameRule
    ? "given name and surname"
    : !d.names.givenAgrees
      ? "given name"
      : "surname";
}

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

const ON_FILE_HOW: Record<OrcidOnFile["how"], string> = {
  self: "Confirmed by the scholar on their profile",
  proxy: "Confirmed by a proxy on the scholar's profile",
  librarian: "Confirmed by a librarian",
  email_verified: "Confirmed automatically from a verified email",
  authenticated: "Self-claimed by the scholar through ORCID sign-in",
  identity: "From WCM Identity",
  rpm_admin: "Entered by a Publication Manager admin",
};

function onFileProvenance(f: OrcidOnFile): React.ReactNode {
  return (
    <>
      {ON_FILE_HOW[f.how]}
      {f.byName && f.how !== "self" ? (
        <>
          {" "}
          ({f.byName} <span className={MONO}>{f.by}</span>)
        </>
      ) : null}
      {f.at ? ` on ${dateTime(f.at)}` : ""}
    </>
  );
}

function ScholarDetail({
  card,
  outcomes,
  canDecide,
  busy,
  pmBaseUrl,
  hasNext,
  onDecide,
  onNext,
}: {
  card: OrcidQueueCard;
  outcomes: Record<string, Outcome>;
  canDecide: boolean;
  busy: boolean;
  pmBaseUrl: string | null;
  hasNext: boolean;
  onDecide: (
    row: OrcidQueueRow,
    decision: "confirm" | "dismiss",
    opts?: { others?: OrcidQueueRow[]; noneOfThese?: boolean },
  ) => Promise<boolean>;
  onNext: () => void;
}) {
  const outcomeOf = (r: OrcidQueueRow) => outcomes[pairKey(r.cwid, r.orcid)];
  const rows = card.candidates;
  const open = openRows(card, outcomes);
  const auto = rows.find((r) => r.autoConfirmed && outcomeOf(r) !== "undone");
  const confirmed = rows.find((r) => outcomeOf(r) === "confirmed");
  const decided = !!auto || !!confirmed || (rows.length > 0 && open.length === 0);
  const ranked = rows.filter((r) => !r.autoConfirmed);
  const best = ranked[0] ?? rows[0]!;
  const runner = ranked[1];
  const [openId, setOpenId] = useState<string | null>(open[0]?.orcid ?? rows[0]?.orcid ?? null);
  const [alsoDismiss, setAlsoDismiss] = useState(true);
  const conflict = rows.some((r) => r.state === "conflict");

  return (
    <div className="flex flex-col" data-testid={`orcid-queue-card-${card.cwid}`}>
      <div className="flex flex-wrap items-start justify-between gap-6 px-7 pt-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {card.department ? <span className={EYEBROW}>{card.department}</span> : null}
          <h2 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.01em]">
            {card.name}
          </h2>
          {card.title ? <span className="text-[15px] text-[#3a3532]">{card.title}</span> : null}
          <span className="text-muted-foreground flex flex-wrap items-baseline gap-3 text-[13.5px]">
            <span>
              CWID <span className={cn(MONO, "text-foreground")}>{card.cwid}</span>
            </span>
            {card.slug ? (
              <Link href={profilePath(card.slug)} className={LINK} target="_blank">
                View profile ↗
              </Link>
            ) : null}
          </span>
          {card.onFile && !auto ? (
            <div
              className="border-apollo-border-strong bg-apollo-surface-2 mt-3 flex flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 text-[13px]"
              data-testid="orcid-queue-on-file"
            >
              <span className="flex items-center gap-2">
                <Lock className="text-muted-foreground size-3.5" aria-hidden />
                <span className="text-muted-foreground">On file</span>
                <a
                  href={`${ORCID_URL_PREFIX}${card.onFile.orcid}`}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(MONO, "hover:underline")}
                >
                  {card.onFile.orcid}
                </a>
                <span className={card.onFile.name ? undefined : "text-muted-foreground"}>
                  · {card.onFile.name ?? "Name not public"}
                </span>
              </span>
              <span className="text-muted-foreground text-[12.5px]">
                {onFileProvenance(card.onFile)}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex w-full max-w-[420px] flex-col gap-3">
          {decided ? (
            <DecisionBlock card={card} auto={auto} confirmed={confirmed} outcomes={outcomes} />
          ) : null}
          <div
            className={cn(
              "border-apollo-border-strong bg-apollo-surface-2 flex flex-col gap-2 rounded-lg border px-4 py-3.5 text-[13.5px] leading-normal",
              decided && "opacity-55",
            )}
            data-testid="orcid-queue-evidence"
          >
            <span className="flex items-center gap-3">
              <span className={EYEBROW}>
                {decided ? "Match evidence before review" : "Match evidence"}
              </span>
              <EvidenceMeter band={best.band} competitor={best.competitor} />
              <span className="text-[17px] font-semibold">{ORCID_QUEUE_BAND_LABEL[best.band]}</span>
            </span>
            <span className="text-[#3a3532]">
              {ranked.length > 1 ? `Best of ${ranked.length} iDs: ` : "From its one iD: "}
              {foundBy(best)}; {fmt(best.shared)} of the {fmt(best.worksTotal)} works on the ORCID
              record are also in ReCiter; name {best.nameAgrees ? "agrees" : "differs"}.
            </span>
            {card.onFile && !decided ? (
              <span className="text-muted-foreground border-apollo-border border-t pt-2 text-[12.5px]">
                This rates the candidate iD only. The iD on file isn&rsquo;t scored.
              </span>
            ) : null}
            {best.competitor ? (
              <span className="text-apollo-amber flex gap-1.5 text-[12.5px]">
                <ArrowLeftRight className="mt-0.5 size-3 shrink-0" aria-hidden />
                The best iD has a competitor
                {competitorRules(best).length > 0
                  ? ` (rule ${competitorRules(best).join(", ")})`
                  : ""}
                , so this scholar can&rsquo;t reach Strong or be confirmed automatically.
              </span>
            ) : null}
            {runner ? (
              <span className="text-muted-foreground text-[12.5px]">
                Next best is {ORCID_QUEUE_BAND_LABEL[runner.band]} ({fmt(runner.shared)} of{" "}
                {fmt(runner.worksTotal)} ORCID works in ReCiter, name{" "}
                {runner.nameAgrees ? "agrees" : "differs"}).
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-3 text-[13px]">
            <span className="text-muted-foreground">
              {ranked.length > 1
                ? `${plural(ranked.length, "candidate iD")}, best first`
                : plural(ranked.length, "candidate iD")}
            </span>
            {canDecide && open.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void onDecide(open[0]!, "dismiss", { others: open.slice(1), noneOfThese: true })
                }
                className="text-[13px]"
                data-testid="orcid-queue-none"
              >
                None of these
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="border-apollo-border overflow-x-auto border-t">
        <div className="min-w-[870px]">
          <div
            className={cn(
              GRID,
              "bg-apollo-surface-2 border-apollo-border text-muted-foreground border-b py-2.5 text-[11.5px] font-semibold tracking-[0.08em] uppercase",
            )}
          >
            <span />
            <span>ORCID iD</span>
            <span>Tier</span>
            <span>Name on ORCID</span>
            <span>Institution</span>
            <span>Shared works</span>
            <span>Found by</span>
          </div>
          {rows.map((r, i) => (
            <CandidateRow
              key={r.orcid}
              card={card}
              row={r}
              isBest={i === 0 && ranked.length > 1 && !r.autoConfirmed}
              isOpen={openId === r.orcid}
              outcome={outcomeOf(r) ?? null}
              onToggle={() => setOpenId(openId === r.orcid ? null : r.orcid)}
              onOpen={(orcid) => setOpenId(orcid)}
              open={open}
              alsoDismiss={alsoDismiss}
              onAlsoDismiss={setAlsoDismiss}
              canDecide={canDecide}
              busy={busy}
              pmBaseUrl={pmBaseUrl}
              conflict={conflict}
              onConfirm={() =>
                void onDecide(r, "confirm", {
                  others: alsoDismiss ? open.filter((o) => o.orcid !== r.orcid) : [],
                })
              }
              onDismiss={async () => {
                if (await onDecide(r, "dismiss")) {
                  const next = open.find((o) => o.orcid !== r.orcid);
                  setOpenId(next?.orcid ?? null);
                }
              }}
            />
          ))}
        </div>
      </div>

      {decided ? (
        <div className="border-apollo-border flex flex-wrap items-center gap-3 border-t px-7 py-4 text-[13.5px]">
          <span className="text-muted-foreground min-w-0 flex-1" data-testid="orcid-queue-resolved">
            {confirmed
              ? `${conflict ? "Replaced with" : "Confirmed"} ${confirmed.orcid}. Reaches WCM Identity overnight.`
              : auto
                ? `${auto.orcid} was confirmed automatically from a verified email.`
                : `All ${plural(rows.length, "candidate iD")} marked Not this person.`}
          </span>
          {hasNext ? (
            <Button
              type="button"
              size="sm"
              onClick={onNext}
              className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white"
            >
              Next scholar
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Fits the detail panel at a ~1380px window (list 300px): 870px of columns and gaps.
const GRID =
  "grid grid-cols-[28px_minmax(156px,1fr)_84px_minmax(140px,1.2fr)_124px_132px_minmax(130px,1fr)] items-start gap-x-3 px-4";

function DecisionBlock({
  card,
  auto,
  confirmed,
  outcomes,
}: {
  card: OrcidQueueCard;
  auto: OrcidQueueRow | undefined;
  confirmed: OrcidQueueRow | undefined;
  outcomes: Record<string, Outcome>;
}) {
  const dismissed = card.candidates.filter(
    (r) => outcomes[pairKey(r.cwid, r.orcid)] === "dismissed",
  ).length;
  return (
    <div
      className="border-apollo-slate-tint-border bg-apollo-slate-tint flex flex-col gap-1 rounded-lg border px-4 py-3 text-[13.5px]"
      data-testid="orcid-queue-decision"
    >
      <span className={EYEBROW}>Decision</span>
      <span className="font-semibold">
        {confirmed ? (
          <>
            {confirmed.state === "conflict" ? "Replaced with " : "Confirmed "}
            <span className={MONO}>{confirmed.orcid}</span>
          </>
        ) : auto ? (
          <>
            Confirmed <span className={MONO}>{auto.orcid}</span>
          </>
        ) : (
          "None of the candidates"
        )}
      </span>
      <span className="text-muted-foreground text-[12.5px]">
        {confirmed || !auto
          ? `By you, just now${dismissed > 0 ? ` · ${plural(dismissed, "iD")} marked Not this person` : ""}.`
          : card.onFile?.at
            ? `Automatically, from a verified email on the ORCID record, on ${dateTime(card.onFile.at)}.`
            : "Automatically, from a verified email on the ORCID record."}
      </span>
    </div>
  );
}

function CandidateRow({
  card,
  row: r,
  isBest,
  isOpen,
  outcome,
  onToggle,
  onOpen,
  open,
  alsoDismiss,
  onAlsoDismiss,
  canDecide,
  busy,
  pmBaseUrl,
  conflict,
  onConfirm,
  onDismiss,
}: {
  card: OrcidQueueCard;
  row: OrcidQueueRow;
  isBest: boolean;
  isOpen: boolean;
  outcome: Outcome | null;
  onToggle: () => void;
  onOpen: (orcid: string) => void;
  open: OrcidQueueRow[];
  alsoDismiss: boolean;
  onAlsoDismiss: (v: boolean) => void;
  canDecide: boolean;
  busy: boolean;
  pmBaseUrl: string | null;
  conflict: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const name = orcidDisplayName(r);
  const pct = r.worksTotal > 0 ? Math.min(100, (r.shared / r.worksTotal) * 100) : 0;
  const struck = outcome === "dismissed" || outcome === "undone";
  const others = open.filter((o) => o.orcid !== r.orcid).length;
  const pending = !outcome && !r.autoConfirmed;
  return (
    <div
      className={cn("border-apollo-border border-b", isOpen && "bg-apollo-surface-2")}
      data-testid={`orcid-queue-row-${r.cwid}-${r.orcid}`}
    >
      {/* A div, not a <button>: the iD inside is a link people click and copy. */}
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Selecting text to copy it shouldn't toggle the row.
          if (!window.getSelection()?.isCollapsed) return;
          if ((e.target as HTMLElement).closest("a")) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onToggle();
        }}
        aria-expanded={isOpen}
        className={cn(
          GRID,
          "w-full cursor-pointer py-3.5 text-left text-[13.5px]",
          struck && "opacity-55",
        )}
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground mt-1 size-4 transition-transform",
            isOpen && "rotate-90",
          )}
          aria-hidden
        />
        <span className="flex flex-col gap-0.5">
          <a
            href={`${ORCID_URL_PREFIX}${r.orcid}`}
            target="_blank"
            rel="noreferrer"
            className={cn(
              MONO,
              "w-fit text-[13px] hover:underline",
              outcome === "dismissed" && "line-through",
            )}
          >
            {r.orcid}
          </a>
          {isBest && pending ? (
            <span className="text-apollo-slate text-[11.5px] font-semibold">Best match</span>
          ) : null}
          {outcome || r.autoConfirmed ? (
            <span
              className={cn(
                "text-[11.5px] font-semibold",
                outcome === "confirmed" || (r.autoConfirmed && !outcome)
                  ? "text-apollo-slate"
                  : "text-destructive",
              )}
              data-testid="orcid-queue-outcome"
            >
              {outcome === "confirmed"
                ? conflict
                  ? "Replaced the iD on file"
                  : "Confirmed"
                : outcome === "undone"
                  ? "Undone"
                  : outcome === "dismissed"
                    ? "Not this person"
                    : "Confirmed by email"}
            </span>
          ) : null}
        </span>
        <span>
          <span
            className={cn(
              CHIP,
              "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate border",
            )}
          >
            {ORCID_QUEUE_BAND_LABEL[r.band]}
          </span>
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            {r.nameAgrees ? <Check className="text-apollo-slate size-3.5" aria-hidden /> : null}
            <span className={name.main ? undefined : "text-muted-foreground"}>
              {name.main ?? "Name not public"}
            </span>
          </span>
          <span
            className={cn(
              "text-[12.5px]",
              r.nameAgrees ? "text-apollo-slate" : "text-apollo-amber",
            )}
          >
            {r.nameAgrees ? "Agrees" : "Differs"}: {nameVerdict(r)}
          </span>
        </span>
        <span
          className={cn(
            "flex items-center gap-2",
            !(r.instMatch || r.historyMatch) && "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full border",
              r.instMatch || r.historyMatch ? "border-apollo-slate" : "border-apollo-border-strong",
              r.instMatch && r.historyMatch && "bg-apollo-slate",
            )}
            aria-hidden
          />
          {INST_SHORT(r)}
        </span>
        <span className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{fmt(r.shared)} shared</span>
            <span className="text-muted-foreground text-[12.5px]">of {fmt(r.worksTotal)}</span>
          </span>
          <span
            className="bg-apollo-amber-tint-border h-[5px] overflow-hidden rounded-full"
            aria-hidden
          >
            <span className="bg-apollo-slate block h-full" style={{ width: `${pct}%` }} />
          </span>
        </span>
        <span className="flex flex-col gap-0.5">
          <span className={r.sources.length >= 2 ? "text-apollo-slate font-semibold" : undefined}>
            {foundBy(r)}
          </span>
          {r.competitor ? (
            <span className="text-apollo-amber flex items-center gap-1 text-[12.5px]">
              <ArrowLeftRight className="size-3 shrink-0" aria-hidden />
              Competitor
            </span>
          ) : null}
        </span>
      </div>

      {isOpen ? (
        <div className="flex flex-col gap-4 px-4 pt-1 pb-5 sm:pl-[52px]">
          {r.competitor ? <CompetitorCallout card={card} row={r} onOpen={onOpen} /> : null}
          <div className="grid gap-4 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,2fr)]">
            <NameAndSignals card={card} row={r} />
            <Publications card={card} row={r} pmBaseUrl={pmBaseUrl} />
          </div>
          {canDecide && r.autoConfirmed && !outcome ? (
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onDismiss}
                className="text-[13px]"
                data-testid="orcid-queue-undo"
              >
                Undo
              </Button>
              <span className="text-muted-foreground text-[13px]">
                Takes the iD off file and marks it Not this person.
              </span>
            </div>
          ) : null}
          {canDecide && pending ? (
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-2"
              data-testid="orcid-queue-decision-bar"
            >
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={onConfirm}
                className="bg-foreground hover:bg-foreground/90 text-[13px] text-white"
                data-testid="orcid-queue-confirm"
              >
                {r.state === "conflict" ? "Replace with this iD" : "Confirm"}
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
              {others > 0 ? (
                <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={alsoDismiss}
                    onChange={(e) => onAlsoDismiss(e.target.checked)}
                    data-testid="orcid-queue-also-dismiss"
                  />
                  Also mark the other {others} Not this person
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const RULES: Record<1 | 2 | 3, { title: string; text: string }> = {
  1: {
    title: "Same-surname scholar",
    text: "Another WCM scholar with the same surname has at least 3 papers on this ORCID record that this scholar hasn't accepted. The works could be theirs.",
  },
  2: {
    title: "Another plausible iD",
    text: "This scholar has another candidate iD that also shares at least 3 papers, or one that couldn't be fetched in this run. Only one can be theirs.",
  },
  3: {
    title: "iD shared with another scholar",
    text: "This iD is also a candidate for another scholar who shares at least 3 papers with it. It has two plausible owners.",
  },
};

function CompetitorCallout({
  card,
  row: r,
  onOpen,
}: {
  card: OrcidQueueCard;
  row: OrcidQueueRow;
  onOpen: (orcid: string) => void;
}) {
  const rules = competitorRules(r);
  const who = (rule: 1 | 2 | 3): React.ReactNode[] => {
    if (rule === 2)
      return r.competitorOrcids.map((o) => {
        const i = card.candidates.findIndex((c) => c.orcid === o.orcid);
        const c = card.candidates[i];
        const onFile = card.onFile?.orcid === o.orcid;
        return (
          <WhoRow
            key={o.orcid}
            primary={
              <a
                href={`${ORCID_URL_PREFIX}${o.orcid}`}
                target="_blank"
                rel="noreferrer"
                className={cn(MONO, "hover:underline")}
              >
                {o.orcid}
              </a>
            }
            meta={
              onFile
                ? `On file now for this scholar · ${card.onFile?.name ?? "name not public"}`
                : c
                  ? `Candidate ${i + 1} · ${ORCID_QUEUE_BAND_LABEL[c.band]} · ${fmt(c.shared)} of ${fmt(c.worksTotal)} shared`
                  : o.shared === null
                    ? "Couldn't be fetched this run"
                    : `${fmt(o.shared)} shared`
            }
            action={c && !onFile ? { label: "Open this iD", onClick: () => onOpen(o.orcid) } : null}
          />
        );
      });
    return r.competitors
      .filter((c) => (rule === 3) === (c.reason === "same_id"))
      .map((c) => (
        <WhoRow
          key={c.cwid}
          primary={
            <>
              {c.name} <span className={MONO}>{c.cwid}</span>
            </>
          }
          meta={
            rule === 3
              ? `Also a candidate for this iD · ${c.shared ?? "3+"} shared`
              : `Holds ${c.shared ?? "3+"} of this record's papers`
          }
          action={null}
        />
      ));
  };
  return (
    <div
      className="border-apollo-amber-tint-border bg-apollo-amber-tint flex flex-col gap-3 rounded-lg border px-4 py-3.5 text-[13.5px]"
      data-testid="orcid-queue-competitor"
    >
      {(rules.length > 0 ? rules : [null]).map((rule) => (
        <div key={rule ?? "unknown"} className="flex flex-col gap-2">
          <span className="flex items-center gap-2">
            <ArrowLeftRight className="text-apollo-amber size-3.5" aria-hidden />
            <span className="text-apollo-amber font-semibold">Competitor</span>
            {rule ? (
              <span>
                Rule {rule} · {RULES[rule].title}
              </span>
            ) : null}
          </span>
          <span className="text-[#3a3532]">
            {rule
              ? RULES[rule].text
              : "The weekly evidence run flagged a competitor but recorded no detail."}
          </span>
          {rule ? <div className="flex flex-col gap-1.5">{who(rule)}</div> : null}
        </div>
      ))}
      <span className="text-apollo-amber text-[12.5px]">
        A competitor keeps an iD out of Strong and out of email auto-confirm, so it stays at
        Moderate or Weak for one-at-a-time review.
      </span>
    </div>
  );
}

function WhoRow({
  primary,
  meta,
  action,
}: {
  primary: React.ReactNode;
  meta: string;
  action: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className="border-apollo-amber-tint-border bg-apollo-surface flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2">
      <span>{primary}</span>
      <span className="text-muted-foreground text-[12.5px]">{meta}</span>
      {action ? (
        <button type="button" onClick={action.onClick} className={cn(LINK, "ml-auto text-[13px]")}>
          {action.label}
        </button>
      ) : null}
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

function NameAndSignals({ card, row: r }: { card: OrcidQueueCard; row: OrcidQueueRow }) {
  const d = r.detail;
  const name = orcidDisplayName(r);
  const sources = r.sources.filter(isOrcidCandidateSource);
  const signal = (on: boolean, text: React.ReactNode, sub?: React.ReactNode) => (
    <li className="flex gap-2.5">
      {on ? (
        <Check className="text-apollo-slate mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <Minus className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <span className="flex flex-col gap-0.5">
        <span className={on ? undefined : "text-muted-foreground"}>{text}</span>
        {sub ? <span className="text-muted-foreground text-[12.5px]">{sub}</span> : null}
      </span>
    </li>
  );
  return (
    <div
      className={cn(CARD, "flex flex-col gap-3 px-4 py-3.5 text-[13.5px]")}
      data-testid="orcid-queue-names"
    >
      <span className={EYEBROW}>Name</span>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground text-[11.5px] tracking-[0.06em] uppercase">Scholar</dt>
        <dd className="m-0 font-semibold">{card.scholarNames.join(" / ") || card.name}</dd>
        <dt className="text-muted-foreground text-[11.5px] tracking-[0.06em] uppercase">ORCID</dt>
        <dd className="m-0 font-semibold">
          {name.main ?? <span className="text-muted-foreground font-normal">Not public</span>}
          {name.aka.length > 0 ? (
            <span className="text-muted-foreground block text-[12.5px] font-normal">
              Also known as {name.aka.join("; ")}
            </span>
          ) : null}
          <a
            href={`${ORCID_URL_PREFIX}${r.orcid}`}
            target="_blank"
            rel="noreferrer"
            className={cn(LINK, "block text-[12.5px] font-normal")}
            data-testid="orcid-queue-record-link"
          >
            Open the ORCID record ↗
          </a>
        </dd>
      </dl>
      <span
        className={cn(
          "border-apollo-border border-t pt-2.5 text-[13px]",
          r.nameAgrees ? "text-apollo-slate" : "text-apollo-amber",
        )}
      >
        {r.nameAgrees ? "Agree" : "Differ"}: {nameVerdict(r)}
      </span>
      <span className={cn(EYEBROW, "mt-1")}>Signals</span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {signal(
          r.instMatch || r.historyMatch,
          INST_LONG(r),
          d && (d.institutions.length > 0 || d.institutionEmail) ? (
            <>
              {d.institutions.map((p, i) => (
                <span key={i} className="block">
                  {p.orcid.name}
                  {years(p.orcid.start, p.orcid.end)} ↔ {SOURCE_SIDE[p.ours.source]}: {p.ours.name}
                </span>
              ))}
              {d.institutionEmail ? (
                <span className="block">A Cornell email on the record: {d.institutionEmail}</span>
              ) : null}
            </>
          ) : null,
        )}
        {signal(
          r.emailVerified,
          r.emailVerified ? "Verified email" : "No verified email",
          d?.email ? `${d.email}, marked verified by ORCID` : null,
        )}
        {signal(
          sources.length >= 2,
          `Found by: ${foundBy(r)}`,
          sources.length >= 2 ? sources.map((s) => ORCID_SOURCE_LABEL[s]).join(", ") : null,
        )}
      </ul>
    </div>
  );
}

type PubTab = "orcid" | "both" | "rec";

const STATUS_TONE: Record<ReciterWorkStatus, string> = {
  accepted: "bg-apollo-slate-tint text-apollo-slate",
  pending: "bg-apollo-slate-tint text-apollo-slate",
  rejected: "bg-apollo-amber-tint text-apollo-amber",
  not_retrieved: "bg-apollo-surface-2 text-muted-foreground",
  not_in_pubmed: "bg-apollo-surface-2 text-muted-foreground",
  no_ids: "bg-apollo-surface-2 text-muted-foreground",
};

const STATUS_SHORT: Record<ReciterWorkStatus, string> = {
  accepted: "accepted",
  pending: "pending",
  rejected: "rejected",
  not_retrieved: "not retrieved",
  not_in_pubmed: "not in PubMed",
  no_ids: "with no identifiers",
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
    <p
      className="text-muted-foreground m-0 text-[12.5px]"
      data-testid="orcid-queue-work-status-summary"
    >
      {sentences.join(". ")}
    </p>
  );
}

function Publications({
  card,
  row: r,
  pmBaseUrl,
}: {
  card: OrcidQueueCard;
  row: OrcidQueueRow;
  pmBaseUrl: string | null;
}) {
  const onlyOrcid = r.newWorks;
  const both = r.shared;
  // Opens on the first non-empty list.
  const [tab, setTab] = useState<PubTab>(onlyOrcid > 0 ? "orcid" : both > 0 ? "both" : "rec");
  // ponytail: counts, not lists, for "Only in ReCiter": the ETL keeps a capped
  // sample of shared papers, so the exact set of the scholar's papers missing
  // from the record isn't known here. List it when PR B stores the overlap.
  const onlyRec = Math.max(0, card.reciterTotal - r.shared);
  const total = onlyOrcid + both + onlyRec;
  const pm = pmCurateHref(pmBaseUrl, card.cwid);
  const tabs: Array<{ k: PubTab; label: string; n: number; swatch: string }> = [
    { k: "orcid", label: "Only on ORCID", n: onlyOrcid, swatch: "bg-apollo-amber-tint-border" },
    { k: "both", label: "In both", n: both, swatch: "bg-apollo-slate" },
    { k: "rec", label: "Only in ReCiter", n: onlyRec, swatch: "bg-apollo-rail-border" },
  ];
  const sharedList = r.detail?.shared ?? [];
  return (
    <div
      className={cn(CARD, "flex min-w-0 flex-col gap-3 px-4 py-3.5 text-[13.5px]")}
      data-testid="orcid-queue-pubs"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={EYEBROW}>Publications · ORCID vs. ReCiter</span>
        <span className="text-muted-foreground text-[12.5px]">
          {fmt(r.worksTotal)} on ORCID · {fmt(card.reciterTotal)} in ReCiter
        </span>
      </div>
      {total > 0 ? (
        <div className="flex h-[6px] gap-[2px] overflow-hidden rounded-full" aria-hidden>
          {tabs.map((t) =>
            t.n > 0 ? <span key={t.k} className={t.swatch} style={{ flex: t.n }} /> : null,
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[13px]",
              tab === t.k
                ? "bg-apollo-surface-2 border-[#5c574d] font-semibold"
                : "border-apollo-border-strong bg-apollo-surface",
            )}
            data-testid={`orcid-queue-pubs-${t.k}`}
          >
            <span className={cn("size-2.5 rounded-[2px]", t.swatch)} aria-hidden />
            {t.label}
            <span className="tabular-nums">{fmt(t.n)}</span>
          </button>
        ))}
      </div>

      {tab === "orcid" ? (
        <>
          <span className="font-semibold">
            {onlyOrcid === 0
              ? "Every work on the ORCID record is also in ReCiter."
              : `${fmt(onlyOrcid)} of ${fmt(r.worksTotal)} works on the ORCID record aren't in ReCiter`}
          </span>
          <WorkStatusSummary row={r} />
          <ul className="m-0 flex list-none flex-col p-0">
            {r.newWorksSample.map((w, i) => (
              <PubItem
                key={i}
                title={w.title ?? "Untitled work"}
                year={w.year}
                meta={w.source}
                ids={{ doi: w.doi, pmid: w.pmid }}
                href={workHref(w)}
                status={w.status ?? null}
                pm={pmActionOf(w, r.cwid, pmBaseUrl)}
              />
            ))}
          </ul>
        </>
      ) : tab === "both" ? (
        <>
          <span className="font-semibold">
            {both === 0
              ? "No works appear in both."
              : `${fmt(both)} works appear on ORCID and in ReCiter`}
          </span>
          <ul className="m-0 flex list-none flex-col p-0">
            {sharedList.map((p) => (
              <PubItem
                key={p.pmid}
                title={p.title ? <PubTitle value={p.title} /> : `PMID ${p.pmid}`}
                year={p.year}
                meta={p.journal ? <PubJournal as="span" value={p.journal} /> : null}
                ids={{ doi: p.doi, pmid: p.pmid }}
                href={workHref(p)}
                status={null}
                pm={null}
              />
            ))}
          </ul>
          {both > sharedList.length && sharedList.length > 0 ? (
            <span className="text-muted-foreground text-[12.5px]">
              Showing {fmt(sharedList.length)} of {fmt(both)}.
            </span>
          ) : null}
        </>
      ) : (
        <span className="font-semibold">
          {onlyRec === 0
            ? "Every ReCiter publication is on this ORCID record."
            : `${fmt(onlyRec)} of the scholar's ${fmt(card.reciterTotal)} ReCiter publications aren't on this ORCID record`}
        </span>
      )}

      {pm &&
      (tab === "rec" ? onlyRec > 0 : tab === "orcid" && onlyOrcid > r.newWorksSample.length) ? (
        <a href={pm} target="_blank" rel="noreferrer" className={cn(LINK, "text-[13px]")}>
          Open {card.name.split(",")[0]} in Publication Manager ↗
        </a>
      ) : null}
    </div>
  );
}

function PubItem({
  title,
  year,
  meta,
  ids,
  href,
  status,
  pm,
}: {
  title: React.ReactNode;
  year: number | null;
  meta: React.ReactNode;
  ids: { doi: string | null; pmid: string | null };
  href: string | null;
  status: ReciterWorkStatus | null;
  pm: { href: string; label: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const idList = [
    ...(ids.doi ? [{ label: "DOI", value: ids.doi }] : []),
    ...(ids.pmid ? [{ label: "PMID", value: ids.pmid }] : []),
  ];
  return (
    <li className="border-apollo-border border-t py-2.5" data-testid="orcid-queue-work">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)_44px_minmax(90px,150px)] items-start gap-x-3 text-left"
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground mt-0.5 size-3.5 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="text-foreground">{title}</span>
        <span className="text-muted-foreground tabular-nums">{year ?? ""}</span>
        <span className="text-muted-foreground text-[12.5px]">{meta}</span>
      </button>
      {status || pm ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
          {status ? (
            <span className={cn(CHIP, STATUS_TONE[status])} data-testid="orcid-queue-work-status">
              {status === "rejected"
                ? "Rejected in ReCiter: re-review"
                : RECITER_WORK_STATUS_LABEL[status]}
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
        </div>
      ) : null}
      {open ? (
        <div className="mt-2 flex flex-col gap-1 pl-7 text-[12.5px]">
          {idList.length === 0 ? (
            <span className="text-muted-foreground">No DOI or PMID on this work.</span>
          ) : (
            idList.map((id) => (
              <span key={id.label} className="flex items-baseline gap-3">
                <span className="text-muted-foreground w-10">{id.label}</span>
                <span className={MONO}>{id.value}</span>
                <button
                  type="button"
                  className={cn(LINK, "text-[12px]")}
                  onClick={() => {
                    void navigator.clipboard?.writeText(id.value).catch(() => {});
                    setCopied(id.label);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  {copied === id.label ? "Copied" : "Copy"}
                </button>
              </span>
            ))
          )}
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className={LINK}>
              Open the work ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
