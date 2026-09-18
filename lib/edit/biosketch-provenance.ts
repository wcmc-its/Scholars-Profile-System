/**
 * Biosketch generation history reads (#917 v6, handoff §6). Every successful biosketch
 * Generate appends a `BiosketchGeneration` row (best-effort, on the generate route); this
 * module is the READ side the "Earlier biosketches" history panel browses + restores.
 *
 * Unlike the overview, the biosketch is a copy/export artifact with NO save-to-profile flow,
 * so there is no provenance analog (no "is the live bio authored/generated?" record). This
 * module is just `listBiosketchGenerations` — the overview's `computeOverviewOrigin` /
 * `loadOverviewProvenance` half does not exist here.
 *
 * Read-only — the write lives on `/api/edit/biosketch/generate`. Node-runtime only (Prisma).
 */
import { db } from "@/lib/db";
import {
  normalizeBiosketchParams,
  type BiosketchEntry,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";
import type { BiosketchContributionSources } from "@/lib/edit/biosketch-sources";

/** How many recent biosketches the history panel surfaces (matches the overview cap). */
const BIOSKETCH_HISTORY_LIMIT = 20;

/** One biosketch generation history row, shaped for the `/edit` history panel. */
export interface BiosketchGenerationSummary {
  id: string;
  mode: string;
  /** The generated entries (1..5 contributions, or one statement) as `{ title, body }` (#917 v7).
   *  `title` is the per-contribution heading (v7; `""` for v5 / v6 + Personal Statement). */
  entries: BiosketchEntry[];
  /** Personal Statement project framing (or the optional contributions aims), when present. */
  projectTitle: string | null;
  projectAims: string | null;
  model: string;
  /** The authoritative, queryable prompt-version column ("v5" / "v6" / "v7"). */
  promptVersion: string | null;
  /** Re-normalized steering params (the trust boundary, applied on read) — carries the
   *  `promptVersion` for Clone (#2654) to restore. */
  params: BiosketchParams;
  /** The Products list (Contributions mode), or null. */
  products: BiosketchProducts | null;
  /** Per-contribution source PMIDs, or null. */
  sources: BiosketchContributionSources[] | null;
  /** The accountable human who ran the generation (audit "who ran it"). */
  createdByCwid: string;
  /** The "View as" overlay target when generated through impersonation, else null. */
  impersonatedCwid: string | null;
  /** #2654 — the scholar-typed label (application name), or null when unlabeled. */
  label: string | null;
  /** #2654 / #2668 — how many CONFIRMED authorships of the scholar's were LINKED after this
   *  draft was generated: the staleness nudge. Keyed on `publication_author.created_at`,
   *  which is set once on create and never bumped — NOT on `last_refreshed_at`, the coi-gap
   *  watermark that also moves on an authorship UPDATE (position / totalAuthors /
   *  isConfirmed), which made a metadata sweep read as "publications added". */
  pubsAddedSince: number;
  createdAt: Date;
}

/**
 * Coerce a stored `entries` JSON value to `BiosketchEntry[]` (#917 v7). BACKWARD-COMPAT: rows
 * written before v7 persisted entries as a plain `string[]`, so a bare string becomes
 * `{ title: "", body: s }`; a new `{ title, body }` object is carried through (a missing/non-string
 * title defaults to `""`). Anything else in the array is dropped.
 */
export function coerceEntries(value: unknown): BiosketchEntry[] {
  if (!Array.isArray(value)) return [];
  const out: BiosketchEntry[] = [];
  for (const e of value) {
    if (typeof e === "string") {
      out.push({ title: "", body: e });
    } else if (e && typeof e === "object" && !Array.isArray(e)) {
      const o = e as { title?: unknown; body?: unknown };
      if (typeof o.body === "string") {
        out.push({ title: typeof o.title === "string" ? o.title : "", body: o.body });
      }
    }
  }
  return out;
}

function coerceProducts(value: unknown): BiosketchProducts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<BiosketchProducts>;
  if (!Array.isArray(v.related) || !Array.isArray(v.otherSignificant)) return null;
  return {
    related: v.related,
    otherSignificant: v.otherSignificant,
    relatedFromAims: Boolean(v.relatedFromAims),
  };
}

function coerceSources(value: unknown): BiosketchContributionSources[] | null {
  if (!Array.isArray(value)) return null;
  const out: BiosketchContributionSources[] = [];
  for (const s of value) {
    const ss = s as Partial<BiosketchContributionSources>;
    if (typeof ss.contributionIndex === "number" && Array.isArray(ss.pmids)) {
      out.push({
        contributionIndex: ss.contributionIndex,
        pmids: ss.pmids.filter((p): p is string => typeof p === "string"),
      });
    }
  }
  return out.length > 0 ? out : null;
}

/** The column set both readers select — one shape, so `toSummary` fits both. */
const GENERATION_SELECT = {
  id: true,
  mode: true,
  entries: true,
  projectTitle: true,
  projectAims: true,
  model: true,
  promptVersion: true,
  params: true,
  products: true,
  sources: true,
  createdByCwid: true,
  impersonatedCwid: true,
  label: true,
  createdAt: true,
} as const;

type GenerationRow = {
  id: string;
  mode: string;
  entries: unknown;
  projectTitle: string | null;
  projectAims: string | null;
  model: string;
  promptVersion: string | null;
  params: unknown;
  products: unknown;
  sources: unknown;
  createdByCwid: string;
  impersonatedCwid: string | null;
  label: string | null;
  createdAt: Date;
};

/** `pubsAddedSince` is a per-LIST computation (one authorship read spanning every listed draft),
 *  so the single-row reader passes 0 — the worksheet has no nudge. */
function toSummary(row: GenerationRow, pubsAddedSince: number): BiosketchGenerationSummary {
  // The stored params Json predates a `projectTitle`/`aims` field, so re-seed them from the
  // first-class columns before normalizing — so a restore recovers the project framing.
  const rawParams = (row.params && typeof row.params === "object" ? row.params : {}) as Record<
    string,
    unknown
  >;
  const params = normalizeBiosketchParams({
    ...rawParams,
    projectTitle: row.projectTitle ?? rawParams.projectTitle ?? "",
    aims: row.projectAims ?? rawParams.aims ?? "",
  });
  return {
    id: row.id,
    mode: row.mode,
    entries: coerceEntries(row.entries),
    projectTitle: row.projectTitle,
    projectAims: row.projectAims,
    model: row.model,
    promptVersion: row.promptVersion,
    params,
    products: coerceProducts(row.products),
    sources: coerceSources(row.sources),
    createdByCwid: row.createdByCwid,
    impersonatedCwid: row.impersonatedCwid,
    label: row.label,
    pubsAddedSince,
    createdAt: row.createdAt,
  };
}

/**
 * The scholar's recent biosketch generations, newest first, capped at
 * {@link BIOSKETCH_HISTORY_LIMIT}. `params` is re-normalized on read so a row written under an
 * older params shape still yields a usable {@link BiosketchParams}. Reads only (`db.read`).
 */
export async function listBiosketchGenerations(
  cwid: string,
): Promise<BiosketchGenerationSummary[]> {
  const rows = await db.read.biosketchGeneration.findMany({
    where: { cwid },
    orderBy: { createdAt: "desc" },
    take: BIOSKETCH_HISTORY_LIMIT,
    select: GENERATION_SELECT,
  });
  // #2654 — ONE read for the staleness nudge: every confirmed authorship LINKED after the OLDEST
  // listed draft (rows are newest-first, so that is the last one), then counted per draft in
  // memory. Bounded by what the nightly added since the scholar's oldest kept draft, not by the
  // corpus. #2668: keyed on `createdAt` (set once), not `lastRefreshedAt` (bumped on update).
  const oldest = rows.at(-1)?.createdAt;
  const addedAt = oldest
    ? (
        await db.read.publicationAuthor.findMany({
          where: { cwid, isConfirmed: true, createdAt: { gt: oldest } },
          select: { createdAt: true },
        })
      ).map((a) => a.createdAt.getTime())
    : [];
  return rows.map((row) =>
    toSummary(row, addedAt.filter((t) => t > row.createdAt.getTime()).length),
  );
}

/**
 * One generation by id, or null (#2652 — the SciENcv worksheet is per saved generation and is
 * keyed on the row, not the history window, so a run older than the 20-row list still opens).
 * The caller authorizes on the returned `cwid` — this read is NOT an authorization gate.
 */
export async function getBiosketchGeneration(
  id: string,
): Promise<(BiosketchGenerationSummary & { cwid: string }) | null> {
  const row = await db.read.biosketchGeneration.findUnique({
    where: { id },
    select: { ...GENERATION_SELECT, cwid: true },
  });
  return row ? { ...toSummary(row, 0), cwid: row.cwid } : null;
}
