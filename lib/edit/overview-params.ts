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
 *  formal, ~120–180 words) with a sensible starter set of emphasized themes.
 *  Methods is default-on (#886): the generator's method source is now the live
 *  `scholar_family` rollup — the SAME data the public Methods & tools panel
 *  shows — so the emphasis can be grounded. The #765 §2 pmid_count >= 2 floor
 *  governs the default family selection, and `buildOverviewUserPrompt` drops the
 *  Methods emphasis when a scholar has no families, so default-on is honest even
 *  before/without the rollup. */
export const DEFAULT_OVERVIEW_PARAMS: OverviewParams = {
  voice: "third",
  tone: "formal",
  length: "standard",
  elements: ["research_focus", "key_findings", "methods", "recent_work"],
  instructions: "",
};

/** The known enum members, derived from the labels list / defaults so the
 *  normalizer and the type stay in lockstep. */
const VOICES: readonly OverviewVoice[] = ["third", "first"];
const TONES: readonly OverviewTone[] = ["formal", "neutral", "conversational"];
const LENGTHS: readonly OverviewLength[] = ["short", "standard", "extended"];
const ELEMENT_KEYS: ReadonlySet<OverviewElement> = new Set(OVERVIEW_ELEMENTS.map((e) => e.key));

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

// ---------------------------------------------------------------------------
// #742 v3.1 — the source selection (which publications / funding / tools ground
// the draft). A separate concern from the steering controls above: the controls
// shape EMPHASIS/TONE, the selection decides WHICH facts the model sees.
// ---------------------------------------------------------------------------

/** Which sources the scholar picked in the drawer. `pmids` key publications,
 *  `grantIds` key funding awards, `toolNames` key methods — the scholar's #799
 *  method-family labels (#886), `[]` when the scholar has no families. */
export type OverviewSelection = {
  pmids: string[];
  grantIds: string[];
  toolNames: string[];
};

/** Publications + funding share this combined budget (decision 3). */
export const OVERVIEW_SELECTION_MAX_ITEMS = 25;
/** Tools carry their own smaller ceiling so a dozen tool names can't crowd out
 *  the papers, which are the heavy grounding (decision 3 / §3.5). */
export const OVERVIEW_SELECTION_MAX_TOOLS = 10;

/** The §2.5 thin-overview floor: below this many resolved publications the overview
 *  reads as thin, so the drawer warns (`overview-include-picker`) AND the generator
 *  is told to keep the draft proportionately brief (§2.3 server-side guard) instead
 *  of padding one or two papers into a full-length bio. Single source of truth for
 *  both surfaces so they can never drift. */
export const OVERVIEW_MIN_PUBLICATIONS = 3;

/** The #765 §2 / §7.4 honesty floor: a method family is only default-selected
 *  when it appears in ≥ 2 publications. Most families have `pmid_count = 1`; a
 *  top-N-by-count default that surfaced single-paper long-tail families would
 *  contradict the Methods rule line ("ranked by how often each appears"). The
 *  client "Top N by score" Methods quick action applies the same floor. Lives
 *  here (not `overview-facts.ts`) so the client picker can import it without
 *  pulling the Prisma/`lib/db` server module into the browser bundle. */
export const OVERVIEW_METHOD_PMID_FLOOR = 2;

/** Coerce an untrusted value to a de-duped, trimmed, non-empty string array.
 *  A non-array, or any non-string member, yields a clean (possibly empty) list. */
function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Coerce an untrusted `selection` into a usable {@link OverviewSelection} — the
 * server trust boundary for the source picker, mirroring
 * {@link normalizeOverviewParams}'s never-throws contract.
 *
 * - Each bucket: a non-array → `[]`; otherwise trimmed, de-duped, non-empty strings.
 * - **Caps:** `pmids` + `grantIds` are clamped to a COMBINED `maxItems` (pmids
 *   keep priority, grants fill the remainder — publications are the heavy
 *   grounding); `toolNames` is clamped to its own `maxTools`.
 * - Ownership is NOT enforced here — that happens in the facts queries
 *   (`where: { cwid, … in }`), so a forged/foreign id simply matches no rows.
 *
 * Never throws — garbage in yields `{ pmids: [], grantIds: [], toolNames: [] }`.
 */
export function normalizeOverviewSelection(
  raw: unknown,
  opts: { maxItems?: number; maxTools?: number } = {},
): OverviewSelection {
  const maxItems = opts.maxItems ?? OVERVIEW_SELECTION_MAX_ITEMS;
  const maxTools = opts.maxTools ?? OVERVIEW_SELECTION_MAX_TOOLS;
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const pmids = toStringArray(obj.pmids).slice(0, maxItems);
  // Funding fills whatever the combined budget has left after publications.
  const grantIds = toStringArray(obj.grantIds).slice(0, Math.max(0, maxItems - pmids.length));
  const toolNames = toStringArray(obj.toolNames).slice(0, maxTools);

  return { pmids, grantIds, toolNames };
}

/** Whether a selection picks at least one source (any bucket). An all-empty
 *  selection means "use the server-computed default" (§3.4). */
export function isOverviewSelectionEmpty(selection: OverviewSelection): boolean {
  return (
    selection.pmids.length === 0 &&
    selection.grantIds.length === 0 &&
    selection.toolNames.length === 0
  );
}

// ---------------------------------------------------------------------------
// #742 spec §2.5 — the THREE-STATE selection model (default / pinned-in /
// excluded), stored as DELTAS against a live auto-set rather than a snapshot of
// checked boxes. The auto-set (the Recommended featured set) is recomputed every
// run; the deltas are durable and re-applied on top. The snapshot
// `OverviewSelection` above is the RESOLVED product the assembler consumes — the
// deltas + the recomputed auto-set produce it via `applyDeltas`.
// ---------------------------------------------------------------------------

/** The drawer's content types. Each keys its records by a stable id: `pmid`
 *  (publications), grant id (funding), family label (methods), appointment/role
 *  id (titles & positions), education-row id (education). */
export type OverviewRecordType = "publication" | "funding" | "method" | "title" | "education";

/** The §2.3 toggles — "led" (the default: work you drove) vs "all" (every
 *  position/role). Surfaced only for publications and funding; the toggle changes
 *  which candidates the auto-set draws from, not the deltas. */
export type OverviewPositionMode = "led" | "all";

/** A per-type bag of record ids. A missing type key means "no delta of this kind
 *  for that type" — identical to an empty array. */
export type OverviewRecordIds = Partial<Record<OverviewRecordType, string[]>>;

/**
 * The durable deltas a scholar has applied to their auto-set (§2.5). `pinned`
 * forces records IN (the centrality override — "add merges into pin"); `excluded`
 * forces records OUT (a persistent veto). Per-type, never global. The two toggles
 * carry the §2.3 systematic-disagreement overrides. Everything else is "default".
 */
export type OverviewSelectionDeltas = {
  pinned: OverviewRecordIds;
  excluded: OverviewRecordIds;
  publicationPositions: OverviewPositionMode;
  fundingRoles: OverviewPositionMode;
};

/** Zero deltas — pure auto-set, both toggles on "led". `isOverviewSelectionDeltasEmpty`
 *  of this is true, which the status line reads as "Using your recommended set". */
export const DEFAULT_OVERVIEW_SELECTION_DELTAS: OverviewSelectionDeltas = {
  pinned: {},
  excluded: {},
  publicationPositions: "led",
  fundingRoles: "led",
};

/** Defensive ceiling on how many ids a single (type, kind) delta bag may carry —
 *  the durable store and the request body are both untrusted, and the effective
 *  selection is re-capped downstream anyway. Generous: a real scholar pins a
 *  handful, not hundreds. */
export const OVERVIEW_DELTA_MAX_PER_BAG = 100;

const RECORD_TYPES: readonly OverviewRecordType[] = [
  "publication",
  "funding",
  "method",
  "title",
  "education",
];
const POSITION_MODES: readonly OverviewPositionMode[] = ["led", "all"];

/** Coerce an untrusted per-type id bag: each known type → a clean, de-duped,
 *  capped string array; unknown keys dropped; non-arrays → omitted. */
function normalizeRecordIds(raw: unknown): OverviewRecordIds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: OverviewRecordIds = {};
  for (const type of RECORD_TYPES) {
    const ids = toStringArray(obj[type]).slice(0, OVERVIEW_DELTA_MAX_PER_BAG);
    if (ids.length > 0) out[type] = ids;
  }
  return out;
}

/**
 * Coerce an untrusted `deltas` value into a usable {@link OverviewSelectionDeltas}
 * — the server trust boundary for the three-state model, mirroring
 * {@link normalizeOverviewSelection}'s never-throws contract. Unknown toggle values
 * fall back to "led"; id bags are filtered to known types, trimmed, de-duped, and
 * capped. Ownership is NOT enforced here (the facts queries do that), so a forged
 * id simply resolves against no candidate.
 */
export function normalizeOverviewSelectionDeltas(raw: unknown): OverviewSelectionDeltas {
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    pinned: normalizeRecordIds(obj.pinned),
    excluded: normalizeRecordIds(obj.excluded),
    publicationPositions: pickEnum(obj.publicationPositions, POSITION_MODES, "led"),
    fundingRoles: pickEnum(obj.fundingRoles, POSITION_MODES, "led"),
  };
}

/** True when the deltas diverge in NO way from the pure auto-set — no pins, no
 *  excludes, both toggles default. The status line reads this as "auto" (§2.5). */
export function isOverviewSelectionDeltasEmpty(deltas: OverviewSelectionDeltas): boolean {
  const noIds = (bag: OverviewRecordIds) => RECORD_TYPES.every((t) => (bag[t]?.length ?? 0) === 0);
  return (
    deltas.publicationPositions === "led" &&
    deltas.fundingRoles === "led" &&
    noIds(deltas.pinned) &&
    noIds(deltas.excluded)
  );
}

/**
 * Resolve ONE type's effective id list (§2.5): `(featured ∪ pinned) \ excluded`,
 * de-duped, exclude winning over pin (a veto is stronger — an unlikely client
 * state, resolved conservatively). Pure.
 *
 * Ordering is governed by `opts.pinsFirst`:
 *   - **default (tail)** — the auto-set's order first, pinned-but-not-featured ids
 *     appended (a pin reaches PAST the default, landing at the tail). Right for
 *     UN-capped types (titles / education), where order is cosmetic.
 *   - **pinsFirst** — surviving pins ahead of the auto-set, so a deliberate pin
 *     SURVIVES a downstream `slice(0, N)` cap instead of being evicted past the
 *     budget (#742 §2.1 decision #3, the pin-loss fix). Right for the capped types
 *     (publications / funding share the 25-item budget; tools their own 10). This
 *     mirrors the client resolver's pins-first order (`overview-resolve.ts`).
 */
export function applyDeltas(
  featured: readonly string[],
  pinned: readonly string[] = [],
  excluded: readonly string[] = [],
  opts: { pinsFirst?: boolean } = {},
): string[] {
  const excludeSet = new Set(excluded);
  const pinSet = new Set(pinned);
  const out: string[] = [];
  const seen = new Set<string>();
  const pushAll = (ids: Iterable<string>) => {
    for (const id of ids) {
      if (excludeSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  };
  if (opts.pinsFirst) {
    pushAll(pinSet);
    pushAll(featured);
  } else {
    pushAll(featured);
    pushAll(pinSet);
  }
  return out;
}

/** Divergence counts for the status line — "1 pinned · 2 hidden" (§2.5: counts
 *  divergences, NOT records; never "9 of 25"). Numberless rendering is the UI's
 *  job; this returns the raw counts. */
export function summarizeOverviewDeltas(deltas: OverviewSelectionDeltas): {
  pinned: number;
  hidden: number;
} {
  const sum = (bag: OverviewRecordIds) =>
    RECORD_TYPES.reduce((n, t) => n + (bag[t]?.length ?? 0), 0);
  return { pinned: sum(deltas.pinned), hidden: sum(deltas.excluded) };
}
