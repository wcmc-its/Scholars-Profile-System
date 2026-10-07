"use client";

/**
 * The presentational pieces of the core review queue's v2 layout (Core Review
 * Queue v2 mockup): the scope rail, the "About these signals" note, the To
 * review summary strip, the filters panel and its active chips, the
 * keyboard-shortcuts popover, and the undo toast.
 *
 * Props in, callbacks out — nothing here owns queue state or knows what a
 * `CoreQueueRow` is. `core-claim-queue.tsx` derives every label and count and
 * hands them down, so the vocabulary rules that file enforces (bands, "N of 4",
 * decoded priors) stay in one place, and this file never imports it back.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";

/** One rail entry: an evidence group, or a person. */
export interface RailItem {
  key: string;
  label: string;
  sub: string;
  /** Tailwind background for the sub-line's 7px dot (mockup) — the caller
   *  picks it (a band colour for a person, slate for "All"). No dot when both
   *  this and `dotColor` are absent. */
  dot?: string;
  /** The dot as a CSS colour instead: an evidence group's own colour
   *  (`evidenceGroupColor`), the one its summary bar and legend draw. */
  dotColor?: string;
  /** Open (undecided) papers in this scope. */
  count: number;
}

export type RailMode = "evidence" | "person";

/**
 * The left pane. At `lg` and up it is the mockup's rail: the By evidence / By
 * person toggle, the scope list, and the "About these signals" note. Below `lg`
 * (phones, and the console IS used on phones) the list collapses to a native
 * select above the paper list — the designer drew no phone layout, and this is
 * the approved proposal — and the note stays desktop-only, since on a 390px
 * screen it would push the list a screen further down for copy a reviewer reads
 * once.
 */
export function ScopeRail({
  mode,
  onMode,
  items,
  activeKey,
  onSelect,
  emptyText,
  about,
  noun = "candidates",
}: {
  mode: RailMode;
  onMode: (m: RailMode) => void;
  items: RailItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Shown instead of the list when the mode has nothing to scope by. */
  emptyText: string;
  about: ReactNode;
  /** What the rail groups, for its accessible name ("Group confirmed papers"). */
  noun?: string;
}) {
  return (
    <aside data-slot="core-queue-rail" className="flex min-w-0 flex-col gap-3">
      <div
        role="group"
        aria-label={`Group ${noun}`}
        className="bg-apollo-rail flex rounded-lg p-[3px]"
      >
        {(["evidence", "person"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => onMode(m)}
              className={`focus-visible:ring-apollo-maroon flex-1 rounded-md px-2 py-1.5 text-[13px] focus-visible:ring-2 focus-visible:outline-none ${
                active
                  ? "bg-apollo-surface text-foreground shadow-[var(--apollo-shadow-card)]"
                  : "text-[var(--evidence-body)]"
              }`}
            >
              {m === "evidence" ? "By evidence" : "By person"}
            </button>
          );
        })}
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{emptyText}</p>
      ) : (
        <>
          <select
            aria-label="Choose a scope"
            value={activeKey}
            onChange={(e) => onSelect(e.target.value)}
            className="border-apollo-border-strong bg-apollo-surface focus-visible:ring-apollo-maroon rounded-md border px-2 py-2 text-[13px] focus-visible:ring-2 focus-visible:outline-none lg:hidden"
          >
            {items.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label} ({i.count})
              </option>
            ))}
          </select>
          <ul
            aria-label={mode === "evidence" ? "Evidence groups" : "People"}
            className="hidden max-h-[70vh] flex-col gap-0.5 overflow-y-auto lg:flex"
          >
            {items.map((i) => {
              const active = i.key === activeKey;
              return (
                <li key={i.key}>
                  <button
                    type="button"
                    aria-pressed={active}
                    data-slot="core-queue-rail-item"
                    onClick={() => onSelect(i.key)}
                    className={`focus-visible:ring-apollo-maroon flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none ${
                      active
                        ? "border-apollo-border-strong bg-apollo-surface"
                        : "hover:bg-apollo-rail-hover border-transparent"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="text-foreground block text-[13px]">{i.label}</span>
                      <span className="text-muted-foreground mt-0.5 flex items-center gap-[5px] text-xs">
                        {i.dot || i.dotColor ? (
                          <span
                            aria-hidden
                            data-slot="core-queue-rail-dot"
                            className={`size-[7px] shrink-0 rounded-full ${i.dot ?? ""}`}
                            style={i.dotColor ? { background: i.dotColor } : undefined}
                          />
                        ) : null}
                        {i.sub}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">{i.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="hidden lg:block">{about}</div>
    </aside>
  );
}

/**
 * What the co-author signal (signal 2) actually has to work with on this core.
 * Both counts come from ReciterAI's facility dictionary via etl/dynamodb Block
 * 6b (`PK=CORE#{id}, SK=STAFF_DICT`) — COUNTS, never the CWIDs.
 *
 * The two numbers are not interchangeable, and that is the whole reason this
 * renders both. `staffCount` is what the dictionary LISTS; `staffTrackedCount`
 * is how many of those the signal can actually MATCH (pipeline_cores/signals.py
 * `coauthorship_index` reads tracked CWIDs, so a listed staff member with no
 * personIdentifier upstream is invisible to it). They differ on 9 of the 14
 * live cores; the mockup's own core lists four and tracks one. So the sentence
 * leads with the tracked count and carries the listed one behind it, and the
 * two dead states say so outright rather than naming a number the signal
 * cannot use.
 *
 * Four states:
 *   - counts unpublished (either null; the ETL writes the pair together) —
 *     renders NOTHING. Not-yet-published must look like nothing at all, never
 *     like an empty roster.
 *   - listed 0 — the signal cannot fire.
 *   - listed > 0, tracked 0 — same conclusion, different (fixable upstream) cause.
 *   - tracked > 0 — "M of N", the fraction emphasised.
 *
 * v2 moved it off the toolbar into the rail's "About these signals" note (the
 * mockup's placement). The mockup's "Manage staff" link is still NOT built:
 * the roster lives in the facility dictionary, not in SPS, so there is no
 * destination for it.
 */
export function CoreStaffChip({
  staffCount,
  staffTrackedCount,
}: {
  staffCount: number | null;
  staffTrackedCount: number | null;
}) {
  if (staffCount === null || staffTrackedCount === null) return null;
  return (
    <p data-slot="core-staff-chip">
      {staffCount === 0 ? (
        <span>
          The facility dictionary lists no core staff, so the co-author signal cannot fire for this
          core.
        </span>
      ) : staffTrackedCount === 0 ? (
        <span>
          The facility dictionary lists {staffCount} core staff, but none are resolvable, so the
          co-author signal cannot fire for this core.
        </span>
      ) : (
        <span>
          Co-author signal draws on{" "}
          <span className="text-foreground font-semibold">
            {staffTrackedCount} of {staffCount}
          </span>{" "}
          core staff from the facility dictionary
        </span>
      )}
    </p>
  );
}

/**
 * The rail's static note. Every line is a statement about THIS core's data, not
 * the mockup's sample: the staff line is `CoreStaffChip` (silent when the engine
 * has published no counts), and the MeSH line counts the candidates whose prior
 * actually decodes to a MeSH-branch match rather than asserting that the core
 * has, or lacks, a mapped branch — the queue cannot see the mapping, only what
 * the prefilter emitted.
 */
export function AboutSignals({
  staffCount,
  staffTrackedCount,
  meshCount,
  one = "candidate",
  many = "candidates",
}: {
  staffCount: number | null;
  staffTrackedCount: number | null;
  /** Rows on this tab whose topical prior decodes to a MeSH-branch match. */
  meshCount: number;
  /** What those rows are called ("confirmed paper" on the Confirmed tab). */
  one?: string;
  many?: string;
}) {
  return (
    <div
      data-slot="core-queue-about"
      className="border-apollo-border-strong flex flex-col gap-2 border-t pt-3 text-xs leading-normal text-[var(--evidence-body)]"
    >
      <p className="text-muted-foreground text-[11px] tracking-[0.1em] uppercase">
        About these signals
      </p>
      <CoreStaffChip staffCount={staffCount} staffTrackedCount={staffTrackedCount} />
      <p>
        Method family shows what a paper did, not whether this core did it. It is context and isn’t
        counted.
      </p>
      <p>
        {meshCount === 0
          ? `No ${one} here carries a topical MeSH match, so that prior never shows.`
          : `${meshCount} ${meshCount === 1 ? `${one} carries` : `${many} carry`} a topical MeSH match. It shows as a footnote on the paper and is never counted.`}
      </p>
    </div>
  );
}

/** Four dots, `dots` of them filled — the fixed per-signal-type strength. */
export function StrengthGlyphs({ dots }: { dots: number }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`size-1.5 rounded-full border ${
            i < dots ? "border-apollo-maroon bg-apollo-maroon" : "border-muted-foreground/40"
          }`}
        />
      ))}
    </span>
  );
}

/** The summary strip's big figures: Charter at 600 (see the serif note in
 *  app/globals.css), a step smaller on a phone. `font-semibold` is 500 in
 *  this theme, hence the explicit weight. */
const BIG_FIGURE = "font-serif font-[600] leading-none tabular-nums";
const HEADLINE_FIGURE = `${BIG_FIGURE} text-[36px] sm:text-[44px]`;
const SESSION_FIGURE = `${BIG_FIGURE} text-[28px] sm:text-[32px]`;

/** A session count's colour: muted gray at 0, its own colour once > 0. Pure. */
export function sessionCountTone(count: number, tone: string): string {
  return count > 0 ? tone : "text-muted-foreground";
}

/** "candidates in 4 evidence groups. 543 have two or more signals." — the line
 *  beside the big number, singular-safe. Pure. */
export function openSummaryText(total: number, groups: number, multiSignal: number): string {
  const head = `${total === 1 ? "candidate" : "candidates"} in ${groups} evidence ${
    groups === 1 ? "group" : "groups"
  }.`;
  return `${head} ${multiSignal} ${multiSignal === 1 ? "has" : "have"} two or more signals.`;
}

export interface SummaryGroupView {
  key: string;
  label: string;
  /** The pile's fill in the bar and legend (`evidenceGroupColor`). */
  color: string;
  count: number;
}

export interface SummarySignalView {
  /** The "Signals fired" facet value a click toggles. */
  facet: string;
  label: string;
  strength: string;
  dots: number;
  /** The coverage bar's fill: this signal's own colour, the one a pile whose
   *  strongest signal it is starts from (`evidenceGroupColor`). */
  color: string;
  count: number;
  /** Already ticked in the Filters panel. */
  active: boolean;
}

export interface SessionView {
  confirmed: number;
  rejected: number;
  reasons: { label: string; count: number }[];
  note: string;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
}

const EYEBROW = "text-muted-foreground text-[11px] tracking-[0.1em] uppercase";

/**
 * The stacked bar of evidence groups and its legend, shared by both summary
 * strips so the two tabs colour a pile the same way: each segment and legend
 * square is the group's own `color`, in the order the groups arrive
 * (`buildEvidenceGroups`).
 */
export function EvidenceGroupBar({ groups }: { groups: SummaryGroupView[] }) {
  return (
    <>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {groups.map((g) => (
          <div
            key={g.key}
            data-slot="core-queue-group-segment"
            className="min-w-[6px]"
            style={{ flex: `${g.count} 1 0`, background: g.color }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs text-[var(--evidence-body)]">
        {groups.map((g) => (
          <li key={g.key} className="contents">
            <span
              data-slot="core-queue-group-swatch"
              className="size-2 rounded-[2px]"
              style={{ background: g.color }}
              aria-hidden
            />
            <span className="min-w-0">{g.label}</span>
            <span className="tabular-nums">{g.count}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The To review summary strip (mockup): open candidates by evidence group,
 * which signals fired (each row a toggle on the Filters panel's "Signals fired"
 * facet), and this session's decisions. Three columns at `lg`; below it they
 * stack, each under a hairline, so a 390px screen gets one readable column.
 * Every number arrives computed — see `summarizeOpen` and `reasonTally`.
 */
export function QueueSummary({
  total,
  multiSignal,
  groups,
  signals,
  onSignal,
  session,
}: {
  total: number;
  multiSignal: number;
  groups: SummaryGroupView[];
  signals: SummarySignalView[];
  onSignal: (facet: string) => void;
  session: SessionView;
}) {
  const pane = "flex min-w-0 flex-col gap-3 px-5 py-4";
  const divider = "border-apollo-border border-t lg:border-t-0 lg:border-l";
  return (
    <section
      aria-label="Queue summary"
      data-slot="core-queue-summary"
      className="border-apollo-border bg-apollo-surface mt-4 grid grid-cols-1 rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)] lg:grid-cols-3"
    >
      <div data-slot="core-queue-summary-groups" className={pane}>
        <p className={EYEBROW}>Open candidates by evidence</p>
        <div className="flex items-baseline gap-2.5">
          <span className={HEADLINE_FIGURE}>{total}</span>
          <span className="text-[13px] leading-snug text-[var(--evidence-body)]">
            {openSummaryText(total, groups.length, multiSignal)}
          </span>
        </div>
        {total > 0 ? <EvidenceGroupBar groups={groups} /> : null}
      </div>

      <SignalCoverage
        className={`${pane} ${divider} gap-2.5`}
        signals={signals}
        total={total}
        onSignal={onSignal}
      />

      <div data-slot="core-queue-session" className={`${pane} ${divider}`}>
        <div className="flex items-baseline justify-between gap-2">
          <p className={EYEBROW}>This session</p>
          {session.canUndo ? (
            <button
              type="button"
              disabled={session.undoing}
              onClick={session.onUndo}
              className="text-apollo-slate text-xs hover:underline disabled:opacity-50"
            >
              Undo last
            </button>
          ) : null}
        </div>
        <div className="flex gap-6">
          <p className="flex flex-col gap-0.5">
            <span
              data-slot="core-queue-session-confirmed"
              className={`${SESSION_FIGURE} ${sessionCountTone(session.confirmed, "text-apollo-green")}`}
            >
              {session.confirmed}
            </span>
            <span className="text-xs text-[var(--evidence-body)]">Confirmed</span>
          </p>
          <p className="flex flex-col gap-0.5">
            <span
              data-slot="core-queue-session-rejected"
              className={`${SESSION_FIGURE} ${sessionCountTone(session.rejected, "text-apollo-brick")}`}
            >
              {session.rejected}
            </span>
            <span className="text-xs text-[var(--evidence-body)]">Rejected</span>
          </p>
        </div>
        {session.reasons.length > 0 ? (
          <ul
            aria-label="Reject reasons this session"
            data-slot="core-queue-session-reasons"
            className="flex flex-col gap-0.5 text-xs text-[var(--evidence-body)]"
          >
            {session.reasons.map((r) => (
              <li key={r.label} className="flex justify-between gap-2">
                <span className="min-w-0">{r.label}</span>
                <span className="tabular-nums">{r.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {/* Straight under the counts (and the reason tally, once there is one),
            not pinned to the foot of the pane, where it floated far from the
            zeros it explains. */}
        <p className="border-apollo-border border-t pt-3 text-xs leading-normal text-[var(--evidence-body)]">
          {session.note}
        </p>
      </div>
    </section>
  );
}

/**
 * "Which signals fired · Click to filter", shared by both summary strips: one
 * row per counted signal, its fixed strength, a bar against `total` and the
 * count. A click toggles the Filters panel's "Signals fired" value, so it
 * shows as an ordinary removable chip; a signal with no hits is disabled.
 * `footer` is the Confirmed strip's method note.
 */
export function SignalCoverage({
  className,
  signals,
  total,
  onSignal,
  footer,
}: {
  className: string;
  signals: SummarySignalView[];
  total: number;
  onSignal: (facet: string) => void;
  footer?: ReactNode;
}) {
  return (
    <div data-slot="core-queue-summary-signals" className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <p className={EYEBROW}>Which signals fired</p>
        <span className="text-muted-foreground text-[11px] whitespace-nowrap">Click to filter</span>
      </div>
      <div role="group" aria-label="Filter by signal" className="flex flex-col gap-0.5">
        {signals.map((s) => {
          // A signal with no hits is dimmed, but its strength dots are not: the
          // 4-dot scale is fixed per signal type and must read the same on
          // every row, so the maroon never fades to pink.
          const off = s.count === 0 && !s.active;
          const dim = off ? "opacity-60" : "";
          return (
            <button
              key={s.facet}
              type="button"
              aria-pressed={s.active}
              disabled={off}
              onClick={() => onSignal(s.facet)}
              className={`focus-visible:ring-apollo-maroon -mx-2 grid grid-cols-[minmax(0,1fr)_minmax(40px,110px)_34px] items-center gap-3 rounded-lg border px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default ${
                s.active
                  ? "border-apollo-slate-tint-border bg-apollo-slate-tint"
                  : "hover:bg-apollo-surface-2 border-transparent"
              }`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`text-foreground text-[13px] ${dim}`}>{s.label}</span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <StrengthGlyphs dots={s.dots} />
                  <span className={dim}>{s.strength}</span>
                </span>
              </span>
              <span
                className={`bg-apollo-surface-2 h-1.5 overflow-hidden rounded-full ${dim}`}
                aria-hidden
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${total > 0 ? Math.min(100, (s.count / total) * 100) : 0}%`,
                    background: s.color,
                  }}
                />
              </span>
              <span className={`text-right text-[13px] tabular-nums ${dim}`}>{s.count}</span>
            </button>
          );
        })}
      </div>
      {footer ? (
        <p className="border-apollo-border mt-auto border-t pt-3 text-xs leading-normal text-[var(--evidence-body)]">
          {footer}
        </p>
      ) : null}
    </div>
  );
}

/** "122 of 123 confirmed papers rest on two or more independent signals." —
 *  the line beside the big number, singular-safe. Pure. */
export function multiSignalText(total: number): string {
  return `of ${total} confirmed ${total === 1 ? "paper rests" : "papers rest"} on two or more independent signals`;
}

/** A band word in its own colour, as the mockup sets STRONG. */
export interface BandWordView {
  label: string;
  /** The band's text colour class (`likelihoodBand(...).text`). */
  className: string;
}

export interface ConfirmedPersonView {
  /** Lowercased CWID, the rail's By person key. */
  key: string;
  name: string;
  papers: number;
}

/** How many repeat-user people the Confirmed strip shows as chips; the rest
 *  are a count, and the rail's By person lists everyone. */
export const CONFIRMED_PEOPLE_SHOWN = 6;

/**
 * The Confirmed tab's summary strip (mockup): independent signals per paper,
 * which signals fired, and what these confirmations rest on. The mockup's
 * third card was "What these confirmations teach the next run"; it is
 * "Behind these confirmations" here, because the engine reads back one thing
 * from a confirmation, the repeat-user prior (owner decision 8). The
 * acknowledgment aliases come from the core's dictionary and the LLM read is a
 * per-paper read, so each says what it is rather than claiming to be learned.
 * Three columns at `lg`, one stacked column below it. Every number arrives
 * computed — see `summarizeConfirmed`.
 */
export function ConfirmedSummaryStrip({
  total,
  manual,
  groups,
  multiSignal,
  band,
  signals,
  onSignal,
  methodNote,
  people,
  onPerson,
  aliases,
  ackNoAlias,
  llm,
  llmUnread,
}: {
  total: number;
  manual: number;
  /** Confirmed papers per evidence group (not revoked, not manual adds), rail
   *  order, empty groups dropped — the same piles, and colours, as To review's
   *  bar. Sums to `total`; manual adds are the `manual` note, not a pile. */
  groups: SummaryGroupView[];
  multiSignal: number;
  band: { low: BandWordView; high: BandWordView; pct: string } | null;
  signals: SummarySignalView[];
  onSignal: (facet: string) => void;
  methodNote: string;
  /** Everyone with a confirmed paper here, most papers first. */
  people: ConfirmedPersonView[];
  onPerson: (key: string) => void;
  aliases: { alias: string; count: number }[];
  ackNoAlias: number;
  llm: { tier: string; label: string; count: number }[];
  llmUnread: number;
}) {
  const pane = "flex min-w-0 flex-col gap-3 px-5 py-4";
  const divider = "border-apollo-border border-t lg:border-t-0 lg:border-l";
  const footnote =
    "border-apollo-border mt-auto border-t pt-3 text-xs leading-normal text-[var(--evidence-body)]";
  const note = "text-muted-foreground text-[11px] leading-snug";
  const llmShade: Record<string, string> = {
    core: "bg-apollo-slate",
    possible: "bg-apollo-slate-tint-border",
    little: "bg-apollo-rail",
  };
  const shownPeople = people.slice(0, CONFIRMED_PEOPLE_SHOWN);
  const bandWord = (b: BandWordView) => (
    <span className={`font-semibold tracking-[0.06em] uppercase ${b.className}`}>{b.label}</span>
  );
  return (
    <section
      aria-label="Confirmed summary"
      data-slot="core-queue-confirmed-summary"
      className="border-apollo-border bg-apollo-surface mt-4 grid grid-cols-1 rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)] lg:grid-cols-3"
    >
      <div data-slot="core-queue-confirmed-summary-signals" className={pane}>
        <p className={EYEBROW}>Confirmed papers by evidence</p>
        {/* Every confirmation a manual add: no "0 of 0" line, just the note. */}
        {total > 0 ? (
          <>
            <div className="flex items-baseline gap-2.5">
              <span className={HEADLINE_FIGURE}>{multiSignal}</span>
              <span className="text-[13px] leading-snug text-[var(--evidence-body)]">
                {multiSignalText(total)}
              </span>
            </div>
            <EvidenceGroupBar groups={groups} />
          </>
        ) : null}
        {manual > 0 ? (
          <p className={note}>
            {manual} manually added {manual === 1 ? "paper is" : "papers are"} unscored and not
            counted.
          </p>
        ) : null}
        {band ? (
          <p data-slot="core-queue-confirmed-band" className={footnote}>
            {band.low.label === band.high.label ? (
              <>
                Every confirmation sits in the {bandWord(band.high)} band, {band.pct}.
              </>
            ) : (
              <>
                Confirmations run from the {bandWord(band.low)} to the {bandWord(band.high)} band,{" "}
                {band.pct}.
              </>
            )}
          </p>
        ) : null}
      </div>

      <SignalCoverage
        className={`${pane} ${divider} gap-2.5`}
        signals={signals}
        total={total}
        onSignal={onSignal}
        footer={methodNote}
      />

      <div data-slot="core-queue-confirmed-summary-behind" className={`${pane} ${divider}`}>
        <p className={EYEBROW}>Behind these confirmations</p>
        <div className="flex flex-col gap-1.5">
          <span className="text-foreground text-[13px]">
            Repeat-user prior for {people.length} {people.length === 1 ? "person" : "people"}
          </span>
          {shownPeople.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {shownPeople.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => onPerson(p.key)}
                  aria-label={`${p.name}, ${p.papers} confirmed ${p.papers === 1 ? "paper" : "papers"}`}
                  className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate hover:bg-apollo-slate-tint-border focus-visible:ring-apollo-maroon flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none"
                >
                  {p.name}
                  <span className="text-muted-foreground tabular-nums">{p.papers}</span>
                </button>
              ))}
              {people.length > shownPeople.length ? (
                <span className="text-muted-foreground self-center text-xs">
                  +{people.length - shownPeople.length} more under By person
                </span>
              ) : null}
            </div>
          ) : null}
          <p className={note}>
            The one thing the engine reads back from a confirmation: each byline author&rsquo;s
            confirmed papers with this core.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-foreground text-[13px]">Acknowledgment aliases that matched</span>
          {aliases.length > 0 || ackNoAlias > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs text-[var(--evidence-body)]">
              {aliases.map((a) => (
                <li key={a.alias} className="flex justify-between gap-2">
                  <span className="min-w-0">&ldquo;{a.alias}&rdquo;</span>
                  <span className="tabular-nums">{a.count}</span>
                </li>
              ))}
              {ackNoAlias > 0 ? (
                <li className="flex justify-between gap-2">
                  <span className="min-w-0">Acknowledged, no alias captured</span>
                  <span className="tabular-nums">{ackNoAlias}</span>
                </li>
              ) : null}
            </ul>
          ) : (
            <span className="text-xs text-[var(--evidence-body)]">None matched.</span>
          )}
          <p className={note}>
            From the core&rsquo;s alias list. Confirming a paper does not add one.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-foreground text-[13px]">LLM read of title and abstract</span>
          {llm.length > 0 ? (
            <>
              <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                {llm.map((t) => (
                  <div
                    key={t.tier}
                    className={`min-w-1 ${llmShade[t.tier] ?? "bg-apollo-rail"}`}
                    style={{ flex: `${t.count} 1 0` }}
                  />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--evidence-body)]">
                {llm.map((t) => (
                  <li key={t.tier}>
                    {t.label} · {t.count}
                  </li>
                ))}
                {llmUnread > 0 ? <li>Not read · {llmUnread}</li> : null}
              </ul>
            </>
          ) : (
            <span className="text-xs text-[var(--evidence-body)]">No LLM read on file.</span>
          )}
          <p className={note}>
            What the read said about each paper when it was scored. It is not a prior.
          </p>
        </div>
      </div>
    </section>
  );
}

export interface FacetOptionView {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetGroupView {
  key: string;
  label: string;
  options: FacetOptionView[];
}

/**
 * The Filters panel: one labelled group per facet, each option a genuine
 * checkbox carrying its live count. Options OR within a group and AND across
 * groups (the mockup's semantics); a value whose count is 0 is not offered at
 * all unless it is already ticked, so a single tick can never empty the list.
 */
export function FiltersPanel({
  id,
  groups,
  onToggle,
}: {
  id: string;
  groups: FacetGroupView[];
  onToggle: (group: string, value: string) => void;
}) {
  return (
    <div
      id={id}
      data-slot="core-queue-filters"
      className="border-apollo-border bg-apollo-surface grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-5 gap-y-3.5 rounded-[var(--apollo-radius-card)] border px-4 py-3.5"
    >
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing in this scope to filter on.</p>
      ) : null}
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label} className="min-w-0">
          <p className="text-muted-foreground mb-1.5 text-[11px] tracking-[0.1em] uppercase">
            {g.label}
          </p>
          <div className="flex flex-wrap gap-1">
            {g.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="checkbox"
                aria-checked={o.selected}
                onClick={() => onToggle(g.key, o.value)}
                className={`focus-visible:ring-apollo-maroon inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs focus-visible:ring-2 focus-visible:outline-none ${
                  o.selected
                    ? "bg-apollo-slate border-apollo-slate text-white"
                    : "border-apollo-border-strong bg-apollo-surface text-foreground"
                }`}
              >
                {o.value} <span className="tabular-nums opacity-70">{o.count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface ActiveChip {
  group: string;
  groupLabel: string;
  value: string;
}

/** The active-filter chips under the search row, each removable, plus the one
 *  reset ("Clear all"), which also drops the search text — so it shows for a
 *  text-only narrowing too. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: ActiveChip[];
  onRemove: (group: string, value: string) => void;
  onClear: () => void;
}) {
  return (
    <div
      data-slot="core-queue-active-filters"
      className="flex flex-wrap items-center gap-1.5 text-xs"
    >
      {chips.map((c) => (
        <button
          key={`${c.group}:${c.value}`}
          type="button"
          aria-label={`Remove filter ${c.groupLabel}: ${c.value}`}
          onClick={() => onRemove(c.group, c.value)}
          className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1.5 pl-2.5"
        >
          <span className="text-muted-foreground">{c.groupLabel}:</span>
          {c.value}
          <X className="size-3" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="text-muted-foreground hover:text-foreground px-1"
      >
        Clear all
      </button>
    </div>
  );
}

/** The shortcuts the queue listens for, in the popover's order. */
export const SHORTCUTS: ReadonlyArray<{ label: string; keys: string[] }> = [
  { label: "Next paper", keys: ["j", "↓"] },
  { label: "Previous paper", keys: ["k", "↑"] },
  { label: "Confirm", keys: ["a"] },
  { label: "Reject", keys: ["r"] },
  { label: "Select / deselect", keys: ["x"] },
  { label: "Undo last decision", keys: ["u"] },
  { label: "Show this list", keys: ["?"] },
];

/** The first key of the SHORTCUTS entry with this label, as a key cap reads. */
function keyFor(label: string): string {
  return (SHORTCUTS.find((s) => s.label === label)?.keys[0] ?? "").toUpperCase();
}

/**
 * The tab row's inline hint (mockup "J / K move · C confirm · X reject"), built
 * off SHORTCUTS so it names the keys the queue actually listens for: `a`
 * confirms, `r` rejects, and `x` only ticks a row.
 */
export const KEYS_HINT = `${keyFor("Next paper")} / ${keyFor("Previous paper")} move · ${keyFor(
  "Confirm",
)} confirm · ${keyFor("Reject")} reject`;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-apollo-border-strong bg-apollo-surface rounded border px-1 font-mono text-[11px]">
      {children}
    </kbd>
  );
}

/** "Shortcuts ?" and its popover. The popover is a plain disclosure, not a
 *  modal: it must not trap focus away from the queue the keys act on. */
export function ShortcutsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="core-queue-shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={onToggle}
        className={`border-apollo-border-strong inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-[var(--evidence-body)] ${
          open ? "bg-apollo-surface-2" : "bg-apollo-surface"
        }`}
      >
        Shortcuts <Kbd>?</Kbd>
      </button>
      {open ? (
        <div
          id="core-queue-shortcuts"
          data-slot="core-queue-shortcuts"
          className="border-apollo-border-strong bg-apollo-surface text-foreground absolute top-full right-0 z-20 mt-1 w-60 rounded-[10px] border px-3.5 py-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-muted-foreground text-[11px] tracking-[0.1em] uppercase">
              Keyboard shortcuts
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close shortcuts"
              className="text-muted-foreground leading-none"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <ul>
            {SHORTCUTS.map((s) => (
              <li
                key={s.label}
                className="border-apollo-border flex items-center justify-between gap-3 border-t py-1.5 text-[13px]"
              >
                <span>{s.label}</span>
                <span className="flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The undo toast (mockup): bottom-centre, the last decision and its Undo, gone
 * after a few seconds (the parent owns the timer). It carries no live region
 * of its own; the queue's polite announcement already speaks each outcome, and
 * a second one here would read it twice. Above the phone's full-screen sheet
 * (z-40), and never wider than the screen less its gutters.
 */
export function UndoToast({
  text,
  tone,
  undoing,
  onUndo,
}: {
  text: string;
  tone: "claimed" | "rejected" | "error";
  undoing: boolean;
  onUndo: () => void;
}) {
  return (
    <div
      data-slot="core-queue-toast"
      className="bg-apollo-bar fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-[10px] py-2.5 pr-3.5 pl-4 text-[13px] text-white shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${
            tone === "claimed"
              ? "bg-emerald-400"
              : tone === "rejected"
                ? "bg-red-400"
                : "bg-amber-400"
          }`}
        />
        <span className="truncate">{text}</span>
      </span>
      <button
        type="button"
        disabled={undoing}
        onClick={onUndo}
        className="shrink-0 text-white underline disabled:opacity-60"
      >
        Undo
      </button>
    </div>
  );
}
