"use client";

/**
 * "Feed CWID issues" — the CTSC center's to-do list for its own system. Each row
 * is a CTSC feed record whose CWID should be fixed at the source; the nightly
 * `etl/ctsc-roster` sync rebuilds the list, so a record CTSC corrects drops off
 * the next day.
 *
 * Layout (design pass 2026-09-29): a pill filter per issue type with counts, a
 * list header ("Showing N of M"), and one row per record — who it is on the
 * left; on the right a grey box splitting the FACT (what the directory says,
 * with CWIDs / emails as mono chips) from the INSTRUCTION (what CTSC should do).
 */
import { useMemo, useState, type ReactNode } from "react";
import { EditPanel } from "@/components/edit/edit-panel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type CtscFeedIssueRow = {
  primaryKey: number;
  name: string;
  institution: string | null;
  feedCwid: string | null;
  reason: string;
  suggestedCwid: string | null;
  suggestedName: string | null;
  matchedEmail: string | null;
};

/** Rows rendered per page before "Show more" (the feed can carry 1,000+). */
export const CTSC_FEED_ISSUES_PAGE_SIZE = 100;

const fmt = (n: number) => n.toLocaleString("en-US");

/** A CWID or email, set as a mono chip so it reads as a copyable value. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="bg-apollo-surface border-apollo-border-strong rounded-md border px-2 py-0.5 font-mono text-[13px] break-all">
      {children}
    </span>
  );
}

/** A CWID / value inline in a sentence (instruction lines). */
function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] break-all">{children}</span>;
}

/**
 * "<email> belongs to <Name> (<cwid>)" — the directory's answer for the email on
 * the record. Degrades when the email, name, or CWID is missing.
 */
function BelongsTo({ r }: { r: CtscFeedIssueRow }) {
  if (!r.matchedEmail && !r.suggestedName && !r.suggestedCwid) return null;
  const owner = (
    <>
      {r.suggestedName && <span className="font-semibold">{r.suggestedName}</span>}
      {r.suggestedCwid &&
        (r.suggestedName ? (
          <span className="text-muted-foreground font-mono text-[13px]">({r.suggestedCwid})</span>
        ) : (
          <Chip>{r.suggestedCwid}</Chip>
        ))}
    </>
  );
  if (!r.matchedEmail) {
    return (
      <>
        <span className="text-muted-foreground">Directory match</span>
        {owner}
      </>
    );
  }
  return (
    <>
      <Chip>{r.matchedEmail}</Chip>
      {r.suggestedName || r.suggestedCwid ? (
        <>
          <span className="text-muted-foreground">belongs to</span>
          {owner}
        </>
      ) : (
        <span className="text-muted-foreground">matched in the directory</span>
      )}
    </>
  );
}

type Reason = {
  label: string;
  /** Fact lines — what the feed / directory say. Empty fragments are skipped. */
  facts: (r: CtscFeedIssueRow) => ReactNode[];
  /** The one change CTSC should make. */
  instruction: (r: CtscFeedIssueRow) => ReactNode;
};

const hasMatch = (r: CtscFeedIssueRow) => Boolean(r.matchedEmail || r.suggestedName || r.suggestedCwid);

export const REASONS: Record<string, Reason> = {
  "blank-resolved": {
    label: "Blank CWID, found via email",
    facts: (r) => [hasMatch(r) ? <BelongsTo key="m" r={r} /> : null],
    instruction: (r) =>
      r.suggestedCwid ? (
        <>
          The CWID is blank. Set it to <Mono>{r.suggestedCwid}</Mono>.
        </>
      ) : (
        "The CWID is blank. Look the person up and set it."
      ),
  },
  "not-in-ed": {
    label: "CWID not in the directory",
    facts: (r) => [
      r.feedCwid ? (
        <span key="c" className="contents">
          <Chip>{r.feedCwid}</Chip>
          <span className="text-muted-foreground">isn’t in the directory</span>
        </span>
      ) : null,
      hasMatch(r) ? <BelongsTo key="m" r={r} /> : null,
    ],
    instruction: (r) =>
      r.suggestedCwid ? (
        <>
          Change CWID {r.feedCwid ? <Mono>{r.feedCwid}</Mono> : null}
          {r.feedCwid ? " " : ""}to <Mono>{r.suggestedCwid}</Mono>.
        </>
      ) : (
        "Look the person up and correct the CWID, or clear it."
      ),
  },
  "retired-cwid": {
    label: "Retired CWID",
    facts: (r) => [
      r.feedCwid ? (
        <span key="c" className="contents">
          <Chip>{r.feedCwid}</Chip>
          <span className="text-muted-foreground">is retired</span>
        </span>
      ) : null,
      hasMatch(r) ? <BelongsTo key="m" r={r} /> : null,
    ],
    instruction: (r) =>
      r.suggestedCwid ? (
        <>
          Change the retired CWID to <Mono>{r.suggestedCwid}</Mono>.
        </>
      ) : (
        "Look up the person’s current CWID."
      ),
  },
  "cwid-email-conflict": {
    label: "CWID and email disagree",
    facts: (r) => [
      r.feedCwid ? (
        <span key="c" className="contents">
          <span className="text-muted-foreground">Feed CWID</span>
          <Chip>{r.feedCwid}</Chip>
        </span>
      ) : null,
      hasMatch(r) ? <BelongsTo key="m" r={r} /> : null,
    ],
    instruction: () => "The CWID and the email are different people. Check which is right.",
  },
  "email-match-name-differs": {
    label: "Email matches, name differs",
    facts: (r) => [hasMatch(r) ? <BelongsTo key="m" r={r} /> : null],
    instruction: () => "If that’s this person, set the CWID; otherwise fix the email.",
  },
  "email-ambiguous": {
    label: "Email matches several people",
    facts: (r) => [
      r.matchedEmail ? (
        <span key="e" className="contents">
          <Chip>{r.matchedEmail}</Chip>
          <span className="text-muted-foreground">matches more than one person</span>
        </span>
      ) : (
        <span key="e" className="text-muted-foreground">
          The emails on this record belong to more than one person
        </span>
      ),
    ],
    instruction: () => "Set the CWID by hand.",
  },
  "duplicate-record": {
    label: "Duplicate record",
    facts: (r) => {
      const cwid = r.feedCwid ?? r.suggestedCwid;
      return [
        <span key="d" className="contents">
          <span className="text-muted-foreground">Same person as another record</span>
          {cwid && <Chip>{cwid}</Chip>}
        </span>,
      ];
    },
    instruction: () => "Merge or remove one.",
  },
};

const ALL = "all";

/** "Sep 29, 2026 · 2:00 AM" in New York time. U+202F (ICU's narrow space before
 *  AM/PM) is normalised so server and browser render identical text. */
export function formatRebuiltAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = "America/New_York";
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${date} · ${time}`.replace(/[  ]/g, " ");
}

export function CtscFeedIssuesCard({ issues, syncedAt }: { issues: CtscFeedIssueRow[]; syncedAt: string | null }) {
  const [reason, setReason] = useState<string>(ALL);
  const [limit, setLimit] = useState(CTSC_FEED_ISSUES_PAGE_SIZE);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of issues) c.set(i.reason, (c.get(i.reason) ?? 0) + 1);
    return c;
  }, [issues]);

  // Known reasons in their canonical order, then any reason the ETL emits that
  // this card doesn't know yet (so no record is ever unreachable).
  const filters = useMemo(() => {
    const keys = [
      ...Object.keys(REASONS).filter((k) => counts.has(k)),
      ...[...counts.keys()].filter((k) => !(k in REASONS)).sort(),
    ];
    return [
      { key: ALL, label: "All issues", count: issues.length },
      ...keys.map((k) => ({ key: k, label: REASONS[k]?.label ?? k, count: counts.get(k) ?? 0 })),
    ];
  }, [counts, issues.length]);

  const active = filters.find((f) => f.key === reason) ?? filters[0];
  const matching = active.key === ALL ? issues : issues.filter((i) => i.reason === active.key);
  const shown = matching.slice(0, limit);
  const showBadges = active.key === ALL;
  const rebuilt = syncedAt ? formatRebuiltAt(syncedAt) : null;

  const select = (key: string) => {
    setReason(key);
    setLimit(CTSC_FEED_ISSUES_PAGE_SIZE);
  };

  return (
    <EditPanel
      slot="ctsc-feed-issues-card"
      heading="Feed CWID issues"
      description={
        <>
          Records from the CTSC feed that couldn’t be matched cleanly. These must be corrected in CTSC’s system. The
          list is rebuilt every night, so a fixed record drops off the next day.
          {rebuilt && (
            <span className="mt-1.5 block text-[var(--evidence-faint)]" data-testid="ctsc-feed-issues-rebuilt">
              Last rebuilt {rebuilt}
            </span>
          )}
        </>
      }
    >
      {issues.length === 0 ? (
        <p className="text-muted-foreground text-sm">No issues. Every feed record has a usable CWID.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2.5" role="group" aria-labelledby="ctsc-feed-issues-filter-label">
            <span
              id="ctsc-feed-issues-filter-label"
              className="text-xs font-semibold tracking-[0.06em] text-[var(--evidence-faint)] uppercase"
            >
              Filter by issue
            </span>
            <div className="flex flex-wrap gap-2">
              {filters.map((f) => {
                const on = f.key === active.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => select(f.key)}
                    data-testid={`ctsc-feed-issues-filter-${f.key}`}
                    className={cn(
                      "focus-visible:ring-ring/50 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] leading-tight outline-none focus-visible:ring-[3px]",
                      on
                        ? "bg-apollo-bar border-apollo-bar font-semibold text-white"
                        : "bg-apollo-surface border-apollo-border-strong text-foreground hover:bg-apollo-surface-2",
                    )}
                  >
                    <span>{f.label}</span>
                    <span className="tabular-nums opacity-75">{fmt(f.count)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="border-apollo-border-strong flex items-baseline justify-between gap-3 border-b pb-2.5">
              <span className="min-w-0 flex-1 text-[15px] font-semibold" data-testid="ctsc-feed-issues-active-label">
                {active.label}
              </span>
              <span
                className="text-muted-foreground text-[13px] whitespace-nowrap tabular-nums"
                data-testid="ctsc-feed-issues-count"
              >
                {shown.length < matching.length
                  ? `Showing ${fmt(shown.length)} of ${fmt(matching.length)}`
                  : `${fmt(matching.length)} ${matching.length === 1 ? "record" : "records"}`}
              </span>
            </div>
            <ol className="m-0 list-none p-0">
              {shown.map((r) => {
                const def = REASONS[r.reason];
                const facts = def ? def.facts(r).filter(Boolean) : [];
                const instruction = def?.instruction(r);
                return (
                  <li
                    key={r.primaryKey}
                    className="border-apollo-border grid grid-cols-1 gap-x-7 gap-y-3 border-b py-5 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]"
                    data-testid={`ctsc-feed-issue-${r.primaryKey}`}
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-base font-semibold break-words">{r.name}</span>
                      <span className="text-muted-foreground text-[13px]">
                        CTSC record <span className="text-foreground font-mono">#{r.primaryKey}</span>
                      </span>
                      {r.institution && (
                        <span className="text-muted-foreground text-[13px] leading-snug">{r.institution}</span>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-2.5">
                      {showBadges && (
                        <div>
                          <Badge variant="outline" className="max-w-full rounded-full font-normal">
                            {def?.label ?? r.reason}
                          </Badge>
                        </div>
                      )}
                      {(facts.length > 0 || instruction) && (
                        <div className="bg-apollo-surface-2 flex flex-col gap-2 rounded-lg px-3.5 py-3">
                          {facts.map((fact, i) => (
                            <div
                              key={i}
                              className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm"
                              data-testid="ctsc-feed-issue-fact"
                            >
                              {fact}
                            </div>
                          ))}
                          {instruction && (
                            <div
                              className="text-sm leading-normal text-[var(--evidence-body)]"
                              data-testid="ctsc-feed-issue-instruction"
                            >
                              {instruction}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {shown.length < matching.length && (
              <button
                type="button"
                onClick={() => setLimit((n) => n + CTSC_FEED_ISSUES_PAGE_SIZE)}
                className="text-apollo-slate mt-4 text-sm hover:underline"
                data-testid="ctsc-feed-issues-more"
              >
                Show {fmt(Math.min(CTSC_FEED_ISSUES_PAGE_SIZE, matching.length - shown.length))} more
              </button>
            )}
          </div>
        </div>
      )}
    </EditPanel>
  );
}
