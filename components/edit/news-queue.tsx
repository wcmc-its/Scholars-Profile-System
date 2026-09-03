/**
 * The news approval queue UI (client). Three tabs — Pending (the working queue),
 * Approved and Rejected (read-only history). A pending group is either one
 * candidate (plain Approve / Reject) or a CONTESTED set where one detected name
 * resolved to several scholars: there the reviewer picks the right person with
 * "This is the one" (which the decision route publishes and rejects the siblings
 * atomically), or "None of these" to reject the whole group.
 *
 * Each decision POSTs /api/edit/news-mention/decision and refreshes the page (the
 * queue is force-dynamic), so the row moves to its new tab without local
 * bookkeeping.
 *
 * The three tabs are NOT symmetrical, because the questions differ:
 *   Pending  — a sort selector + a name filter, both CLIENT-SIDE over the already
 *              loaded groups (see the comment on the controls below).
 *   Approved — `status=published` answered "is this the right person?"; it says
 *              nothing about whether comms WANTS the mention on the profile. That
 *              second, orthogonal question is `showOnProfile`, toggled here
 *              against /api/edit/news-mention (a different route and body from
 *              `decide()` — hence a second helper, not an overload).
 *   Rejected — an Approve, because "rejected" is a human judgement a human may
 *              have got wrong. On a CONTESTED row it states its blast radius
 *              before the click: approving one candidate rejects the others.
 */
"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { NEWS_HISTORY_LIMIT, sortNewsQueueGroups } from "@/lib/edit/news-queue";
import type { NewsQueueCounts, NewsQueueGroup, NewsQueueRow, NewsQueueSort } from "@/lib/edit/news-queue";

type Tab = "pending" | "approved" | "rejected";

/**
 * The snippet with the detected name emphasised at `ranges` (#2578 follow-up).
 *
 * Returns React nodes, never an HTML string: this is scraped article prose, and
 * the surrounding comment's rule — no `dangerouslySetInnerHTML` here, ever —
 * still holds. React escapes text children, so marking the name costs nothing
 * in safety. An empty `ranges` renders exactly the flat string it always did.
 */
function highlightName(snippet: string, ranges: [number, number][]): ReactNode {
  if (ranges.length === 0) return snippet;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    // Defensive: a range outside the string, or one that overlaps its
    // predecessor, is dropped rather than allowed to slice text out of order.
    if (start < at || end > snippet.length || start >= end) continue;
    if (start > at) out.push(snippet.slice(at, start));
    out.push(
      <mark key={start} className="text-foreground bg-transparent font-semibold not-italic">
        {snippet.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < snippet.length) out.push(snippet.slice(at));
  return out;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Undated";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Confidence-tier badge colours — green / amber / red, per the product owner's
 * ask (#2578 follow-up). Every class is an EXISTING house token, none invented
 * here:
 *
 *   HIGH   apollo-green*  — the same pairing matcha-panel.tsx's `strong` fit
 *                           tier and `GRANT_TIER_CLASS` already use.
 *   MEDIUM apollo-amber*  — likewise matcha-panel.tsx's `good` fit tier. Amber's
 *                           "confidence/tier classification" meaning is one of
 *                           its FOUR settled uses (app/globals.css, the Apollo
 *                           colour-language block) — this is that meaning, not
 *                           a new one.
 *   LOW    apollo-red-tint + text-destructive — apollo-red-tint/-border are the
 *                           only "red" tint pair the token system defines.
 *                           `--apollo-maroon` is NOT used for the text here: the
 *                           same colour-language block reserves maroon "Brand
 *                           only; never a provenance cue", so LOW instead pairs
 *                           the red tint with `--destructive` (the house DANGER
 *                           role), which is already how this queue's own error
 *                           text reads (`text-destructive` above).
 *
 * Green has no OTHER meaning on this page (the "Yours to edit" ownership badge
 * lives only on the scholar edit panel), so this does not collide with the
 * colour-language block's "never two meanings on the same surface" rule.
 */
const LIKELIHOOD_BADGE_CLASS: Readonly<Record<string, string>> = {
  HIGH: "border-apollo-green-tint-border bg-apollo-green-tint text-apollo-green-foreground",
  MEDIUM: "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber",
  LOW: "border-apollo-red-tint-border bg-apollo-red-tint text-destructive",
};

/**
 * How the ETL found the name, in reviewer language (#2578).
 *
 * `likelihood` alone cannot explain itself: it folds in contested-ness as well
 * as basis, so a MEDIUM may mean "prose match" or "tagged but two scholars share
 * the name". The basis is the half a reviewer can actually act on — above all
 * `TITLE`, the endowed-chair/memorial case that drove most rejections, where the
 * story is about the chair's HOLDER rather than the person it is named for.
 */
const BASIS_LABEL: Readonly<Record<string, { text: string; hint: string }>> = {
  TAG: {
    text: "newsroom tag",
    hint: "The newsroom's own story tags name this scholar — attribution by the article's authors.",
  },
  BODY: { text: "article text", hint: "Named in the article prose." },
  CAPTION: {
    text: "photo caption",
    hint: "Named only in a photo's alt text, nowhere in the prose.",
  },
  TITLE: {
    text: "endowed title only",
    hint:
      "Named only inside an endowed-chair or memorial phrase (e.g. “the O. Wayne Isom Professor of…”). " +
      "The story is usually about the chair's holder, not the person it is named for.",
  },
};

/** The Approved tab's profile-visibility pill — SHAPE only, matching the VIVO
 *  badge above; the colour pair is chosen at the call site. */
const VISIBILITY_PILL =
  "rounded-sm border px-1 py-px text-[10px] font-semibold tracking-wider uppercase";

/**
 * The Pending sort options, in the order they are offered.
 *
 * "certainty" is FIRST and is the default because it is the shipped order — the
 * likelihood rank the loader already applies, with contested groups sunk to the
 * bottom. The other two are alternate readings of the same rows, not a
 * replacement: "recent" drops the likelihood weighting entirely (what a reviewer
 * wants when clearing the newest scrape), "prominence" leads with leadership tier
 * (a Dean's mention is worth confirming before an unranked one).
 */
const SORT_OPTIONS: ReadonlyArray<{ value: NewsQueueSort; label: string }> = [
  { value: "certainty", label: "Certainty" },
  { value: "recent", label: "Most recent" },
  { value: "prominence", label: "Prominence" },
];

/**
 * A decision failure in reviewer language.
 *
 * The decision route has TWO distinct 409s and both are actionable by a human, so
 * neither may fall through to a generic "please try again":
 *
 *   already_decided — a competing scholar is already published for this detected
 *                     name. One mention can only be credited to one person, so
 *                     the other approval has to come off first — and NOT from
 *                     this queue, which offers no un-approve (the Approved tab's
 *                     toggle is `showOnProfile`, a different question). The
 *                     remedy lives on the competing scholar's own edit page, so
 *                     the message has to say so; a retry would never reveal it.
 *   not_pending     — the row moved under the reviewer (a second steward decided
 *                     it, or this tab has gone stale). A refresh, not a retry.
 */
function decisionErrorMessage(status: number, code: string | undefined): string {
  if (status === 409 && code === "already_decided") {
    return (
      "Another scholar is already approved for this story — a mention can only be credited " +
      "to one person. Remove their approval first, on that scholar's own edit page, then " +
      "approve this one."
    );
  }
  if (status === 409 && code === "not_pending") {
    return (
      "That mention has already been decided by someone else. Refresh the page to see where " +
      "it landed."
    );
  }
  return "We couldn't record that decision. Please try again.";
}

/** The scholar identity block a reviewer weighs: name, title, department, and the
 *  match likelihood + basis for a name-detected candidate. `decidedNote` rides on
 *  the secondary line (Approved tab only — see the call site). */
function Candidate({ row, decidedNote }: { row: NewsQueueRow; decidedNote?: string | null }) {
  const basis = row.matchBasis ? BASIS_LABEL[row.matchBasis] : undefined;
  return (
    <div className="min-w-0">
      <p className="text-[14px] font-medium">
        {row.slug ? (
          <a
            href={`/${row.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate underline-offset-4 hover:underline"
          >
            {row.scholarName}
          </a>
        ) : (
          row.scholarName
        )}
        {/* ponytail: badge the VIVO rows only. A NAME row already announces itself
            with its likelihood label, and only the history tabs mix the two —
            pending is name-only, so a "NAME" badge there would be pure noise. */}
        {row.source === "VIVO" ? (
          <span
            className="text-muted-foreground border-border ml-2 rounded-sm border px-1 py-px text-[10px] font-semibold tracking-wider uppercase"
            title="Linked by VIVO cwid — published automatically, never queued"
          >
            VIVO
          </span>
        ) : row.likelihood ? (
          <span
            className={`ml-2 rounded-sm border px-1 py-px text-[10px] font-semibold tracking-wider uppercase ${
              LIKELIHOOD_BADGE_CLASS[row.likelihood] ?? "text-muted-foreground border-transparent"
            }`}
            data-testid={`news-queue-likelihood-${row.likelihood}`}
          >
            {row.likelihood}
          </span>
        ) : null}
        {/* The basis rides beside the likelihood rather than replacing it: the
            score drives the sort, the basis explains it. Absent on VIVO rows and
            on NAME rows matched before #2578, where it is simply unknown. */}
        {row.source !== "VIVO" && basis ? (
          <span
            className="text-muted-foreground border-border ml-2 rounded-sm border px-1 py-px text-[10px] font-medium"
            title={basis.hint}
            data-testid={`news-queue-basis-${row.matchBasis}`}
          >
            {basis.text}
          </span>
        ) : null}
      </p>
      <p className="text-muted-foreground text-xs">
        {[row.title, row.department, row.roleLabel].filter(Boolean).join(" · ") || "—"}
        {decidedNote ? ` · ${decidedNote}` : ""}
      </p>
      {/* Name-in-context snippet (#2578 follow-up) — the raw article text around
          the matched name, so a reviewer can judge a candidate (e.g. an
          endowed-chair false positive like the O. Wayne Isom case the basis
          hint above describes) without opening the article. Rendered as plain
          text, never dangerouslySetInnerHTML: this is scraped article prose,
          not markup this page should ever interpret — the matched name is
          emphasised by slicing the string into React nodes, not by injecting
          markup into it. Visually secondary —
          smaller and lighter than the title/department line above — and only
          present for a NAME row with a prose position (BODY/TITLE basis). */}
      {row.contextSnippet ? (
        <p className="text-muted-foreground/80 mt-1 text-[11px] italic">
          “{highlightName(row.contextSnippet, row.contextSnippetMatches)}”
        </p>
      ) : null}
    </div>
  );
}

export function NewsQueue({
  pending,
  approved,
  rejected,
  counts,
}: {
  pending: NewsQueueGroup[];
  approved: NewsQueueGroup[];
  rejected: NewsQueueGroup[];
  /** TRUE totals from the DB. The history props are capped at
   *  NEWS_HISTORY_LIMIT, so they cannot be counted for a header. */
  counts: NewsQueueCounts;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("pending");
  // The transition flag is deliberately unbound — see `busy` below for why it
  // cannot gate the buttons.
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<NewsQueueSort>("certainty");
  const [nameQuery, setNameQuery] = useState("");

  async function decide(id: string, decision: "approve" | "reject") {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch("/api/edit/news-mention/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) {
        // The 409s are the whole reason for reading the body: see
        // decisionErrorMessage. `.catch` because a 500 can arrive as non-JSON.
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(decisionErrorMessage(res.status, data?.error));
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't record that decision. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Flip one APPROVED mention's `showOnProfile`.
   *
   * A second helper rather than a branch inside `decide()`: different route,
   * different body ({ action } not { decision }), and a different question —
   * `status` is the correctness judgement, `showOnProfile` the editorial one. The
   * busy/refresh/error mechanics are deliberately identical so a row behaves the
   * same wherever the reviewer clicks.
   */
  async function setVisibility(id: string, action: "hide" | "show") {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch("/api/edit/news-mention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        setError("We couldn't update this mention. Please try again.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't update this mention. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  /** Reject every candidate in a group ("None of these"). Sequential on purpose:
   *  small groups, and it keeps the per-row refreshes ordered. */
  async function rejectGroup(rows: NewsQueueRow[]) {
    for (const r of rows) {
      await decide(r.id, "reject");
    }
  }

  /**
   * How many PENDING rows share each `sourceRef` — the exact set the decision
   * route rejects when a competing candidate is approved
   * (`where: { sourceRef, status: "pending" }`).
   *
   * Keyed off the `pending` prop rather than the rendered tab's groups, because
   * the Rejected tab needs to warn about siblings that are NOT on it.
   */
  const pendingBySourceRef = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of pending) {
      for (const r of g.rows) {
        if (!r.sourceRef) continue;
        counts.set(r.sourceRef, (counts.get(r.sourceRef) ?? 0) + 1);
      }
    }
    return counts;
  }, [pending]);

  const tabGroups = tab === "pending" ? pending : tab === "approved" ? approved : rejected;

  /**
   * Pending's sort + name filter run ENTIRELY IN THE CLIENT, on groups already in
   * this component's props. That is not a shortcut — `loadNewsQueue` leaves
   * Pending deliberately unbounded (only the history tabs take
   * NEWS_HISTORY_LIMIT), so every pending row is already here and narrowing it
   * costs zero requests and can never show a partial view. Do NOT "improve" this
   * into a server round-trip: a paged Pending would make the filter lie, because
   * it could only search the page you happen to be on.
   */
  const query = nameQuery.trim().toLowerCase();
  const filtering = tab === "pending" && query.length > 0;
  const groups =
    tab === "pending"
      ? sortNewsQueueGroups(
          filtering
            ? // Keep a group when ANY candidate matches: on a contested group the
              // reviewer searched for one name but must still see its rivals to
              // pick between them.
              tabGroups.filter((g) =>
                g.rows.some(
                  (r) =>
                    r.scholarName.toLowerCase().includes(query) ||
                    (r.detectedName ?? "").toLowerCase().includes(query),
                ),
              )
            : tabGroups,
          sort,
        )
      : tabGroups;

  const countRows = (gs: NewsQueueGroup[]) => gs.reduce((n, g) => n + g.rows.length, 0);
  // Mentions, not groups — the page heading above counts mentions ("1,371 name-
  // matched mentions awaiting confirmation"), and two numbers counting different
  // things is worse than no number at all.
  const shownCount = countRows(groups);
  const pendingCount = countRows(pending);
  // TRUE totals, not `countRows(approved)`. The history tabs are capped at
  // NEWS_HISTORY_LIMIT (500), so once published mentions pass that — the expected
  // steady state — deriving these from the prop would report a fabricated total
  // and, worse, undercount the HIDDEN rows, which is the number a steward
  // auditing suppressed mentions actually acts on. Counted at the DB and passed
  // in; see loadNewsQueueCounts.
  const approvedCount = counts.approved;
  const approvedHidden = counts.approvedHidden;

  // `busyId` alone, NOT `pendingTx && busyId === id`. The transition flag is set
  // in the same batched tick the `finally` clears `busyId`, so the conjunction was
  // never true and no button ever disabled — a double-click on Hide fired two
  // POSTs and wrote two audit rows for one change. `busyId` is cleared only after
  // the request settles, which is the window that actually needs guarding.
  const busy = (id: string) => busyId === id;
  // The history tabs are capped at the loader. Say so rather than letting a
  // truncated list read as the complete record.
  const truncated =
    tab !== "pending" &&
    groups.reduce((n, g) => n + g.rows.length, 0) >= NEWS_HISTORY_LIMIT;

  return (
    <div data-slot="news-queue">
      <div className="border-border mb-4 flex gap-4 border-b" role="tablist">
        {(["pending", "approved", "rejected"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "border-apollo-maroon -mb-px border-b-2 py-2 text-sm font-medium capitalize"
                : "text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent py-2 text-sm capitalize"
            }
            data-testid={`news-queue-tab-${t}`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-destructive mb-3 text-sm" role="alert">
          {error}
        </p>
      )}

      {/* Pending-only controls. Both are labelled with a real <label htmlFor>, and
          both are native elements: a <select> and an <input type="search"> are
          already keyboard- and screen-reader-operable, and this queue is worked
          all day by two people — a custom listbox would be a regression. */}
      {tab === "pending" && (
        <div className="mb-4 flex flex-wrap items-end gap-3" data-testid="news-queue-controls">
          <div className="flex flex-col gap-1">
            <label htmlFor="news-queue-sort" className="text-muted-foreground text-xs">
              Sort by
            </label>
            <select
              id="news-queue-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as NewsQueueSort)}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              data-testid="news-queue-sort"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="news-queue-name" className="text-muted-foreground text-xs">
              Filter by name
            </label>
            <input
              id="news-queue-name"
              type="search"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="scholar or detected name"
              className="border-input bg-background h-9 w-64 rounded-md border px-3 text-sm"
              data-testid="news-queue-name-filter"
            />
          </div>
        </div>
      )}

      {/* How much of Pending is on screen. Mounted for the whole tab (not only
          while filtering) so the live region exists BEFORE its text changes —
          a region that appears at the same moment as its content is announced
          unreliably. Silent and sr-only when nothing is filtered out. */}
      {tab === "pending" && (
        <p
          role="status"
          aria-live="polite"
          className={filtering ? "text-muted-foreground mb-3 text-sm" : "sr-only"}
          data-testid="news-queue-filter-count"
        >
          {filtering
            ? `Showing ${shownCount.toLocaleString()} of ` +
              `${pendingCount.toLocaleString()} pending mentions.`
            : ""}
        </p>
      )}

      {/* Both halves of the Approved tab. "Approved" and "on a profile" are not
          the same thing (status vs showOnProfile), so a lone approved count would
          overstate what the public actually sees. */}
      {tab === "approved" && (
        <p className="text-muted-foreground mb-3 text-sm" data-testid="news-queue-approved-counts">
          {approvedCount.toLocaleString()} approved · {approvedHidden.toLocaleString()} hidden
        </p>
      )}

      {truncated && (
        <p className="text-muted-foreground mb-3 text-sm">
          Showing the {NEWS_HISTORY_LIMIT} most recent — older mentions are not listed here, but
          still show on their profiles.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filtering ? "No pending mentions match that name." : "Nothing here."}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {groups.map((g) => (
            <li
              key={g.key}
              className="border-apollo-border bg-apollo-surface rounded-md border p-4"
              data-testid={`news-queue-group-${g.key}`}
            >
              {/* The article + the prose name that was matched against it. */}
              <div className="mb-3">
                <a
                  href={g.rows[0].articleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[15px] font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                >
                  {g.rows[0].articleTitle}
                </a>
                <p className="text-muted-foreground text-xs">
                  {formatDate(g.rows[0].publishedAt)}
                  {g.detectedName ? ` · detected name: “${g.detectedName}”` : ""}
                  {g.contested ? " · more than one scholar matches — pick one" : ""}
                </p>
              </div>

              <ul className="divide-apollo-border divide-y">
                {g.rows.map((row) => {
                  // Who last touched this row, shown on Approved only. NOT
                  // decoration: `showOnProfile` is settable by the SCHOLAR from
                  // their own /edit news card, so a steward flipping it here is
                  // overriding someone's decision about their own profile.
                  //
                  // Deliberately NEUTRAL wording. `entered_by_cwid` is "the last
                  // human who touched this row", not "who chose to show it" —
                  // approving a pending match sets it without touching
                  // `showOnProfile` at all, so "shown by X" would caption every
                  // approved row with an editorial decision X never made, and
                  // bury the genuine override in noise. The Hidden pill carries
                  // the state; this line carries only the attribution.
                  const decidedNote =
                    tab === "approved" && row.decidedByName
                      ? `last updated by ${row.decidedByName}`
                      : null;
                  // Rows this approval will ACTUALLY reject.
                  //
                  // NOT `row.competingCwids`. That is built per-status by
                  // `loadNewsQueue`, so on the Rejected tab it counts siblings
                  // that are ALREADY rejected — which the route skips, because
                  // its sweep is `where: { sourceRef, status: "pending" }` — and
                  // it counts ZERO pending siblings, because pending rows are in
                  // a different load entirely. It was therefore wrong in BOTH
                  // directions: it overstated a wholesale-rejected group (warning
                  // about rows nothing will touch) and, worse, it silently
                  // understated the one case that matters — a rejected row whose
                  // contested sibling is still pending rendered a bare "Approve"
                  // and then killed that sibling with no warning at all.
                  //
                  // The pending groups are already a prop, so count the true
                  // blast radius from the same predicate the route uses.
                  const competing = row.sourceRef
                    ? (pendingBySourceRef.get(row.sourceRef) ?? 0)
                    : 0;
                  // Built as ONE string, not JSX text plus a plural expression:
                  // JSX joins those across a line break with a space, which would
                  // render "candidate s".
                  const blastNote =
                    `Rejects ${competing} other candidate${competing === 1 ? "" : "s"} ` +
                    `matched to this name.`;
                  return (
                    <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                      <Candidate row={row} decidedNote={decidedNote} />
                      {tab === "pending" ? (
                        <div className="flex flex-none gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy(row.id)}
                            onClick={() => decide(row.id, "approve")}
                          >
                            {g.contested ? "This is the one" : "Approve"}
                          </Button>
                          {!g.contested ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy(row.id)}
                              onClick={() => decide(row.id, "reject")}
                            >
                              Reject
                            </Button>
                          ) : null}
                        </div>
                      ) : null}

                      {tab === "approved" ? (
                        <div className="flex flex-none items-center gap-2">
                          {/* Colourless on purpose. Green and amber and red are
                              already spoken for on this surface by the likelihood
                              tiers (LIKELIHOOD_BADGE_CLASS), and the house colour
                              language forbids one colour carrying two meanings on
                              one surface. "Hidden" is an editorial choice, not a
                              warning — the fill and the word carry it. */}
                          <span
                            className={`${VISIBILITY_PILL} ${
                              row.showOnProfile
                                ? "text-muted-foreground border-border"
                                : "text-foreground border-border bg-muted"
                            }`}
                            data-testid={`news-queue-visibility-${row.id}`}
                          >
                            {row.showOnProfile ? "On profile" : "Hidden"}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy(row.id)}
                            // Per-row label: five identical "Hide" buttons in a
                            // tab list are indistinguishable to a screen reader.
                            aria-label={
                              `${row.showOnProfile ? "Hide" : "Show"} “${row.articleTitle}” ` +
                              `on ${row.scholarName}'s profile`
                            }
                            onClick={() =>
                              setVisibility(row.id, row.showOnProfile ? "hide" : "show")
                            }
                          >
                            {row.showOnProfile ? "Hide" : "Show"}
                          </Button>
                        </div>
                      ) : null}

                      {tab === "rejected" ? (
                        <div className="flex flex-none flex-col items-end gap-1">
                          {/* A scholar's own "Not me" is a disavowal of an
                              article about themselves, not a comms triage call.
                              Approving it here republishes it to their profile
                              with no notice to them, so the reviewer is told
                              whose decision they would be reversing. */}
                          {row.declinedByScholar ? (
                            <p
                              className="max-w-[15rem] text-right text-[11px] font-medium
                                text-amber-700 dark:text-amber-500"
                              data-testid={`news-queue-declined-${row.id}`}
                            >
                              The scholar declined this mention themselves.
                            </p>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy(row.id)}
                            // The consequence is described BEFORE activation, not
                            // in a confirm() — this codebase uses none, and a
                            // browser modal blocks the page. aria-describedby is
                            // what makes the warning reach a screen reader too.
                            aria-describedby={competing > 0 ? `news-blast-${row.id}` : undefined}
                            onClick={() => decide(row.id, "approve")}
                          >
                            Approve
                          </Button>
                          {competing > 0 ? (
                            <p
                              id={`news-blast-${row.id}`}
                              className="text-muted-foreground max-w-[15rem] text-right text-[11px]"
                              data-testid={`news-queue-blast-${row.id}`}
                            >
                              {blastNote}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {tab === "pending" && g.contested ? (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={g.rows.some((r) => busy(r.id))}
                    onClick={() => rejectGroup(g.rows)}
                  >
                    None of these
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
