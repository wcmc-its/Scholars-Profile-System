"use client";

/**
 * #3071 — the grant attribution queue's decided tabs: Confirmed, Not this
 * person and Unproven. Every award the weekly check or a curator settled, 50
 * to a page, with its score and the evidence behind it one click away.
 *
 * Filters, sort, search, grouping and the page all live in the URL, so the
 * server loads exactly one page (`loadDecidedPage`). A decision dims its row in
 * place rather than refreshing: the replica may not have the write yet.
 *
 * Mockup: the Grant Attribution Showcase canvas, boards 3–6.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ReasonSelect } from "@/components/edit/honors-review";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { postRequeue } from "@/components/edit/grant-attribution-shared";
import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import {
  DECIDED_GROUP_PAGE_SIZE,
  DECIDED_PAGE_SIZE,
  HIDE_AT,
  PRIOR,
  SHOW_AT,
  checkedNothingFound,
  decidedHref,
  marginText,
  nameParts,
  partsDiffer,
  signed,
  type DecidedGroup,
  type DecidedPage,
  type DecidedParams,
  type DecidedRow,
  type DecidedTab,
} from "@/lib/edit/grant-attribution-decided";
import {
  GRANT_REJECTION_REASONS,
  cueLabel,
  reporterProjectUrl,
} from "@/lib/edit/grant-attribution-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

const CONTROL =
  "border-apollo-border-strong bg-apollo-surface text-foreground h-[34px] rounded-lg border px-2 text-[13px]";
const BUTTON =
  "border-apollo-border-strong bg-apollo-surface text-foreground inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[13px] whitespace-nowrap disabled:opacity-50 max-md:min-h-11 max-md:text-[14px]";
const LABEL = "text-muted-foreground text-[11.5px] font-medium tracking-[0.05em] uppercase";

const TAB_NOUN: Record<DecidedTab, string> = {
  confirmed: "confirmed awards",
  rejected: "awards marked not this person",
  unproven: "unproven awards",
};

type Outcome = { text: string };

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function years(from: number | null, to: number | null): string {
  if (from === null && to === null) return "";
  if (from === to || to === null) return String(from);
  if (from === null) return String(to);
  return `${from}–${to}`;
}

/** The award's first institution, as RePORTER prints it. */
function orgOf(r: DecidedRow): string {
  return r.award.orgs[0]?.name ?? "";
}

function whenLine(r: DecidedRow): string {
  const d = fmtDate(r.when);
  if (r.by === "curator") return [r.decidedByName ?? "A curator", d].filter(Boolean).join(" · ");
  const label =
    r.tab === "confirmed" ? "Auto-confirmed" : r.tab === "rejected" ? "Auto-rejected" : "";
  if (r.stillHidden)
    return [label, "still hidden until the next run", d].filter(Boolean).join(" · ");
  const was = r.was === "queued" ? "was in the queue" : r.was === "hidden" ? "was hidden" : "";
  return [label, was, d].filter(Boolean).join(" · ");
}

function scoreColor(r: DecidedRow): string {
  if (r.by === "curator" || r.tab === "unproven") return "text-muted-foreground";
  return r.tab === "confirmed" ? "text-apollo-slate" : "text-apollo-amber";
}

function ExternalIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="ml-[3px] inline-block align-[-1px]"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
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
      <path d={up ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard blocked: nothing to do.
  }
}

async function postDecisionByGrant(
  grant: string,
  decision: "confirm" | "reject",
  reason?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant, decision, ...(reason ? { reason } : {}) }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 409 && data?.error === "hidden_by_age")
      return {
        ok: false,
        message: "This award is also hidden because it is old, so confirming it would not show it.",
      };
    if (res.status === 409)
      return {
        ok: false,
        message: "This award changed since the page loaded. Refresh to see where it is now.",
      };
    if (res.status === 403)
      return { ok: false, message: "Your role can read this queue but not decide it." };
    return { ok: false, message: "We couldn't record that decision. Please try again." };
  } catch {
    return { ok: false, message: "We couldn't record that decision. Please try again." };
  }
}

async function postUndo(reviewId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: reviewId, decision: "undo" }),
    });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      message: "This decision changed since the page loaded. Refresh to see where it is now.",
    };
  } catch {
    return { ok: false, message: "We couldn't move that award. Please try again." };
  }
}

export function DecidedAwards({ page, readOnly }: { page: DecidedPage; readOnly: boolean }) {
  const router = useRouter();
  const p = page.params;
  const canDecide = !readOnly;
  const [q, setQ] = useState(p.q);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const go = useCallback(
    (over: Partial<DecidedParams>) =>
      router.push(decidedHref(p, { page: 1, ...over }), { scroll: false }),
    [router, p],
  );

  // Follow the URL when it changes under us (Back, a link), and push typing
  // to it after a pause. Compared trimmed, as the server stores it.
  useEffect(() => setQ(p.q), [p.q]);
  useEffect(() => {
    if (q.trim().slice(0, 200) === p.q) return;
    const t = setTimeout(() => go({ q: q.trim() }), 350);
    return () => clearTimeout(t);
  }, [q, p.q, go]);

  const done = (r: DecidedRow, text: string) => {
    setOutcomes((o) => ({ ...o, [r.grantId]: { text } }));
    setAsking(null);
    setReason("");
    setToast(text);
  };

  const moveToReview = async (r: DecidedRow, force = false): Promise<boolean> => {
    if (!canDecide || (busy && !force)) return false;
    setBusy(r.grantId);
    setError(null);
    const res =
      r.by === "curator" && r.reviewId ? await postUndo(r.reviewId) : await postRequeue(r.grantId);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    done(r, "Moved to review. It's off the profile until a curator decides.");
    return true;
  };

  const decide = async (r: DecidedRow, decision: "confirm" | "reject", why?: string) => {
    if (!canDecide || busy) return;
    setBusy(r.grantId);
    setError(null);
    const res = await postDecisionByGrant(r.grantId, decision, why);
    setBusy(null);
    if (!res.ok) return setError(res.message);
    done(
      r,
      decision === "confirm"
        ? "Confirmed. It shows on the scholar's profile; search updates within minutes."
        : "Marked not this person. The profile won't show it.",
    );
  };

  const moveAll = async (g: DecidedGroup) => {
    if (!canDecide || busy) return;
    for (const r of g.rows) {
      if (outcomes[r.grantId]) continue;
      // One at a time; the first refusal stops the rest.
      if (!(await moveToReview(r, true))) break;
    }
  };

  const counts = page.counts[p.tab];
  const pageSize = p.group ? DECIDED_GROUP_PAGE_SIZE : DECIDED_PAGE_SIZE;
  const first = page.matched === 0 ? 0 : (p.page - 1) * pageSize + 1;
  const last = Math.min(page.matched, p.page * pageSize);
  const autoLabel =
    p.tab === "confirmed" ? "Auto-confirmed" : p.tab === "rejected" ? "Auto-rejected" : null;
  const rowProps = {
    canDecide,
    busy,
    open,
    asking,
    reason,
    outcomes,
    onToggle: (id: string) => setOpen((o) => (o === id ? null : id)),
    onAsk: (id: string | null) => {
      setAsking(id);
      setReason("");
    },
    onReason: setReason,
    onDecide: decide,
    onMove: (r: DecidedRow) => void moveToReview(r),
  };

  return (
    <div className="flex flex-col gap-4" data-slot="grant-attribution-decided">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {autoLabel ? (
          <div
            role="group"
            aria-label="Decided by"
            className="border-apollo-border-strong bg-apollo-surface inline-flex overflow-hidden rounded-lg border"
          >
            {(
              [
                ["all", "All", counts.all],
                ["curator", "By a curator", counts.curator],
                ["auto", autoLabel, counts.auto],
              ] as const
            ).map(([k, label, n], i) => (
              <button
                key={k}
                type="button"
                aria-pressed={p.by === k}
                onClick={() => go({ by: k })}
                className={cn(
                  "h-[34px] px-3 text-[13px] max-md:h-11",
                  i > 0 && "border-apollo-border-strong border-l",
                  p.by === k
                    ? "bg-apollo-surface-2 text-foreground font-semibold"
                    : "text-[#3a3532]",
                )}
                data-testid={`grant-attribution-by-${k}`}
              >
                {label}
                {k === "all" ? "" : ` ${n.toLocaleString("en-US")}`}
              </button>
            ))}
          </div>
        ) : null}
        {p.tab === "confirmed" ? (
          <label className="flex min-h-[34px] items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={p.changed}
              onChange={(e) => go({ changed: e.target.checked })}
              className="size-4"
              data-testid="grant-attribution-changed"
            />
            Changed this run ({page.changed.toLocaleString("en-US")})
          </label>
        ) : null}
        <label className="flex min-h-[34px] items-center gap-2 text-[13px] max-md:min-h-11">
          <input
            type="checkbox"
            checked={p.group}
            onChange={(e) => go({ group: e.target.checked })}
            className="size-4"
            data-testid="grant-attribution-group"
          />
          Group by scholar
        </label>
        <label className="text-muted-foreground flex items-center gap-1.5 text-[13px] max-md:w-full">
          Sort
          <select
            value={p.sort}
            onChange={(e) => go({ sort: e.target.value as DecidedParams["sort"] })}
            className={cn(CONTROL, "max-md:h-11 max-md:flex-1 max-md:text-[15px]")}
          >
            {p.tab !== "unproven" ? <option value="least">Least certain first</option> : null}
            <option value="recent">Most recent</option>
            <option value="scholar">Scholar (A–Z)</option>
          </select>
        </label>
        {p.group ? (
          <button
            type="button"
            onClick={() =>
              setCollapsed((c) =>
                c.size > 0 ? new Set() : new Set((page.groups ?? []).map((g) => g.cwid)),
              )
            }
            className="text-foreground decoration-apollo-border-strong h-[34px] px-1 text-[13px] underline underline-offset-2"
          >
            {collapsed.size > 0 ? "Expand all" : "Collapse all"}
          </button>
        ) : null}
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Scholar, award or PI…"
          aria-label={`Search ${TAB_NOUN[p.tab]}`}
          className={cn(
            CONTROL,
            "w-[220px] max-w-full px-2.5 text-[13.5px] outline-none max-md:order-first max-md:h-11 max-md:w-full max-md:text-[15px] md:ml-auto",
          )}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="border-destructive bg-apollo-red-tint text-destructive flex items-center gap-3 rounded-lg border px-3 py-[9px] text-[13.5px]"
          data-testid="grant-attribution-error"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto text-[13px]">
            Dismiss
          </button>
        </div>
      ) : null}

      {page.matched === 0 ? (
        <div
          className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded-[var(--apollo-radius-card)] border p-8 text-center text-[14px]"
          data-testid="grant-attribution-empty"
        >
          {p.q || p.by !== "all" || p.changed
            ? "Nothing matches. Try a wider filter."
            : "Nothing here yet."}
        </div>
      ) : p.group && page.groups ? (
        <GroupedTable
          groups={page.groups}
          tab={p.tab}
          collapsed={collapsed}
          onCollapse={(cwid) =>
            setCollapsed((c) => {
              const n = new Set(c);
              if (n.has(cwid)) n.delete(cwid);
              else n.add(cwid);
              return n;
            })
          }
          onMoveAll={moveAll}
          hrefFor={(tab, cwid) =>
            decidedHref({ ...p, tab, by: "all", changed: false, group: false, q: cwid, page: 1 })
          }
          rowProps={rowProps}
        />
      ) : (
        <>
          <div className="bg-apollo-surface border-apollo-border overflow-x-auto rounded-xl border max-md:hidden">
            <table className="w-full min-w-[900px] border-collapse text-[13.5px]">
              <thead>
                <tr className="bg-apollo-surface-2 text-muted-foreground text-left text-xs tracking-[0.05em] uppercase">
                  <th className="px-3.5 py-2.5 font-medium">Scholar</th>
                  <th className="px-3.5 py-2.5 font-medium">Award</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">Score</th>
                  <th className="px-3.5 py-2.5 font-medium">Why</th>
                  <th className="px-3.5 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <Row key={r.grantId} r={r} withScholar {...rowProps} />
                ))}
              </tbody>
            </table>
          </div>
          <ul
            className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden"
            data-testid="grant-attribution-cards"
          >
            {page.rows.map((r) => (
              <Card key={r.grantId} r={r} {...rowProps} />
            ))}
          </ul>
        </>
      )}

      {page.matched > 0 ? (
        <nav
          aria-label="Pages"
          className="flex flex-wrap items-center gap-2.5 text-[13px] text-[#3a3532]"
        >
          <span>
            {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")} of{" "}
            {page.matched.toLocaleString("en-US")}
            {p.group ? " scholars" : ""}
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              disabled={p.page <= 1}
              onClick={() => go({ page: p.page - 1 })}
              className={cn(BUTTON, "h-[34px] px-3")}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={last >= page.matched}
              onClick={() => go({ page: p.page + 1 })}
              className={cn(BUTTON, "h-[34px] px-3")}
            >
              Next
            </button>
          </span>
        </nav>
      ) : null}

      {toast ? (
        <DecisionStatusBar
          text={toast}
          canUndo={false}
          undoing={false}
          onUndo={() => undefined}
          onDismiss={() => setToast(null)}
          testId="grant-attribution-status"
          className="fixed bottom-5 left-1/2 z-20 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 shadow-[0_6px_20px_rgba(0,0,0,.18)]"
        />
      ) : null}
    </div>
  );
}

type RowProps = {
  canDecide: boolean;
  busy: string | null;
  open: string | null;
  asking: string | null;
  reason: string;
  outcomes: Record<string, Outcome>;
  onToggle: (id: string) => void;
  onAsk: (id: string | null) => void;
  onReason: (v: string) => void;
  onDecide: (r: DecidedRow, d: "confirm" | "reject", why?: string) => void;
  onMove: (r: DecidedRow) => void;
};

function ScholarCell({ r, compact = false }: { r: DecidedRow; compact?: boolean }) {
  const s = r.scholar;
  return (
    <div className="flex flex-col gap-px">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        {s.slug ? (
          <a
            href={profilePath(s.slug)}
            target="_blank"
            rel="noopener"
            aria-label={`${s.name}, Scholars profile (opens in a new tab)`}
            className={cn("font-semibold whitespace-nowrap", compact ? "text-[15px]" : "")}
          >
            {s.name}
            <ExternalIcon />
          </a>
        ) : (
          <span className="font-semibold">{s.name}</span>
        )}
        {s.degrees ? (
          <span className="text-muted-foreground text-[12.5px]">{s.degrees}</span>
        ) : null}
      </div>
      <div className="font-mono text-xs text-[#3a3532]">{s.cwid}</div>
      <div className="text-muted-foreground text-[12.5px]">
        {[s.department, s.career].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

/** "On award Lindqvist, Priya M", the part that differs marked. */
function OnAward({ r }: { r: DecidedRow }) {
  if (!r.reporterName) return null;
  const theirs = nameParts(r.reporterName, "last-first");
  const ours = nameParts(r.scholar.names[r.scholar.names.length - 1] ?? "", "first-last");
  const mark = (a: string, b: string) =>
    partsDiffer(a, b) ? (
      <mark className="bg-apollo-surface-2 text-foreground border-foreground border-b-2 px-0.5 font-bold">
        {a}
      </mark>
    ) : (
      a
    );
  return (
    <div className="mt-0.5 text-[12.5px] text-[#3a3532]" data-testid="grant-attribution-on-award">
      <span className={cn(LABEL, "mr-1")}>On award</span>
      {mark(theirs.last, ours.last)}, {mark(theirs.first, ours.first)}
      {theirs.middle ? <> {mark(theirs.middle, ours.middle)}</> : null}
    </div>
  );
}

function AwardCell({ r }: { r: DecidedRow }) {
  const a = r.award;
  const url = reporterProjectUrl(a.applId);
  const num = a.awardNumber ?? a.coreProjectNum;
  return (
    <div className="flex flex-col gap-px">
      <div>{a.title ?? "Untitled award"}</div>
      <div className="text-[13px] text-[#3a3532]">
        {[orgOf(r), years(a.startYear, a.endYear)].filter(Boolean).join(" · ")}
      </div>
      {num ? (
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener"
            aria-label={`${num} in NIH RePORTER (opens in a new tab)`}
            className="text-muted-foreground self-start text-xs whitespace-nowrap tabular-nums"
          >
            {num}
            <ExternalIcon />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs tabular-nums">{num}</span>
        )
      ) : null}
    </div>
  );
}

function Actions({ r, ...rp }: { r: DecidedRow } & RowProps) {
  if (!rp.canDecide) return null;
  const outcome = rp.outcomes[r.grantId];
  if (outcome)
    return <span className="text-muted-foreground text-[13px]">{outcome.text.split(".")[0]}.</span>;
  const disabled = rp.busy !== null;
  if (rp.asking === r.grantId) {
    return (
      <div className="flex flex-col items-end gap-1.5 max-md:items-stretch">
        <ReasonSelect
          value={rp.reason}
          onChange={rp.onReason}
          disabled={disabled}
          small
          reasons={GRANT_REJECTION_REASONS}
          placeholder="Reason (required)"
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={disabled || !rp.reason}
            onClick={() => rp.onDecide(r, "reject", rp.reason)}
            className={cn(BUTTON, "text-destructive")}
          >
            Not this person
          </button>
          <button type="button" onClick={() => rp.onAsk(null)} className={BUTTON}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const reject = (
    <button
      key="reject"
      type="button"
      disabled={disabled}
      onClick={() => rp.onAsk(r.grantId)}
      className={BUTTON}
    >
      Not this person
    </button>
  );
  const confirm = (
    <button
      key="confirm"
      type="button"
      disabled={disabled}
      onClick={() => rp.onDecide(r, "confirm")}
      className={BUTTON}
    >
      Confirm instead
    </button>
  );
  const move = (
    <button
      key="move"
      type="button"
      disabled={disabled}
      onClick={() => rp.onMove(r)}
      className={BUTTON}
    >
      Move to review
    </button>
  );
  const buttons =
    r.tab === "confirmed"
      ? [reject, move]
      : r.tab === "rejected"
        ? [confirm, move]
        : [confirm, reject];
  return (
    <div className="flex flex-col items-end gap-1.5 max-md:flex-row max-md:flex-wrap max-md:items-stretch">
      {buttons}
    </div>
  );
}

function EvidenceButton({
  r,
  open,
  onToggle,
  wide = false,
}: {
  r: DecidedRow;
  open: boolean;
  onToggle: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        BUTTON,
        "mt-2",
        open && "border-foreground font-medium",
        wide && "mt-0 w-full max-md:min-h-11",
      )}
      data-testid={`grant-attribution-evidence-${r.grantId}`}
    >
      {wide ? (open ? "Hide evidence" : "Show evidence") : "Evidence"}
      <Chevron up={open} />
    </button>
  );
}

function Row({
  r,
  withScholar,
  indent = false,
  ...rp
}: { r: DecidedRow; withScholar: boolean; indent?: boolean } & RowProps) {
  const isOpen = rp.open === r.grantId;
  const dim = !!rp.outcomes[r.grantId];
  const cols = withScholar ? 5 : 4;
  return (
    <>
      <tr
        className={cn(
          "border-apollo-border border-t align-top",
          isOpen && "bg-apollo-surface-2",
          dim && "opacity-60",
        )}
        data-testid={`grant-attribution-row-${r.grantId}`}
      >
        {withScholar ? (
          <td className="w-[230px] px-3.5 py-3">
            <ScholarCell r={r} />
            <OnAward r={r} />
          </td>
        ) : null}
        <td className={cn("max-w-[360px] px-3.5 py-3", indent && "pl-[50px]")}>
          <AwardCell r={r} />
          {withScholar ? null : <OnAward r={r} />}
        </td>
        <td className="px-3.5 py-3 text-right whitespace-nowrap">
          <div className={cn("text-[18px] font-semibold tabular-nums", scoreColor(r))}>
            {signed(r.score)}
          </div>
          <div className="text-muted-foreground text-xs">{marginText(r.tab, r.score, r.by)}</div>
        </td>
        <td className="max-w-[300px] px-3.5 py-3">
          <div>{r.reason}</div>
          <div className="text-muted-foreground mt-0.5 text-[12.5px]">{whenLine(r)}</div>
          <EvidenceButton r={r} open={isOpen} onToggle={() => rp.onToggle(r.grantId)} />
        </td>
        <td className="px-3.5 py-3 text-right">
          <Actions r={r} {...rp} />
        </td>
      </tr>
      {isOpen ? (
        <tr className="bg-apollo-surface-2">
          <td colSpan={cols} className="px-3.5 pb-4">
            <Evidence r={r} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Card({ r, ...rp }: { r: DecidedRow } & RowProps) {
  const isOpen = rp.open === r.grantId;
  return (
    <li
      className={cn(
        "bg-apollo-surface flex flex-col gap-2.5 rounded-xl border p-3.5",
        isOpen ? "border-apollo-border-strong" : "border-apollo-border",
        rp.outcomes[r.grantId] && "opacity-60",
      )}
    >
      <ScholarCell r={r} compact />
      <div className="text-[14px]">
        <AwardCell r={r} />
        <OnAward r={r} />
      </div>
      <div className="flex items-baseline gap-2.5">
        <span className={cn("text-[18px] font-semibold tabular-nums", scoreColor(r))}>
          {signed(r.score)}
        </span>
        <span className="text-[13px] text-[#3a3532]">
          {r.reason} · {whenLine(r)}
        </span>
      </div>
      <EvidenceButton r={r} open={isOpen} onToggle={() => rp.onToggle(r.grantId)} wide />
      {isOpen ? (
        <div className="border-apollo-border border-t pt-3">
          <Evidence r={r} bare />
        </div>
      ) : null}
      <Actions r={r} {...rp} />
    </li>
  );
}

function GroupedTable({
  groups,
  tab,
  collapsed,
  onCollapse,
  onMoveAll,
  hrefFor,
  rowProps,
}: {
  groups: DecidedGroup[];
  tab: DecidedTab;
  collapsed: ReadonlySet<string>;
  onCollapse: (cwid: string) => void;
  onMoveAll: (g: DecidedGroup) => void;
  /** One scholar's awards on another tab. */
  hrefFor: (tab: DecidedTab, cwid: string) => string;
  rowProps: RowProps;
}) {
  const TAB_NAME: Record<DecidedTab | "pending", string> = {
    confirmed: "in Confirmed",
    rejected: "in Not this person",
    unproven: "in Unproven",
    pending: "to review",
  };
  return (
    <div className="bg-apollo-surface border-apollo-border overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[900px] border-collapse text-[13.5px]">
        <thead>
          <tr className="bg-apollo-surface-2 text-muted-foreground text-left text-xs tracking-[0.05em] uppercase">
            <th className="py-2.5 pr-3.5 pl-[50px] font-medium">Award</th>
            <th className="px-3.5 py-2.5 text-right font-medium">Score</th>
            <th className="px-3.5 py-2.5 font-medium">Why</th>
            <th className="px-3.5 py-2.5 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {groups.map((g) => {
          const r0 = g.rows[0]!;
          const isOpen = !collapsed.has(g.cwid);
          return (
            <tbody key={g.cwid} className="border-apollo-border-strong border-t">
              <tr className="bg-apollo-surface-2">
                <th scope="rowgroup" colSpan={3} className="px-3.5 py-2.5 text-left font-normal">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${r0.scholar.name}`}
                      onClick={() => onCollapse(g.cwid)}
                      className="-mt-[3px] flex size-7 shrink-0 items-center justify-center rounded-md"
                    >
                      <span className={cn("inline-block", !isOpen && "-rotate-90")}>
                        <Chevron up={false} />
                      </span>
                    </button>
                    <div>
                      <ScholarCell r={r0} />
                      <div className="mt-[3px] text-[12.5px] text-[#3a3532]">
                        {g.shown < g.here ? `${g.shown} shown · ` : ""}
                        {g.here} of {g.total} awards here
                        {Object.entries(g.elsewhere).map(([k, n]) => (
                          <span key={k}>
                            {" · "}
                            {k === "pending" ? (
                              <a href="?tab=pending">
                                {n} {TAB_NAME.pending}
                              </a>
                            ) : (
                              <a href={hrefFor(k as DecidedTab, g.cwid)}>
                                {n} {TAB_NAME[k as DecidedTab]}
                              </a>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </th>
                <td className="px-3.5 py-2.5 text-right align-top">
                  {rowProps.canDecide && tab !== "unproven" ? (
                    <button
                      type="button"
                      disabled={rowProps.busy !== null}
                      onClick={() => onMoveAll(g)}
                      className={BUTTON}
                    >
                      {g.shown === 1 ? "Move to review" : `Move ${g.shown} to review`}
                    </button>
                  ) : null}
                </td>
              </tr>
              {isOpen
                ? g.rows.map((r) => (
                    <Row key={r.grantId} r={r} withScholar={false} indent {...rowProps} />
                  ))
                : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** The evidence panel: names, the score ledger, where it landed, what was
 *  checked and not found. */
function Evidence({ r, bare = false }: { r: DecidedRow; bare?: boolean }) {
  const toward = r.tab === "confirmed";
  const main = r.cues.find((c) =>
    toward ? c.weight > 0 : c.weight < 0 || c.id === "infoed_other_wcm_pi_named",
  );
  const ids = new Set(r.cues.map((c) => c.id));
  const nothing = checkedNothingFound(ids);
  const rarity = r.cues.find((c) => c.id === "name_rare" || c.id === "name_common");
  const verdict =
    r.by === "curator"
      ? r.tab === "confirmed"
        ? "Confirmed by a curator"
        : "Not this person, by a curator"
      : r.tab === "confirmed"
        ? "Score: confirmed"
        : r.tab === "rejected"
          ? "Score: not this person"
          : "Score: unproven";
  const explain =
    r.tab === "confirmed"
      ? `Confirm at ${signed(SHOW_AT)} or above.`
      : r.tab === "rejected"
        ? `Hide at ${signed(HIDE_AT)} or below, with evidence against.`
        : `Kept off until evidence turns up. It needs ${signed(SHOW_AT - r.score)} to be confirmed.`;
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        !bare && "bg-apollo-surface border-apollo-border rounded-[10px] border px-[18px] py-4",
      )}
      data-testid="grant-attribution-evidence"
    >
      <NameTable r={r} rarity={rarity?.reason ?? null} />

      <div className="grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-3 max-md:grid-cols-[40px_minmax(0,1fr)]">
        <span className="text-muted-foreground text-right text-[15px] tabular-nums">
          {signed(PRIOR)}
        </span>
        <span className="text-muted-foreground text-[13px]">Every award starts here</span>
        {r.cues.length === 0 ? (
          <>
            <span className="text-muted-foreground text-right text-[15px] tabular-nums">0</span>
            <span className="text-muted-foreground text-[13px]">Nothing points either way</span>
          </>
        ) : (
          r.cues.map((c) => <LedgerItem key={c.id} cue={c} main={c === main} />)
        )}
        <div aria-hidden className="border-foreground col-span-full -mb-1 border-t" />
        <span className="text-right text-[18px] font-bold tabular-nums">{signed(r.score)}</span>
        <div>
          <div className="font-semibold">{verdict}</div>
          <div className="text-[13px] text-[#3a3532]">{explain}</div>
        </div>
      </div>

      <Scale score={r.score} />

      {nothing.length > 0 ? (
        <div className="text-muted-foreground text-[12.5px] leading-normal">
          <div className="mb-1 font-semibold text-[#3a3532]">Checked, nothing found</div>
          <ul className="m-0 flex flex-col gap-0.5 pl-[18px]">
            {nothing.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function NameTable({ r, rarity }: { r: DecidedRow; rarity: string | null }) {
  if (!r.reporterName) return null;
  const theirs = nameParts(r.reporterName, "last-first");
  const ours = nameParts(r.scholar.names[r.scholar.names.length - 1] ?? "", "first-last");
  const keys = ["last", "first", "middle"] as const;
  const differs = keys.filter((k) => partsDiffer(theirs[k], ours[k]));
  const cell = (v: string, k: (typeof keys)[number]) => (
    <td className="py-[3px] pr-[18px] text-[14px] font-medium">
      {differs.includes(k) ? (
        <mark className="bg-apollo-surface-2 text-foreground border-foreground border-b-2 px-[3px] font-bold">
          {v}
        </mark>
      ) : (
        v || "—"
      )}
    </td>
  );
  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-3">
      <table className="border-collapse">
        <caption className="sr-only">Name on the award compared with the scholar’s name</caption>
        <thead>
          <tr>
            <td />
            {["Last", "First", "Middle"].map((h) => (
              <th key={h} scope="col" className={cn(LABEL, "pr-[18px] pb-1 text-left")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className={cn(LABEL, "py-[3px] pr-[18px] text-left whitespace-nowrap")}>
              RePORTER PI
            </th>
            {keys.map((k) => (
              <Fragmentless key={k}>{cell(theirs[k], k)}</Fragmentless>
            ))}
          </tr>
          <tr>
            <th scope="row" className={cn(LABEL, "py-[3px] pr-[18px] text-left whitespace-nowrap")}>
              Scholars
            </th>
            {keys.map((k) => (
              <Fragmentless key={k}>{cell(ours[k], k)}</Fragmentless>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="flex flex-col gap-1.5 text-[13px] text-[#3a3532]">
        <div>
          <div className={LABEL}>Names</div>
          <div>
            {differs.length === 0
              ? "Match"
              : differs.length === 1 && differs[0] === "middle"
                ? "Middle initial differs"
                : `${differs.map((d) => (d === "last" ? "Last" : d === "first" ? "First" : "Middle")).join(" and ")} name differs`}
          </div>
        </div>
        {rarity ? (
          <div>
            <div className={LABEL}>Name rarity</div>
            <div>{rarity}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Renders its child as is; keeps the table rows' keys in one place. */
function Fragmentless({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function LedgerItem({ cue, main }: { cue: DecidedRow["cues"][number]; main: boolean }) {
  const color =
    cue.weight > 0
      ? "text-apollo-slate"
      : cue.weight < 0
        ? "text-apollo-amber"
        : "text-muted-foreground";
  const pmids = cue.coPi?.papers.map((p) => p.pmid) ?? [];
  return (
    <>
      <span className={cn("text-right text-[15px] font-semibold tabular-nums", color)}>
        {signed(cue.weight)}
      </span>
      <div>
        <div className="flex flex-wrap items-baseline gap-2 font-semibold">
          {cueLabel(cue.id)}
          {main ? (
            <span className="border-foreground rounded-full border px-[7px] text-[11.5px] font-semibold">
              Main reason
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[13px] text-[#3a3532]">{cue.reason}</div>
        {cue.coPi && cue.coPi.papers.length > 0 ? (
          <>
            <ul className="mt-1 flex flex-col gap-0.5 pl-[18px] text-[12.5px] text-[#3a3532]">
              {cue.coPi.papers.map((p) => (
                <li key={p.pmid}>
                  <a
                    href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                    target="_blank"
                    rel="noopener"
                  >
                    <PubTitle value={p.title} />
                  </a>
                  {p.journal ? (
                    <>
                      {" · "}
                      <PubJournal as="span" value={p.journal} />
                    </>
                  ) : null}
                  {p.year ? ` ${p.year}` : ""}
                  {" · "}
                  <span className="text-muted-foreground inline-flex items-center gap-0.5 whitespace-nowrap tabular-nums">
                    PMID {p.pmid}
                    <button
                      type="button"
                      aria-label={`Copy PMID ${p.pmid}`}
                      title="Copy PMID"
                      onClick={() => void copy(p.pmid)}
                      className="inline-flex size-6 items-center justify-center rounded-md max-md:size-11"
                    >
                      <CopyIcon />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {pmids.length > 1 ? (
              <button
                type="button"
                aria-label={`Copy ${pmids.length} PMIDs: ${pmids.join(", ")}`}
                onClick={() => void copy(pmids.join("\n"))}
                className={cn(BUTTON, "mt-1.5")}
              >
                <CopyIcon />
                Copy {pmids.length} PMIDs
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Where the score landed on a −10…+10 line, with the hide and confirm marks. */
function Scale({ score }: { score: number }) {
  const pos = (n: number) => `${((Math.max(-10, Math.min(10, n)) + 10) / 20) * 100}%`;
  const moved = score !== PRIOR;
  return (
    <div
      role="img"
      aria-label={`Score ${signed(score)} on a scale from −10 to +10, ${moved ? `from a start of ${signed(PRIOR)}` : "unchanged from the start"}. Hide at ${signed(HIDE_AT)} or below, confirm at ${signed(SHOW_AT)} or above.`}
      className="relative h-11 max-w-[520px]"
    >
      <div className="absolute inset-x-0 top-2.5 flex h-2.5 overflow-hidden rounded-[5px]">
        <div className="bg-apollo-amber-tint w-[40%]" />
        <div className="bg-apollo-surface-2 w-[20%]" />
        <div className="bg-apollo-slate-tint w-[40%]" />
      </div>
      {moved ? (
        <div
          className="border-muted-foreground bg-apollo-surface absolute top-[9px] -ml-1.5 size-3 rounded-full border-2"
          style={{ left: pos(PRIOR) }}
        />
      ) : null}
      <div
        className="absolute top-[7px] -ml-2 size-4 rounded-full border-2 border-white bg-[#3a3532]"
        style={{ left: pos(score) }}
      />
      <span
        className="text-muted-foreground absolute top-7 -translate-x-1/2 text-[11.5px] whitespace-nowrap"
        style={{ left: pos(HIDE_AT) }}
      >
        {signed(HIDE_AT)} hide
      </span>
      <span
        className="text-muted-foreground absolute top-7 -translate-x-1/2 text-[11.5px] whitespace-nowrap"
        style={{ left: pos(SHOW_AT) }}
      >
        {signed(SHOW_AT)} confirm
      </span>
    </div>
  );
}
