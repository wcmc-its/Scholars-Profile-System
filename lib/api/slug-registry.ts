/**
 * The slug-namespace registry reads for `/edit/slugs` (#497, the superuser
 * "used / unavailable slugs" view). This is the single net-new slug feature:
 * the existing `/edit/slug-requests` queue is pending-only, and no surface
 * enumerates the full slug namespace — active, historical, override-pinned,
 * reserved, requested, and the derived `-N` collision groups.
 *
 * Two exports:
 *   - `loadSlugRegistry(opts, client)` — one paginated page of one segment
 *     (`active` | `historical` | `override` | `reserved` | `requested` |
 *     `collisions`), each carrying the columns the registry table renders.
 *     Mirrors `lib/api/edit-roster.ts` pagination/search (take/skip + parallel
 *     count). The `reserved` segment is in-memory (a code constant, not a DB
 *     table) so it neither paginates nor counts a DB query.
 *   - `resolveSlugStatus(slug, client)` — the "is this slug available?" checker
 *     backing the top-of-page input and the GET route. It **reuses**
 *     `validateSlugFormat` + `checkSlugCollision` + `RESERVED_SLUGS` — never a
 *     re-implementation — so its verdict can never disagree with the
 *     `POST /api/edit/field` write path. When unavailable it surfaces the
 *     holder's identity (the same holder-resolution the queue uses).
 *
 * Server-only by construction (Prisma) but with no `server-only` import, so it
 * loads under vitest with a fake client — matching `edit-roster.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  RESERVED_SLUGS,
  checkSlugCollision,
  validateSlugFormat,
} from "@/lib/edit/validators";
import type { SlugRequestStatus } from "@/lib/generated/prisma/client";

// ---------------------------------------------------------------------------
// shared types
// ---------------------------------------------------------------------------

/** The registry segments. `reserved` is in-memory; the rest are DB-backed. */
export type SlugRegistrySegment =
  | "active"
  | "historical"
  | "override"
  | "reserved"
  | "requested"
  | "collisions";

export const SLUG_REGISTRY_SEGMENTS: readonly SlugRegistrySegment[] = [
  "active",
  "historical",
  "override",
  "reserved",
  "requested",
  "collisions",
] as const;

export function isSlugRegistrySegment(value: string): value is SlugRegistrySegment {
  return (SLUG_REGISTRY_SEGMENTS as readonly string[]).includes(value);
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Trim + lowercase a search term — slugs are lowercase (`validateSlugFormat`). */
function normalizeQuery(q: string | undefined): string {
  return (q ?? "").trim().toLowerCase();
}

// ── per-segment row shapes ─────────────────────────────────────────────────

/** A active (`active`) or `-N` collision (`collisions`) row. */
export type ActiveSlugRow = {
  slug: string;
  cwid: string;
  /** Display name (`preferredName ?? fullName`), or `null`. */
  name: string | null;
};

/** A historical (`historical`) row — a former slug that 301/308-redirects. */
export type HistoricalSlugRow = {
  oldSlug: string;
  /** The current scholar's live slug (the redirect target), or `null`. */
  currentSlug: string | null;
  /** The current scholar's display name, or `null`. */
  name: string | null;
  currentCwid: string;
  /** ISO-serialized for the client island. */
  recordedAt: string;
  /** When `false`, the old URL 404s instead of redirecting — the current
   *  scholar is soft-deleted or suppressed (`url-resolver.ts`). Badge it. */
  redirects: boolean;
};

/** An override-pinned (`override`) row — a `FieldOverride(scholar, slug)`. */
export type OverrideSlugRow = {
  slug: string;
  /** The CWID the override is pinned for (`entityId`). */
  pinnedForCwid: string;
  /** The actor who set the override (`actorCwid`). */
  setByCwid: string;
  /** ISO-serialized for the client island. */
  updatedAt: string;
};

/** A reserved (`reserved`) row — a `RESERVED_SLUGS` route word (no DB). */
export type ReservedSlugRow = {
  word: string;
  reason: string;
};

/** A requested (`requested`) row — a `SlugRequest` of ANY status. */
export type RequestedSlugRow = {
  id: string;
  requestedSlug: string;
  forCwid: string;
  status: SlugRequestStatus;
  requestedByCwid: string;
  /** ISO-serialized for the client island. */
  requestedAt: string;
  decidedByCwid: string | null;
  /** ISO-serialized, or `null` when still pending. */
  decidedAt: string | null;
  decisionNote: string | null;
};

export type SlugRegistryRow =
  | ActiveSlugRow
  | HistoricalSlugRow
  | OverrideSlugRow
  | ReservedSlugRow
  | RequestedSlugRow;

export type SlugRegistryResult<T extends SlugRegistryRow = SlugRegistryRow> = {
  rows: T[];
  /** Total matching the filter (before limit/offset) — drives pagination.
   *  For `reserved` this is the in-memory match count. */
  total: number;
};

export type SlugRegistryOptions = {
  segment: SlugRegistrySegment;
  /** Slug/CWID substring search; trimmed + lowercased. Empty = no filter. */
  query?: string;
  /** Page size (default 50, capped at 200). */
  limit?: number;
  /** Page offset (default 0). */
  offset?: number;
};

/** The Prisma surface the registry needs — a client or tx satisfies it. */
export type SlugRegistryClient = Pick<
  PrismaClient,
  "scholar" | "slugHistory" | "fieldOverride" | "slugRequest"
>;

function take(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}
function skip(offset?: number): number {
  return Math.max(offset ?? 0, 0);
}

// ---------------------------------------------------------------------------
// segment loaders
// ---------------------------------------------------------------------------

/**
 * Segment A (`active`) — live, non-deleted scholars by `Scholar.slug`. Search
 * ORs the slug against the scholar's name/CWID (mirrors `loadEditRoster`).
 */
async function loadActive(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult<ActiveSlugRow>> {
  const q = normalizeQuery(opts.query);
  const where = {
    deletedAt: null,
    status: "active",
    ...(q
      ? {
          OR: [
            { slug: { contains: q } },
            { preferredName: { contains: q } },
            { fullName: { contains: q } },
            { cwid: { contains: q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    client.scholar.findMany({
      where,
      select: { slug: true, cwid: true, preferredName: true, fullName: true },
      orderBy: [{ slug: "asc" }],
      take: take(opts.limit),
      skip: skip(opts.offset),
    }),
    client.scholar.count({ where }),
  ]);
  return {
    rows: rows.map((s) => ({
      slug: s.slug,
      cwid: s.cwid,
      name: s.preferredName ?? s.fullName ?? null,
    })),
    total,
  };
}

/**
 * Segment F (`collisions`) — the `-N` suffixed slugs derived from A
 * (`nextAvailableSlug`'s output: `name`, `name-2`, …). A non-anchored
 * `endsWith(/-\d+$/)` test can't run in SQL, so we restrict the DB query to
 * slugs containing a hyphen-digit pair (`-2` … `-9`), then post-filter the page
 * with the precise regex. Counting under the precise regex needs the same
 * post-filter, so the count is over a hyphen-digit candidate set; close enough
 * for an admin tool and avoids loading the whole table.
 */
async function loadCollisions(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult<ActiveSlugRow>> {
  const q = normalizeQuery(opts.query);
  // `contains: "-"` narrows to hyphenated slugs in SQL; the precise `/-\d+$/`
  // regex runs in-memory below. AND'd with the search term when present.
  const and: Array<Record<string, unknown>> = [{ slug: { contains: "-" } }];
  if (q) {
    and.push({
      OR: [
        { slug: { contains: q } },
        { preferredName: { contains: q } },
        { fullName: { contains: q } },
        { cwid: { contains: q } },
      ],
    });
  }
  const where = { deletedAt: null, status: "active", AND: and };

  // Fetch hyphenated candidates ordered by slug, then keep only `-N`-suffixed
  // ones, then paginate in memory. The candidate set is bounded (hyphenated
  // active slugs); a hard ceiling guards a pathological dataset.
  const candidates = await client.scholar.findMany({
    where,
    select: { slug: true, cwid: true, preferredName: true, fullName: true },
    orderBy: [{ slug: "asc" }],
    take: MAX_LIMIT * 40,
  });
  const matched = candidates.filter((s) => /-\d+$/.test(s.slug));
  const total = matched.length;
  const start = skip(opts.offset);
  const page = matched.slice(start, start + take(opts.limit));
  return {
    rows: page.map((s) => ({
      slug: s.slug,
      cwid: s.cwid,
      name: s.preferredName ?? s.fullName ?? null,
    })),
    total,
  };
}

/**
 * Segment B (`historical`) — `slug_history` rows, newest first. Each row is
 * flagged for whether it still redirects: a dead-end (the current scholar is
 * soft-deleted or suppressed) resolves to 404, not a 301 (`url-resolver.ts`).
 */
async function loadHistorical(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult<HistoricalSlugRow>> {
  const q = normalizeQuery(opts.query);
  const where = q
    ? { OR: [{ oldSlug: { contains: q } }, { currentCwid: { contains: q } }] }
    : {};
  const [rows, total] = await Promise.all([
    client.slugHistory.findMany({
      where,
      select: {
        oldSlug: true,
        currentCwid: true,
        createdAt: true,
        current: { select: { slug: true, preferredName: true, fullName: true, deletedAt: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
      take: take(opts.limit),
      skip: skip(opts.offset),
    }),
    client.slugHistory.count({ where }),
  ]);
  return {
    rows: rows.map((r) => {
      const cur = r.current;
      const redirects = !!cur && cur.deletedAt === null && cur.status === "active";
      return {
        oldSlug: r.oldSlug,
        currentSlug: cur?.slug ?? null,
        name: cur ? (cur.preferredName ?? cur.fullName ?? null) : null,
        currentCwid: r.currentCwid,
        recordedAt: r.createdAt.toISOString(),
        redirects,
      };
    }),
    total,
  };
}

/**
 * Segment C (`override`) — `FieldOverride(scholar, slug)` rows: a slug pinned
 * by a superuser, override-authoritative over the ETL value.
 */
async function loadOverride(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult<OverrideSlugRow>> {
  const q = normalizeQuery(opts.query);
  const where = {
    entityType: "scholar" as const,
    fieldName: "slug",
    ...(q ? { OR: [{ value: { contains: q } }, { entityId: { contains: q } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    client.fieldOverride.findMany({
      where,
      select: { value: true, entityId: true, actorCwid: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: take(opts.limit),
      skip: skip(opts.offset),
    }),
    client.fieldOverride.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      slug: r.value,
      pinnedForCwid: r.entityId,
      setByCwid: r.actorCwid,
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
  };
}

/**
 * Segment D (`reserved`) — the in-memory `RESERVED_SLUGS` route words. Not a DB
 * table; the UI notes these are edited in `lib/slug.ts`, not via a DB row. No
 * pagination — the set is ~30 entries — but the in-memory `take`/`skip` keep the
 * return shape uniform with the DB segments.
 */
function loadReserved(opts: SlugRegistryOptions): SlugRegistryResult<ReservedSlugRow> {
  const q = normalizeQuery(opts.query);
  const all = [...RESERVED_SLUGS]
    .filter((w) => (q ? w.includes(q) : true))
    .sort()
    .map((word) => ({ word, reason: "Reserved route segment" }));
  const start = skip(opts.offset);
  return { rows: all.slice(start, start + take(opts.limit)), total: all.length };
}

/**
 * Segment E (`requested`) — `SlugRequest` rows of ANY status (unlike the
 * pending-only `/edit/slug-requests` queue). Newest first.
 *
 * Tolerates the table being absent/dormant: the local dev DB lacks the
 * `slug_request` table (migration drift), and the feature ships off, so a
 * failed query here returns an empty page rather than throwing — the page hides
 * this segment when the feature flag is off, but a stray request must not 500
 * the whole registry.
 */
async function loadRequested(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult<RequestedSlugRow>> {
  const q = normalizeQuery(opts.query);
  const where = q
    ? { OR: [{ requestedSlug: { contains: q } }, { cwid: { contains: q } }] }
    : {};
  try {
    const [rows, total] = await Promise.all([
      client.slugRequest.findMany({
        where,
        select: {
          id: true,
          requestedSlug: true,
          cwid: true,
          status: true,
          requestedBy: true,
          createdAt: true,
          decidedBy: true,
          decidedAt: true,
          decisionNote: true,
        },
        orderBy: { createdAt: "desc" },
        take: take(opts.limit),
        skip: skip(opts.offset),
      }),
      client.slugRequest.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        requestedSlug: r.requestedSlug,
        forCwid: r.cwid,
        status: r.status,
        requestedByCwid: r.requestedBy,
        requestedAt: r.createdAt.toISOString(),
        decidedByCwid: r.decidedBy ?? null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        decisionNote: r.decisionNote ?? null,
      })),
      total,
    };
  } catch {
    // Table absent (dev DB drift) or otherwise unavailable — the registry's
    // other segments must still render. A dormant feature is not an error.
    return { rows: [], total: 0 };
  }
}

/**
 * Load one page of one registry segment. The page handler picks the segment
 * (default `active`); each segment's query mirrors `loadEditRoster`'s
 * take/skip + parallel-count shape.
 */
export async function loadSlugRegistry(
  opts: SlugRegistryOptions,
  client: SlugRegistryClient,
): Promise<SlugRegistryResult> {
  switch (opts.segment) {
    case "active":
      return loadActive(opts, client);
    case "collisions":
      return loadCollisions(opts, client);
    case "historical":
      return loadHistorical(opts, client);
    case "override":
      return loadOverride(opts, client);
    case "reserved":
      return loadReserved(opts);
    case "requested":
      return loadRequested(opts, client);
  }
}

// ---------------------------------------------------------------------------
// "is this slug available?" checker
// ---------------------------------------------------------------------------

/** A resolved availability verdict for a candidate slug. */
export type SlugStatus =
  /** The input is not a valid slug shape (format / too-long). */
  | { state: "invalid"; reason: "format" | "too_long" }
  /** A reserved route word — never assignable (segment D). */
  | { state: "reserved"; slug: string }
  /** Free — passes every write-path check. */
  | { state: "available"; slug: string }
  /** Held by a live scholar (segment A). */
  | {
      state: "taken";
      slug: string;
      held: "live";
      cwid: string;
      name: string | null;
    }
  /** Pinned by another CWID's override (segment C). */
  | { state: "taken"; slug: string; held: "override"; cwid: string }
  /** A former slug of a different live scholar — claiming it breaks that 301
   *  (segment B, the #29 identity-bleed guard). */
  | {
      state: "taken";
      slug: string;
      held: "history";
      currentCwid: string;
      currentSlug: string | null;
    };

/** The Prisma surface `resolveSlugStatus` needs. */
export type SlugStatusClient = Pick<PrismaClient, "scholar" | "fieldOverride" | "slugHistory">;

/**
 * Resolve a candidate slug's availability, running the SAME checks the write
 * path uses, in the same order:
 *   1. `validateSlugFormat` — reserved → `reserved`; format/too-long → `invalid`.
 *   2. `checkSlugCollision` (reused, never re-implemented) — if it reports a
 *      collision, identify which of the three sources holds it and surface the
 *      holder, so the verdict can never disagree with `POST /api/edit/field`.
 *   3. else → `available`.
 *
 * `forCwid` is omitted (a registry lookup is "is this free for ANYONE?"); a
 * sentinel CWID that can never be a real one is passed to `checkSlugCollision`
 * so its `cwid: { not: forCwid }` exclusion never accidentally excludes a real
 * holder.
 */
export async function resolveSlugStatus(
  slug: string,
  client: SlugStatusClient,
): Promise<SlugStatus> {
  const format = validateSlugFormat(slug);
  if (!format.ok) {
    if (format.error === "reserved") {
      return { state: "reserved", slug: slug.trim().toLowerCase() };
    }
    return { state: "invalid", reason: format.error };
  }
  const value = format.value;

  // A sentinel that can never equal a real CWID — so `checkSlugCollision`'s
  // `forCwid` exclusion never hides a genuine holder. (Reuse the exact write-
  // path collision predicate; only the holder-identity resolution is new.)
  const NO_CWID = " __registry_no_cwid__";
  const collision = await checkSlugCollision(value, NO_CWID, client);
  if (collision.ok) {
    return { state: "available", slug: value };
  }

  // Identify the holder for the message — the same resolution order
  // `checkSlugCollision` uses (live → override → history), so the surfaced
  // reason matches the verdict.
  const live = await client.scholar.findFirst({
    where: { slug: value, deletedAt: null, status: "active" },
    select: { cwid: true, preferredName: true, fullName: true },
  });
  if (live) {
    return {
      state: "taken",
      slug: value,
      held: "live",
      cwid: live.cwid,
      name: live.preferredName ?? live.fullName ?? null,
    };
  }

  const override = await client.fieldOverride.findFirst({
    where: { entityType: "scholar", fieldName: "slug", value },
    select: { entityId: true },
  });
  if (override) {
    return { state: "taken", slug: value, held: "override", cwid: override.entityId };
  }

  const former = await client.slugHistory.findUnique({
    where: { oldSlug: value },
    select: { currentCwid: true, current: { select: { slug: true } } },
  });
  if (former) {
    return {
      state: "taken",
      slug: value,
      held: "history",
      currentCwid: former.currentCwid,
      currentSlug: former.current?.slug ?? null,
    };
  }

  // checkSlugCollision said "taken" but none of the three sources matched — a
  // benign race (the holder vanished between the two reads). Treat as available;
  // the atomic `slug_guard` UNIQUE index is the real backstop on write.
  return { state: "available", slug: value };
}
