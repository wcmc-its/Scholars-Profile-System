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

/** The scholar identity block a reviewer weighs: name, title, department, and the
 *  match likelihood for a name-detected candidate. */
function Candidate({ row }: { row: NewsQueueRow }) {
  return (
    <div className="min-w-0">
      <p className="text-[14px] font-medium">
        {row.slug ? (
          <a
            href={`/${row.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
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
          <span className="text-muted-foreground ml-2 text-[10px] font-semibold tracking-wider uppercase">
            {row.likelihood}
          </span>
        ) : null}
      </p>
      <p className="text-muted-foreground text-xs">
        {[row.title, row.department, row.roleLabel].filter(Boolean).join(" · ") || "—"}
      </p>
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

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {groups.map((g) => (
            <li
              key={g.key}
              className="border-border rounded-md border p-4"
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
