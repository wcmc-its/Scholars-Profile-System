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
 * scholar?" than the presence of their name in the body. Four tiers:
 *
 *   TAG     the feed itself tags this scholar on this story   -> HIGH
 *   BODY    named in the article prose                        -> scored, see below
 *   TITLE   named in prose, but EVERY occurrence sits inside
 *           an endowed-chair/memorial phrase                  -> LOW
 *   CAPTION named only in a photo's alt text                   -> LOW
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
 * #2578 FOLLOW-UP — BODY used to collapse into one flat MEDIUM band. That made it
 * the queue's biggest bucket (729 of 1,371 pending rows) and its least-ranked
 * one, since every prose match sorted identically regardless of how strong the
 * hit actually was. It is now SCORED 0..7 from four signals — see
 * `scoreBodyMention` and `bandForScore` below for the weights, their measured
 * provenance, and the band cutoffs.
 *
 * TITLE SHORT-CIRCUITS BEFORE SCORING, unconditionally. An honorific-only match
 * (every occurrence of the name sits inside an endowed-chair/memorial phrase)
 * stays LOW no matter how early or how often it appears — it never enters
 * `scoreBodyMention` at all. That is the entire guard against the regression
 * this issue was filed for: an emeritus professor's name inside his OWN endowed
 * chair's title, printed early in the article and possibly more than once,
 * scoring HIGH by the same position/repeat signals that reward a real subject.
 * It is safe to hard-code rather than merely down-weight because the measured
 * ground truth has no counter-example to weigh against: of 1,500 live articles
 * sampled, honorific-only matches were 15 for 15 negatives — ZERO on either the
 * VIVO cwid-link ground truth or the feed's own tag list. A score cannot beat a
 * signal with a 0% hit rate; the short-circuit can.
 *
 * BASIS vs CONTESTED-NESS are orthogonal and both have to survive. `basis` says
 * how the name was found; `likelihood` says how much to trust THIS (scholar,
 * article) pair. A folded full name shared by >1 scholar is contested however it
 * was found — a tag naming "David Cohen" says the story is about *a* David
 * Cohen, not *which* one — so contested CAPS likelihood at MEDIUM. It is a cap,
 * never a promotion: a contested CAPTION stays LOW, and a contested BODY score
 * that lands on HIGH is capped down to MEDIUM the same way a contested TAG is.
 * The queue keys its single-select on the shared `groupKey`, unchanged. Measured
 * over the same 1,500-article sample: the cap fires on only 0.4–0.8% of rows.
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
 * on news_mention.match_basis (#2578). Ordered strongest-first; see BASIS_TIER
 * (TAG/TITLE/CAPTION) and scoreBodyMention/bandForScore (BODY).
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
  /**
   * ~200-300 chars of the RAW article text around the name's first prose
   * occurrence, clipped to word boundaries with the matched name intact
   * (#2578 follow-up) — lets a reviewer judge a candidate without opening the
   * article. Populated only for BODY and TITLE, the two bases found by scanning
   * `sources.text`; TAG has no prose position to snippet and CAPTION's
   * occurrence lives in the separate `captionText` stream. Null otherwise.
   */
  contextSnippet: string | null;
};

/**
 * TAG, TITLE and CAPTION map to a fixed tier. BODY does NOT — see
 * scoreBodyMention/bandForScore below, which replaced a flat BODY -> MEDIUM
 * band in the #2578 follow-up (see the module docblock for why).
 */
const BASIS_TIER: Readonly<Record<Exclude<MatchBasis, "BODY">, "HIGH" | "MEDIUM" | "LOW">> = {
  TAG: "HIGH",
  TITLE: "LOW",
  CAPTION: "LOW",
};

/** The article-side inputs a mention can be found in, strongest first. */
export type MentionSources = {
  /** Article headline. Also the literal prefix of `text` below — kept as its
   *  own field (rather than re-deriving it) purely so the score's headline
   *  bonus knows where the title ends in the shared token stream: "named in the
   *  headline" is `firstTokenIndex < tokenize(title).length` (#2578 follow-up). */
  title: string;
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

/** One folded token from `tokenizeWithSpans`, plus its `[start, end)` character
 *  offset in the ORIGINAL (unfolded) string — the raw-text address a folded
 *  token-stream match needs to be sliced back out of `text` (#2578 follow-up
 *  context snippets). `tokenizeWithSpans(text).map((t) => t.token)` is always
 *  equal to `tokenize(text)`; this is the same split, just offset-tracking. */
export type SpannedToken = { token: string; start: number; end: number };

/** Same folding as tokenize(), but each token keeps its character span in
 *  `text` so a token-stream match can be mapped back to raw text. */
export function tokenizeWithSpans(text: string): SpannedToken[] {
  const out: SpannedToken[] = [];
  for (const m of text.matchAll(/[0-9A-Za-zÀ-ɏ]+/g)) {
    const token = foldToken(m[0]);
    if (token) out.push({ token, start: m.index, end: m.index + m[0].length });
  }
  return out;
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

/** Indices in `hay` where `needle` starts as a consecutive run, in stream
 *  order. The one scan `containsSequence` and the BODY score's position/repeat
 *  signals (positions[0], positions.length) all read from. */
function sequenceIndices(hay: string[], needle: string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0 || needle.length > hay.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** True when `needle` appears as a consecutive run inside `hay`. */
function containsSequence(hay: string[], needle: string[]): boolean {
  return sequenceIndices(hay, needle).length > 0;
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
 * #2578 follow-up — the four BODY score signals, each measured across 1,500
 * live articles / 2,327 prose matches against TWO independent ground truths
 * (a VIVO cwid-link on the article, n=1040; the feed's own tag list, n=522),
 * against negatives (a prose match on a TAGGED article where the scholar was
 * NOT tagged, n=750-765):
 *
 *   signal                                      VIVO   TAG   negatives
 *   median first-occurrence position            28.2%  32.0%  56.2%
 *   in first tenth of article                    12.4%  17.2%   6.7%
 *   mentioned more than once                     41.4%  33.7%    12%
 *   a feed tag contains their own primaryDepartment 58.8% 46.0%  15.6%
 *   named in the headline                          3.7%   7.9%   2.0%
 *
 * Position carries the most weight because it separates the groups the widest
 * and because "mentioned more than once" and "in the headline" are largely
 * downstream of it (a subject introduced early is also likelier to be quoted
 * again and likelier to be who the headline is about). All 1,500 sampled
 * articles carry tags, so the department signal is comparably available to
 * every row it can fire on.
 */
const POSITION_TENTH_BONUS = 3;
const POSITION_THIRD_BONUS = 1;
const REPEAT_MENTION_BONUS = 1;
const DEPARTMENT_TAG_BONUS = 2;
const HEADLINE_BONUS = 1;

/** Score one BODY-basis prose match 0..7 — see the constants above for the
 *  weights' provenance. `firstTokenIndex`/`tokenCount` are positions into the
 *  SAME folded token stream `detectMentions` already scans
 *  (`tokenize(\`${title} ${bodyText}\`)`); `titleTokenCount` is where that
 *  stream's headline prefix ends. Never called for a TITLE-basis match — see
 *  the module docblock's short-circuit note. */
function scoreBodyMention(args: {
  firstTokenIndex: number;
  tokenCount: number;
  occurrences: number;
  titleTokenCount: number;
  departmentTagged: boolean;
}): number {
  let score = 0;
  const positionFraction = args.tokenCount > 0 ? args.firstTokenIndex / args.tokenCount : 1;
  if (positionFraction < 0.1) score += POSITION_TENTH_BONUS;
  else if (positionFraction < 1 / 3) score += POSITION_THIRD_BONUS;
  if (args.occurrences > 1) score += REPEAT_MENTION_BONUS;
  if (args.departmentTagged) score += DEPARTMENT_TAG_BONUS;
  if (args.firstTokenIndex < args.titleTokenCount) score += HEADLINE_BONUS;
  return score;
}

const HIGH_SCORE = 4;
const MEDIUM_SCORE = 2;

/**
 * Bands validated by per-score PRECISION over the same sample (positives vs
 * negatives): score 0 -> 41%, 1 -> 58%, 2 -> 76%, 3 -> 88%, 4+ -> 92.5%.
 *
 * HIGH>=4 beats HIGH>=5 on both precision (92.5% vs 89.0%) and volume — the 5th
 * point buys back almost nothing. MEDIUM>=3 would push roughly half of real
 * subjects (scoring 2) down into LOW, burying them under the unscored rows the
 * LOW band also holds (TITLE, CAPTION, and a contested cap).
 */
function bandForScore(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= HIGH_SCORE) return "HIGH";
  if (score >= MEDIUM_SCORE) return "MEDIUM";
  return "LOW";
}

/**
 * True when at least one feed tag contains the scholar's own `primaryDepartment`
 * as a case-insensitive substring — the DEPARTMENT_TAG_BONUS signal. A plain
 * substring check, not a token-sequence match like `tagMatchesSequence` uses for
 * a person tag: a department legitimately appears as a FRAGMENT of a longer tag
 * ("Hematology and Oncology" contains "Oncology"), and department names are
 * institutional enough that a stray substring collision is not a practical risk.
 */
function tagContainsDepartment(tags: string[], department: string | null): boolean {
  const dept = department?.trim().toLowerCase();
  if (!dept) return false;
  return tags.some((t) => t.toLowerCase().includes(dept));
}

/** Target width (chars, each side of the match) for a context snippet — ~250
 *  chars total before word-boundary clipping trims it in, comfortably inside
 *  the `context_snippet` column's 512-char cap even for a long matched name. */
const SNIPPET_RADIUS = 120;

/**
 * ~200-300 chars of `text` around `[matchStart, matchEnd)`, clipped to word
 * boundaries so the article's own words are never cut mid-word, with an
 * ellipsis on whichever side(s) were actually clipped (#2578 follow-up). The
 * source text (`title`/`bodyText`) is already HTML-stripped and control-char
 * free by the time it reaches here — see `clean`/`stripControl` in scrape.ts,
 * which run before `detectMentions` ever sees this text — so no further
 * sanitizing happens here, only slicing.
 */
function extractSnippet(text: string, matchStart: number, matchEnd: number): string {
  let from = Math.max(0, matchStart - SNIPPET_RADIUS);
  let to = Math.min(text.length, matchEnd + SNIPPET_RADIUS);
  if (from > 0) {
    const sp = text.indexOf(" ", from);
    if (sp !== -1 && sp < matchStart) from = sp + 1;
  }
  if (to < text.length) {
    const sp = text.lastIndexOf(" ", to);
    if (sp !== -1 && sp > matchEnd) to = sp;
  }
  const clipped = text.slice(from, to).trim();
  const snippet = `${from > 0 ? "…" : ""}${clipped}${to < text.length ? "…" : ""}`;
  // Defensive cap only — SNIPPET_RADIUS already keeps this well under 512 for
  // any real name, but the column is VARCHAR(512) and a slice costs nothing.
  return snippet.length > 500 ? `${snippet.slice(0, 499)}…` : snippet;
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
  const spans = tokenizeWithSpans(sources.text);
  const tokens = spans.map((s) => s.token);
  // Where the headline prefix of `sources.text` ends in the shared token stream
  // — the HEADLINE_BONUS boundary (#2578 follow-up).
  const titleTokenCount = tokenize(sources.title).length;
  const captionTokens = tokenize(sources.captionText);
  // One token list per tag entry — matching must not run across the comma
  // boundary, or "…Cancer Center" + "Dr. Scott Tagawa" would blur into one.
  const tagTokens = sources.tags.map((t) => tokenize(t)).filter((t) => t.length > 0);
  if (tokens.length === 0 && captionTokens.length === 0 && tagTokens.length === 0) return [];

  const tokenSet = new Set(tokens);
  const captionSet = new Set(captionTokens);
  const tagSet = new Set(tagTokens.flat());
  const honorifics = honorificNamePhrases(sources.text);

  const hits: {
    cwid: string;
    displayName: string;
    groupKey: string;
    basis: MatchBasis;
    tier: "HIGH" | "MEDIUM" | "LOW";
    contextSnippet: string | null;
  }[] = [];
  for (const entry of index) {
    if (excludeCwids.has(entry.cwid)) continue;
    // Cheap pre-filter: only consider a scholar whose surname appears somewhere.
    if (!entry.surnames.some((sn) => tokenSet.has(sn) || tagSet.has(sn) || captionSet.has(sn))) {
      continue;
    }

    let match: string[] | undefined;
    let basis: MatchBasis | undefined;
    let tier: "HIGH" | "MEDIUM" | "LOW" | undefined;
    let contextSnippet: string | null = null;

    // 1. TAG — the feed's own answer to "who is this story about". Unscored.
    match = entry.sequences.find((seq) => tagTokens.some((t) => tagMatchesSequence(t, seq)));
    if (match) {
      basis = "TAG";
      tier = BASIS_TIER.TAG;
    }

    // 2. BODY/TITLE — prose, demoted to TITLE when EVERY occurrence of the name
    //    sits inside an endowed-chair/memorial phrase. "Every", not "any": a
    //    person named once in a chair title and again as a speaker is really in
    //    the story, and only the all-occurrences test can tell those apart.
    //
    //    TITLE is decided and short-circuited BEFORE any score is computed —
    //    see the module docblock. Only a BODY verdict goes through
    //    scoreBodyMention/bandForScore.
    if (!basis) {
      for (const seq of entry.sequences) {
        const positions = sequenceIndices(tokens, seq);
        if (positions.length === 0) continue;
        const inTitles = honorifics.filter((h) => containsSequence(h, seq)).length;
        match = seq;
        const firstTokenIndex = positions[0];
        contextSnippet = extractSnippet(
          sources.text,
          spans[firstTokenIndex].start,
          spans[firstTokenIndex + seq.length - 1].end,
        );
        if (inTitles >= positions.length) {
          basis = "TITLE";
          tier = BASIS_TIER.TITLE;
          // No break: a later sequence (e.g. preferredName) might still be
          // found in plain prose and upgrade this from TITLE to BODY.
        } else {
          basis = "BODY";
          tier = bandForScore(
            scoreBodyMention({
              firstTokenIndex,
              tokenCount: tokens.length,
              occurrences: positions.length,
              titleTokenCount,
              departmentTagged: tagContainsDepartment(sources.tags, entry.department),
            }),
          );
          // A sequence found in plain prose beats one found only in a chair
          // title, so keep looking only while still on the demoted verdict.
          break;
        }
      }
    }

    // 3. CAPTION — named only in a photo's alt text. `clean()` strips attributes
    //    out of bodyText, so this tier is pure recall: without it these scholars
    //    are not proposed at all. No prose position, so no context snippet.
    if (!basis) {
      match = entry.sequences.find((seq) => containsSequence(captionTokens, seq));
      if (match) {
        basis = "CAPTION";
        tier = BASIS_TIER.CAPTION;
      }
    }

    if (!basis || !match || !tier) continue;
    hits.push({
      cwid: entry.cwid,
      displayName: entry.displayName,
      groupKey: match.join(" "),
      basis,
      tier,
      // Only BODY/TITLE ever populate contextSnippet above; TAG/CAPTION leave
      // it at its `null` default.
      contextSnippet: basis === "BODY" || basis === "TITLE" ? contextSnippet : null,
    });
  }

  // A groupKey (folded full name) shared by >1 cwid is ambiguous however it was
  // found, so it CAPS the tier at MEDIUM — a tag naming "David Cohen" says the
  // story is about *a* David Cohen, not which. A cap, never a promotion: a
  // contested CAPTION/TITLE stays LOW, and a contested BODY score that reached
  // HIGH is capped down like a contested TAG.
  const byGroup = new Map<string, number>();
  for (const h of hits) byGroup.set(h.groupKey, (byGroup.get(h.groupKey) ?? 0) + 1);

  return hits.map((h) => {
    const contested = (byGroup.get(h.groupKey) ?? 1) > 1;
    return {
      cwid: h.cwid,
      detectedName: h.displayName,
      likelihood: contested && h.tier === "HIGH" ? "MEDIUM" : h.tier,
      basis: h.basis,
      groupKey: h.groupKey,
      contextSnippet: h.contextSnippet,
    };
  });
}
