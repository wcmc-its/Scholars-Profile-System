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
 * Discoverable via the admin sub-nav "Activity" tab (superuser-only, no separate
 * flag — the superuser gate is the control). Renders the standard console header
 * + AdminSubnav so it matches the other `/edit/*` admin surfaces.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type EditActivitySummary,
  type FieldChange,
  type RecentEdit,
  loadEditActivitySummary,
} from "@/lib/api/edit-activity";
import { labelForAction } from "@/lib/api/scholar-audit";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit activity — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** Above this length a value is collapsed behind a native `<details>` toggle. */
const VALUE_COLLAPSE_AT = 100;

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

/** The per-entity history page for an audited entity, or null if none exists.
 *  Only scholar + center have a history route today (the `.../history` pages). */
function historyHref(entityType: string, entityId: string): string | null {
  const id = encodeURIComponent(entityId);
  if (entityType === "scholar") return `/edit/scholar/${id}/history`;
  if (entityType === "center") return `/edit/center/${id}/history`;
  return null;
}

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

/** One value, collapsed behind a `<details>` disclosure when long (no JS). */
function Value({ v }: { v: string | null }) {
  if (v === null) return <span className="text-muted-foreground">∅</span>;
  if (v.length <= VALUE_COLLAPSE_AT) return <span className="break-words">{v}</span>;
  return (
    <details className="inline-block align-top">
      <summary className="text-apollo-slate cursor-pointer list-none">
        {v.slice(0, VALUE_COLLAPSE_AT)}…<span className="ml-1 underline">show</span>
      </summary>
      <span className="mt-1 block whitespace-pre-wrap break-words">{v}</span>
    </details>
  );
}

/** `before → after` for one changed field. */
function ChangeRow({ change }: { change: FieldChange }) {
  return (
    <li>
      <span className="font-medium">{change.field}</span>:{" "}
      <Value v={change.before} /> <span className="text-muted-foreground">→</span>{" "}
      <Value v={change.after} />
    </li>
  );
}

/** The Details cell: per-field before→after, else a compact detail, else a dash. */
function Details({ edit }: { edit: RecentEdit }) {
  if (edit.changes.length > 0) {
    return (
      <ul className="space-y-1">
        {edit.changes.map((c, i) => (
          <ChangeRow key={`${c.field}-${i}`} change={c} />
        ))}
      </ul>
    );
  }
  if (edit.detail) return <span className="text-muted-foreground">{edit.detail}</span>;
  return <span className="text-muted-foreground">—</span>;
}

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
      <div className="border-apollo-border bg-apollo-surface mt-2 overflow-x-auto rounded-md border">
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

function EntityCell({ edit }: { edit: RecentEdit }) {
  const href = historyHref(edit.entityType, edit.entityId);
  const inner = (
    <>
      {edit.entityType} <span className="text-muted-foreground">{edit.entityId}</span>
    </>
  );
  return href ? (
    <Link href={href} className="text-apollo-slate hover:underline">
      {inner}
    </Link>
  ) : (
    <span>{inner}</span>
  );
}

function ActivityBody({ summary }: { summary: EditActivitySummary }) {
  return (
    <>
      <p className="text-muted-foreground mt-2">
        Edits across all profile entities in the last {summary.windowDays} days —{" "}
        <strong>{summary.totalEdits.toLocaleString()}</strong> total. Read-only. Scholar and center
        entities link to their full history.
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
        <div className="border-apollo-border bg-apollo-surface mt-2 overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className={thClass}>When</th>
                <th className={thClass}>Actor</th>
                <th className={thClass}>Action</th>
                <th className={thClass}>Entity</th>
                <th className={thClass}>Details</th>
              </tr>
            </thead>
            <tbody>
              {summary.recent.length === 0 ? (
                <tr>
                  <td className={`${tdClass} text-muted-foreground`} colSpan={5}>
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
                      <EntityCell edit={e} />
                    </td>
                    <td className={`${tdClass} max-w-xl`}>
                      <Details edit={e} />
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

  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

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
    <div className="min-h-screen bg-apollo-page" data-slot="edit-activity-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
        </div>
      </header>

      <AdminSubnav
        active="activity"
        unitsTab={session.isSuperuser}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8" data-slot="edit-activity">
        <h1 className="mb-1 text-xl font-semibold">Edit activity</h1>
        {unavailable ? (
          <p className="text-muted-foreground mt-8" data-testid="edit-activity-unavailable">
            Edit activity is temporarily unavailable. Please try again later or contact ITS Support
            if this persists.
          </p>
        ) : (
          <ActivityBody summary={summary!} />
        )}
      </main>
    </div>
  );
}
