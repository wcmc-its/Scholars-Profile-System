/** Server loader for the CTSC "Feed CWID issues" card (etl/ctsc-roster). */
import { db } from "@/lib/db";
import { CtscFeedIssuesCard } from "@/components/edit/ctsc-feed-issues-card";

export async function CtscFeedIssuesPanel() {
  const rows = await db.read.ctscFeedIssue.findMany({ orderBy: [{ reason: "asc" }, { name: "asc" }] });
  const syncedAt = rows.reduce<Date | null>((m, r) => (m && m > r.syncedAt ? m : r.syncedAt), null);
  return (
    <CtscFeedIssuesCard
      issues={rows.map(({ syncedAt: _s, ...r }) => r)}
      syncedAt={syncedAt ? syncedAt.toISOString().slice(0, 10) : null}
    />
  );
}
