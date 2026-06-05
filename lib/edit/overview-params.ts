/**
 * The parameterized controls for the overview-statement generator (#742 Phase A,
 * `docs/overview-statement-generator-spec.md` § Reuse — the RSG control surface).
 *
 * Phase A turns the v1 fixed-prompt generator into a steerable one: the `/edit`
 * Generate panel exposes voice / tone / length / which themes to emphasize / an
 * optional free-text steering note, and those choices become prompt directives
 * (`lib/edit/overview-generator.ts` reads this shape). The grounding contract is
 * unchanged — params steer EMPHASIS, TONE, and FRAMING only; they can never make
 * the model assert a fact not in `OverviewFacts` (SPEC § threat model — prompt
 * injection). The free-text `instructions` are explicitly UNTRUSTED: they ride in
 * the user turn as a delimited data block, never in the system prompt.
 *
 * `normalizeOverviewParams` is the trust boundary: a request body's `params` is
 * never used as-is. Unknown enums fall back to the default, the element list is
 * filtered to known keys, and `instructions` is coerced + trimmed + clamped. It
 * never throws, so a garbage body normalizes to a usable shape rather than a 400.
 */

/** Narrative voice — the bio's grammatical person. */
export type OverviewVoice = "third" | "first";
/** Register — how formal the prose reads. */
export type OverviewTone = "formal" | "neutral" | "conversational";
/** Target length band (the hard 20k sanitizer cap still applies downstream). */
export type OverviewLength = "short" | "standard" | "extended";
/** A theme the scholar can ask the draft to emphasize. */
export type OverviewElement =
  | "research_focus"
  | "key_findings"
  | "methods"
  | "clinical_applications"
  | "recent_work"
  | "grants_funding"
  | "education_training";

/** The steering controls a generate request carries. `instructions` is already
 *  trimmed and clamped to {@link OVERVIEW_INSTRUCTIONS_MAX} after normalization. */
export type OverviewParams = {
  voice: OverviewVoice;
  tone: OverviewTone;
  length: OverviewLength;
  elements: OverviewElement[];
  /** Optional free-text steering note — UNTRUSTED; trimmed, <= OVERVIEW_INSTRUCTIONS_MAX. */
  instructions: string;
};

/** UI-facing labels for the element checkboxes, in display order. The generator
 *  reuses these labels verbatim in the "Emphasize these themes" directive. */
export const OVERVIEW_ELEMENTS: { key: OverviewElement; label: string }[] = [
  { key: "research_focus", label: "Research focus" },
  { key: "key_findings", label: "Key findings & significance" },
  { key: "methods", label: "Methods" },
  { key: "clinical_applications", label: "Clinical applications" },
  { key: "recent_work", label: "Recent work" },
  { key: "grants_funding", label: "Grants & funding" },
  { key: "education_training", label: "Education & training" },
];

/** Free-text steering note ceiling — generous for a sentence or two of guidance,
 *  bounded so it can't bloat the prompt or the cost cap (SPEC § threat model). */
export const OVERVIEW_INSTRUCTIONS_MAX = 500;

/** The defaults a fresh Generate panel opens with — and the fallback every
 *  unknown enum normalizes to. Mirrors the v1 fixed prompt (third person,
 *  formal, ~120–180 words) with a sensible starter set of emphasized themes. */
export const DEFAULT_OVERVIEW_PARAMS: OverviewParams = {
  voice: "third",
  tone: "formal",
  length: "standard",
  elements: ["research_focus", "key_findings", "recent_work"],
  instructions: "",
};

/** The known enum members, derived from the labels list / defaults so the
 *  normalizer and the type stay in lockstep. */
const VOICES: readonly OverviewVoice[] = ["third", "first"];
const TONES: readonly OverviewTone[] = ["formal", "neutral", "conversational"];
const LENGTHS: readonly OverviewLength[] = ["short", "standard", "extended"];
const ELEMENT_KEYS: ReadonlySet<OverviewElement> = new Set(
  OVERVIEW_ELEMENTS.map((e) => e.key),
);

/** Pick `value` from `allowed` when it is a member, else `fallback`. The cast is
 *  safe — membership is checked before it is returned. */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Coerce an untrusted `params` value into a usable {@link OverviewParams}. The
 * trust boundary for the generate route — `body.params` is NEVER used as-is.
 *
 * - `voice` / `tone` / `length`: unknown or missing → the {@link DEFAULT_OVERVIEW_PARAMS} value.
 * - `elements`: a non-array → `[]`; otherwise filtered to known keys and de-duped
 *   (order preserved). An empty list is allowed — it means "no extra emphasis".
 * - `instructions`: `String(raw ?? "")`, trimmed, then sliced to
 *   {@link OVERVIEW_INSTRUCTIONS_MAX}.
 *
 * Never throws — garbage in yields the default-shaped object, not an error.
 */
export function normalizeOverviewParams(raw: unknown): OverviewParams {
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const seen = new Set<OverviewElement>();
  const elements = Array.isArray(obj.elements)
    ? obj.elements.filter((key): key is OverviewElement => {
        if (!ELEMENT_KEYS.has(key as OverviewElement) || seen.has(key as OverviewElement)) {
          return false;
        }
        seen.add(key as OverviewElement);
        return true;
      })
    : [];

  const instructions = String(obj.instructions ?? "")
    .trim()
    .slice(0, OVERVIEW_INSTRUCTIONS_MAX);

  return {
    voice: pickEnum(obj.voice, VOICES, DEFAULT_OVERVIEW_PARAMS.voice),
    tone: pickEnum(obj.tone, TONES, DEFAULT_OVERVIEW_PARAMS.tone),
    length: pickEnum(obj.length, LENGTHS, DEFAULT_OVERVIEW_PARAMS.length),
    elements,
    instructions,
  };
}
