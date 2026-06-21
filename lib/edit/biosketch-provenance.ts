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
import { normalizeBiosketchParams, type BiosketchParams } from "@/lib/edit/biosketch-params";
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";

/** How many recent biosketches the history panel surfaces (matches the overview cap). */
const BIOSKETCH_HISTORY_LIMIT = 20;

/** One biosketch generation history row, shaped for the `/edit` history panel. */
export interface BiosketchGenerationSummary {
  id: string;
  mode: string;
  /** The generated entries (1..5 contributions, or one statement). */
  entries: string[];
  /** Personal Statement project framing (or the optional contributions aims), when present. */
  projectTitle: string | null;
  projectAims: string | null;
  model: string;
  /** The authoritative, queryable prompt-version column ("v5" / "v6"). */
  promptVersion: string | null;
  /** Re-normalized steering params (the trust boundary, applied on read) — carries the
   *  `promptVersion` for "Use these settings" restore. */
  params: BiosketchParams;
  /** The Products list (Contributions mode), or null. */
  products: BiosketchProducts | null;
  createdAt: Date;
}

function coerceEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
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
    select: {
      id: true,
      mode: true,
      entries: true,
      projectTitle: true,
      projectAims: true,
      model: true,
      promptVersion: true,
      params: true,
      products: true,
      createdAt: true,
    },
  });
  return rows.map((row) => {
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
      createdAt: row.createdAt,
    };
  });
}
