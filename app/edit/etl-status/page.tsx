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
 * TRIAGE, not a list. On a normal day all but one or two of the tracked sources
 * are healthy, so a flat table of near-identical green rows buries the one row
 * somebody has to act on. The page therefore leads with a one-glance summary
 * bar, then the rows that need reading as cards, then the healthy rest grouped
 * by cadence (`./running-normally.tsx`, the page's only client island — it owns
 * the filter, the External/Internal switch and hide/show, nothing else).
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
import {
  type EtlSourceOrigin,
  sourceDescription,
  sourceLabel,
  sourceOrigin,
} from "@/lib/edit/etl-source-copy";
import type { Cadence } from "@/lib/etl/freshness-policy";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { cn } from "@/lib/utils";

import {
  type NormalGroupKey,
  type NormalRow,
  type NormalSortDir,
  type NormalSortKey,
  RunningNormally,
} from "./running-normally";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ETL status — Scholars Console",
  robots: { index: false, follow: false },
};

const TZ = "America/New_York";

function parts(d: Date, opts: Intl.DateTimeFormatOptions): (t: string) => string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).formatToParts(d);
  return (t: string) => p.find((x) => x.type === t)?.value ?? "";
}

/** "Sep 25, 2026 12:57 EDT" — the page's as-of stamp. */
function formatStamp(d: Date): string {
  const get = parts(d, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return `${get("month")} ${get("day")}, ${get("year")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/**
 * "Sep 25, 03:26" — WCM-local Eastern (DST-aware). The year is added only when
 * it differs from the page's as-of year, so a yearly import last fed in
 * December still reads unambiguously in January.
 */
function formatShort(d: Date | null, now: Date): string {
  if (d === null || Number.isNaN(d.getTime())) return "—";
  const get = parts(d, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const year = get("year");
  const sameYear = year === parts(now, { year: "numeric" })("year");
  return `${get("month")} ${get("day")}${sameYear ? "" : `, ${year}`}, ${get("hour")}:${get("minute")}`;
}

/** An ack's ISO `until` date as "Sep 30" (or "Sep 30, 2027" in another year). */
function formatUntil(until: string, now: Date): string {
  const d = new Date(`${until}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return until;
  const get = parts(d, { year: "numeric", month: "short", day: "numeric" });
  const sameYear = get("year") === parts(now, { year: "numeric" })("year");
  return `${get("month")} ${get("day")}${sameYear ? "" : `, ${get("year")}`}`;
}

/** "3 hours ago" / "12 days ago" — no decimals, no units a reader has to convert. */
function formatAge(ageHours: number | null): string {
  if (ageHours === null) return "never";
  if (ageHours < 1) return "under an hour ago";
  if (ageHours < 48) {
    const h = Math.round(ageHours);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(ageHours / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * How long the newest attempt took, start to finish — `null` when there is no
 * measurement.
 *
 * The sub-second floor is not cosmetic. Ten sources used to write a single
 * terminal `etl_run` row, leaving `startedAt` to `@default(now())` so it landed
 * on the same instant as `completedAt` — start and finish indistinguishable.
 * Those writers now record a real start, but the board reads the LATEST row, so
 * every one of them keeps serving a legacy zero until it next runs (up to a
 * month for the monthly ones). "—" is the honest answer for those; printing
 * "0 sec" would claim a measurement nobody took.
 */
function durationMs(startedAt: Date | null, endedAt: Date | null): number | null {
  if (startedAt === null || Number.isNaN(startedAt.getTime())) return null;
  if (endedAt === null || Number.isNaN(endedAt.getTime())) return null;
  const ms = endedAt.getTime() - startedAt.getTime();
  return ms < 1000 ? null : ms;
}

function formatDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (startedAt !== null && !Number.isNaN(startedAt.getTime()) && endedAt === null) {
    return "still running";
  }
  const ms = durationMs(startedAt, endedAt);
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** How long this import may go quiet before it counts as late, spelled out. */
function expectedEvery(slaHours: number): string {
  if (slaHours < 48) return `${slaHours} hours`;
  const d = Math.round(slaHours / 24);
  return `${d} days`;
}

const CADENCE_LABEL: Record<Cadence, string> = {
  nightly: "Every night",
  // Reads the same to a superuser ON PURPOSE: the job really does run nightly,
  // and the distinction from `nightly` is only about how long we wait before
  // calling it late (it is mirrored from a system whose run lands after ours).
  // That is a policy detail, not something to make somebody decode in a column.
  "nightly-mirrored": "Every night",
  weekly: "Every week",
  monthly: "Every month",
  annual: "Once a year",
};

/** The "Running normally" group a cadence files under — fastest first. */
const CADENCE_GROUP: Record<Cadence, NormalGroupKey> = {
  nightly: "nightly",
  "nightly-mirrored": "nightly",
  weekly: "weekly",
  monthly: "monthly",
  annual: "annual",
};

const GROUP_ADJECTIVE: Record<NormalGroupKey, string> = {
  nightly: "nightly",
  weekly: "weekly",
  monthly: "monthly",
  annual: "yearly",
};

const STATE_LABEL: Record<EtlSourceState, string> = {
  "up-to-date": "Up to date",
  late: "Late",
  failed: "Failed",
  stopped: "Stopped unexpectedly",
  "never-ran": "Never ran",
  "known-issue": "Known issue",
};

/**
 * The three card treatments. Red is a failure, amber is lateness, and an
 * accepted staleness is neutral greige — never green and never red: it is a
 * staleness somebody has already looked at and accepted until a date, and
 * colouring it either way is how a status board starts lying.
 */
type CardKind = "fail" | "late" | "known";

const CARD_KIND: Record<EtlSourceState, CardKind> = {
  failed: "fail",
  stopped: "fail",
  "never-ran": "fail",
  late: "late",
  "known-issue": "known",
  // Only reaches a card when its acknowledgement lapsed (see inAttentionSection).
  "up-to-date": "known",
};

const KIND_STYLE: Record<CardKind, { stripe: string; pill: string }> = {
  fail: { stripe: "bg-destructive", pill: "bg-apollo-red-tint text-destructive" },
  late: { stripe: "bg-apollo-amber", pill: "bg-apollo-amber-tint text-apollo-amber" },
  known: { stripe: "bg-apollo-border-strong", pill: "bg-apollo-surface-2 text-muted-foreground" },
};

/** The worded pill on a card — the status is never carried by colour alone. */
function cardPillLabel(row: EtlSourceRow, now: Date): string {
  if (row.state === "known-issue" && row.ack)
    return `Accepted until ${formatUntil(row.ack.until, now)}`;
  if (row.state === "up-to-date" && row.ackExpired) return "Acceptance lapsed";
  return STATE_LABEL[row.state];
}

const ORIGIN_PREFIX: Record<EtlSourceOrigin, string> = {
  external: "External",
  internal: "Internal",
};

/**
 * "Internal: CdnReconcile" / "External: ASMS" — the raw `etl_run.source` key
 * (what ITS greps when a problem gets reported onward), qualified up front
 * with whether a failure here is this app's own bug or someone else's system.
 * Just the bare key for a source {@link sourceOrigin} hasn't caught up with.
 */
function sourceKeyDisplay(source: string): string {
  const origin = sourceOrigin(source);
  return origin === null ? source : `${ORIGIN_PREFIX[origin]}: ${source}`;
}

/** What a superuser should read, and where to look next, for one card. */
function Explanation({
  row,
  timeoutHours,
  now,
}: {
  row: EtlSourceRow;
  timeoutHours: number;
  now: Date;
}) {
  const note = "text-muted-foreground text-[13px] leading-normal";
  const expired =
    row.ackExpired && row.ack !== undefined ? (
      <p className={cn("m-0", note)}>
        This was accepted as a known issue until {formatUntil(row.ack.until, now)}. That date has
        passed, so it counts against us again.
      </p>
    ) : null;

  if (row.state === "never-ran") {
    // A missing row outranks the acknowledgement — nothing on record is a real
    // gap, not an accepted staleness — but the ack still has to be SAID, or the
    // reader is sent chasing something somebody already decided to live with.
    const accepted =
      row.ackActive && row.ack !== undefined ? (
        <p className={cn("m-0", note)}>
          Somebody has already accepted this until {formatUntil(row.ack.until, now)}:{" "}
          {row.ack.reason}
        </p>
      ) : null;
    return (
      <>
        <p className="m-0">
          Nothing has ever been recorded for this import. Either it stopped before it got this far,
          or it isn&rsquo;t switched on.
        </p>
        {accepted}
        {expired}
      </>
    );
  }

  if (row.state === "failed") {
    return (
      <>
        <p className="m-0">
          The last attempt failed on{" "}
          <span className="whitespace-nowrap">
            {formatShort(row.lastAttemptEndedAt ?? row.lastAttemptStartedAt, now)}
          </span>
          .
        </p>
        {row.errorMessage && (
          <p className={cn("m-0 break-words whitespace-pre-wrap", note)}>{row.errorMessage}</p>
        )}
        {expired}
      </>
    );
  }

  if (row.state === "stopped") {
    return (
      <>
        <p className="m-0">
          Started{" "}
          <span className="whitespace-nowrap">{formatShort(row.lastAttemptStartedAt, now)}</span>{" "}
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
        <p className="m-0">Out of date, already looked at.</p>
        {row.ack && <p className={cn("m-0 break-words", note)}>{row.ack.reason}</p>}
      </>
    );
  }

  if (row.state === "late") {
    return (
      <>
        <p className="m-0">Expected fresh data at least every {expectedEvery(row.slaHours)}.</p>
        {expired}
      </>
    );
  }

  return expired;
}

/**
 * Which section a row belongs in.
 *
 * `needsAttention` is the EXISTING rule and is not re-derived here — it is what
 * the summary bar's failing/late counts and the heartbeat both mean by "wrong".
 * It deliberately says NO to a live acknowledgement, because an ack is precisely
 * the decision that nobody has to chase this today.
 *
 * A row an operator does not have to chase is still a row they have to READ:
 * an acked source is the one line on this page that is neither healthy nor
 * actionable, and filing it into the healthy list is how it gets rediscovered
 * from scratch every month. So the attention SECTION is `needsAttention` OR a
 * live ack — one row wider than the failure count, never narrower. The counts
 * stay untouched: an ack is shown, explained, and still not counted as a failure.
 *
 * `ackActive` is only ever true on a source that is genuinely stale
 * (`gradeSource` sets it from `stale && ack active`), so a healthy source that
 * happens to carry an ack stays in the healthy section where it belongs.
 *
 * `ackExpired` is the case that does NOT follow that rule. `gradeSource` sets it
 * from `state === "expired"` alone, never gated on `stale`, so a source whose
 * data recovered while its ack quietly lapsed grades `up-to-date` and carries a
 * dead acceptance nobody renewed. Without this clause the lapse would be stated
 * nowhere.
 */
function inAttentionSection(row: EtlSourceRow): boolean {
  return needsAttention(row) || row.ackActive || row.ackExpired;
}

/** One row that needs reading, with everything a reader needs in one block. */
function AttentionCard({
  row,
  timeoutHours,
  now,
}: {
  row: EtlSourceRow;
  timeoutHours: number;
  now: Date;
}) {
  const description = sourceDescription(row.source);
  const label = sourceLabel(row.source);
  const style = KIND_STYLE[CARD_KIND[row.state]];
  return (
    <li
      className="border-apollo-border-strong bg-apollo-surface grid grid-cols-[4px_minmax(0,1fr)] overflow-hidden rounded-[13px] border sm:grid-cols-[4px_minmax(0,1fr)_auto]"
      data-testid={`etl-status-row-${row.source}`}
      data-state={row.state}
    >
      <div className={style.stripe} aria-hidden="true" data-testid="etl-status-stripe" />
      <div className="flex min-w-0 flex-col gap-1.5 px-[18px] py-3.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="m-0 text-[15.5px] font-semibold">{label}</h3>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11.5px] font-semibold tracking-[0.04em] whitespace-nowrap",
              style.pill,
            )}
            data-testid="etl-status-pill"
          >
            {cardPillLabel(row, now)}
          </span>
          {label === row.source ? null : (
            <span
              className="text-muted-foreground font-mono text-xs"
              data-testid="etl-status-source-key"
            >
              {sourceKeyDisplay(row.source)}
            </span>
          )}
        </div>
        {description === null ? null : (
          <p className="text-muted-foreground m-0 text-[13.5px]">{description}</p>
        )}
        <div className="flex flex-col gap-1.5 text-[13.5px] leading-normal">
          <Explanation row={row} timeoutHours={timeoutHours} now={now} />
        </div>
      </div>
      <div className="col-start-2 flex flex-wrap gap-x-3 gap-y-1 px-[18px] pb-3.5 text-[13px] whitespace-nowrap sm:col-start-auto sm:flex-col sm:items-end sm:gap-1 sm:py-3.5 sm:text-right">
        <span className="text-muted-foreground">{CADENCE_LABEL[row.cadence]}</span>
        <span className="font-medium" data-testid="etl-status-last-good">
          {row.lastSuccessAt === null ? "No data" : formatShort(row.lastSuccessAt, now)}
        </span>
        {row.lastSuccessAt === null ? null : (
          <span className="text-muted-foreground">{formatAge(row.ageHours)}</span>
        )}
      </div>
    </li>
  );
}

/**
 * The "Running normally" table's sort keys — header links navigate to
 * `?sort=<key>&dir=<dir>` and the server re-sorts on the way back. Sorting
 * applies inside each cadence group. With no sort chosen, each group reads
 * stalest-first against its own allowance, so the row closest to going late
 * is the first one seen.
 */
const SORT_KEYS: ReadonlyArray<NormalSortKey> = [
  "import",
  "source",
  "freshness",
  "lastGood",
  "duration",
];

function parseSortKey(v: string | undefined): NormalSortKey | null {
  return SORT_KEYS.includes(v as NormalSortKey) ? (v as NormalSortKey) : null;
}

function freshnessFraction(row: EtlSourceRow): number | null {
  return row.ageHours === null ? null : row.ageHours / row.slaHours;
}

/** Comparable value per column. `null` always sorts last, in either direction. */
function sortValue(row: EtlSourceRow, key: NormalSortKey): string | number | null {
  switch (key) {
    case "import":
      return sourceLabel(row.source).toLowerCase();
    case "source":
      // Origin first, then key: the External/Internal badge this column shows
      // is also what sorting it groups by.
      return sourceKeyDisplay(row.source).toLowerCase();
    case "freshness":
      return freshnessFraction(row);
    case "lastGood":
      return row.ageHours;
    case "duration":
      if (row.lastAttemptStartedAt === null) return null;
      // Still running outlasts every finished run — that IS the longest duration.
      if (row.lastAttemptEndedAt === null) return Infinity;
      return row.lastAttemptEndedAt.getTime() - row.lastAttemptStartedAt.getTime();
  }
}

function sortRows(rows: EtlSourceRow[], key: NormalSortKey, dir: NormalSortDir): EtlSourceRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    if (typeof av === "string" || typeof bv === "string")
      return sign * String(av).localeCompare(String(bv));
    return sign * (av - bv);
  });
}

function toNormalRow(row: EtlSourceRow, now: Date): NormalRow {
  const fraction = freshnessFraction(row);
  return {
    source: row.source,
    label: sourceLabel(row.source),
    description: sourceDescription(row.source),
    origin: sourceOrigin(row.source),
    group: CADENCE_GROUP[row.cadence],
    lastGood: formatShort(row.lastSuccessAt, now),
    ago: formatAge(row.ageHours),
    fraction,
    freshTip:
      fraction === null
        ? "No good data yet"
        : `${Math.round(Math.min(1, fraction) * 100)}% of the ${expectedEvery(row.slaHours)} allowed before this counts as late`,
    took: formatDuration(row.lastAttemptStartedAt, row.lastAttemptEndedAt),
    tookMs: durationMs(row.lastAttemptStartedAt, row.lastAttemptEndedAt),
  };
}

/** One segment of the summary bar, and its legend entry. */
type Segment = { key: string; n: number; label: string; color: string; href: string };

function SummaryBar({ segments }: { segments: Segment[] }) {
  const shown = segments.filter((s) => s.n > 0);
  return (
    <div className="flex flex-col gap-3" data-testid="etl-status-summary">
      {/* Decoration: the legend below carries every number in words. */}
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {shown.map((s) => (
          <div key={s.key} className={s.color} style={{ flex: s.n }} title={`${s.n} ${s.label}`} />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-[22px] gap-y-1.5 p-0">
        {shown.map((s) => (
          <li key={s.key}>
            <a
              href={s.href}
              className="inline-flex items-baseline gap-[7px] text-sm hover:underline"
              data-testid={`etl-status-count-${s.key}`}
            >
              <span
                className={cn("size-2.5 self-center rounded-[3px]", s.color)}
                aria-hidden="true"
              />
              <span className="font-semibold tabular-nums">{s.n}</span>
              <span className="text-muted-foreground">{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBody({
  summary,
  sortKey,
  sortDir,
}: {
  summary: EtlStatusSummary;
  sortKey: NormalSortKey | null;
  sortDir: NormalSortDir;
}) {
  const now = summary.checkedAt;
  const total = summary.sources.length;
  const attention = summary.sources.filter(inAttentionSection);
  const normal = summary.sources.filter((row) => !inAttentionSection(row));

  // The bar counts FAILURES the way the heartbeat does (needsAttention), and
  // shows accepted rows as their own neutral segment — shown, never counted.
  const failing = attention.filter((r) => needsAttention(r) && r.state !== "late").length;
  const late = attention.filter((r) => needsAttention(r) && r.state === "late").length;
  const accepted = attention.length - failing - late;
  const segments: Segment[] = [
    {
      key: "failing",
      n: failing,
      label: "failing",
      color: "bg-destructive",
      href: "#etl-status-attention",
    },
    {
      key: "late",
      n: late,
      label: "late",
      color: "bg-apollo-amber",
      href: "#etl-status-attention",
    },
    {
      key: "accepted",
      n: accepted,
      label: accepted === 1 ? "known issue, accepted" : "known issues, accepted",
      color: "bg-apollo-border-strong",
      href: "#etl-status-attention",
    },
    {
      key: "normal",
      n: normal.length,
      label: "running normally",
      color: "bg-apollo-slate",
      href: "#etl-status-normal",
    },
  ];

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
  const summaryLine =
    normal.length === 0
      ? "Nothing else to report: every import is listed above."
      : `All ${normal.length} up to date.` +
        (oldestHealthy === null
          ? ""
          : ` Oldest data: ${sourceLabel(oldestHealthy.source)}, ${formatAge(oldestHealthy.ageHours)} (${GROUP_ADJECTIVE[CADENCE_GROUP[oldestHealthy.cadence]]}).`);

  const ordered =
    sortKey === null ? sortRows(normal, "freshness", "desc") : sortRows(normal, sortKey, sortDir);

  return (
    <>
      <p className="text-muted-foreground m-0 mt-1.5 max-w-[86ch] text-[14.5px] leading-normal">
        Every automatic data import that keeps profiles current, as of{" "}
        <span className="whitespace-nowrap">{formatStamp(summary.checkedAt)}</span>. Read-only:
        nothing here can be restarted. If a row needs attention, contact ITS Support with the
        import&rsquo;s name.
      </p>

      <div className="mt-6 flex flex-col gap-6">
        <SummaryBar segments={segments} />

        <section
          className="flex flex-col gap-2.5"
          id="etl-status-attention"
          data-testid="etl-status-attention"
          aria-label={`Needs attention, ${attention.length} of ${total} imports`}
        >
          <h2 className="m-0 text-lg font-semibold">Needs attention</h2>
          {attention.length === 0 ? (
            <p className="text-muted-foreground m-0 text-sm" data-testid="etl-status-headline">
              Nothing needs attention. All {total} imports are up to date.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {attention.map((row) => (
                <AttentionCard
                  key={row.source}
                  row={row}
                  timeoutHours={summary.runningTimeoutHours}
                  now={now}
                />
              ))}
            </ul>
          )}
        </section>

        <RunningNormally
          rows={ordered.map((row) => toNormalRow(row, now))}
          summaryLine={summaryLine}
          sortKey={sortKey}
          sortDir={sortDir}
        />
      </div>
    </>
  );
}

export default async function EtlStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ sort?: string; dir?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const sortKey = parseSortKey(sp.sort);
  const sortDir: NormalSortDir = sp.dir === "desc" ? "desc" : "asc";

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
    return (
      <ConsoleShell
        active="etl-status"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
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
      <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">ETL status</h1>
      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="etl-status-unavailable">
          Import status is temporarily unavailable. Please try again later or contact ITS Support if
          this persists.
        </p>
      ) : (
        <StatusBody summary={summary!} sortKey={sortKey} sortDir={sortDir} />
      )}
    </ConsoleShell>
  );
}
