/**
 * The "News mentions" attribute panel — the scholar's own curation of the WCM
 * Research news articles that mention them (scraped by etl/news; attached by the
 * VIVO cwid link or a comms-queue-confirmed prose name match).
 *
 * Unlike the read-only CTL technologies mirror, this is interactive: each row
 * can be hidden from the public profile (showOnProfile) or marked "Not me" to
 * remove a wrong attribution (status → rejected). Both POST /api/edit/news-mention,
 * which re-enforces `authorizeOverviewWrite`, so an unauthorized write 403s.
 * Approving a PENDING name-match is NOT here — that is the comms /edit/news-queue.
 *
 * Rendered only when the loader populated `ctx.news` (NEWS_MENTIONS_SECTION on AND
 * the scholar has ≥1 published mention), so an empty panel is never reached.
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { EditPanel } from "@/components/edit/edit-panel";
import type { EditContextNews } from "@/lib/api/edit-context";

export type NewsEditCardProps = {
  /** Accepted for call-site parity with the other cards; the route derives the
   *  owner from the row, so it is not needed here. */
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  news: ReadonlyArray<EditContextNews>;
};

/** ISO YYYY-MM-DD → "July 16, 2026" in UTC (deterministic). */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function NewsEditCard({ mode, scholarName, news }: NewsEditCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const who = mode === "superuser" ? scholarName : "you";

  async function act(id: string, action: "hide" | "show" | "reject") {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch("/api/edit/news-mention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      if (!res.ok) {
        setError("We couldn't update this mention. Please try again.");
        return;
      }
      // The /edit page is force-dynamic; a refresh re-reads the mention state.
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't update this mention. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <EditPanel
      slot="news-panel"
      heading="News mentions"
      description={`WCM Research news articles that mention ${who}, scraped from the newsroom. Hide one you'd rather not show on the profile, or use "Not me" to remove a wrong attribution.`}
    >
      {news.length === 0 ? (
        <p className="text-muted-foreground text-sm">No news mentions on file.</p>
      ) : (
        <ul className="divide-apollo-border divide-y" data-slot="news-list">
          {news.map((n) => {
            const date = formatDate(n.publishedAt);
            const busy = pending && busyId === n.id;
            return (
              <li
                key={n.id}
                className="flex items-start justify-between gap-3 py-3"
                data-testid={`news-row-${n.id}`}
              >
                <div className="min-w-0">
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[14px] font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                  >
                    {n.title}
                  </a>
                  <p className="text-muted-foreground text-xs">
                    {date ?? "Undated"}
                    {!n.showOnProfile ? " · Hidden from profile" : ""}
                  </p>
                </div>
                <div className="flex flex-none gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(n.id, n.showOnProfile ? "hide" : "show")}
                  >
                    {n.showOnProfile ? "Hide" : "Show"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(n.id, "reject")}
                    title="This article isn't about me — remove it"
                  >
                    Not me
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </EditPanel>
  );
}
