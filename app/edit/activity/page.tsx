/**
 * `/edit/activity` — the fleet-wide edit-activity view: edits/day, top editors,
 * most-edited entities, and recent activity across ALL profile entities over the
 * trailing 30 days. The read-only cross-entity companion to the per-entity
 * `/edit/scholar/[cwid]/history` and `/edit/center/[code]/history` surfaces.
 *
 * Superuser-only (this exposes every editor's activity across every unit — a
 * strictly-more-privileged view than the per-entity history, which any editor
 * of that entity can see). Re-checked on every GET, never cached. The audit
 * table lives in the separate `scholars_audit` DB; if the read role lacks SELECT
 * there the read throws and we render an honest "unavailable" notice rather than
 * 500ing (the scholar-history fail-soft pattern).
 *
 * ponytail: superuser-URL only, no per-tab flag and not wired into AdminSubnav —
 * add the tab (and its flag) if operators want it discoverable in the admin nav.
 */
import { redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { labelForAction } from "@/lib/api/scholar-audit";
import {
  type EditActivitySummary,
  loadEditActivitySummary,
} from "@/lib/api/edit-activity";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit activity — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** Stored UTC instant -> WCM-local Eastern (DST-aware), server-rendered. */
function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

function CountTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: [string, string, string?];
  rows: ReadonlyArray<[string, string, string?]>;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">{caption}</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              {headers.map((h) => (
                <th key={h} className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={`${tdClass} text-muted-foreground`} colSpan={headers.length}>
                  None in the last 30 days.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={`${r[0]}-${i}`} className="border-apollo-border border-b align-top">
                  <td className={tdClass}>{r[0]}</td>
                  <td className={tdClass}>{r[1]}</td>
                  {r[2] !== undefined && <td className={`${tdClass} whitespace-nowrap`}>{r[2]}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActivityBody({ summary }: { summary: EditActivitySummary }) {
  return (
    <>
      <p className="text-muted-foreground mt-2">
        Edits across all profile entities in the last {summary.windowDays} days —{" "}
        <strong>{summary.totalEdits.toLocaleString()}</strong> total. Read-only.
      </p>

      <CountTable
        caption="Edits per day"
        headers={["Day", "Edits"]}
        rows={summary.perDay.map((r) => [r.day, r.edits.toLocaleString()])}
      />
      <CountTable
        caption="Top editors"
        headers={["Actor", "Edits"]}
        rows={summary.topEditors.map((r) => [r.actorCwid, r.edits.toLocaleString()])}
      />
      <CountTable
        caption="Most-edited entities"
        headers={["Type", "Entity", "Edits"]}
        rows={summary.topEntities.map((r) => [r.entityType, r.entityId, r.edits.toLocaleString()])}
      />

      <section className="mt-8">
        <h2 className="text-base font-semibold">Recent activity</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className={thClass}>When</th>
                <th className={thClass}>Actor</th>
                <th className={thClass}>Action</th>
                <th className={thClass}>Entity</th>
              </tr>
            </thead>
            <tbody>
              {summary.recent.length === 0 ? (
                <tr>
                  <td className={`${tdClass} text-muted-foreground`} colSpan={4}>
                    No edits recorded in the last {summary.windowDays} days.
                  </td>
                </tr>
              ) : (
                summary.recent.map((e) => (
                  <tr
                    key={e.id}
                    className="border-apollo-border border-b align-top"
                    data-action={e.action}
                  >
                    <td className={`${tdClass} whitespace-nowrap`}>{formatTs(e.ts)}</td>
                    <td className={tdClass}>
                      {e.actorCwid}
                      {e.impersonatedCwid && (
                        <span className="text-muted-foreground"> (as {e.impersonatedCwid})</span>
                      )}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap`}>{labelForAction(e.action)}</td>
                    <td className={tdClass}>
                      {e.entityType} <span className="text-muted-foreground">{e.entityId}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default async function EditActivityPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/activity");
  }
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "activity",
      path: "/edit/activity",
      reason: "not_superuser_get",
    });
    return <ForbiddenEditPage />;
  }

  let summary: EditActivitySummary | null = null;
  let unavailable = false;
  try {
    summary = await loadEditActivitySummary(db.read);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "edit_activity_read_failed",
        path: "/edit/activity",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <main className="mx-auto w-full max-w-[var(--max-content)] px-6 py-10" data-slot="edit-activity">
      <h1 className="page-title">Edit activity</h1>
      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="edit-activity-unavailable">
          Edit activity is temporarily unavailable. Please try again later or contact ITS Support if
          this persists.
        </p>
      ) : (
        <ActivityBody summary={summary!} />
      )}
    </main>
  );
}
