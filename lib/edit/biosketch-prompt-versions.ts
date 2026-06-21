/**
 * Biosketch prompt-version registry (#917 v6) — the client-safe half of the biosketch
 * prompt-versioning system, mirroring `overview-prompt-versions.ts`. It carries NO server
 * dependencies so it is importable into the browser bundle (the generate-controls selector).
 *
 * The biosketch version namespace is INTERNAL to the biosketch artifact (Contributions to
 * Science / Personal Statement) and is NOT the overview `v2/v3/v4` namespace — a different
 * artifact, a different registry. The prompt CONTENT for each version lives in
 * `biosketch-generator.ts` (`BIOSKETCH_PROMPT_IMPLS`); this module is identity + metadata
 * + the env-driven default resolver only.
 */

export type BiosketchPromptVersionId = "v5" | "v6";

export type BiosketchPromptVersionStatus = "default" | "experimental" | "deprecated";

export type BiosketchPromptVersionMeta = {
  id: BiosketchPromptVersionId;
  /** Selector label, e.g. "v6 — role, four elements, grounded impact". */
  label: string;
  /** One-line description shown under the selector to superuser / curator. */
  description: string;
  status: BiosketchPromptVersionStatus;
  /** Bedrock inference-profile pin for this version, when it overrides the default model. */
  model?: string;
  /**
   * #917 v6 — whether this version grounds impact on the FACTS bibliometrics (citation count /
   * NIH iCite RCR), relaxing the absolute external-uptake ban to a grounded conditional. v5 = no
   * (bibliometrics fully banned); v6 = yes. Consumed server-side by the generator (which model-
   * facts projection to use) and the faithfulness pass (`permitBibliometrics`).
   */
  groundsImpact?: boolean;
};

/**
 * Insertion order = selector order (default first). v6 is the overhaul (role per contribution,
 * the four NIH elements, grounded impact, length band, em-dash ban); v5 is the prior baseline,
 * kept for A/B + as the rollback target.
 */
export const BIOSKETCH_PROMPT_VERSION_METAS: Record<
  BiosketchPromptVersionId,
  BiosketchPromptVersionMeta
> = {
  v6: {
    id: "v6",
    label: "v6 — role, four elements, grounded impact",
    description:
      "Names the faculty member's specific role in each contribution, enforces the four NIH elements (problem, finding, influence, role), grounds impact on the publication's NIH iCite RCR / citation count when present, targets a fuller length band, and bans em dashes. Same entity-grounding floor.",
    status: "default",
    groundsImpact: true,
  },
  v5: {
    id: "v5",
    label: "v5 — baseline (significance on)",
    description:
      "The prior biosketch prompt: significance of a grounded finding turned on, external uptake and all bibliometrics banned. Kept for comparison and as the rollback baseline.",
    status: "deprecated",
  },
};

/** The ids in selector order (insertion order of the metas map). */
export const BIOSKETCH_PROMPT_VERSION_IDS = Object.keys(
  BIOSKETCH_PROMPT_VERSION_METAS,
) as BiosketchPromptVersionId[];

/** The compiled-in baseline default (the rollback target if the env lever is unset/invalid). */
export const BIOSKETCH_DEFAULT_PROMPT_VERSION: BiosketchPromptVersionId = "v6";

export function isValidBiosketchPromptVersionId(
  value: unknown,
): value is BiosketchPromptVersionId {
  return (
    typeof value === "string" &&
    (BIOSKETCH_PROMPT_VERSION_IDS as readonly string[]).includes(value)
  );
}

/**
 * The LIVE default biosketch prompt version — reads `BIOSKETCH_PROMPT_VERSION_DEFAULT`
 * (wired per-env in cdk app-stack) so ops can roll the default back without a code change.
 * Falls back to the compiled-in baseline when the env var is unset or invalid. Called
 * server-side only (params default + route); mirrors `defaultPromptVersionId()`.
 */
export function defaultBiosketchPromptVersionId(): BiosketchPromptVersionId {
  const env = process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT;
  return isValidBiosketchPromptVersionId(env) ? env : BIOSKETCH_DEFAULT_PROMPT_VERSION;
}

/** The versions to offer in the selector, in insertion order. */
export function listSelectableBiosketchPromptVersions(): BiosketchPromptVersionMeta[] {
  return BIOSKETCH_PROMPT_VERSION_IDS.map((id) => BIOSKETCH_PROMPT_VERSION_METAS[id]);
}

/** Whether a version grounds impact on FACTS bibliometrics (#917 v6). */
export function biosketchVersionGroundsImpact(id: BiosketchPromptVersionId): boolean {
  return BIOSKETCH_PROMPT_VERSION_METAS[id]?.groundsImpact === true;
}
