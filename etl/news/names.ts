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
 * said..." but not the stray tokens "ma" or "xiaojing" alone.
 *
 * #2578 — WHERE the name was found now decides the confidence, because a prose
 * hit alone is a poor signal. The newsroom feed tags each story with its own
 * faculty list (`term_node_tid`), and that list is authored by the people who
 * wrote the article, so it is a far better answer to "is this story about this
 * scholar?" than the presence of their name in the body. Three tiers:
 *
 *   TAG     the feed itself tags this scholar on this story   -> HIGH
 *   BODY    named in the article prose                        -> MEDIUM
 *   CAPTION named only in a photo's alt text                  -> LOW
 *   TITLE   named in prose, but EVERY occurrence sits inside
 *           an endowed-chair / memorial phrase                -> LOW
 *
 * TITLE is the demotion that motivated the issue. Endowed professorships embed a
 * DIFFERENT person's name — usually an emeritus or memorialized figure the story
 * is not about — and they were the bulk of reviewer rejections. Two proven cases:
 *
 *   "…and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended…"
 *      proposed O. Wayne Isom at HIGH; the feed tags Dr. Leonard Girardi, who
 *      holds that chair. Isom is not tagged.
 *   "…the Gebroe Family Professor of Hematology-Oncology in honor of Morton
 *    Coleman, M.D. …" proposed Morton Coleman at HIGH; the feed tags Dr. Scott
 *      Tagawa. Coleman is not tagged.
 *
 * Note the two have DIFFERENT shapes ("<name> Professor of" vs "in honor of
 * <name>"), which is why the tag signal is primary and the phrase list secondary.
 *
 * BASIS vs CONTESTED-NESS are orthogonal and both have to survive. `basis` says
 * how the name was found; `likelihood` says how much to trust THIS (scholar,
 * article) pair. A folded full name shared by >1 scholar is contested however it
 * was found — a tag naming "David Cohen" says the story is about *a* David
 * Cohen, not *which* one — so contested CAPS likelihood at MEDIUM. It is a cap,
 * never a promotion: a contested CAPTION stays LOW. The queue keys its
 * single-select on the shared `groupKey`, unchanged.
 *
 * ponytail: naive per-surname candidate scan (see detectMentions) — fast enough
 * for the weekly delta (a few dozen new articles). A full name with a middle
 * token the article omits ("Xiaojing Q. Ma" vs "Xiaojing Ma") will miss in PROSE;
 * matching both `fullName` and `preferredName` covers most of it, and the tag
 * pass is deliberately looser (see tagMatchesSequence). Upgrade path if recall
 * matters: NER. False positives are the queue's job.
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

/**
 * How the (scholar, article) pair was found — the reviewer-facing "why". Stored
 * on news_mention.match_basis (#2578). Ordered strongest-first; see BASIS_TIER.
 */
export type MatchBasis = "TAG" | "BODY" | "TITLE" | "CAPTION";

export type DetectedMention = {
  cwid: string;
  /** The scholar display name that matched, shown in the queue. */
  detectedName: string;
  likelihood: "HIGH" | "MEDIUM" | "LOW";
  /** Where the name was found — carries the "why" that `likelihood` cannot. */
  basis: MatchBasis;
  /** Folded full name — pending rows sharing it are competing candidates. */
  groupKey: string;
};

/** The one place basis maps to confidence. TITLE and CAPTION are both weak, for
 *  different reasons the queue shows separately. */
const BASIS_TIER: Readonly<Record<MatchBasis, "HIGH" | "MEDIUM" | "LOW">> = {
  TAG: "HIGH",
  BODY: "MEDIUM",
  TITLE: "LOW",
  CAPTION: "LOW",
};

/** The article-side inputs a mention can be found in, strongest first. */
export type MentionSources = {
  /** Article title + body prose. Required — the pre-#2578 signal. */
  text: string;
  /** The feed's own story tags (`term_node_tid`), already comma-split. */
  tags: string[];
  /** Photo alt text (featured image + body `<img alt>`), space-joined. */
  captionText: string;
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

/** How many times `needle` appears as a consecutive run inside `hay`. */
function countSequence(hay: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return 0;
  let n = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) n++;
  }
  return n;
}

/** True when `needle` appears as a consecutive run inside `hay`. */
function containsSequence(hay: string[], needle: string[]): boolean {
  return countSequence(hay, needle) > 0;
}

/**
 * Tokens that may sit BETWEEN a first and last name in a feed tag without making
 * it something other than a person's name: a bare initial is handled by length,
 * these are the multi-letter particles. Deliberately tiny — see tagMatchesSequence.
 */
const NAME_PARTICLES = new Set(["van", "von", "de", "del", "della", "di", "da", "la", "le", "den", "der", "bin", "al"]);

/**
 * Does one feed tag entry name this scholar?
 *
 * Looser than the prose rule ON PURPOSE, and safe only because a tag entry is a
 * short bounded string rather than 60kB of prose. The feed writes person tags as
 * "Dr. Leonard Girardi" / "Dr. Robert A. Harrington" / "Cassandra Stecker" — the
 * honorific is inconsistent (students get none) and middle initials appear on
 * one side of the join but not the other, so a consecutive-run match under-fires.
 * Three guards keep it from swallowing the department/center/topic tags that
 * share the same comma-delimited list:
 *
 *   1. the tag's FINAL token is the scholar's surname — a person tag ends on the
 *      surname, so "Sandra and Edward Meyer Cancer Center" and "Gale and Ira
 *      Drukier Institute for Children's Health" are rejected on this alone,
 *      even though both embed a plausible first+last pair;
 *   2. every token of the scholar's name appears IN ORDER from their first name
 *      to the end of the tag;
 *   3. the only tag tokens allowed to interleave are ones the roster name simply
 *      omits: a bare initial or a name particle. "and Edward" is neither.
 *
 * A leading honorific is skipped for free — the walk starts at the scholar's
 * first name, so "Dr." is never examined.
 */
function tagMatchesSequence(tagTokens: string[], seq: string[]): boolean {
  // (1) a person tag ends on the surname.
  if (tagTokens[tagTokens.length - 1] !== seq[seq.length - 1]) return false;
  let i = tagTokens.indexOf(seq[0]);
  if (i < 0) return false;
  // (2)+(3) walk both, tolerating the initials/middle names one side carries and
  // the other does not ("Dr. Robert A. Harrington" vs roster "Robert Harrington").
  let s = 0;
  while (i < tagTokens.length && s < seq.length) {
    if (tagTokens[i] === seq[s]) {
      i++;
      s++;
    } else if (tagTokens[i].length === 1 || NAME_PARTICLES.has(tagTokens[i])) {
      i++;
    } else {
      return false;
    }
  }
  // The whole name matched and nothing trails the surname.
  return s === seq.length && i === tagTokens.length;
}

/**
 * Capitalized-word runs that a donor/memorial naming convention wraps around a
 * person who is NOT what the story is about (#2578).
 *
 * Measured over 300 live stories before being written, because the endowed-chair
 * shape and a scholar's REAL title differ only by punctuation and case, both of
 * which token folding destroys:
 *
 *   "the O. Wayne Isom Professor of Cardiothoracic Surgery"   50 hits  DEMOTE
 *   "…, professor of medicine"  (comma, lowercase p)          75 hits  KEEP
 *   "…, Professor of …"         (comma, capital p)             0 hits
 *
 * So the patterns run on RAW text, never the folded stream, and each captures the
 * NAME PHRASE rather than flagging the sentence: a scholar is demoted only when
 * their own name is what the phrase wraps. That keeps "Dr. David Lyden, the
 * Stavros S. Niarchos Professor…" clean for Lyden while still demoting Niarchos.
 * Extra capitalized words swept into the capture ("Abby Rockefeller Mauzé
 * Distinguished") are harmless — the scholar sequence is matched INSIDE it.
 *
 * Kept to the two proven shapes plus their immediate siblings. This is not an
 * attempt at general NLP; the tag signal is the primary fix.
 */
const CAP_RUN = String.raw`[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,4}`;
const HONORIFIC_TITLE_PATTERNS: readonly RegExp[] = [
  // "the O. Wayne Isom Professor of …" / "… Distinguished Professor …" / "… Professorship"
  new RegExp(String.raw`\bthe\s+(${CAP_RUN})\s+Professor(?:ship)?\b`, "g"),
  // "in honor of Morton Coleman, M.D." / "in memory of …"
  new RegExp(String.raw`\bin\s+(?:honor|memory)\s+of\s+(${CAP_RUN})`, "gi"),
  // "the Skaggs Presidential Chair" — same donor convention, different noun.
  new RegExp(String.raw`\bthe\s+(${CAP_RUN})\s+Chair\b`, "g"),
];

/**
 * The folded token runs sitting inside an endowed-chair / memorial phrase, one
 * entry per occurrence (NOT deduped — the count is what decides the demotion).
 * Exported for tests.
 */
export function honorificNamePhrases(text: string): string[][] {
  const out: string[][] = [];
  for (const re of HONORIFIC_TITLE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const toks = tokenize(m[1]);
      if (toks.length > 0) out.push(toks);
    }
  }
  return out;
}

/**
 * Detect scholar mentions in one article.
 *
 * `excludeCwids` are the scholars already VIVO-linked on this article — an
 * identifier hit always wins, so we never also emit a weaker prose candidate for
 * them.
 *
 * `sources` is an object rather than the bare body string it used to be so that
 * a caller CANNOT silently forget the tag list: every field is required, and a
 * caller with nothing to pass says so explicitly (`tags: []`). The tag pass is
 * the whole point of #2578, and this repo's recurring bug is a signal that is
 * declared but never connected.
 *
 * Per scholar we take the STRONGEST basis available — tags, then prose, then
 * caption — and only then apply the contested cap.
 */
export function detectMentions(
  sources: MentionSources,
  index: NameIndexEntry[],
  excludeCwids: Set<string> = new Set(),
): DetectedMention[] {
  const tokens = tokenize(sources.text);
  const captionTokens = tokenize(sources.captionText);
  // One token list per tag entry — matching must not run across the comma
  // boundary, or "…Cancer Center" + "Dr. Scott Tagawa" would blur into one.
  const tagTokens = sources.tags.map((t) => tokenize(t)).filter((t) => t.length > 0);
  if (tokens.length === 0 && captionTokens.length === 0 && tagTokens.length === 0) return [];

  const tokenSet = new Set(tokens);
  const captionSet = new Set(captionTokens);
  const tagSet = new Set(tagTokens.flat());
  const honorifics = honorificNamePhrases(sources.text);

  const hits: { cwid: string; displayName: string; groupKey: string; basis: MatchBasis }[] = [];
  for (const entry of index) {
    if (excludeCwids.has(entry.cwid)) continue;
    // Cheap pre-filter: only consider a scholar whose surname appears somewhere.
    if (!entry.surnames.some((sn) => tokenSet.has(sn) || tagSet.has(sn) || captionSet.has(sn))) {
      continue;
    }

    let match: string[] | undefined;
    let basis: MatchBasis | undefined;

    // 1. TAG — the feed's own answer to "who is this story about".
    match = entry.sequences.find((seq) => tagTokens.some((t) => tagMatchesSequence(t, seq)));
    if (match) basis = "TAG";

    // 2. BODY — prose, demoted to TITLE when EVERY occurrence of the name sits
    //    inside an endowed-chair/memorial phrase. "Every", not "any": a person
    //    named once in a chair title and again as a speaker is really in the
    //    story, and only the all-occurrences test can tell those apart.
    if (!basis) {
      for (const seq of entry.sequences) {
        const inBody = countSequence(tokens, seq);
        if (inBody === 0) continue;
        const inTitles = honorifics.filter((h) => containsSequence(h, seq)).length;
        match = seq;
        basis = inTitles >= inBody ? "TITLE" : "BODY";
        // A sequence found in plain prose beats one found only in a chair title,
        // so keep looking only while we are still on the demoted verdict.
        if (basis === "BODY") break;
      }
    }

    // 3. CAPTION — named only in a photo's alt text. `clean()` strips attributes
    //    out of bodyText, so this tier is pure recall: without it these scholars
    //    are not proposed at all.
    if (!basis) {
      match = entry.sequences.find((seq) => containsSequence(captionTokens, seq));
      if (match) basis = "CAPTION";
    }

    if (!basis || !match) continue;
    hits.push({ cwid: entry.cwid, displayName: entry.displayName, groupKey: match.join(" "), basis });
  }

  // A groupKey (folded full name) shared by >1 cwid is ambiguous however it was
  // found, so it CAPS the tier at MEDIUM — a tag naming "David Cohen" says the
  // story is about *a* David Cohen, not which. A cap, never a promotion: a
  // contested CAPTION/TITLE stays LOW.
  const byGroup = new Map<string, number>();
  for (const h of hits) byGroup.set(h.groupKey, (byGroup.get(h.groupKey) ?? 0) + 1);

  return hits.map((h) => {
    const tier = BASIS_TIER[h.basis];
    const contested = (byGroup.get(h.groupKey) ?? 1) > 1;
    return {
      cwid: h.cwid,
      detectedName: h.displayName,
      likelihood: contested && tier === "HIGH" ? "MEDIUM" : tier,
      basis: h.basis,
      groupKey: h.groupKey,
    };
  });
}
