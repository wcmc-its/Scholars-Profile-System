/**
 * The overview-generator PROMPT VERSION registry (#742, `docs/overview-prompt-versioning-spec.md`).
 *
 * A "prompt version" is a swappable bundle — system prompt + user-turn directive
 * wording + word bands + theme labels — so the generator can be iterated and A/B
 * tested without a hard cutover. This module holds the CLIENT-SAFE half of that
 * registry: the version metadata (id / label / description / status / optional
 * model pin / theme-label overrides), the default resolver, and small display
 * helpers. It has NO server dependencies (no Bedrock SDK, no `lib/db`), so the
 * generate-controls UI and the version history can import it into the browser
 * bundle.
 *
 * The PROMPT CONTENT itself — the system-prompt strings and the word-band
 * directives — lives in `lib/edit/overview-generator.ts` (server-only), keyed by
 * the SAME ids defined here. The split keeps the heavyweight gateway imports out
 * of the client while the metadata that both sides need (ids, labels, theme
 * labels) has one home.
 *
 * Versioning rule (spec §3): theme KEYS are stable across versions — only the
 * LABELS, directive wording, and word bands are version-scoped — so a stored
 * selection (`OverviewParams.elements` / the deltas) never breaks when the
 * default version changes.
 */
import type { OverviewElement } from "@/lib/edit/overview-params";

/** The known prompt-version ids. Extend as new versions are authored. */
export type OverviewPromptVersionId = "v2" | "v3" | "v4";

/** A version's lifecycle status — drives ordering / labelling in the selector. */
export type OverviewPromptVersionStatus = "default" | "experimental" | "deprecated";

/** The CLIENT-SAFE metadata for one prompt version. The prompt CONTENT (system
 *  prompt, word bands) lives server-side in `overview-generator.ts` under the
 *  same id; this is everything the UI + the history display need. */
export type OverviewPromptVersionMeta = {
  id: OverviewPromptVersionId;
  /** Selector label, e.g. "v3 — keyword-rich narrative". */
  label: string;
  /** One-line description shown under the selector to superuser / curator. */
  description: string;
  status: OverviewPromptVersionStatus;
  /**
   * An optional model PIN for this version (a cross-region Bedrock inference
   * profile id). Almost always unset — the version then runs on the operator's
   * `OVERVIEW_GENERATE_MODEL` env or the generator's `DEFAULT_MODEL`. Set it only
   * to tie a version to a specific model for a prompt×model experiment. The
   * IAM policy scopes Bedrock to the `claude-sonnet-4-*` family, so a pin outside
   * that family would be denied at invoke time.
   */
  model?: string;
  /**
   * Version-scoped theme-label overrides. Keys are STABLE {@link OverviewElement}
   * ids; only the displayed label differs. A key absent here falls back to the
   * canonical `OVERVIEW_ELEMENTS` label. This is how v3 renames the `key_findings`
   * theme from "Key findings & significance" → "Findings & their implications"
   * (spec §4: drop the importance-rating framing the grounding floor bans) without
   * touching the stored element key.
   */
  elementLabels?: Partial<Record<OverviewElement, string>>;
  /**
   * Whether this version's grounding floor PERMITS a quantitative finding reported
   * in a publication `synopsis` (e.g. a measured percentage). Consumed SERVER-SIDE
   * by the post-generation faithfulness pass (`overview-generator.ts`) so the pass
   * stays in step with the prompt: when true, a synopsis-stated number is NOT flagged
   * as a fabrication. v3 sets this; v2 (which bans all numbers but publicationCount /
   * yearsActive) leaves it false. Bibliometrics are forbidden regardless.
   */
  permitsSynopsisFindings?: boolean;
};

/**
 * The registry, keyed by id. Insertion order is the selector display order:
 * the live default first, the experimental A/B next, the rollback baseline last.
 *
 * - **v4** — v3's keyword-rich narrative plus an explicit charge to name the
 *   throughline that unifies the research program (the larger trends, themes, and
 *   patterns connecting the work). Same entity-grounding floor and word band as v3.
 *   The new DEFAULT.
 * - **v3** — the keyword-rich narrative prompt (the v3a design doc). Connects the
 *   scholar's work into its natural threads, richer in discriminating terms,
 *   longer word band. Demoted to the A/B experimental, still selectable.
 * - **v2** — the original concise, cautious prompt. Kept selectable as the rollback
 *   baseline (set `OVERVIEW_PROMPT_VERSION_DEFAULT=v2`).
 */
export const OVERVIEW_PROMPT_VERSION_METAS: Record<
  OverviewPromptVersionId,
  OverviewPromptVersionMeta
> = {
  v4: {
    id: "v4",
    label: "v4 — synthesis & throughline",
    description:
      "v3's keyword-rich narrative plus an explicit charge to name the throughline that unifies the research program — the larger trends, themes, and patterns connecting the work. Same entity-grounding floor.",
    status: "default",
    elementLabels: {
      key_findings: "Findings & their implications",
    },
    permitsSynopsisFindings: true,
  },
  v3: {
    id: "v3",
    label: "v3 — keyword-rich narrative",
    description:
      "Connects the work into its natural threads with richer, more discriminating terms and a longer word band. Same entity-grounding floor.",
    status: "experimental",
    elementLabels: {
      // Drop the importance-rating framing ("significance" is the one axis the
      // grounding floor bans) for scientific-implication framing.
      key_findings: "Findings & their implications",
    },
    // v3's floor permits a quantitative finding from a publication synopsis — the
    // faithfulness pass honors this so it doesn't strip what v3 legitimately allows.
    permitsSynopsisFindings: true,
  },
  v2: {
    id: "v2",
    label: "v2 — concise (legacy)",
    description:
      "The original, more cautious prompt: shorter and terser. Kept for comparison and as the rollback baseline.",
    status: "deprecated",
  },
};

/** All version ids, in selector display order (object insertion order). */
export const OVERVIEW_PROMPT_VERSION_IDS = Object.keys(
  OVERVIEW_PROMPT_VERSION_METAS,
) as OverviewPromptVersionId[];

/** The registry's baseline default version — the constant fallback when no env
 *  override is set. The live default is {@link defaultPromptVersionId}, which lets
 *  an operator roll back without a code change. */
export const OVERVIEW_DEFAULT_PROMPT_VERSION: OverviewPromptVersionId = "v4";

/** Type guard: is `value` a known version id? */
export function isValidPromptVersionId(value: unknown): value is OverviewPromptVersionId {
  return (
    typeof value === "string" &&
    (OVERVIEW_PROMPT_VERSION_IDS as readonly string[]).includes(value)
  );
}

/**
 * The LIVE default version id. Reads `OVERVIEW_PROMPT_VERSION_DEFAULT` (a
 * non-redeploy rollback lever, set per-env in cdk app-stack) and falls back to
 * {@link OVERVIEW_DEFAULT_PROMPT_VERSION} when unset or invalid. On the client the
 * non-public env var is undefined, so this returns the constant — which matches
 * the registry default; the server route re-normalizes authoritatively.
 */
export function defaultPromptVersionId(): OverviewPromptVersionId {
  const env = process.env.OVERVIEW_PROMPT_VERSION_DEFAULT;
  return isValidPromptVersionId(env) ? env : OVERVIEW_DEFAULT_PROMPT_VERSION;
}

/** The selectable versions (metadata only), in display order — drives the
 *  superuser / curator version dropdown. */
export function listSelectablePromptVersions(): OverviewPromptVersionMeta[] {
  return OVERVIEW_PROMPT_VERSION_IDS.map((id) => OVERVIEW_PROMPT_VERSION_METAS[id]);
}

/** Resolve one theme's label for a version: the version override if present, else
 *  the canonical `fallback` (the `OVERVIEW_ELEMENTS` label). Pure. */
export function promptVersionElementLabel(
  versionId: OverviewPromptVersionId,
  key: OverviewElement,
  fallback: string,
): string {
  return OVERVIEW_PROMPT_VERSION_METAS[versionId]?.elementLabels?.[key] ?? fallback;
}

/**
 * A human-readable model name for display next to the version, e.g.
 * "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "Claude Sonnet 4.5". Best-effort
 * pattern match on the Anthropic Bedrock inference-profile id; falls back to the
 * raw id for anything it doesn't recognize. Pure / display-only — never used for
 * routing.
 */
export function humanizeModelId(modelId: string): string {
  const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(modelId);
  if (!m) return modelId;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `Claude ${family} ${m[2]}.${m[3]}`;
}

/** Per-MILLION-token Bedrock list prices (USD), keyed by model-family fragment.
 *  Display-only — drives the superuser cost estimate, never routing. */
const MODEL_PRICE_PER_MTOK: { test: RegExp; input: number; output: number }[] = [
  { test: /claude-opus/i, input: 5, output: 25 },
  { test: /claude-sonnet/i, input: 3, output: 15 },
  { test: /claude-haiku/i, input: 1, output: 5 },
  { test: /claude-fable/i, input: 10, output: 50 },
];
/** Typical overview-draft token shape: profile facts in, short prose out. */
const OVERVIEW_DRAFT_INPUT_TOKENS = 5000;
const OVERVIEW_DRAFT_OUTPUT_TOKENS = 300;
/** Best-effort USD estimate for ONE draft on `modelId`; null when the model is
 *  unrecognized. A grounding (faithfulness) pass, when enabled, multiplies this
 *  by roughly 3 (two extra Bedrock calls). */
export function estimateDraftCostUsd(modelId: string): number | null {
  const p = MODEL_PRICE_PER_MTOK.find((x) => x.test.test(modelId));
  if (!p) return null;
  return (
    (OVERVIEW_DRAFT_INPUT_TOKENS / 1_000_000) * p.input +
    (OVERVIEW_DRAFT_OUTPUT_TOKENS / 1_000_000) * p.output
  );
}
