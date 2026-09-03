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
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { NEWS_HISTORY_LIMIT } from "@/lib/edit/news-queue";
import type { NewsQueueGroup, NewsQueueRow } from "@/lib/edit/news-queue";

type Tab = "pending" | "approved" | "rejected";

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

/** The scholar identity block a reviewer weighs: name, title, department, and the
 *  match likelihood + basis for a name-detected candidate. */
function Candidate({ row }: { row: NewsQueueRow }) {
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
      </p>
      {/* Name-in-context snippet (#2578 follow-up) — the raw article text around
          the matched name, so a reviewer can judge a candidate (e.g. an
          endowed-chair false positive like the O. Wayne Isom case the basis
          hint above describes) without opening the article. Rendered as plain
          text, never dangerouslySetInnerHTML: this is scraped article prose,
          not markup this page should ever interpret. Visually secondary —
          smaller and lighter than the title/department line above — and only
          present for a NAME row with a prose position (BODY/TITLE basis). */}
      {row.contextSnippet ? (
        <p className="text-muted-foreground/80 mt-1 text-[11px] italic">“{row.contextSnippet}”</p>
      ) : null}
    </div>
  );
}

export function NewsQueue({
  pending,
  approved,
  rejected,
}: {
  pending: NewsQueueGroup[];
  approved: NewsQueueGroup[];
  rejected: NewsQueueGroup[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("pending");
  const [pendingTx, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError("We couldn't record that decision. Please try again.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't record that decision. Please try again.");
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

  const groups = tab === "pending" ? pending : tab === "approved" ? approved : rejected;
  const busy = (id: string) => pendingTx && busyId === id;
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

      {truncated && (
        <p className="text-muted-foreground mb-3 text-sm">
          Showing the {NEWS_HISTORY_LIMIT} most recent — older mentions are not listed here, but
          still show on their profiles.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing here.</p>
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
                {g.rows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                    <Candidate row={row} />
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
                  </li>
                ))}
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
