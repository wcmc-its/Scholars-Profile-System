/**
 * The Profile URLs page body for `/edit/slugs` (#497; design canvas "Profile
 * URLs", 2026-09-25). Top to bottom:
 *
 *   - the page title and one-line intro;
 *   - `requests` — the "Requests to review" card (`SlugRequestQueue`, a
 *     client island), passed in by the page when the slug-request feature is
 *     on;
 *   - "Registry": ONE `/scholars/…` input that both checks a URL and narrows
 *     every tab to matches. It is a plain GET form (`q`), so the verdict beside
 *     it is computed server-side by the page (`resolveSlugStatus`, the same
 *     checks the write path runs, or a CWID lookup) — no client JS;
 *   - tabs with match counts (Live / Redirects / Pinned / Reserved /
 *     Collisions / Decided requests), links, so the tab is bookmarkable. The
 *     `?seg=` values are the registry segments, unchanged;
 *   - the tab's title, hint and count, then one card of rows (a grid at md+,
 *     stacked cards on a phone), and page navigation.
 *
 * Server-rendered; the Apollo chrome + sub-nav wrap it.
 */
import Link from "next/link";

import type {
  ActiveSlugRow,
  HistoricalSlugRow,
  OverrideSlugRow,
  RequestedSlugRow,
  ReservedSlugRow,
  SlugRegistryExtras,
  SlugRegistryRow,
  SlugRegistrySegment,
  SlugStatus,
} from "@/lib/api/slug-registry";
import { cn } from "@/lib/utils";

const BASE = "/edit/slugs";

/** Tabs in display order: label, one-line hint, column heads. `requested` is
 *  dropped when the slug-request feature is off. */
const TABS: ReadonlyArray<{
  seg: SlugRegistrySegment;
  label: string;
  hint: string;
  heads: [string, string, string, string];
}> = [
  {
    seg: "active",
    label: "Live",
    hint: "Every scholar’s current URL.",
    heads: ["URL", "Scholar", "How set", ""],
  },
  {
    seg: "historical",
    label: "Redirects",
    hint: "Old URLs that forward to a current one.",
    heads: ["Old URL", "Forwards to", "Status", "Since"],
  },
  {
    seg: "override",
    label: "Pinned",
    hint: "Won’t change if the scholar’s name changes.",
    heads: ["URL", "Scholar", "Status", "Pinned"],
  },
  {
    seg: "reserved",
    label: "Reserved",
    hint: "Not available to anyone. Reserved words are code constants (edited in lib/slug.ts), not database rows.",
    heads: ["URL", "Reason", "Status", "Added"],
  },
  {
    seg: "collisions",
    label: "Collisions",
    hint: "URLs that got a -N suffix because the base was taken.",
    heads: ["URL", "Scholar", "Base URL", ""],
  },
  {
    seg: "requested",
    label: "Decided requests",
    hint: "Pending requests are at the top of the page.",
    heads: ["URL requested", "Scholar", "Outcome", "Decided"],
  },
];

/** The md+ row grid: URL, who/what, status, date, action. */
const GRID = "md:grid-cols-[minmax(170px,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_120px_64px]";

/** Pill tones — one job each: neutral = routine, slate = a pin, green = free
 *  or approved, amber = reserved / forwards, red tint = blocked / broken. */
const TONE = {
  grey: "bg-apollo-surface-2 text-muted-foreground border-apollo-border",
  slate: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
  green: "bg-apollo-green-tint text-apollo-green-foreground border-apollo-green-tint-border",
  amber: "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border",
  red: "bg-apollo-red-tint text-destructive border-apollo-red-tint-border",
} as const;
type Tone = keyof typeof TONE;

/** The input's verdict, computed by the page from `q`. */
export type RegistryVerdict =
  | { kind: "cwid"; cwid: string; name: string | null; slug: string }
  | { kind: "status"; status: SlugStatus };

export type SlugRegistryProps = {
  segment: SlugRegistrySegment;
  rows: ReadonlyArray<SlugRegistryRow>;
  total: number;
  query: string;
  page: number;
  pageSize: number;
  /** Whether the `requested` segment tab is shown (slug-request flag on). */
  requestedSegmentVisible: boolean;
  /** Each tab's match count for `query`; a missing tab shows no count. */
  counts?: Partial<Record<SlugRegistrySegment, number>>;
  /** Names, departments, pins and collision bases for the page's rows. */
  extras?: SlugRegistryExtras;
  /** The verdict for `query`, when one was typed. */
  verdict?: RegistryVerdict | null;
  /** The "Requests to review" card, when the slug-request feature is on. */
  requests?: React.ReactNode;
};

function segHref(opts: { segment: SlugRegistrySegment; query: string; page: number }): string {
  const p = new URLSearchParams();
  if (opts.segment !== "active") p.set("seg", opts.segment);
  if (opts.query) p.set("q", opts.query);
  if (opts.page > 0) p.set("page", String(opts.page));
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function SlugRegistry({
  segment,
  rows,
  total,
  query,
  page,
  pageSize,
  requestedSegmentVisible,
  counts = {},
  extras = { people: {}, pinned: [], baseHolders: {} },
  verdict = null,
  requests = null,
}: SlugRegistryProps) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * pageSize < total;
  const tabs = TABS.filter((t) => t.seg !== "requested" || requestedSegmentVisible);
  const tab = tabs.find((t) => t.seg === segment) ?? tabs[0];

  return (
    <div className="flex flex-col gap-[22px]">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] font-semibold tracking-[-0.01em]">Profile URLs</h1>
        <p className="text-muted-foreground text-sm text-pretty">
          Requests for a personalized URL, and the registry of every URL that is live, redirecting,
          pinned or reserved.
        </p>
      </div>

      {requests}

      <section aria-labelledby="slug-registry-heading" className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1">
          <h2 id="slug-registry-heading" className="text-lg font-semibold">
            Registry
          </h2>
          <p className="text-muted-foreground text-[13px]">
            Type a URL to check whether it&apos;s free. The tabs below narrow to matches.
          </p>
        </div>

        <div className="bg-apollo-surface border-apollo-border-strong flex flex-col gap-3 rounded-[var(--apollo-radius-card)] border p-3.5">
          <div className="flex flex-wrap items-center gap-3">
            {/* GET form: preserves the tab; Enter checks and narrows. */}
            <form
              method="get"
              action={BASE}
              role="search"
              className="border-apollo-border-strong bg-apollo-page focus-within:ring-ring/50 flex h-[42px] min-w-0 flex-[1_1_280px] items-center overflow-hidden rounded-[9px] border focus-within:ring-2"
              data-testid="slug-registry-search-form"
            >
              {segment !== "active" && <input type="hidden" name="seg" value={segment} />}
              <label
                htmlFor="slug-registry-q"
                className="text-muted-foreground pr-0.5 pl-3.5 font-mono text-sm"
              >
                /scholars/
              </label>
              <input
                id="slug-registry-q"
                type="search"
                name="q"
                defaultValue={query}
                placeholder="jane-q-smith, or a CWID"
                aria-label="Check a URL, or search slug, name or CWID"
                autoComplete="off"
                spellCheck={false}
                className="h-full min-w-0 flex-1 border-0 bg-transparent pr-3 font-mono text-sm outline-none"
                data-testid="slug-check-input"
              />
              {query && (
                <Link
                  href={segHref({ segment, query: "", page: 0 })}
                  className="text-muted-foreground hover:text-foreground px-3.5 text-[13px]"
                  data-testid="slug-registry-clear"
                >
                  Clear
                </Link>
              )}
            </form>
            {verdict && <Verdict verdict={verdict} />}
          </div>

          <nav
            className="border-apollo-border flex flex-wrap gap-1 border-t pt-3"
            data-testid="slug-registry-segments"
            aria-label="Registry tabs"
          >
            {tabs.map((t) => {
              const on = t.seg === tab.seg;
              const n = counts[t.seg];
              return (
                <Link
                  key={t.seg}
                  href={segHref({ segment: t.seg, query, page: 0 })}
                  aria-current={on ? "page" : undefined}
                  data-testid={`slug-segment-${t.seg}`}
                  className={cn(
                    "flex h-8 items-center gap-[7px] rounded-lg px-3 text-[13.5px] whitespace-nowrap",
                    on
                      ? "bg-apollo-slate-tint text-apollo-slate font-semibold"
                      : "text-foreground hover:bg-apollo-surface-2",
                  )}
                >
                  {t.label}
                  {n !== undefined && (
                    <span className="text-muted-foreground text-xs font-normal tabular-nums">
                      {n.toLocaleString()}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-sm font-medium">{tab.label}</span>
          <span className="text-muted-foreground min-w-0 flex-1 text-[13px] text-pretty">
            {tab.hint}
          </span>
          <span
            className="text-muted-foreground ml-auto text-[13px] whitespace-nowrap tabular-nums"
            aria-live="polite"
            data-testid="slug-registry-count"
          >
            {total === 0
              ? "No matching URLs."
              : total <= pageSize && page === 0
                ? `${total.toLocaleString()} ${query ? "matching" : "shown"}`
                : `Showing ${start}–${end} of ${total.toLocaleString()}${query ? " matching" : ""}`}
          </span>
        </div>

        <div className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border">
          <div
            className={cn(
              "bg-apollo-surface-2 text-muted-foreground hidden gap-4 px-[18px] py-2.5 text-[12.5px] font-medium md:grid",
              GRID,
            )}
            aria-hidden
          >
            {tab.heads.map((h, i) => (
              <span key={i}>{h}</span>
            ))}
            <span />
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border px-[18px] py-7 text-center text-sm md:border-t">
              {query ? (
                <>Nothing in this tab matches &ldquo;{query}&rdquo;.</>
              ) : (
                "Nothing here yet."
              )}
            </p>
          ) : (
            <ul>
              <SegmentRows segment={tab.seg} rows={rows} extras={extras} />
            </ul>
          )}
        </div>

        {(hasPrev || hasNext) && (
          <div className="flex items-center justify-between">
            {hasPrev ? (
              <Link
                href={segHref({ segment, query, page: page - 1 })}
                className="text-apollo-slate text-sm hover:underline"
                data-testid="slug-registry-prev"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            {hasNext ? (
              <Link
                href={segHref({ segment, query, page: page + 1 })}
                className="text-apollo-slate text-sm hover:underline"
                data-testid="slug-registry-next"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the verdict beside the input
// ---------------------------------------------------------------------------

function Verdict({ verdict }: { verdict: RegistryVerdict }) {
  let tone: Tone;
  let label: string;
  let detail: React.ReactNode;
  if (verdict.kind === "cwid") {
    tone = "slate";
    label = "CWID";
    detail = `${verdict.name ?? verdict.cwid} is at /${verdict.slug}`;
  } else {
    const s = verdict.status;
    if (s.state === "available") {
      tone = "green";
      label = "Available";
      detail = `/${s.slug} isn’t in use`;
    } else if (s.state === "invalid") {
      tone = "red";
      label = "Invalid";
      detail =
        s.reason === "too_long"
          ? "Too long (max 64 characters)"
          : "Lowercase letters, digits and single hyphens only";
    } else if (s.state === "reserved") {
      tone = "red";
      label = "Reserved";
      detail = "A reserved route word";
    } else if (s.held === "live") {
      tone = "red";
      label = "Taken";
      detail = s.name ? `${s.name} (${s.cwid})` : s.cwid;
    } else if (s.held === "override") {
      tone = "red";
      label = "Taken";
      detail = `Pinned for ${s.cwid}`;
    } else {
      tone = "amber";
      label = "Redirect";
      detail = `Forwards to /${s.currentSlug ?? s.currentCwid}; claiming it breaks that redirect`;
    }
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-[9px] border px-3.5 py-2",
        TONE[tone],
      )}
      role="status"
      data-testid="slug-check-result"
    >
      <span className="text-sm font-semibold whitespace-nowrap">{label}</span>
      <span className="text-foreground text-[13px]">{detail}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

type RowCells = {
  key: string;
  testId: string;
  url: string;
  /** Links the URL cell (live URLs only). */
  urlHref?: string;
  urlTestId?: string;
  tag?: string;
  primary: React.ReactNode;
  primaryMono?: boolean;
  secondary?: React.ReactNode;
  pill: { label: string; tone: Tone; testId?: string };
  date?: React.ReactNode;
  action?: { label: string; href: string; testId?: string };
};

function Row({ r }: { r: RowCells }) {
  return (
    <li
      className={cn(
        "border-apollo-border hover:bg-apollo-page/60 grid grid-cols-1 gap-x-4 gap-y-1.5 border-t px-[18px] py-2.5 text-sm first:border-t-0 md:items-center md:first:border-t",
        GRID,
      )}
      data-testid={r.testId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {r.urlHref ? (
          <Link
            href={r.urlHref}
            className="font-mono text-[13.5px] break-words hover:underline"
            data-testid={r.urlTestId}
          >
            {r.url}
          </Link>
        ) : (
          <span className="font-mono text-[13.5px] break-words">{r.url}</span>
        )}
        {r.tag && (
          <span className="bg-apollo-slate-tint text-apollo-slate rounded-full px-[7px] py-px text-[11.5px] whitespace-nowrap">
            {r.tag}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-px">
        <span
          className={cn("[overflow-wrap:anywhere]", r.primaryMono && "font-mono text-[13.5px]")}
        >
          {r.primary}
        </span>
        {r.secondary && <span className="text-muted-foreground text-[12.5px]">{r.secondary}</span>}
      </div>
      <div className="flex min-w-0">
        <span
          className={cn("rounded-full border px-[9px] py-0.5 text-[12.5px]", TONE[r.pill.tone])}
          data-testid={r.pill.testId}
        >
          {r.pill.label}
        </span>
      </div>
      <span className="text-muted-foreground text-[13px]">{r.date}</span>
      <div className="flex md:justify-end">
        {r.action && (
          <Link
            href={r.action.href}
            className="text-apollo-slate px-1.5 py-1 text-[13.5px] whitespace-nowrap hover:underline"
            data-testid={r.action.testId}
          >
            {r.action.label}
          </Link>
        )}
      </div>
    </li>
  );
}

const joinDot = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");

function SegmentRows({
  segment,
  rows,
  extras,
}: {
  segment: SlugRegistrySegment;
  rows: ReadonlyArray<SlugRegistryRow>;
  extras: SlugRegistryExtras;
}) {
  const person = (cwid: string) => extras.people[cwid];
  const pinned = new Set(extras.pinned);
  let cells: RowCells[];
  if (segment === "historical") {
    cells = (rows as HistoricalSlugRow[]).map((r) => ({
      key: r.oldSlug,
      testId: `slug-row-${r.oldSlug}`,
      url: `/${r.oldSlug}`,
      primary: r.currentSlug ? `→ /${r.currentSlug}` : "—",
      primaryMono: true,
      secondary: joinDot(r.name, r.currentCwid),
      pill: r.redirects
        ? { label: "Redirects", tone: "grey", testId: `slug-redirect-${r.oldSlug}` }
        : { label: "Dead-end (404)", tone: "red", testId: `slug-deadend-${r.oldSlug}` },
      date: formatMonthYear(r.recordedAt),
    }));
  } else if (segment === "override") {
    cells = (rows as OverrideSlugRow[]).map((r) => ({
      key: `${r.pinnedForCwid}:${r.slug}`,
      testId: `slug-row-${r.slug}`,
      url: `/${r.slug}`,
      urlHref: `/scholars/${r.slug}`,
      primary: person(r.pinnedForCwid)?.name ?? r.pinnedForCwid,
      secondary: joinDot(r.pinnedForCwid, person(r.pinnedForCwid)?.department),
      pill: { label: "Pinned", tone: "slate" },
      date: (
        <>
          {formatShortDate(r.updatedAt)}
          <span className="block text-xs">by {r.setByCwid}</span>
        </>
      ),
      action: {
        label: "Edit",
        href: `/edit/scholar/${r.pinnedForCwid}`,
        testId: `slug-edit-${r.pinnedForCwid}`,
      },
    }));
  } else if (segment === "reserved") {
    cells = (rows as ReservedSlugRow[]).map((r) => ({
      key: r.word,
      testId: `slug-row-${r.word}`,
      url: `/${r.word}`,
      primary: r.reason,
      pill: { label: "Reserved", tone: "amber" },
      date: "Built in",
    }));
  } else if (segment === "requested") {
    cells = (rows as RequestedSlugRow[]).map((r) => ({
      key: r.id,
      testId: `slug-row-${r.id}`,
      url: `/${r.requestedSlug}`,
      primary: person(r.forCwid)?.name ?? r.forCwid,
      secondary: joinDot(
        r.forCwid,
        r.decisionNote && r.decisionNote.trim().length > 0 ? `“${r.decisionNote}”` : null,
      ),
      pill: {
        label: OUTCOME_LABEL[r.status],
        tone: r.status === "approved" ? "green" : "grey",
        testId: `slug-status-${r.id}`,
      },
      date: r.decidedAt ? `${formatShortDate(r.decidedAt)} by ${r.decidedByCwid ?? "—"}` : "—",
    }));
  } else {
    // active + collisions share a shape.
    const bases = extras.baseHolders;
    cells = (rows as ActiveSlugRow[]).map((r) => {
      const base = r.slug.replace(/-\d+$/, "");
      const holder = bases[base];
      const isPinned = pinned.has(r.cwid);
      return {
        key: `${r.cwid}:${r.slug}`,
        testId: `slug-row-${r.slug}`,
        url: `/${r.slug}`,
        urlHref: `/scholars/${r.slug}`,
        urlTestId: `slug-public-${r.slug}`,
        tag: segment === "active" && isPinned ? "pinned" : undefined,
        primary: r.name ?? "—",
        secondary: joinDot(r.cwid, person(r.cwid)?.department),
        pill:
          segment === "collisions"
            ? holder === undefined
              ? { label: `Base /${base}`, tone: "grey" }
              : holder
                ? {
                    label: `Base held by ${holder.name ?? holder.cwid} (${holder.cwid})`,
                    tone: "grey",
                  }
                : { label: "Base is free", tone: "green" }
            : isPinned
              ? { label: "Pinned", tone: "slate" }
              : { label: "Auto", tone: "grey" },
        action: { label: "Edit", href: `/edit/scholar/${r.cwid}`, testId: `slug-edit-${r.cwid}` },
      };
    });
  }
  return (
    <>
      {cells.map((c) => (
        <Row key={c.key} r={c} />
      ))}
    </>
  );
}

const OUTCOME_LABEL: Record<RequestedSlugRow["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Denied",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

/** "Sep 25, 2026". */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Sep 2026". */
function formatMonthYear(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" });
}
