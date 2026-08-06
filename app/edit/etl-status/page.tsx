/**
 * `/edit/etl-status` — the state of every automatic data import, in language a
 * non-technical superuser can act on. Read-only; nothing on this page writes.
 *
 * Superuser-only, re-checked on every GET and never cached — the page is ABOUT
 * freshness, so serving a cached copy would be self-defeating. No feature flag:
 * the superuser gate IS the control, exactly as on `/edit/activity`.
 *
 * Fails soft. If `etl_run` is unreadable the loader throws and we render an
 * honest "unavailable" notice rather than 500ing (the /edit/activity pattern).
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type EtlSourceRow,
  type EtlSourceState,
  type EtlStatusSummary,
  loadEtlStatus,
} from "@/lib/api/etl-status";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import type { Cadence } from "@/lib/etl/freshness-policy";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ETL status — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** Stored UTC instant -> WCM-local Eastern (DST-aware), server-rendered. */
function formatTs(d: Date | null): string {
  if (d === null || Number.isNaN(d.getTime())) return "—";
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

/** "3 hours ago" / "12 days ago" — no decimals, no units a reader has to convert. */
function formatAge(ageHours: number | null): string {
  if (ageHours === null) return "never";
  if (ageHours < 1) return "less than an hour ago";
  if (ageHours < 48) {
    const h = Math.round(ageHours);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(ageHours / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** How long this import may go quiet before it counts as late, spelled out. */
function expectedEvery(slaHours: number): string {
  if (slaHours < 48) return `${slaHours} hours`;
  const d = Math.round(slaHours / 24);
  return `${d} days`;
}

const CADENCE_LABEL: Record<Cadence, string> = {
  nightly: "Every night",
  weekly: "Every week",
  monthly: "Every month",
  annual: "Once a year",
};

/**
 * One label + pill per state. "Known issue" is slate, not green and not red:
 * it is a staleness somebody has already looked at and accepted until a date,
 * and colouring it either way is how a status board starts lying.
 */
const STATE_STYLE: Record<EtlSourceState, { label: string; className: string }> = {
  "up-to-date": {
    label: "Up to date",
    className: "border-emerald-300 bg-emerald-50 text-emerald-700",
  },
  late: { label: "Late", className: "border-amber-300 bg-amber-50 text-amber-700" },
  failed: { label: "Failed", className: "border-red-300 bg-red-50 text-red-700" },
  stopped: {
    label: "Stopped unexpectedly",
    className: "border-red-300 bg-red-50 text-red-700",
  },
  "never-ran": { label: "Never ran", className: "border-red-300 bg-red-50 text-red-700" },
  "known-issue": {
    label: "Known issue",
    className: "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate",
  },
};

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

function StatePill({ state }: { state: EtlSourceState }) {
  const { label, className } = STATE_STYLE[state];
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}
      data-testid="etl-status-pill"
    >
      {label}
    </span>
  );
}

/** What a superuser should read, and where to look next, for one row. */
function Explanation({ row, timeoutHours }: { row: EtlSourceRow; timeoutHours: number }) {
  const expired =
    row.ackExpired && row.ack !== undefined ? (
      <p className="text-muted-foreground mt-1">
        This was accepted as a known issue until {row.ack.until}. That date has passed, so it counts
        against us again.
      </p>
    ) : null;

  if (row.state === "never-ran") {
    return (
      <>
        <p>
          Nothing has ever been recorded for this import. Either it stopped before it got this far,
          or it is not switched on here.
        </p>
        {expired}
      </>
    );
  }

  if (row.state === "failed") {
    return (
      <>
        <p>
          The last attempt failed on{" "}
          <span className="whitespace-nowrap">
            {formatTs(row.lastAttemptEndedAt ?? row.lastAttemptStartedAt)}
          </span>
          .
        </p>
        {row.errorMessage && (
          <p className="text-muted-foreground mt-1 break-words whitespace-pre-wrap">
            {row.errorMessage}
          </p>
        )}
        {expired}
      </>
    );
  }

  if (row.state === "stopped") {
    return (
      <>
        <p>
          Started <span className="whitespace-nowrap">{formatTs(row.lastAttemptStartedAt)}</span>{" "}
          and never reported back. Nothing runs longer than {timeoutHours} hours, so this one is
          gone rather than still working.
        </p>
        {expired}
      </>
    );
  }

  if (row.state === "known-issue") {
    return (
      <>
        <p>
          Out of date, already looked at, and accepted until{" "}
          <span className="whitespace-nowrap">{row.ack?.until}</span>.
        </p>
        {row.ack && <p className="text-muted-foreground mt-1 break-words">{row.ack.reason}</p>}
      </>
    );
  }

  if (row.state === "late") {
    return (
      <>
        <p>Expected fresh data at least every {expectedEvery(row.slaHours)}.</p>
        {expired}
      </>
    );
  }

  return expired ?? <span className="text-muted-foreground">—</span>;
}

function StatusBody({ summary }: { summary: EtlStatusSummary }) {
  const total = summary.sources.length;
  return (
    <>
      <p className="text-muted-foreground mt-2">
        Every automatic data import that keeps profiles current, and where each one stands as of{" "}
        <span className="whitespace-nowrap">{formatTs(summary.checkedAt)}</span>. Read-only —
        nothing here can be restarted from this page.
      </p>
      <p className="mt-2" data-testid="etl-status-headline">
        {summary.needsAttention === 0 ? (
          <>All {total} imports are current or already accounted for.</>
        ) : (
          <>
            <strong>{summary.needsAttention}</strong> of {total} imports need attention.
          </>
        )}
      </p>

      <div className="border-apollo-border bg-apollo-surface mt-6 overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="etl-status-table">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Data import</th>
              <th className={thClass}>How often</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Last good data</th>
              <th className={thClass}>What this means</th>
            </tr>
          </thead>
          <tbody>
            {summary.sources.map((row) => (
              <tr
                key={row.source}
                className="border-apollo-border border-b align-top"
                data-testid={`etl-status-row-${row.source}`}
                data-state={row.state}
              >
                <td className={`${tdClass} font-medium`}>{row.source}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{CADENCE_LABEL[row.cadence]}</td>
                <td className={tdClass}>
                  <StatePill state={row.state} />
                </td>
                <td className={tdClass}>
                  <span className="whitespace-nowrap">{formatTs(row.lastSuccessAt)}</span>
                  <span className="text-muted-foreground block">{formatAge(row.ageHours)}</span>
                </td>
                <td className={`${tdClass} max-w-xl`}>
                  <Explanation row={row} timeoutHours={summary.runningTimeoutHours} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground mt-4 text-sm">
        &ldquo;Last good data&rdquo; is when the information itself was produced, which is not
        always when the import last ran: some imports check whether anything changed and finish
        without replacing anything. If a row needs attention, contact ITS Support with the name of
        the import and the time shown.
      </p>
    </>
  );
}

export default async function EtlStatusPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/etl-status");
  }
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "etl-status",
      path: "/edit/etl-status",
      reason: "not_superuser_get",
    });
    return <ForbiddenEditPage />;
  }

  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  let summary: EtlStatusSummary | null = null;
  let unavailable = false;
  try {
    summary = await loadEtlStatus(db.read);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "etl_status_read_failed",
        path: "/edit/etl-status",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <ConsoleShell
      active="etl-status"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="mb-1 text-xl font-semibold">ETL status</h1>
      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="etl-status-unavailable">
          Import status is temporarily unavailable. Please try again later or contact ITS Support if
          this persists.
        </p>
      ) : (
        <StatusBody summary={summary!} />
      )}
    </ConsoleShell>
  );
}
