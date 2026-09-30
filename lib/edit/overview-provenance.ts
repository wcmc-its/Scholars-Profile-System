/**
 * Overview version history + provenance reads (#742 Phase B,
 * `docs/overview-statement-generator-spec.md` § Version history & provenance).
 *
 * Phase A produces a draft and the owner saves it through `/api/edit/field`.
 * Phase B records the lineage: every successful Generate appends an
 * `OverviewGeneration` row (the version HISTORY the scholar browses + reloads),
 * and every overview save upserts an `OverviewProvenance` row answering "is the
 * live bio authored, generated, or generated-then-edited, and from which
 * generation / model?". This module is the READ side of that record plus the one
 * pure helper (`computeOverviewOrigin`) the save path uses to classify an
 * overview save against the generation it derived from.
 *
 * Read-only — the writes live on the write paths (`/api/edit/overview/generate`
 * appends a generation; `/api/edit/field` upserts provenance in-transaction).
 * Node-runtime only (Prisma).
 */
import { db } from "@/lib/db";
import { sanitizeOverviewHtml } from "@/lib/edit/validators";
import { sanitizeVIVOHtml } from "@/lib/utils";
import { normalizeOverviewParams, type OverviewParams } from "@/lib/edit/overview-params";

/** The provenance classification of the currently-published overview. */
export type OverviewOrigin = "authored" | "generated" | "generated_edited";

/** How many recent generations the history panel surfaces — bounded so the
 *  read stays cheap and the panel stays scannable (SPEC § Version history). */
const GENERATION_HISTORY_LIMIT = 20;

/**
 * Classify a saved overview against the generation it derived from: byte-equal to
 * the generation's text ⇒ `"generated"` (the scholar saved the draft verbatim);
 * otherwise `"generated_edited"` (the scholar tweaked it after generating). A
 * hand-authored save with no source generation is `"authored"` and never reaches
 * this helper — the caller assigns it directly (SPEC § provenance rules).
 *
 * The two inputs are sanitized by compatible DOMPurify configs — `storedText` by
 * `sanitizeOverview` (the save path) and `generationText` by `sanitizeOverviewHtml`
 * (the generate path). They agree byte-for-byte on any real (non-empty) draft, so a
 * verbatim save classifies as `"generated"`. Keep the two sanitizers compatible if
 * either is ever extended (e.g. a new empty-collapse rule), or verbatim saves would
 * mis-classify as `"generated_edited"`.
 */
export function computeOverviewOrigin(
  storedText: string,
  generationText: string,
): "generated" | "generated_edited" {
  return storedText === generationText ? "generated" : "generated_edited";
}

/** One generation history row, shaped for the `/edit` Versions panel. */
export interface OverviewGenerationSummary {
  id: string;
  model: string;
  /** The prompt version that generated this draft (#742). Null for rows written
   *  before versioning shipped; `params.promptVersion` carries the same value for
   *  new rows, but this is the authoritative, queryable column. */
  promptVersion: string | null;
  params: OverviewParams;
  createdAt: Date;
  text: string;
  /** The History-panel label, or null for the default "AI draft N". */
  name: string | null;
  createdByCwid: string;
}

/**
 * The scholar's recent generation history, newest first, capped at
 * {@link GENERATION_HISTORY_LIMIT}. `params` is re-normalized on read — the
 * stored `Json` blob is shaped by the same trust boundary the generate route
 * applies, so a row written by an older shape still yields a usable
 * {@link OverviewParams}. Reads only (`db.read`).
 */
export async function listOverviewGenerations(
  cwid: string,
): Promise<OverviewGenerationSummary[]> {
  const rows = await db.read.overviewGeneration.findMany({
    // Only SUCCEEDED runs reach the history/restore panel — failed attempts are now
    // persisted too (audit/debug trail) but a draft-less, error-only row is not
    // something the scholar can reload or regenerate from.
    // Hidden (deleted from the History panel) drafts stay for the audit trail.
    where: { cwid, status: "succeeded", hiddenAt: null },
    orderBy: { createdAt: "desc" },
    take: GENERATION_HISTORY_LIMIT,
    select: {
      id: true,
      model: true,
      promptVersion: true,
      params: true,
      createdAt: true,
      text: true,
      name: true,
      createdByCwid: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    model: row.model,
    promptVersion: row.promptVersion,
    params: normalizeOverviewParams(row.params),
    createdAt: row.createdAt,
    // `text` is now nullable (failed rows store NULL), but the status filter above
    // guarantees these are succeeded rows with a draft; coerce defensively.
    text: row.text ?? "",
    name: row.name,
    createdByCwid: row.createdByCwid,
  }));
}

/** One saved overview for the History panel, newest first. */
export interface OverviewVersionSummary {
  id: string;
  html: string;
  origin: OverviewOrigin;
  savedByCwid: string;
  createdAt: Date;
}

/** The scholar's recent saved overviews (not hidden), newest first. The newest is
 *  the live text. Reads only (`db.read`). */
export async function listOverviewVersions(cwid: string): Promise<OverviewVersionSummary[]> {
  const rows = await db.read.overviewVersion.findMany({
    where: { cwid, hiddenAt: null },
    orderBy: { createdAt: "desc" },
    take: GENERATION_HISTORY_LIMIT,
    select: { id: true, html: true, origin: true, savedByCwid: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, origin: r.origin as OverviewOrigin }));
}

/** The overview imported from the previous profile system (the ETL column,
 *  sanitized exactly as the public read does), or null when there is none. */
export async function loadImportedOverview(cwid: string): Promise<string | null> {
  const row = await db.read.scholar.findUnique({ where: { cwid }, select: { overview: true } });
  if (!row?.overview) return null;
  const clean = sanitizeOverviewHtml(sanitizeVIVOHtml(row.overview));
  return clean === "" ? null : clean;
}

/** Display names for the cwids that drafted / saved history rows; a cwid with no
 *  scholar row (e.g. a staff superuser) is simply absent. */
export async function loadHistoryNames(cwids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(cwids)];
  if (unique.length === 0) return {};
  const rows = await db.read.scholar.findMany({
    where: { cwid: { in: unique } },
    select: { cwid: true, preferredName: true },
  });
  return Object.fromEntries(rows.map((r) => [r.cwid, r.preferredName]));
}

/**
 * The provenance of the scholar's currently-published overview, or `null` when
 * none has been recorded (no overview saved since Phase B shipped). Reads only
 * (`db.read`).
 */
export async function loadOverviewProvenance(cwid: string): Promise<{
  origin: OverviewOrigin;
  model: string | null;
  sourceGenerationId: string | null;
  updatedAt: Date;
} | null> {
  const row = await db.read.overviewProvenance.findUnique({
    where: { cwid },
    select: { origin: true, model: true, sourceGenerationId: true, updatedAt: true },
  });
  if (!row) return null;
  return {
    origin: row.origin as OverviewOrigin,
    model: row.model,
    sourceGenerationId: row.sourceGenerationId,
    updatedAt: row.updatedAt,
  };
}
