/**
 * Deterministic scholar-name detection for the news-mentions ETL.
 *
 * The reliable join is the VIVO cwid link the article prints beside a faculty
 * name (handled in scrape.ts). This module covers the OTHER case the feature
 * exists for: an article names a scholar in prose WITHOUT linking VIVO. We match
 * the article text against the known scholar full names and emit one PENDING
 * candidate per hit for a human to confirm in /edit/news-queue.
 *
 * No LLM. A full name (≥2 tokens) is matched as a CONSECUTIVE token sequence in
 * the article's token stream, so "Xiaojing Ma" matches "...co-author Xiaojing Ma
 * said..." but not the stray tokens "ma" or "xiaojing" alone. When one folded
 * full name resolves to more than one scholar (e.g. two "David Cohen"s), every
 * candidate is emitted with likelihood MEDIUM and a shared `groupKey` so the
 * queue presents them as a contested single-select (title/department
 * disambiguate); a unique match is HIGH.
 *
 * ponytail: naive per-surname candidate scan (see detectMentions) — fast enough
 * for the weekly delta (a few dozen new articles). A full name with a middle
 * token the article omits ("Xiaojing Q. Ma" vs "Xiaojing Ma") will miss; matching
 * both `fullName` and `preferredName` covers most of it. Upgrade path if recall
 * matters: NER, or first+last-only sequences. False positives are the queue's job.
 */

export type NameIndexEntry = {
  cwid: string;
  /** Display name shown in the queue (the scholar's preferred name). */
  displayName: string;
  title: string | null;
  department: string | null;
  /** Folded token sequences to search for (fullName and preferredName). */
  sequences: string[][];
  /** Folded surname (last token) of each sequence — the cheap pre-filter key. */
  surnames: string[];
};

export type DetectedMention = {
  cwid: string;
  /** The scholar display name that matched, shown in the queue. */
  detectedName: string;
  likelihood: "HIGH" | "MEDIUM";
  /** Folded full name — pending rows sharing it are competing candidates. */
  groupKey: string;
};

/**
 * Fold a name fragment to lowercase ASCII letters/digits: NFKD-decompose,
 * drop combining marks (é→e, ñ→n), lowercase, strip anything else. Diacritic-
 * safe and symmetric — the scholar name and the article text both pass through
 * it, so "José" in prose matches a "José" scholar. (Mojibake — already-corrupt
 * bytes — will not fold and simply won't match; that is an upstream data bug,
 * not something a fold can repair.)
 */
export function foldToken(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Split arbitrary text into folded, non-empty tokens. Keeps accented letters
 *  attached to their word (so "José" tokenizes whole, then folds to "jose"). */
export function tokenize(text: string): string[] {
  return text
    .split(/[^0-9A-Za-zÀ-ɏ]+/)
    .map(foldToken)
    .filter((t) => t.length > 0);
}

/** The folded token sequence of a name, or null if it has fewer than 2 tokens. */
function nameSequence(name: string): string[] | null {
  const toks = tokenize(name);
  // Require first + last: a lone surname is too ambiguous to auto-propose.
  return toks.length >= 2 ? toks : null;
}

export type ScholarNameInput = {
  cwid: string;
  fullName: string;
  preferredName: string | null;
  primaryTitle: string | null;
  primaryDepartment: string | null;
};

/** Build the searchable name index from Scholar rows. */
export function buildNameIndex(scholars: ScholarNameInput[]): NameIndexEntry[] {
  const out: NameIndexEntry[] = [];
  for (const s of scholars) {
    const seqs: string[][] = [];
    const seen = new Set<string>();
    for (const name of [s.fullName, s.preferredName ?? ""]) {
      const seq = nameSequence(name);
      if (!seq) continue;
      const key = seq.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      seqs.push(seq);
    }
    if (seqs.length === 0) continue;
    out.push({
      cwid: s.cwid,
      displayName: (s.preferredName ?? s.fullName).trim(),
      title: s.primaryTitle,
      department: s.primaryDepartment,
      sequences: seqs,
      surnames: [...new Set(seqs.map((seq) => seq[seq.length - 1]))],
    });
  }
  return out;
}

/** True when `needle` appears as a consecutive run inside `hay`. */
function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Detect scholar mentions in one article's text (title + body).
 *
 * `excludeCwids` are the scholars already VIVO-linked on this article — an
 * identifier hit always wins, so we never also emit a weaker prose candidate for
 * them.
 */
export function detectMentions(
  text: string,
  index: NameIndexEntry[],
  excludeCwids: Set<string> = new Set(),
): DetectedMention[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);

  // (cwid, displayName) hits, one per scholar that matched.
  const hits: { cwid: string; displayName: string; groupKey: string }[] = [];
  for (const entry of index) {
    if (excludeCwids.has(entry.cwid)) continue;
    // Cheap pre-filter: only consider a scholar whose surname token is present.
    if (!entry.surnames.some((sn) => tokenSet.has(sn))) continue;
    const match = entry.sequences.find((seq) => containsSequence(tokens, seq));
    if (!match) continue;
    hits.push({ cwid: entry.cwid, displayName: entry.displayName, groupKey: match.join(" ") });
  }

  // A groupKey (folded full name) shared by >1 cwid is ambiguous → MEDIUM +
  // contested; a unique folded name is HIGH.
  const byGroup = new Map<string, number>();
  for (const h of hits) byGroup.set(h.groupKey, (byGroup.get(h.groupKey) ?? 0) + 1);

  return hits.map((h) => ({
    cwid: h.cwid,
    detectedName: h.displayName,
    likelihood: (byGroup.get(h.groupKey) ?? 1) > 1 ? "MEDIUM" : "HIGH",
    groupKey: h.groupKey,
  }));
}
