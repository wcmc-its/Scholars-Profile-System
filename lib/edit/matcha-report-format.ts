/**
 * Matcha report v4: DISPLAY-ONLY clean-ups for the printable scouting report. Pure functions over
 * values the report already holds; the source records are never touched.
 *
 *  - `reportName`: dedupe postnominal degrees ("MB,BS, MD, MD" → "MB,BS, MD") and give a bare
 *    middle initial its period ("Jane Q Doe" → "Jane Q. Doe").
 *  - `sponsorShort`: "NCI via Some University" → "NCI"; a full NIH institute name → its acronym.
 *  - `awardCode`: the mechanism, else a funder-type label ("Industry", "Foundation", …).
 *  - `mergeMethods`: exact duplicates (by normalized name) merged, strongest first.
 */
import { getSponsor, listSponsors, type SponsorCategory } from "@/lib/sponsor-lookup";
import type { BriefRecords } from "@/lib/edit/matcha-brief-types";

type Award = BriefRecords["funding"][number];
type Method = BriefRecords["methods"][number];

/** "Jane Q Doe" → "Jane Q. Doe": a single-letter word between the first and last gets a period. */
export function punctuateInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .map((w, i) => (i > 0 && i < words.length - 1 && /^\p{Lu}$/u.test(w) ? `${w}.` : w))
    .join(" ");
}

/** "MB,BS, MD, MD" → "MB,BS, MD": repeated degrees dropped (case-insensitive), order kept. */
export function dedupeDegrees(postnominal: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of postnominal.split(/,\s+/)) {
    const d = raw.trim();
    const key = d.toLowerCase().replace(/[.\s]/g, "");
    if (!d || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.join(", ");
}

/** A display name "Name, postnominals" with both fixes applied. The name part ends at the first
 *  ", " (a degree like "MB,BS" has no space after its comma). */
export function reportName(full: string): string {
  const i = full.indexOf(", ");
  if (i < 0) return punctuateInitials(full);
  const degrees = dedupeDegrees(full.slice(i + 2));
  const name = punctuateInitials(full.slice(0, i));
  return degrees ? `${name}, ${degrees}` : name;
}

const NIH_BY_FULL_NAME: Map<string, string> = new Map(
  listSponsors()
    .filter((s) => s.category === "NIH IC")
    .map((s) => [s.full.toLowerCase(), s.short]),
);

/** The funder without its "via …" routing tail. */
function primeFunder(funder: string): string {
  return funder.replace(/\s+via\s+.*$/i, "").trim();
}

/**
 * A short sponsor name: the award's NIH institute code when known, else the funder without
 * "via …", with a full NIH institute name turned into its acronym ("National Institute on
 * Aging" → "NIA"). Anything else is returned as is.
 */
export function sponsorShort(a: Pick<Award, "funder" | "nihIc">): string {
  if (a.nihIc?.trim()) return a.nihIc.trim();
  const f = primeFunder(a.funder);
  return NIH_BY_FULL_NAME.get(f.toLowerCase()) ?? getSponsor(f)?.short ?? f;
}

const CATEGORY_LABEL: Record<SponsorCategory, string> = {
  "NIH IC": "NIH",
  Federal: "Federal",
  Foundation: "Foundation",
  Industry: "Industry",
  Other: "Other",
};

/** A funder-type label for an award with no mechanism code. */
export function funderTypeLabel(a: Pick<Award, "funder" | "programType">): string {
  const f = primeFunder(a.funder);
  const sponsor = getSponsor(f) ?? getSponsor(NIH_BY_FULL_NAME.get(f.toLowerCase()));
  if (sponsor) return CATEGORY_LABEL[sponsor.category];
  if (a.programType === "BioPharma Alliance Agreement") return "Industry";
  return "Other";
}

/** The award's code: its mechanism ("R01"), else its funder-type label. */
export function awardCode(a: Pick<Award, "mechanism" | "funder" | "programType">): string {
  return a.mechanism?.trim() || funderTypeLabel(a);
}

/** "1 active award" / "6 active awards". */
export function awardsLabel(n: number): string {
  return `${n} active ${n === 1 ? "award" : "awards"}`;
}

/** "6 active awards: R01 (NIA), U54 (NIBIB), Industry (Example Co)". Identical entries once. */
export function fundingSummary(awards: readonly Award[]): string {
  const parts: string[] = [];
  for (const a of awards) {
    const code = awardCode(a);
    const sponsor = sponsorShort(a);
    const label = code === sponsor ? code : `${code} (${sponsor})`;
    if (!parts.includes(label)) parts.push(label);
  }
  return `${awardsLabel(awards.length)}: ${parts.join(", ")}`;
}

/** Lowercase, punctuation to spaces, whitespace collapsed: the key exact duplicates share. */
export function normalizeMethodName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Methods with exact duplicates (by normalized name) merged — the larger paper count wins —
 *  sorted by paper count, then name. */
export function mergeMethods(methods: readonly Method[]): Method[] {
  const by = new Map<string, Method>();
  for (const m of methods) {
    const key = normalizeMethodName(m.name);
    if (!key) continue;
    const hit = by.get(key);
    if (!hit || m.papers > hit.papers) by.set(key, m);
  }
  return [...by.values()].sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name));
}

/** The first `n` sentences of a text. */
export function firstSentences(text: string, n: number): string {
  const t = text.trim();
  const m = new RegExp(`^(?:.*?[.!?](?=\\s|$)){1,${n}}`, "s").exec(t);
  return (m ? m[0] : t).trim();
}

/**
 * The cover title without the requester, who is already named under "Prepared for": a leading
 * "Requester: " / "Requester — " or a trailing " for Requester" / " — Requester" is dropped.
 */
export function titleWithoutRequester(title: string, requester: string | null): string {
  const r = requester?.trim();
  if (!r) return title;
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = title
    .replace(new RegExp(`^${esc}\\s*[:–—-]\\s*`, "i"), "")
    .replace(new RegExp(`\\s*(?:[:–—-]|\\bfor)\\s*${esc}$`, "i"), "")
    .trim();
  return out || title;
}
