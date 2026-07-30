/**
 * Repair the two text defects that render as a black box glyph on a public page
 * (reported 2026-07-30 on the profile Overview: "Dr. Zarnegar[box]s primary
 * clinical interests...").
 *
 *  1. **cp1252 mojibake.** Source text encoded in windows-1252 and decoded as
 *     Latin-1/UTF-8 leaves the C1 control block (U+0080-U+009F) sitting where a
 *     smart quote or dash belonged - 0x92 is cp1252's right single quote, 0x96
 *     its en dash. C1 controls have no glyph in any font, so the browser falls
 *     back to Last Resort and paints a labelled box. Mapping the code point back
 *     through the cp1252 table recovers the original punctuation exactly; see
 *     `reference_mojibake_is_not_a_diacritic` - NFD/fold cannot touch this,
 *     there is no accent to strip.
 *
 *  2. **Invisible junk.** Zero-width space, BOM, soft hyphen, word joiner and
 *     the C0 controls survive a copy-paste out of a PDF or a publisher's HTML.
 *     Unrecoverable, so they are dropped. U+FFFD is likewise dropped - the
 *     original byte is already lost, and nothing beats a black diamond.
 *
 * Deliberately NOT touched: U+200C-U+200F (ZWNJ/ZWJ/LRM/RLM are load-bearing in
 * Arabic, Persian, Hebrew and Indic text); tab / newline / carriage return, which
 * are real formatting; and Unicode normalization form - a decomposed accent
 * renders correctly, so NFC is a different problem.
 *
 * **Every suspect code point here is built with `String.fromCharCode`, never
 * typed as a literal.** These characters get mangled a SECOND time in transit
 * through a shell, an editor or a copy-paste while still LOOKING right on
 * screen; the first draft of this file was silently corrupted exactly that way.
 *
 * Call this at every ingest boundary that accepts foreign text; the columns that
 * carried the defect on 2026-07-30 are listed in `scripts/repair-text-encoding.ts`.
 */

/**
 * windows-1252 0x80-0x9F -> Unicode. Printable punctuation, so these ARE safe as
 * literals. The five holes (0x81, 0x8D, 0x8F, 0x90, 0x9D) are unassigned in
 * cp1252 and fall through to "drop".
 */
const CP1252: Record<number, string> = {
  0x80: "€", // euro sign
  0x82: "‚", // single low-9 quote
  0x83: "ƒ", // latin small f with hook
  0x84: "„", // double low-9 quote
  0x85: "…", // horizontal ellipsis
  0x86: "†", // dagger
  0x87: "‡", // double dagger
  0x88: "ˆ", // modifier circumflex
  0x89: "‰", // per mille
  0x8a: "Š", // S with caron
  0x8b: "‹", // single left angle quote
  0x8c: "Œ", // OE ligature
  0x8e: "Ž", // Z with caron
  0x91: "‘", // left single quote
  0x92: "’", // right single quote -- the reported defect
  0x93: "“", // left double quote
  0x94: "”", // right double quote
  0x95: "•", // bullet
  0x96: "–", // en dash
  0x97: "—", // em dash
  0x98: "˜", // small tilde
  0x99: "™", // trade mark
  0x9a: "š", // s with caron
  0x9b: "›", // single right angle quote
  0x9c: "œ", // oe ligature
  0x9e: "ž", // z with caron
  0x9f: "Ÿ", // Y with diaeresis
};

const cc = String.fromCharCode;

/** Code points dropped outright. Order/duplication inside a class is harmless. */
const DROPPED = [
  [0x00, 0x08], // C0 controls, minus tab (0x09) / LF (0x0a) / CR (0x0d)
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f], // DEL
  [0x00ad, 0x00ad], // soft hyphen
  [0x200b, 0x200b], // zero-width space
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xfffd, 0xfffd], // replacement character
] as const;

const C1_CLASS = `[${cc(0x80)}-${cc(0x9f)}]`;
const DROPPED_CLASS = `[${DROPPED.map(([a, b]) => (a === b ? cc(a) : `${cc(a)}-${cc(b)}`)).join("")}]`;

const C1_RE = new RegExp(C1_CLASS, "g");
const DROPPED_RE = new RegExp(DROPPED_CLASS, "g");
const DEFECT_RE = new RegExp(`${C1_CLASS}|${DROPPED_CLASS}`); // non-global: safe to .test()

/** True when `input` carries anything `repairEncoding` would change. */
export function hasEncodingDefect(input: string): boolean {
  return DEFECT_RE.test(input);
}

export function repairEncoding(input: string): string {
  // ponytail: a control char followed by hex digits is sometimes a mangled
  // \uXXXX escape (scholar_tool's "amyloid-b2" was a beta) - dropping the
  // control leaves "amyloid-b2". Decoding that needs a Symbol-font table; do it
  // only if the greek-letter loss ever surfaces on a public page.
  if (!DEFECT_RE.test(input)) return input;
  return input.replace(C1_RE, (c) => CP1252[c.charCodeAt(0)] ?? "").replace(DROPPED_RE, "");
}

/** `null`/`undefined`-tolerant wrapper for ETL upsert payloads. */
export function repairEncodingOrNull<T extends string | null | undefined>(input: T): T {
  return (typeof input === "string" ? repairEncoding(input) : input) as T;
}
