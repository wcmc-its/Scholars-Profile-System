/**
 * The slug-registry table for `/edit/slugs` (#497, the superuser "used /
 * unavailable slugs" view). A single table with a segment selector (active /
 * historical / override / reserved / requested / collisions), per-segment
 * columns, a `q` search, page navigation, and a top-of-page "is this slug
 * available?" checker.
 *
 * The table + filters are a plain GET form (search, segment, pagination all via
 * query params) — server-rendered, no client JS — matching the rest of the
 * `/edit/*` surface (cf. `ProfilesRoster`). Only the availability checker is a
 * client island: it calls `GET /api/edit/slugs` and renders the live verdict.
 * The Apollo chrome + sub-nav wrap it.
 */
import Link from "next/link";

import { SlugAvailabilityChecker } from "@/components/edit/slug-availability-checker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ActiveSlugRow,
  HistoricalSlugRow,
  OverrideSlugRow,
  RequestedSlugRow,
  ReservedSlugRow,
  SlugRegistryRow,
  SlugRegistrySegment,
} from "@/lib/api/slug-registry";

const BASE = "/edit/slugs";

/** Segment tabs in display order; `requested` is dropped when the slug-request
 *  feature is off (the page passes `requestedSegmentVisible`). */
const SEGMENT_LABELS: Record<SlugRegistrySegment, string> = {
  active: "Active",
  historical: "Historical",
  override: "Overrides",
  reserved: "Reserved",
  requested: "Requests",
  collisions: "-N collisions",
};

export type SlugRegistryProps = {
  segment: SlugRegistrySegment;
  rows: ReadonlyArray<SlugRegistryRow>;
  total: number;
  query: string;
  page: number;
  pageSize: number;
  /** Whether the `requested` segment tab is shown (slug-request flag on). */
  requestedSegmentVisible: boolean;
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
}: SlugRegistryProps) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * pageSize < total;

  const segments: SlugRegistrySegment[] = [
    "active",
    "historical",
    "override",
    "reserved",
    ...(requestedSegmentVisible ? (["requested"] as SlugRegistrySegment[]) : []),
    "collisions",
  ];

  return (
    <>
        <h1 className="mb-1 text-xl font-semibold">URL registry</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Who holds which profile URL — live, historical (redirecting), pinned by an override,
          reserved route words, and requested. Check whether a URL is free before assigning it.
        </p>

        {/* Availability checker — the only client island on this page. */}
        <SlugAvailabilityChecker />

        {/* Segment selector — links, so the active segment is bookmarkable. */}
        <nav className="mb-4 flex flex-wrap gap-2" data-testid="slug-registry-segments" aria-label="Slug segments">
          {segments.map((s) => {
            const active = s === segment;
            return active ? (
              <span
                key={s}
                className="bg-apollo-maroon rounded-full px-3 py-1 text-sm font-medium text-white"
                aria-current="page"
                data-testid={`slug-segment-${s}`}
              >
                {SEGMENT_LABELS[s]}
              </span>
            ) : (
              <Link
                key={s}
                href={segHref({ segment: s, query, page: 0 })}
                className="border-border text-muted-foreground hover:text-foreground rounded-full border px-3 py-1 text-sm"
                data-testid={`slug-segment-${s}`}
              >
                {SEGMENT_LABELS[s]}
              </Link>
            );
          })}
        </nav>

        {/* GET search form — preserves the current segment. */}
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3" data-testid="slug-registry-search-form">
          {segment !== "active" && <input type="hidden" name="seg" value={segment} />}
          <div className="flex flex-col gap-1">
            <label htmlFor="slug-registry-q" className="text-muted-foreground text-xs">
              Search slug or CWID
            </label>
            <Input
              id="slug-registry-q"
              type="search"
              name="q"
              defaultValue={query}
              placeholder="e.g. jane-smith or abc1001"
              className="w-64"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        {segment === "reserved" && (
          <p className="text-muted-foreground mb-2 text-sm">
            Reserved words are code constants (edited in <code>lib/slug.ts</code>), not database
            rows. A slug equal to one of these is always rejected.
          </p>
        )}

        <p className="text-muted-foreground mb-2 text-sm" aria-live="polite" data-testid="slug-registry-count">
          {total === 0
            ? "No matching slugs."
            : `Showing ${start}–${end} of ${total.toLocaleString()}`}
        </p>

        <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-md border">
          <SegmentTable segment={segment} rows={rows} />
        </div>

        {(hasPrev || hasNext) && (
          <div className="mt-4 flex items-center justify-between">
            {hasPrev ? (
              <Link
                href={segHref({ segment, query, page: page - 1 })}
                className="text-sm underline"
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
                className="text-sm underline"
                data-testid="slug-registry-next"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// per-segment table bodies
// ---------------------------------------------------------------------------

function SegmentTable({
  segment,
  rows,
}: {
  segment: SlugRegistrySegment;
  rows: ReadonlyArray<SlugRegistryRow>;
}) {
  if (segment === "historical") return <HistoricalTable rows={rows as HistoricalSlugRow[]} />;
  if (segment === "override") return <OverrideTable rows={rows as OverrideSlugRow[]} />;
  if (segment === "reserved") return <ReservedTable rows={rows as ReservedSlugRow[]} />;
  if (segment === "requested") return <RequestedTable rows={rows as RequestedSlugRow[]} />;
  // active + collisions share a shape.
  return <ActiveTable rows={rows as ActiveSlugRow[]} />;
}

function TableShell({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className="[&_td]:align-middle w-full text-sm">
      <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
        <tr>
          {headers.map((h) => (
            <th key={h} className="px-3 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-border divide-y">{children}</tbody>
    </table>
  );
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="text-muted-foreground px-3 py-6 text-center">
        No slugs match your search.
      </td>
    </tr>
  );
}

function ActiveTable({ rows }: { rows: ActiveSlugRow[] }) {
  return (
    <TableShell headers={["Slug", "Scholar", "CWID", "Public URL", ""]}>
      {rows.length === 0 ? (
        <EmptyRow colSpan={5} />
      ) : (
        rows.map((r) => (
          <tr key={`${r.cwid}:${r.slug}`} data-testid={`slug-row-${r.slug}`}>
            <td className="px-3 py-2 font-mono">{r.slug}</td>
            <td className="px-3 py-2">{r.name ?? "—"}</td>
            <td className="text-muted-foreground px-3 py-2">{r.cwid}</td>
            <td className="px-3 py-2">
              <Link
                href={`/scholars/${r.slug}`}
                className="text-[var(--apollo-maroon)] underline"
                data-testid={`slug-public-${r.slug}`}
              >
                /scholars/{r.slug}
              </Link>
            </td>
            <td className="px-3 py-2 text-right">
              <Link
                href={`/edit/scholar/${r.cwid}`}
                className="text-[var(--apollo-maroon)] underline"
                data-testid={`slug-edit-${r.cwid}`}
              >
                Edit
              </Link>
            </td>
          </tr>
        ))
      )}
    </TableShell>
  );
}

function HistoricalTable({ rows }: { rows: HistoricalSlugRow[] }) {
  return (
    <TableShell headers={["Old slug", "Current slug", "Scholar", "CWID", "Recorded", "Status"]}>
      {rows.length === 0 ? (
        <EmptyRow colSpan={6} />
      ) : (
        rows.map((r) => (
          <tr key={r.oldSlug} data-testid={`slug-row-${r.oldSlug}`}>
            <td className="px-3 py-2 font-mono">{r.oldSlug}</td>
            <td className="px-3 py-2 font-mono">{r.currentSlug ? `→ ${r.currentSlug}` : "—"}</td>
            <td className="px-3 py-2">{r.name ?? "—"}</td>
            <td className="text-muted-foreground px-3 py-2">{r.currentCwid}</td>
            <td className="text-muted-foreground px-3 py-2">{formatDate(r.recordedAt)}</td>
            <td className="px-3 py-2">
              {r.redirects ? (
                <Badge variant="secondary" data-testid={`slug-redirect-${r.oldSlug}`}>
                  Redirects
                </Badge>
              ) : (
                <Badge variant="outline" data-testid={`slug-deadend-${r.oldSlug}`}>
                  Dead-end (404)
                </Badge>
              )}
            </td>
          </tr>
        ))
      )}
    </TableShell>
  );
}

function OverrideTable({ rows }: { rows: OverrideSlugRow[] }) {
  return (
    <TableShell headers={["Slug", "Pinned for (CWID)", "Set by (CWID)", "Updated"]}>
      {rows.length === 0 ? (
        <EmptyRow colSpan={4} />
      ) : (
        rows.map((r) => (
          <tr key={`${r.pinnedForCwid}:${r.slug}`} data-testid={`slug-row-${r.slug}`}>
            <td className="px-3 py-2 font-mono">{r.slug}</td>
            <td className="px-3 py-2">
              <Link
                href={`/edit/scholar/${r.pinnedForCwid}`}
                className="text-[var(--apollo-maroon)] underline"
              >
                {r.pinnedForCwid}
              </Link>
            </td>
            <td className="text-muted-foreground px-3 py-2">{r.setByCwid}</td>
            <td className="text-muted-foreground px-3 py-2">{formatDate(r.updatedAt)}</td>
          </tr>
        ))
      )}
    </TableShell>
  );
}

function ReservedTable({ rows }: { rows: ReservedSlugRow[] }) {
  return (
    <TableShell headers={["Word", "Reason"]}>
      {rows.length === 0 ? (
        <EmptyRow colSpan={2} />
      ) : (
        rows.map((r) => (
          <tr key={r.word} data-testid={`slug-row-${r.word}`}>
            <td className="px-3 py-2 font-mono">{r.word}</td>
            <td className="text-muted-foreground px-3 py-2">{r.reason}</td>
          </tr>
        ))
      )}
    </TableShell>
  );
}

const STATUS_VARIANT: Record<RequestedSlugRow["status"], "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  approved: "secondary",
  rejected: "destructive",
  superseded: "outline",
  withdrawn: "outline",
};

function RequestedTable({ rows }: { rows: RequestedSlugRow[] }) {
  return (
    <TableShell
      headers={["Requested slug", "For (CWID)", "Status", "Requested by", "Decided", "Note"]}
    >
      {rows.length === 0 ? (
        <EmptyRow colSpan={6} />
      ) : (
        rows.map((r) => (
          <tr key={r.id} data-testid={`slug-row-${r.id}`}>
            <td className="px-3 py-2 font-mono">{r.requestedSlug}</td>
            <td className="px-3 py-2">{r.forCwid}</td>
            <td className="px-3 py-2">
              <Badge variant={STATUS_VARIANT[r.status]} data-testid={`slug-status-${r.id}`}>
                {r.status}
              </Badge>
            </td>
            <td className="text-muted-foreground px-3 py-2">{r.requestedByCwid}</td>
            <td className="text-muted-foreground px-3 py-2">
              {r.decidedAt
                ? `${r.decidedByCwid ?? "—"} · ${formatDate(r.decidedAt)}`
                : "—"}
            </td>
            <td className="text-muted-foreground px-3 py-2">
              {r.decisionNote && r.decisionNote.trim().length > 0 ? r.decisionNote : "—"}
            </td>
          </tr>
        ))
      )}
    </TableShell>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
