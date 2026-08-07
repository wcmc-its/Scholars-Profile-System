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
 *
 * TRIAGE, not a list. On a normal day all but one of the tracked sources are
 * healthy, so a flat table of near-identical green rows buries the one row
 * somebody has to act on — and it printed raw `etl_run.source` keys at an
 * audience that has never heard of "COI-Gap" or "ReCiterAI-projection". The
 * page therefore leads with the rows that need reading and collapses the rest
 * behind a native `<details>` — no client component, no state, no JS: this stays
 * a server component, and the disclosure is the whole interaction.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type EtlSourceRow,
  type EtlSourceState,
  type EtlStatusSummary,
  loadEtlStatus,
  needsAttention,
} from "@/lib/api/etl-status";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { sourceDescription, sourceLabel } from "@/lib/edit/etl-source-copy";
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
 * One label + emoji + pill per state. "Known issue" is slate, not green and not
 * red: it is a staleness somebody has already looked at and accepted until a
 * date, and colouring it either way is how a status board starts lying.
 *
 * The emoji is a SECOND carrier of the same fact, never the only one — it is
 * `aria-hidden` and the worded pill beside it is what a screen reader (and
 * anyone whose font drops the glyph) actually gets.
 */
const STATE_STYLE: Record<EtlSourceState, { label: string; emoji: string; className: string }> = {
  "up-to-date": {
    label: "Up to date",
    emoji: "🟢",
    className: "border-emerald-300 bg-emerald-50 text-emerald-700",
  },
  late: { label: "Late", emoji: "🟠", className: "border-amber-300 bg-amber-50 text-amber-700" },
  failed: { label: "Failed", emoji: "🔴", className: "border-red-300 bg-red-50 text-red-700" },
  stopped: {
    label: "Stopped unexpectedly",
    emoji: "🔴",
    className: "border-red-300 bg-red-50 text-red-700",
  },
  "never-ran": {
    // 🔴 not ⚪: needsAttention() already treats never-ran like failed/stopped, and
    // the pill is red. A neutral dot on a red row makes the two carriers disagree.
    label: "Never ran",
    emoji: "🔴",
    className: "border-red-300 bg-red-50 text-red-700",
  },
  "known-issue": {
    label: "Known issue",
    emoji: "🟡",
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

/** Decoration. The pill next to it carries the meaning. */
function StateIcon({ state }: { state: EtlSourceState }) {
  return (
    <span aria-hidden="true" data-testid="etl-status-emoji">
      {STATE_STYLE[state].emoji}
    </span>
  );
}

/** Plain name first, raw `etl_run.source` key second — the key is what ITS greps. */
function SourceName({ source }: { source: string }) {
  const label = sourceLabel(source);
  return (
    <>
      <span className="font-medium">{label}</span>
      {label === source ? null : (
        <span
          className="text-muted-foreground ml-1.5 text-xs font-normal"
          data-testid="etl-status-source-key"
        >
          {source}
        </span>
      )}
    </>
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
    // A missing row outranks the acknowledgement — nothing on record is a real
    // gap, not an accepted staleness — but the ack still has to be SAID, or the
    // reader is sent chasing something somebody already decided to live with.
    const accepted =
      row.ackActive && row.ack !== undefined ? (
        <p className="text-muted-foreground mt-1">
          Somebody has already accepted this until {row.ack.until}: {row.ack.reason}
        </p>
      ) : null;
    return (
      <>
        <p>
          Nothing has ever been recorded for this import. Either it stopped before it got this far,
          or it is not switched on here.
        </p>
        {accepted}
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

/**
 * Which section a row belongs in.
 *
 * `needsAttention` is the EXISTING rule and is not re-derived here — it is what
 * the headline count and the heartbeat both mean by "wrong". It deliberately
 * says NO to a live acknowledgement, because an ack is precisely the decision
 * that nobody has to chase this today.
 *
 * A row an operator does not have to chase is still a row they have to READ:
 * the single acked source in prod (Spotlight) is the one line on this page that
 * is neither healthy nor actionable, and filing it into a collapsed list of 30
 * green rows is how it gets rediscovered from scratch every month. So the
 * attention SECTION is `needsAttention` OR a live ack — one row wider than the
 * count, never narrower. The counts stay untouched: an ack is shown, explained,
 * and still not counted as a failure.
 *
 * `ackActive` is only ever true on a source that is genuinely stale
 * (`gradeSource` sets it from `stale && ack active`), so a healthy source that
 * happens to carry an ack stays in the collapsed section where it belongs.
 */
function inAttentionSection(row: EtlSourceRow): boolean {
  return needsAttention(row) || row.ackActive;
}

/** One row that needs reading, with everything a reader needs in one block. */
function AttentionCard({ row, timeoutHours }: { row: EtlSourceRow; timeoutHours: number }) {
  const description = sourceDescription(row.source);
  return (
    <li
      className="border-apollo-border bg-apollo-surface rounded-md border p-3"
      data-testid={`etl-status-row-${row.source}`}
      data-state={row.state}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base">
          <StateIcon state={row.state} /> <SourceName source={row.source} />
        </h3>
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {CADENCE_LABEL[row.cadence]}
        </span>
      </div>
      {description === null ? null : (
        <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatePill state={row.state} />
        {row.lastSuccessAt === null ? null : (
          <span className="text-muted-foreground">
            Last good data: <span className="whitespace-nowrap">{formatTs(row.lastSuccessAt)}</span>{" "}
            ({formatAge(row.ageHours)})
          </span>
        )}
      </div>
      <div className="mt-1.5 text-sm">
        <Explanation row={row} timeoutHours={timeoutHours} />
      </div>
    </li>
  );
}

function StatusBody({ summary }: { summary: EtlStatusSummary }) {
  const total = summary.sources.length;
  const attention = summary.sources.filter(inAttentionSection);
  const normal = summary.sources.filter((row) => !inAttentionSection(row));
  // Shown above, not counted as a failure. See inAttentionSection.
  const accepted = attention.length - summary.needsAttention;
  // Everything in `normal` is up to date by construction, so the FRESHEST of them
  // is trivially fresh and says nothing. The OLDEST is the informative one: it is
  // the worst case in the healthy set, so "nothing here is staler than X" is a
  // real statement about whether the chain has converged.
  const oldestHealthy = normal.reduce<EtlSourceRow | null>(
    (worst, row) =>
      row.ageHours !== null && (worst === null || row.ageHours > (worst.ageHours ?? -Infinity))
        ? row
        : worst,
    null,
  );
  const oldestLine =
    oldestHealthy === null
      ? null
      : `Oldest: ${sourceLabel(oldestHealthy.source)}, ${formatAge(oldestHealthy.ageHours)}.`;
  return (
    <>
      <p className="text-muted-foreground mt-2">
        Every automatic data import that keeps profiles current, and where each one stands as of{" "}
        <span className="whitespace-nowrap">{formatTs(summary.checkedAt)}</span>. Read-only —
        nothing here can be restarted from this page.
      </p>

      <section className="mt-6" data-testid="etl-status-attention">
        <h2 className="text-base font-semibold">Needs attention ({attention.length})</h2>
        <p className="text-muted-foreground mt-1 text-sm" data-testid="etl-status-headline">
          {/*
            The <h2> count is SECTION MEMBERSHIP (failures + live acks); this line
            is the FAILURE count. They differ on the ordinary day — one acked row,
            nothing broken — so the reconciling clause must not be gated on there
            being a failure, or the page reads "Needs attention (1)" directly above
            "All 34 imports are current".
          */}
          {summary.needsAttention === 0 ? (
            accepted === 0 ? (
              <>All {total} imports are current or already accounted for.</>
            ) : (
              <>
                Nothing is failing. {accepted === 1 ? "One import is" : `${accepted} imports are`}{" "}
                listed here as already accepted.
              </>
            )
          ) : (
            <>
              <strong>{summary.needsAttention}</strong> of {total} imports need attention.
              {accepted > 0 ? (
                <>
                  {" "}
                  {accepted === 1 ? "One more is" : `${accepted} more are`} listed here as already
                  accepted.
                </>
              ) : null}
            </>
          )}
        </p>
        {attention.length === 0 ? null : (
          <ul className="mt-3 flex list-none flex-col gap-3 p-0">
            {attention.map((row) => (
              <AttentionCard
                key={row.source}
                row={row}
                timeoutHours={summary.runningTimeoutHours}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Native disclosure — no client component, no state. The two label spans
          swap on [open] through descendant selectors, which is how the rest of
          this codebase does it (components/search/funder-facet.tsx).

          OPEN by default. The split already does the triage work — problems are
          up top and read first — so shutting this as well hid the healthy detail
          behind a click for no gain, and put every raw `etl_run.source` key out
          of reach of browser find-in-page, which is the affordance ITS actually
          uses. Collapsing stays available; it is just not the default. */}
      <details
        open
        className="mt-8 [&:not([open])_.etl-hide]:hidden [&[open]_.etl-show]:hidden"
        data-testid="etl-status-normal"
      >
        <summary className="cursor-pointer">
          {/* A heading, not a styled span — <summary> permits heading content, and
              without it a screen reader navigating by heading finds only one of
              this page's two sections. */}
          <h2 className="inline text-base font-semibold">Running normally ({normal.length})</h2>
          <span className="text-apollo-slate ml-2 text-sm underline">
            <span className="etl-show">show</span>
            <span className="etl-hide">hide</span>
          </span>
          <span className="text-muted-foreground mt-1 block text-sm">
            {normal.length === 0 ? (
              <>Nothing else to report — every import is listed above.</>
            ) : (
              <>
                <StateIcon state="up-to-date" /> All {normal.length}
                {attention.length === 0 ? "" : " other"} imports are up to date.
                {oldestLine === null ? null : <> {oldestLine}</>}
              </>
            )}
          </span>
        </summary>

        <div className="border-apollo-border bg-apollo-surface mt-3 overflow-x-auto rounded-md border">
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
              {normal.map((row) => (
                <tr
                  key={row.source}
                  className="border-apollo-border border-b align-top"
                  data-testid={`etl-status-row-${row.source}`}
                  data-state={row.state}
                >
                  <td className={tdClass}>
                    <SourceName source={row.source} />
                    {/* The descriptions are the point of the rename; showing them only
                        on attention cards means 33 of 34 imports never explain
                        themselves on an ordinary day. */}
                    {sourceDescription(row.source) === null ? null : (
                      <span
                        className="text-muted-foreground mt-0.5 block text-xs font-normal"
                        data-testid="etl-status-description"
                      >
                        {sourceDescription(row.source)}
                      </span>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>{CADENCE_LABEL[row.cadence]}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    <StateIcon state={row.state} /> <StatePill state={row.state} />
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
      </details>

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

  let pendingSlugRequests: number | null = null;
  let pendingHonors: number | null = null;
  let summary: EtlStatusSummary | null = null;
  let unavailable = false;
  // The two tab-badge counts read the SAME database as etl_run, so they need their
  // own fail-soft boundary: left unguarded, a DB outage 500s the one page an
  // operator opens precisely when the database is unhappy. They get a SEPARATE
  // try from the board on purpose — a badge is decoration, and losing it must not
  // blank the status table when etl_run itself reads fine.
  try {
    pendingSlugRequests = isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
    pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "etl_status_badge_count_failed",
        path: "/edit/etl-status",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

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
