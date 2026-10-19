"use client";

/**
 * The honors queue's Possible tab as a split review (2026-10-13 mockup,
 * "Honors Approval Redesign"): a compact list of roster lines on the left, the
 * focused line in full on the right. Presentational — state, decisions and the
 * keyboard live in `HonorsQueue`. Match strength comes from
 * `lib/edit/honor-match.ts`.
 *
 * Kept from the shipped card although the mockup shows it as plain text: the
 * curator tier select (with "Reset to the rules"), and the year-plausibility
 * warning, shown here as a flag.
 *
 * 2026-10-13 iteration: a reject needs a reason. Reject (or R) opens the reason
 * choices in the pane, picked by click or 1–5; Esc cancels.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  groupMatchLevel,
  highlight,
  highlightTerms,
  matchSignals,
  parseEvidence,
  type MatchLevel,
} from "@/lib/edit/honor-match";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";
import { REJECTION_REASONS, yearPlausibilityNote } from "@/lib/edit/honor-queue";
import { HONOR_TIER_LABELS, HONOR_TIERS, ruleTier, type HonorTier } from "@/lib/honors/tiers";
import { cn } from "@/lib/utils";

/** A line's outcome this session. `rowIds` are what an undo reverts. */
export type Decided =
  | { kind: "approved"; scholarName: string; rowIds: string[] }
  | { kind: "rejected"; reason: string; rowIds: string[] };

export type ReviewSection = { key: string; heading: string | null; groups: HonorQueueGroup[] };

export function Kbd({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <kbd
      className={cn(
        "rounded border border-b-2 px-[5px] font-mono text-[11px] leading-[1.4]",
        light
          ? "border-white/40 bg-transparent text-white"
          : "border-apollo-border-strong bg-apollo-surface text-[#3a3532]",
      )}
    >
      {children}
    </kbd>
  );
}

/** "Ada Lovelace" — first + last word of the published name, postnominal dropped. */
export function shortName(scholarName: string): string {
  const words = scholarName.split(",")[0].trim().split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0]} ${words[words.length - 1]}` : (words[0] ?? scholarName);
}

function initials(scholarName: string): string {
  const words = scholarName.split(",")[0].trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return ((words[0][0] ?? "") + last).toUpperCase();
}

const PILL: Record<Exclude<MatchLevel, "pick">, { label: string; cls: string; dot: string }> = {
  strong: {
    label: "Strong",
    cls: "bg-apollo-slate-tint text-apollo-slate",
    dot: "bg-apollo-slate",
  },
  likely: {
    label: "Likely",
    cls: "bg-apollo-amber-tint text-apollo-amber",
    dot: "bg-apollo-amber",
  },
  weak: { label: "Weak", cls: "bg-apollo-red-tint text-destructive", dot: "bg-destructive" },
};

function LevelPill({ level, n, large = false }: { level: MatchLevel; n: number; large?: boolean }) {
  if (level === "pick")
    return (
      <span className="text-apollo-amber border-apollo-amber-tint-border rounded-full border px-2 text-xs whitespace-nowrap">
        Pick 1 of {n}
      </span>
    );
  const p = PILL[level];
  return large ? (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full px-2.5 py-[3px] text-[12.5px] font-medium whitespace-nowrap",
        p.cls,
      )}
      data-slot="honor-match-level"
    >
      <span className={cn("size-1.5 rounded-full", p.dot)} />
      {p.label} match
    </span>
  ) : (
    <span
      className={cn("rounded-full px-2 py-px text-xs whitespace-nowrap", p.cls)}
      data-slot="honor-match-level"
    >
      {p.label}
    </span>
  );
}

/** The left column: one compact row per roster line. */
export function ReviewList({
  sections,
  focusKey,
  decided,
  selected,
  readOnly,
  onFocus,
  onToggle,
}: {
  sections: ReviewSection[];
  focusKey: string | null;
  decided: Record<string, Decided>;
  selected: Record<string, true>;
  readOnly: boolean;
  onFocus: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      data-scroll="1"
      className="bg-apollo-surface border-apollo-border-strong max-h-[45vh] overflow-auto rounded-[var(--apollo-radius-card)] border lg:sticky lg:top-4 lg:max-h-[calc(100vh-32px)]"
      data-slot="honors-review-list"
    >
      {sections.map((sec) => (
        <div key={sec.key}>
          {sec.heading ? (
            <div
              className="bg-apollo-surface-2 border-apollo-border sticky top-0 z-[1] border-b px-3.5 py-[7px] text-[12.5px] font-semibold"
              data-slot="honor-section-heading"
            >
              {sec.heading}{" "}
              <span className="text-muted-foreground font-normal">{sec.groups.length} pending</span>
            </div>
          ) : null}
          {sec.groups.map((g) => {
            const head = g.rows[0];
            const d = decided[g.key];
            const focused = g.key === focusKey;
            const sel = Boolean(selected[g.key]);
            return (
              <div
                key={g.key}
                data-row={g.key}
                data-slot="honor-review-row"
                aria-current={focused ? "true" : undefined}
                onClick={() => onFocus(g.key)}
                className={cn(
                  "border-apollo-border grid cursor-pointer items-center gap-2.5 border-b px-3.5 py-2.5",
                  readOnly
                    ? "grid-cols-[minmax(0,1fr)_auto]"
                    : "grid-cols-[16px_minmax(0,1fr)_auto]",
                  focused
                    ? "bg-apollo-page shadow-[inset_3px_0_0_var(--apollo-slate)]"
                    : sel
                      ? "bg-apollo-slate-tint"
                      : "bg-apollo-surface",
                  d && "opacity-60",
                )}
              >
                {readOnly ? null : (
                  <div className="flex" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={sel}
                      disabled={Boolean(d)}
                      onCheckedChange={() => onToggle(g.key)}
                      aria-label={`Select ${head.name}`}
                    />
                  </div>
                )}
                <div className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13.5px] font-semibold">{head.name}</span>
                  <span className="text-muted-foreground truncate text-[12.5px]">
                    {g.contested
                      ? `${g.rows.length} candidates · ${g.rosterMatchedName ?? head.name}`
                      : head.scholarName}
                    {head.year === null ? null : ` · ${head.year}`}
                  </span>
                </div>
                <div>
                  {d ? (
                    <span
                      className={cn(
                        "text-xs",
                        d.kind === "approved" ? "text-apollo-slate" : "text-destructive",
                      )}
                      data-slot="honor-decided"
                    >
                      {d.kind === "approved" ? "Approved" : "Rejected"}
                    </span>
                  ) : (
                    <LevelPill level={groupMatchLevel(g)} n={g.rows.length} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The right column: the focused line, its evidence, and the decision controls. */
export function ReviewPane({
  group,
  position,
  pick,
  decided,
  asking,
  busy,
  readOnly,
  published,
  pending,
  decidedMap,
  onPick,
  onRejectWith,
  onCancelAsk,
  onApprove,
  onReject,
  onUndo,
  onSkip,
  onTier,
  onFocus,
}: {
  group: HonorQueueGroup;
  position: string;
  pick: string | null;
  decided: Decided | null;
  /** The reason choices are open (Reject was pressed). */
  asking: boolean;
  busy: boolean;
  readOnly: boolean;
  /** Every published row, for "On …'s profile" and the already-on-profile flag. */
  published: HonorQueueRow[];
  /** Every pending line, for "Also pending" and the shared-quote flag. */
  pending: HonorQueueGroup[];
  decidedMap: Record<string, Decided>;
  onPick: (rowId: string) => void;
  onRejectWith: (reason: string) => void;
  onCancelAsk: () => void;
  onApprove: () => void;
  onReject: () => void;
  onUndo: () => void;
  onSkip: () => void;
  onTier: (tier: HonorTier | null) => void;
  onFocus: (key: string) => void;
}) {
  const head = group.rows[0];
  const chosen = group.contested ? (group.rows.find((r) => r.id === pick) ?? null) : head;
  const subject = chosen ?? head;
  const blocked = chosen === null;
  const { signals } = matchSignals(subject, group.rosterMatchedName);
  const level = groupMatchLevel(group);
  const { quote, note } = parseEvidence(subject.evidence);
  const sourceUrl = rosterSourceUrl(head.sourceRef);

  const onProfile = published.filter((r) => r.cwid === subject.cwid);
  const also = chosen
    ? pending.filter(
        (g) =>
          g.key !== group.key &&
          !g.contested &&
          g.rows[0].cwid === subject.cwid &&
          !decidedMap[g.key],
      )
    : [];
  const flags: Array<{ title: string; text: string }> = [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (
    chosen &&
    onProfile.some((p) => same(p.name, head.name) && same(p.organization, head.organization))
  )
    flags.push({
      title: "Already on profile.",
      text: "An identical honor is already published. Reject as Duplicate.",
    });
  else if (chosen) {
    // Same body, same year, another name: often one award under two names
    // (a Damon Runyon "Clinical Investigator Award" vs "Fellowship / Grant").
    const similar = onProfile.find(
      (p) => same(p.organization, head.organization) && p.year !== null && p.year === head.year,
    );
    if (similar)
      flags.push({
        title: "Similar honor on profile.",
        text: `“${similar.name}” (${similar.organization}, ${similar.year}) is already published. It may be the same award under another name.`,
      });
  }
  if (quote) {
    const shared = pending.filter(
      (g) => g.key !== group.key && parseEvidence(g.rows[0].evidence).quote === quote,
    );
    if (shared.length)
      flags.push({
        title: "Same evidence as another pending honor.",
        text: `This quote is also attached to ${shared
          .map(
            (g) =>
              `${g.rows[0].name} (${g.rows[0].organization}${g.rows[0].year ? `, ${g.rows[0].year}` : ""})`,
          )
          .join(", ")}. Check that it really announces this award.`,
      });
  }
  const yearNote = yearPlausibilityNote(subject);
  if (yearNote) flags.push({ title: "Check the year.", text: yearNote });

  const role = (r: HonorQueueRow) =>
    [r.title, r.department].filter(Boolean).join(" · ") || r.roleLabel || "";

  return (
    <div
      className="bg-apollo-surface border-apollo-border-strong flex flex-col gap-[18px] rounded-[var(--apollo-radius-card)] border px-5 py-5 lg:sticky lg:top-4 lg:px-6"
      data-slot={group.contested ? "honor-group-contested" : "honor-group"}
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">
            <b className="text-foreground font-semibold">{head.organization}</b>
            {head.year === null ? null : ` · ${head.year}`}
            {" · "}
            {readOnly ? (
              <span data-slot="honor-tier">
                Tier {head.tier} · {HONOR_TIER_LABELS[head.tier]}
              </span>
            ) : (
              <select
                value={head.tier}
                onChange={(e) =>
                  onTier(e.target.value === "rule" ? null : (Number(e.target.value) as HonorTier))
                }
                disabled={busy}
                aria-label="Honor tier"
                className="text-muted-foreground hover:text-foreground cursor-pointer bg-transparent text-[12.5px]"
                data-slot="honor-tier"
              >
                {HONOR_TIERS.map((t) => (
                  <option key={t} value={t}>
                    Tier {t} · {HONOR_TIER_LABELS[t]}
                    {head.tierOverridden && t === head.tier ? " (set by curator)" : ""}
                  </option>
                ))}
                {head.tierOverridden ? (
                  <option value="rule">
                    Reset to the rules (tier {ruleTier(head.organization, head.name)})
                  </option>
                ) : null}
              </select>
            )}
          </span>
          <span className="text-xl leading-[1.3] font-semibold">{head.name}</span>
          {group.rosterMatchedName || sourceUrl ? (
            <span className="text-muted-foreground text-[13px]" data-slot="honor-roster-name">
              {group.rosterMatchedName ? <>Listed as “{group.rosterMatchedName}”</> : null}
              {group.rosterMatchedName && sourceUrl ? " · " : null}
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate hover:underline"
                >
                  source list ↗
                </a>
              ) : null}
            </span>
          ) : null}
        </div>
        <span className="text-muted-foreground text-[12.5px]" data-slot="honor-position">
          {position}
        </span>
      </div>

      {decided ? (
        <div className="bg-apollo-surface-2 flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[13.5px]">
          {decided.kind === "approved" ? (
            <span className="text-apollo-slate font-medium">
              Approved for {shortName(decided.scholarName)}
            </span>
          ) : (
            <span className="text-destructive font-medium">
              Rejected{decided.reason ? ` · ${decided.reason}` : ""}
            </span>
          )}
          {readOnly ? null : (
            <button
              type="button"
              onClick={onUndo}
              disabled={busy}
              className="border-apollo-border-strong bg-apollo-surface ml-auto rounded-md border px-2.5 py-[3px] text-[13px]"
              data-slot="honor-undo"
            >
              Undo
            </button>
          )}
        </div>
      ) : null}

      {group.contested ? (
        <div className="flex flex-col gap-1.5">
          <span
            className="text-apollo-amber text-[12.5px] font-semibold"
            data-slot="honor-contested-label"
          >
            {group.rows.length} scholars match this name. Pick the right one; approving one rejects
            the others.
          </span>
          <div
            className="border-apollo-border overflow-hidden rounded-[10px] border"
            role="radiogroup"
            aria-label={`Who won ${head.name}, ${head.organization}?`}
          >
            {group.rows.map((r, i) => (
              <label
                key={r.id}
                className={cn(
                  "border-apollo-border grid cursor-pointer grid-cols-[18px_32px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5",
                  i > 0 && "border-t",
                  pick === r.id ? "bg-apollo-slate-tint" : "bg-apollo-surface",
                )}
                data-slot="honor-candidate"
              >
                <input
                  type="radio"
                  name={`honor-pick-${group.key}`}
                  checked={pick === r.id}
                  disabled={busy || readOnly || Boolean(decided)}
                  onChange={() => onPick(r.id)}
                  className="accent-apollo-slate m-0"
                  aria-label={r.scholarName}
                />
                <Avatar name={r.scholarName} size={32} />
                <span className="min-w-0 text-sm">
                  <b className="font-semibold">{r.scholarName}</b>{" "}
                  <span className="text-muted-foreground font-mono text-xs">{r.cwid}</span>
                  <br />
                  <span className="text-muted-foreground text-[12.5px]">
                    {role(r)}
                    {r.roleLabel && role(r) !== r.roleLabel ? ` · ${r.roleLabel}` : null}
                    {" · "}
                    <ProfileLink slug={r.slug} />
                  </span>
                </span>
                {i < 9 ? <Kbd>{i + 1}</Kbd> : <span />}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3" data-slot="honor-candidate">
          <Avatar name={head.scholarName} size={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[15px] font-semibold">
              {head.scholarName}{" "}
              <span className="text-muted-foreground font-mono text-xs font-normal">
                {head.cwid}
              </span>
            </span>
            <span className="text-muted-foreground text-[13px]">
              {role(head)}
              {head.roleLabel && role(head) !== head.roleLabel ? ` · ${head.roleLabel}` : null}
              {" · "}
              <ProfileLink slug={head.slug} />
            </span>
          </div>
          <div className="shrink-0">
            <LevelPill level={level} n={group.rows.length} large />
          </div>
        </div>
      )}

      {quote !== null ? (
        <EvidenceQuote quote={quote} group={group} />
      ) : note !== null ? (
        <p className="text-muted-foreground m-0 text-[13.5px]" data-slot="honor-evidence">
          {note}
        </p>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[18px] text-[13px]">
        <div className="flex flex-col gap-[5px]" data-slot="honor-signals">
          <SectionLabel>Match evidence</SectionLabel>
          {signals.length === 0 ? (
            <span className="text-muted-foreground">No evidence recorded</span>
          ) : (
            signals.map((s) => (
              <span key={s.text} className="flex items-baseline gap-2">
                <span
                  className={cn("w-3 font-bold", s.ok ? "text-apollo-slate" : "text-apollo-amber")}
                  aria-hidden
                >
                  {s.ok ? "✓" : "–"}
                </span>
                <span className="text-[#3a3532]">{s.text}</span>
              </span>
            ))
          )}
        </div>
        {chosen ? (
          <div className="flex flex-col gap-[5px]" data-slot="honor-on-profile">
            <SectionLabel>On {shortName(subject.scholarName)}’s profile</SectionLabel>
            {onProfile.length === 0 ? (
              <span className="text-muted-foreground">No honors yet</span>
            ) : (
              onProfile.map((p) => (
                <span key={p.id} className="text-[#3a3532]">
                  {p.name}{" "}
                  <span className="text-muted-foreground">
                    · {p.organization}
                    {p.year ? ` · ${p.year}` : ""}
                  </span>
                </span>
              ))
            )}
            {also.length ? (
              <>
                <span className="mt-2">
                  <SectionLabel>Also pending</SectionLabel>
                </span>
                {also.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => onFocus(g.key)}
                    className="text-apollo-slate text-left text-[13px]"
                  >
                    {g.rows[0].name}{" "}
                    <span className="text-muted-foreground">
                      · {g.rows[0].organization}
                      {g.rows[0].year ? ` · ${g.rows[0].year}` : ""}
                    </span>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {flags.map((f) => (
        <div
          key={f.title}
          className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded-lg border px-3 py-[9px] text-[13px] leading-[1.45]"
          data-slot="honor-flag"
        >
          <b className="font-semibold">{f.title}</b> {f.text}
        </div>
      ))}

      {asking && !readOnly && !decided ? (
        <div
          className="border-apollo-border-strong bg-apollo-surface-2 flex flex-col gap-2.5 rounded-[10px] border px-3.5 py-3"
          data-slot="honor-reject-reasons"
        >
          <span className="text-[13.5px] font-semibold">
            Why reject this?{" "}
            <span className="text-muted-foreground font-normal">A reason is required.</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {REJECTION_REASONS.map((r, i) => (
              <button
                key={r}
                type="button"
                disabled={busy}
                onClick={() => onRejectWith(r)}
                className="border-apollo-border-strong bg-apollo-surface flex items-center gap-[7px] rounded-lg border px-2.5 py-1.5 text-[13px]"
              >
                <span aria-hidden className="hidden md:inline">
                  <Kbd>{i + 1}</Kbd>
                </span>
                {r}
              </button>
            ))}
            <button
              type="button"
              onClick={onCancelAsk}
              className="text-muted-foreground flex items-center gap-1.5 text-[13px]"
            >
              Cancel
              <span aria-hidden className="hidden md:inline">
                <Kbd>Esc</Kbd>
              </span>
            </button>
          </div>
        </div>
      ) : null}

      {readOnly || decided ? null : (
        <div className="border-apollo-border flex flex-wrap items-center gap-2.5 border-t pt-4">
          <Button
            disabled={busy || blocked}
            title={blocked ? "Pick which scholar first" : undefined}
            onClick={onApprove}
            className={cn(
              "text-[13px] text-white",
              blocked ? "bg-apollo-border-strong" : "bg-apollo-slate hover:bg-apollo-slate/90",
            )}
          >
            {blocked ? "Pick a scholar to approve" : `Approve for ${shortName(chosen.scholarName)}`}
            <span aria-hidden className="ml-1.5 hidden md:inline">
              <Kbd light>A</Kbd>
            </span>
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onReject}
            className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
          >
            {group.contested ? "None of these" : "Reject"}
            <span aria-hidden className="ml-1.5 hidden md:inline">
              <Kbd>R</Kbd>
            </span>
          </Button>
          <button
            type="button"
            onClick={onSkip}
            className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[13px]"
          >
            Skip
            <span aria-hidden className="hidden md:inline">
              <Kbd>J</Kbd>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ReasonSelect({
  value,
  onChange,
  disabled,
  small = false,
  reasons = REJECTION_REASONS,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  small?: boolean;
  /** The choices; the honors reasons unless a queue passes its own (#3071). */
  reasons?: ReadonlyArray<string>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label="Rejection reason"
      className={cn(
        "border-apollo-border bg-apollo-surface text-muted-foreground rounded-md border px-2",
        small ? "h-8 text-[12.5px]" : "h-9 text-[13px]",
      )}
      data-slot="honor-reject-reason"
    >
      <option value="">Reason (required to reject)</option>
      {reasons.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

/** An evidence quote with the scholar's name, the award and Weill Cornell marked. */
export function EvidenceQuote({
  quote,
  group,
  small = false,
}: {
  quote: string;
  group: HonorQueueGroup;
  small?: boolean;
}) {
  return (
    <blockquote
      className={cn(
        "bg-apollo-page border-apollo-border m-0 rounded-[10px] border text-pretty text-[#3a3532]",
        small ? "px-3.5 py-3 text-sm leading-[1.6]" : "px-4 py-3.5 text-[15px] leading-[1.65]",
      )}
      data-slot="honor-evidence"
    >
      {highlight(quote, highlightTerms(group)).map((s, i) =>
        s.k === "name" ? (
          <mark
            key={i}
            className="bg-apollo-slate-tint text-apollo-slate rounded-[3px] px-0.5 font-semibold"
          >
            {s.t}
          </mark>
        ) : s.k === "award" ? (
          <mark
            key={i}
            className="bg-apollo-amber-tint text-apollo-amber rounded-[3px] px-0.5 font-semibold"
          >
            {s.t}
          </mark>
        ) : s.k === "inst" ? (
          <mark
            key={i}
            className="decoration-apollo-border-strong bg-transparent text-[#1f1b19] underline underline-offset-[3px]"
          >
            {s.t}
          </mark>
        ) : (
          <span key={i}>{s.t}</span>
        ),
      )}
    </blockquote>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}

function Avatar({ name, size }: { name: string; size: 32 | 40 }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-apollo-surface-2 ring-apollo-border-strong flex flex-none items-center justify-center rounded-full font-semibold ring-1",
        size === 40 ? "size-10 text-[13px]" : "size-8 text-[11.5px]",
      )}
    >
      {initials(name)}
    </span>
  );
}

function ProfileLink({ slug }: { slug: string | null }) {
  return slug ? (
    <a
      href={`/scholars/${slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-apollo-slate hover:underline"
    >
      profile ↗
    </a>
  ) : (
    <span className="italic">no public profile</span>
  );
}

/** The roster URL behind a line, when its `sourceRef` carries one
 *  (`<roster>|<printed-name>|<year>`). Only an http(s) roster segment becomes a
 *  link; an opaque roster id renders nothing. */
export function rosterSourceUrl(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  const roster = sourceRef.split("|")[0].trim();
  return /^https?:\/\//i.test(roster) ? roster : null;
}
