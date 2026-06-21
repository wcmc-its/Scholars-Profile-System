/**
 * The controls for the NIH-biosketch prose generator (#917 v5,
 * `docs/overview-generator-prompt-v5.md` + `docs/overview-generator-v5-handoff.md`).
 *
 * This is a PURPOSE that reuses the overview generator's substrate (the `OverviewFacts`
 * + `assembleOverviewFacts` + the entity-provenance floor + the Opus model) but swaps
 * voice (first person, forced), grounding contract (significance ON — the "(b)-relaxation"),
 * and output schema (up to five character-capped Contributions to Science, OR one Personal
 * Statement). It is NOT a prompt VERSION of the overview (the version registry iterates one
 * artifact); it is a parallel generator.
 *
 * `normalizeBiosketchParams` is the trust boundary, mirroring `normalizeOverviewParams`:
 * a request body's params is never used as-is. Unknown enums fall back to the default,
 * the contribution count is clamped, and the free-text inputs (project title / aims /
 * instructions) are coerced, trimmed, and clamped. It never throws — a garbage body
 * normalizes to a usable shape. The Personal Statement REQUIRED inputs (project title +
 * aims) are enforced separately by {@link missingPersonalStatementInputs} so the route can
 * return a precise 400, rather than silently degrading.
 */

import {
  defaultBiosketchPromptVersionId,
  isValidBiosketchPromptVersionId,
  type BiosketchPromptVersionId,
} from "@/lib/edit/biosketch-prompt-versions";

/** Which biosketch artifact to draft. */
export type BiosketchMode = "contributions" | "personal_statement";

/**
 * One parsed biosketch entry (#917 v7). `title` is the short subject heading a v7 contribution
 * carries (the NIH "Contributions to Science" heading format) — EMPTY for v5 / v6 contributions
 * and for a Personal Statement, which has no heading. `body` is the narrative prose, and is what
 * the character cap, the overflow check, and the faithfulness pass all key on (the title is a
 * short label, not graded prose). Lives here (a client-safe module) so both the server generator
 * and the client result card can share it.
 */
export type BiosketchEntry = { title: string; body: string };

/** Up to five Contributions to Science (NIH 2026 format). The model writes FEWER when the
 *  scholar has fewer genuinely distinct bodies of work — the count is never padded. */
export const BIOSKETCH_MAX_CONTRIBUTIONS = 5;

/** Per-Contribution character ceiling (~330 words). A CEILING, never a target. */
export const BIOSKETCH_CONTRIBUTION_MAX_CHARS = 2_000;
/** Personal Statement character ceiling (~580 words). */
export const BIOSKETCH_STATEMENT_MAX_CHARS = 3_500;

/** Free-text ceilings — bounded so they can't bloat the prompt or the cost cap. */
export const BIOSKETCH_PROJECT_TITLE_MAX = 300;
export const BIOSKETCH_AIMS_MAX = 3_000;
export const BIOSKETCH_INSTRUCTIONS_MAX = 500;
export const BIOSKETCH_EMPHASIS_MAX = 200;

/** The steering controls a biosketch generate request carries. The Personal Statement
 *  sub-mode additionally REQUIRES `projectTitle` + `aims` (enforced at the route). */
export type BiosketchParams = {
  mode: BiosketchMode;
  /** Contributions only: the ceiling on how many entries to produce (1..5). The model
   *  may return fewer; this never forces padding. Ignored for Personal Statement. */
  maxContributions: number;
  /** Personal Statement only: the proposed project's title. REQUIRED for that mode. */
  projectTitle: string;
  /** Personal Statement only: the proposed project's specific aims. REQUIRED for that mode. */
  aims: string;
  /** Optional: weight the selection toward a research area or role (e.g. "clinical",
   *  "AAV gene therapy"). UNTRUSTED; trimmed and clamped. Steers emphasis only. */
  emphasis: string;
  /** Optional free-text steering note — UNTRUSTED; trimmed, <= BIOSKETCH_INSTRUCTIONS_MAX. */
  instructions: string;
  /** The biosketch prompt version to generate with (#917 v6). DERIVED from
   *  `defaultBiosketchPromptVersionId()` on the default; a non-default value is honored only
   *  for a privileged actor (the route downgrades others). Persisted for A/B + restore. */
  promptVersion: BiosketchPromptVersionId;
};

/** The default a fresh biosketch panel opens with — and the fallback every unknown enum
 *  normalizes to. Contributions mode, all five entries permitted. */
export const DEFAULT_BIOSKETCH_PARAMS: BiosketchParams = {
  mode: "contributions",
  maxContributions: BIOSKETCH_MAX_CONTRIBUTIONS,
  projectTitle: "",
  aims: "",
  emphasis: "",
  instructions: "",
  // DERIVED, never a literal — so the cdk `BIOSKETCH_PROMPT_VERSION_DEFAULT` lever steers it.
  promptVersion: defaultBiosketchPromptVersionId(),
};

const MODES: readonly BiosketchMode[] = ["contributions", "personal_statement"];

/** The character ceiling for a single rendered unit of a given mode. */
export function biosketchCharCap(mode: BiosketchMode): number {
  return mode === "personal_statement"
    ? BIOSKETCH_STATEMENT_MAX_CHARS
    : BIOSKETCH_CONTRIBUTION_MAX_CHARS;
}

/** Clamp `maxContributions` to [1, 5]; a non-finite/garbage value → the full 5. */
function clampMaxContributions(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return BIOSKETCH_MAX_CONTRIBUTIONS;
  return Math.min(BIOSKETCH_MAX_CONTRIBUTIONS, Math.max(1, n));
}

function clampString(raw: unknown, max: number): string {
  return String(raw ?? "").trim().slice(0, max);
}

/**
 * Coerce an untrusted `params` value into a usable {@link BiosketchParams}. The trust
 * boundary for the biosketch generate route — `body.params` is NEVER used as-is. Never
 * throws: a garbage body yields the default-shaped object, not an error. Required-input
 * enforcement for Personal Statement is a SEPARATE step ({@link missingPersonalStatementInputs}).
 */
export function normalizeBiosketchParams(raw: unknown): BiosketchParams {
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const mode: BiosketchMode =
    typeof obj.mode === "string" && (MODES as readonly string[]).includes(obj.mode)
      ? (obj.mode as BiosketchMode)
      : DEFAULT_BIOSKETCH_PARAMS.mode;

  return {
    mode,
    maxContributions: clampMaxContributions(obj.maxContributions),
    projectTitle: clampString(obj.projectTitle, BIOSKETCH_PROJECT_TITLE_MAX),
    aims: clampString(obj.aims, BIOSKETCH_AIMS_MAX),
    emphasis: clampString(obj.emphasis, BIOSKETCH_EMPHASIS_MAX),
    instructions: clampString(obj.instructions, BIOSKETCH_INSTRUCTIONS_MAX),
    // Untrusted: a non-default version posted by an unprivileged actor is downgraded at the
    // route; here we only guarantee a VALID id (unknown → the live default).
    promptVersion: isValidBiosketchPromptVersionId(obj.promptVersion)
      ? obj.promptVersion
      : defaultBiosketchPromptVersionId(),
  };
}

/**
 * The Personal Statement sub-mode REQUIRES a project title and aims — without them the
 * model cannot honestly write the "directly relevant experience" framing (spec §USER-TURN).
 * Returns the list of missing required field names (`[]` when the inputs are satisfied, or
 * when the mode is Contributions, which needs neither). The route turns a non-empty result
 * into a 400 rather than generating a degraded statement.
 */
export function missingPersonalStatementInputs(params: BiosketchParams): string[] {
  if (params.mode !== "personal_statement") return [];
  const missing: string[] = [];
  if (params.projectTitle.length === 0) missing.push("projectTitle");
  if (params.aims.length === 0) missing.push("aims");
  return missing;
}
