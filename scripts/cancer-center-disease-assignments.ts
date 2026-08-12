/**
 * Deterministic disease-expertise assignment for Cancer Center members.
 *
 * Same inputs -> byte-identical output. No sampling, no LLM, no hand-tuning:
 * every constant below is either a repo constant or a checked-in CSV row.
 *
 *   CancerTaxonomyDescriptor (lib/cancer-taxonomy.ts)   MeSH descriptor -> article-bucket topics
 *   docs/cancer-center-person-rollup.csv                article bucket  -> person disease code + label
 *   docs/cancer-center-specialty-map.csv                POPS specialty  -> disease codes
 *
 * Run (needs DATABASE_URL; in-VPC):
 *   npx tsx scripts/cancer-center-disease-assignments.ts > assignments.csv
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsv, type Row } from "@/lib/csv";
import {
  loadCancerTaxonomy,
  type CancerTaxonomyDescriptorReader,
  type MeshDescriptorNameReader,
} from "@/lib/cancer-taxonomy";

/** Authorship value, verbatim from `lib/search-index-docs.ts:55`, so this
 *  ranking cannot drift from how search already weights authorship. */
export const AUTHORSHIP_WEIGHTS = { firstOrLast: 10, secondOrPenultimate: 4, middle: 1 } as const;

/** Min distinct publications in a disease subtree to be listed at all. */
export const MIN_PUBS = 3;

/** A publication counts as "recent" within this many years of `asOf`. */
export const RECENT_WINDOW_YEARS = 5;

/** No publication this recent => the row is reported as `peripheral`. */
export const STALE_AFTER_YEARS = 8;

/**
 * How a row should be DISPLAYED, which is a different question from how much
 * evidence stands behind it.
 *
 * Cancer Center review, 2026-08: "for some of the faculty, there are medium or
 * low confidence areas that are pretty far afield from their focus", and a
 * member whose breast rows came only from papers in 2011 and 2017 still read as
 * a breast assignment. Confidence answers "how sure are we"; it cannot answer
 * "is this what they work on now". That needs recency and rank, so it is its own
 * axis rather than another confidence tier.
 *
 * IMPORTANT -- recency is SURFACED, never silently weighted into score or rank.
 * A scholar's uncurated publications are simply absent from `publication_author`,
 * and that gap is not random: it concentrates on affiliated faculty (31.3% read
 * >=8y stale on curation alone, vs 8.2% of full-time). Demoting on staleness
 * would encode a curation gap as a judgment about a person's focus. Emitting
 * `first_year` / `last_year` / `recent_pubs` lets a human see the difference;
 * silently down-ranking would not.
 */
export type Focus = "primary" | "secondary" | "peripheral";

export function focusOf(
  rank: number, confidence: "high" | "medium" | "low", lastYear: number, asOfYear: number,
): Focus {
  const stale = lastYear === 0 || lastYear < asOfYear - STALE_AFTER_YEARS;
  if (stale || confidence === "low") return "peripheral";
  return rank === 1 ? "primary" : "secondary";
}

/** Specialty lookup key — same normalization as `lib/clinical-mesh-anchors.ts`
 *  so POPS casing / punctuation drift can't cause a silent miss. */
export function anchorKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * One row of `docs/cancer-center-person-rollup.csv`: an article-axis topic
 * bucket (`lib/cancer-taxonomy.ts`'s `topics`) rolled up to a person-facing
 * disease code. `person_code` empty means the bucket contributes no identity
 * claim at all -- see the CSV's own header comment.
 */
export type RollupRow = { article_bucket: string; person_code: string; display_label: string; note: string };

/**
 * Roll every cancer-relevant MeSH descriptor's article-bucket topics up to
 * person-facing disease code(s), through the curated rollup CSV.
 *
 * Unlike the retired `buildCodeByUi`, there is no subtree walk or anchor-
 * specificity question here: `topicsByUi` is already the precomputed closure
 * (`lib/cancer-taxonomy.ts`), and a descriptor's topics are already a small,
 * resolved multi-valued set. This function only does the bucket -> code
 * lookup, dropping unmapped buckets, and drops a descriptor entirely (rather
 * than keeping an empty Set) when none of its buckets map to a code.
 */
export function rollupCodeByUi(
  topicsByUi: Map<string, string[]>,
  rollup: RollupRow[],
): Map<string, Set<string>> {
  const codeByBucket = new Map<string, string>();
  for (const r of rollup) {
    if (!r.person_code) continue;
    if (!codeByBucket.has(r.article_bucket)) codeByBucket.set(r.article_bucket, r.person_code);
  }

  const codeByUi = new Map<string, Set<string>>();
  for (const [ui, topics] of topicsByUi) {
    const codes = new Set<string>();
    for (const topic of topics) {
      const code = codeByBucket.get(topic);
      if (code) codes.add(code);
    }
    if (codes.size > 0) codeByUi.set(ui, codes);
  }
  return codeByUi;
}

/** Trials store MeSH as descriptor NAMES (`clinical_trial.mesh_terms`), not
 *  UIs, so they need a name -> UI lookup before they can reuse `codeByUi`.
 *  Sort by UI before inverting so a name collision resolves deterministically
 *  to the same UI on every run -- the same determinism posture the old code
 *  had via `descriptors` sorted by `ui`. */
export function invertNameByUi(nameByUi: Map<string, string>): Map<string, string> {
  const uiByName = new Map<string, string>();
  for (const [ui, name] of [...nameByUi.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!uiByName.has(name)) uiByName.set(name, ui);
  }
  return uiByName;
}

/**
 * Active manual suppressions, folded the way `loadAllPublicationSuppressions`
 * folds them (`lib/api/manual-layer.ts:296-302`).
 *
 * Two traps, both silent if got wrong:
 *   - Active means `revoked_at IS NULL` ONLY. Revoked rows are retained, never
 *     deleted, so omitting the predicate re-hides restored papers.
 *   - `contributor_cwid IS NULL` means EVERYONE (a whole-entity takedown), not
 *     "no one". Treating NULL as a non-matching cwid lets takedowns through.
 */
export type SuppressionSet = {
  darkPmids: Set<string>;
  hiddenAuthorsByPmid: Map<string, Set<string>>;
  darkGrantIds: Set<string>;
};

export function foldSuppressions(
  rows: Array<{ entityType: string; entityId: string; contributorCwid: string | null }>,
): SuppressionSet {
  const sup: SuppressionSet = {
    darkPmids: new Set(), hiddenAuthorsByPmid: new Map(), darkGrantIds: new Set(),
  };
  for (const r of rows) {
    if (r.entityType === "grant") { sup.darkGrantIds.add(r.entityId); continue; }
    if (r.entityType !== "publication") continue;
    if (r.contributorCwid === null) { sup.darkPmids.add(r.entityId); continue; }
    let hidden = sup.hiddenAuthorsByPmid.get(r.entityId);
    if (!hidden) sup.hiddenAuthorsByPmid.set(r.entityId, (hidden = new Set()));
    hidden.add(r.contributorCwid);
  }
  return sup;
}

/** The people-side predicate, identical to `lib/search-index-docs.ts:1058`.
 *  Derived-dark is deliberately NOT applied here: if the scholar is a displayed
 *  author the pub isn't derived-dark from their authorship, and if they hid it
 *  the per-author rule already skips. */
export function isAuthorSuppressed(sup: SuppressionSet, pmid: string, cwid: string): boolean {
  return sup.darkPmids.has(pmid) || (sup.hiddenAuthorsByPmid.get(pmid)?.has(cwid) ?? false);
}

export type Authorship = {
  pmid: string;
  cwid: string;
  /** `publication.year` -- the year of PUBLICATION, deliberately not
   *  `dateAddedToEntrez`, which is a curation artifact. */
  year: number | null;
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
  totalAuthors: number;
  meshUis: string[];
};

/** Role for ONE paper. `sole` counts as first AND last -- the promotion-committee
 *  convention already encoded in `authorRole()` (lib/search-index-docs.ts:86). */
export function kindOf(a: Authorship): keyof typeof AUTHORSHIP_WEIGHTS {
  if (a.totalAuthors === 1 || a.isFirst || a.isLast) return "firstOrLast";
  if (a.isPenultimate) return "secondOrPenultimate";
  return "middle";
}

export type Member = {
  cwid: string; name: string; program: string; specialties: string[];
  /** False when the roster cwid has no `scholar` row. There is deliberately no
   *  FK from `CenterMembership` to `Scholar` (an incoming hire may be rostered
   *  before their record arrives), so a typo'd CWID and a real incoming hire are
   *  indistinguishable to the script -- both simply produce no rows. Reported so
   *  a human can tell them apart. */
  inDirectory: boolean;
};

/** A grant's MeSH tags, with the role that earned them. `role` is InfoEd's
 *  (PI | PI-Subaward | Co-PI | Co-I | Key Personnel). */
export type GrantRow = { externalId: string; cwid: string; role: string; meshUis: string[] };

/** Being PI on a disease-tagged award is the grant analogue of senior authorship:
 *  you were funded to do it. Co-I / Key Personnel are supporting. */
export function grantIsLed(role: string): boolean {
  const r = role.toLowerCase();
  return r === "pi" || r === "co-pi" || r === "pi-subaward";
}

/** A trial's MeSH, as `clinical_trial.mesh_terms` stores it: a semicolon-
 *  delimited list of NLM descriptor NAMES ("Carcinoma, Non-Small-Cell Lung;
 *  Lung Neoplasms") -- NOT the UI array grants use. */
export type TrialRow = { cwid: string; role: string; meshNames: string[] };

export function parseTrialMesh(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Leading a trial on a disease is the strongest clinical claim available. */
export function trialIsLed(role: string): boolean {
  return role.trim().toLowerCase() === "principal investigator";
}

export type Assignment = {
  cwid: string; name: string; program: string; totalPubs: number; rank: number;
  code: string; lead: number; second: number; middle: number;
  grantsLed: number; grantsSupport: number;
  trialsLed: number; trialsSupport: number;
  /** Publication-only score. Governs rank -- see the sort in `assign`. */
  pubScore: number;
  /** All axes combined. Orders within equal publication evidence. */
  score: number;
  /** Publication-year span of the evidence. 0 = no dated publication. */
  firstYear: number; lastYear: number;
  /** Publications within RECENT_WINDOW_YEARS of `asOf`. */
  recentPubs: number;
  focus: Focus;
  specialtyMatch: boolean; specialtyStatus: SpecialtyStatus; specialties: string[];
  confidence: "high" | "medium" | "low";
};

/**
 * Why a row does or doesn't corroborate against clinical specialty (#2033).
 *
 * A bare Y/N made every non-match indistinguishable, which is what stopped an
 * SME auditing a colorectal surgeon's pancreas row: `N` conflated "this member's
 * board says something else" with "no board exists for this cancer" with "we
 * never mapped their specialty" with "they have no specialty on file". Only
 * `other-code` is an actual disagreement.
 */
export type SpecialtyStatus =
  | "match" // a mapped specialty of this member points at this code
  | "other-code" // member has mapped specialties, none is this code -- the only contradiction
  | "code-unmapped" // no specialty in the map points at this code, for anyone
  | "specialty-unmapped" // member has specialties, none of them appear in the map
  | "no-specialty"; // no POPS specialty on file at all

export function specialtyStatusOf(
  isMatch: boolean,
  codeIsMapped: boolean,
  memberHasMappedSpecialty: boolean,
  memberHasAnySpecialty: boolean,
): SpecialtyStatus {
  if (isMatch) return "match";
  if (!codeIsMapped) return "code-unmapped";
  if (memberHasMappedSpecialty) return "other-code";
  return memberHasAnySpecialty ? "specialty-unmapped" : "no-specialty";
}

/**
 * Confidence, not a binary gate -- excluding outright buries the sparse-profile
 * members, so every disease with any real evidence is listed and labelled.
 *
 * Four independent axes: publications (by author rank), grants (by PI role),
 * clinical trials (by PI role), clinical specialty. `leadEvidence` = papers you
 * led + awards you led + trials you led, because driving a study, being funded
 * for it, and running the trial are the same class of claim.
 *
 *   high   - leadEvidence >= 2. Volume of middle-authorship never reaches this.
 *   medium - leadEvidence == 1, or >= 2 supporting awards/trials, or specialty + papers.
 *   low    - >= MIN_PUBS papers in any position, any tagged award/trial, or specialty alone.
 */
export function confidenceOf(
  lead: number, pubs: number, specialtyMatch: boolean,
  grantsLed = 0, grantsSupport = 0, trialsLed = 0, trialsSupport = 0,
) {
  const leadEvidence = lead + grantsLed + trialsLed;
  const supportAll = grantsLed + grantsSupport + trialsLed + trialsSupport;
  if (leadEvidence >= 2) return "high" as const;
  if (leadEvidence === 1 || supportAll >= 2 || (specialtyMatch && pubs >= MIN_PUBS)) return "medium" as const;
  // Specialty ALONE no longer assigns. It corroborates evidence; it does not
  // manufacture it. Cancer Center review: a hematologist with no leukemia,
  // lymphoma, myeloma or MDS output was still carrying all four as rows, which
  // read as "a lot of noise around their specialty". Reverting this restores
  // specialty-only assignment -- it is one `|| specialtyMatch` (Open Decision 4).
  if (pubs >= MIN_PUBS || supportAll >= 1) return "low" as const;
  return null;
}

export function assign(
  members: Member[],
  authorships: Authorship[],
  codeByUi: Map<string, Set<string>>,
  uiByName: Map<string, string>,
  specialtyMap: Row[],
  grants: GrantRow[] = [],
  trials: TrialRow[] = [],
  asOfYear = new Date().getFullYear(),
): { rows: Assignment[] } {
  const codesBySpecialty = new Map<string, Set<string>>();
  // Which disease codes any specialty can reach at all. A code absent here can
  // never corroborate for anyone, which is a property of the map, not of the
  // member -- the distinction #2033 needed.
  const mappedCodes = new Set<string>();
  for (const r of specialtyMap) {
    const k = anchorKey(r.specialty);
    if (!codesBySpecialty.has(k)) codesBySpecialty.set(k, new Set());
    codesBySpecialty.get(k)!.add(r.disease_code);
    mappedCodes.add(r.disease_code);
  }

  type Acc = { lead: number; second: number; middle: number; score: number;
    firstYear: number; lastYear: number; recent: number };
  const agg = new Map<string, Map<string, Acc>>();
  const totals = new Map<string, number>();
  for (const a of authorships) {
    totals.set(a.cwid, (totals.get(a.cwid) ?? 0) + 1);
    const codes = new Set<string>();
    for (const ui of a.meshUis) for (const c of codeByUi.get(ui) ?? []) codes.add(c);
    if (codes.size === 0) continue;
    const kind = kindOf(a);
    let per = agg.get(a.cwid);
    if (!per) agg.set(a.cwid, (per = new Map()));
    for (const c of codes) {
      const e = per.get(c) ?? { lead: 0, second: 0, middle: 0, score: 0, firstYear: 0, lastYear: 0, recent: 0 };
      if (kind === "firstOrLast") e.lead++;
      else if (kind === "secondOrPenultimate") e.second++;
      else e.middle++;
      e.score += AUTHORSHIP_WEIGHTS[kind];
      if (a.year) {
        if (!e.firstYear || a.year < e.firstYear) e.firstYear = a.year;
        if (a.year > e.lastYear) e.lastYear = a.year;
        if (a.year >= asOfYear - RECENT_WINDOW_YEARS) e.recent += 1;
      }
      per.set(c, e);
    }
  }

  // Grants, folded to disease codes through the SAME rollup map as publications.
  const gAgg = new Map<string, Map<string, { led: number; support: number }>>();
  for (const g of grants) {
    const codes = new Set<string>();
    for (const ui of g.meshUis) for (const c of codeByUi.get(ui) ?? []) codes.add(c);
    if (codes.size === 0) continue;
    const led = grantIsLed(g.role);
    let per = gAgg.get(g.cwid);
    if (!per) gAgg.set(g.cwid, (per = new Map()));
    for (const c of codes) {
      const e = per.get(c) ?? { led: 0, support: 0 };
      if (led) e.led++;
      else e.support++;
      per.set(c, e);
    }
  }

  // Trials. Their MeSH arrives as descriptor NAMES, so resolve name -> UI first
  // (`uiByName`, precomputed upstream) and then reuse the exact same rollup
  // map as publications and grants.
  const tAgg = new Map<string, Map<string, { led: number; support: number }>>();
  for (const t of trials) {
    const codes = new Set<string>();
    for (const nm of t.meshNames) {
      const ui = uiByName.get(nm);
      if (!ui) continue;
      for (const c of codeByUi.get(ui) ?? []) codes.add(c);
    }
    if (codes.size === 0) continue;
    const led = trialIsLed(t.role);
    let per = tAgg.get(t.cwid);
    if (!per) tAgg.set(t.cwid, (per = new Map()));
    for (const c of codes) {
      const e = per.get(c) ?? { led: 0, support: 0 };
      if (led) e.led++;
      else e.support++;
      per.set(c, e);
    }
  }

  const rows: Assignment[] = [];
  for (const m of members) {
    const specCodes = new Set<string>();
    for (const s of m.specialties) for (const c of codesBySpecialty.get(anchorKey(s)) ?? []) specCodes.add(c);
    const per = agg.get(m.cwid) ?? new Map();
    const gPer = gAgg.get(m.cwid) ?? new Map();
    const tPer = tAgg.get(m.cwid) ?? new Map();
    const codes = new Set<string>([...per.keys(), ...gPer.keys(), ...tPer.keys(), ...specCodes]);
    const mine: Assignment[] = [];
    for (const code of codes) {
      const e = per.get(code) ?? { lead: 0, second: 0, middle: 0, score: 0, firstYear: 0, lastYear: 0, recent: 0 };
      const g = gPer.get(code) ?? { led: 0, support: 0 };
      const t = tPer.get(code) ?? { led: 0, support: 0 };
      const pubs = e.lead + e.second + e.middle;
      const specialtyMatch = specCodes.has(code);
      const specialtyStatus = specialtyStatusOf(
        specialtyMatch, mappedCodes.has(code), specCodes.size > 0, m.specialties.length > 0,
      );
      const confidence = confidenceOf(e.lead, pubs, specialtyMatch, g.led, g.support, t.led, t.support);
      if (!confidence) continue;
      // One score, same lead/support weights on every axis, components all kept
      // in the sheet so any row can be audited back to its evidence.
      const score = e.score +
        AUTHORSHIP_WEIGHTS.firstOrLast * (g.led + t.led) +
        AUTHORSHIP_WEIGHTS.secondOrPenultimate * (g.support + t.support);
      mine.push({
        cwid: m.cwid, name: m.name, program: m.program, totalPubs: totals.get(m.cwid) ?? 0,
        rank: 0, code, lead: e.lead, second: e.second, middle: e.middle,
        grantsLed: g.led, grantsSupport: g.support, trialsLed: t.led, trialsSupport: t.support,
        pubScore: e.score, score, firstYear: e.firstYear, lastYear: e.lastYear,
        recentPubs: e.recent, focus: "peripheral", specialtyMatch, specialtyStatus,
        specialties: m.specialties, confidence,
      });
    }
    // Descending importance, PUBLICATION EVIDENCE FIRST.
    //
    // Ranking on the combined score exposed the headline disease to the noisiest
    // axis: one keyword-resolved PI grant (10) outranked nine middle-author
    // papers (9), so grant MeSH could choose a member's primary disease while
    // the confidence tiers -- which deliberately cap that same lone grant at
    // `medium` and never `high` -- looked on. What governs confidence must also
    // govern rank.
    //
    // Publications are the only axis with curated NLM indexing; grant MeSH is
    // keyword-resolved and trial MeSH comes from ClinicalTrials.gov enrichment.
    // So publications choose the primary, and the combined score orders within
    // equal publication evidence -- grants and trials still raise confidence and
    // can still contribute a disease the publications never would.
    //
    // Total order: `code` is unique per person, so ties can never reorder.
    mine.sort((a, b) => b.pubScore - a.pubScore || b.score - a.score || b.lead - a.lead ||
      b.grantsLed - a.grantsLed || b.trialsLed - a.trialsLed ||
      Number(b.specialtyMatch) - Number(a.specialtyMatch) || a.code.localeCompare(b.code));
    mine.forEach((r, i) => {
      r.rank = i + 1;
      r.focus = focusOf(r.rank, r.confidence, r.lastYear, asOfYear);
    });
    rows.push(...mine);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.cwid.localeCompare(b.cwid) || a.rank - b.rank);
  return { rows };
}

export function toCsv(rows: Assignment[], labels: Map<string, string>): string {
  const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = "cwid,name,program,total_pubs,rank,disease_code,disease,lead_pubs,second_pubs," +
    "middle_pubs,grants_led,grants_support,trials_led,trials_support,pub_score,score," +
    "first_year,last_year,recent_pubs,focus,specialty_status,specialties,confidence";
  return [head, ...rows.map((r) => [r.cwid, q(r.name), r.program, r.totalPubs, r.rank, r.code,
    q(labels.get(r.code) ?? ""), r.lead, r.second, r.middle, r.grantsLed, r.grantsSupport,
    r.trialsLed, r.trialsSupport, r.pubScore, r.score,
    r.firstYear || "", r.lastYear || "", r.recentPubs, r.focus, r.specialtyStatus,
    q(r.specialties.join("; ")), r.confidence].join(","))].join("\n") + "\n";
}

export function labelsOf(rollup: RollupRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rollup) if (r.person_code && !m.has(r.person_code)) m.set(r.person_code, r.display_label);
  return m;
}

// --- self-check: the two bugs this script exists to prevent -----------------
export function selfCheck(): void {
  // The rollup layer: a mapped bucket surfaces its code, an unmapped bucket
  // contributes nothing, and a descriptor whose topics are ALL unmapped
  // buckets is absent from the map entirely -- not an empty Set. (The old
  // anchor-specificity check this replaced -- "melanoma absorbed by a broad
  // anchor" -- tested a subtree walk this script no longer performs; that
  // behavior now lives in `etl/cancer-taxonomy/generate.ts`, covered by its
  // own tests.)
  const rollupFixture: RollupRow[] = [
    { article_bucket: "breast", person_code: "BREAST", display_label: "Breast Cancer", note: "" },
    { article_bucket: "cc-biology", person_code: "", display_label: "", note: "" },
  ];
  const mixedCodes = rollupCodeByUi(
    new Map([
      ["D001943", ["breast", "cc-biology"]],
      ["D999999", ["cc-biology"]],
    ]),
    rollupFixture,
  );
  const mixed = [...(mixedCodes.get("D001943") ?? [])];
  if (mixed.length !== 1 || mixed[0] !== "BREAST") {
    throw new Error(`mixed mapped/unmapped buckets should surface only the mapped code: ${mixed}`);
  }
  if (mixedCodes.has("D999999")) {
    throw new Error("a descriptor whose buckets are all unmapped must be absent, not an empty Set");
  }
  // A pure middle-author record must never reach "high", however voluminous.
  if (confidenceOf(0, 500, false) === "high") throw new Error("volume alone reached high confidence");
  if (confidenceOf(2, 2, false) !== "high") throw new Error("two lead papers should be high");
  if (confidenceOf(0, 0, true) !== null) {
    throw new Error("specialty ALONE must not assign -- it corroborates, it does not manufacture evidence");
  }
  if (confidenceOf(0, 1, false) !== null) throw new Error("1 pub, no specialty should not assign");
  // Grants: PI counts as lead evidence, Co-I does not.
  if (confidenceOf(1, 1, false, 1, 0) !== "high") throw new Error("1 lead paper + 1 PI grant should be high");
  if (confidenceOf(0, 0, false, 0, 5) === "high") throw new Error("co-investigator grants alone reached high");
  if (confidenceOf(0, 0, false, 1, 0) !== "medium") throw new Error("one PI grant should be medium");
  if (!grantIsLed("PI") || !grantIsLed("Co-PI") || grantIsLed("Co-I") || grantIsLed("Key Personnel")) {
    throw new Error("grant role lead/support split wrong");
  }
  // Trials: semicolon-delimited descriptor NAMES, and PI is the only lead role.
  const tm = parseTrialMesh("Carcinoma, Non-Small-Cell Lung; Lung Neoplasms");
  if (tm.length !== 2 || tm[0] !== "Carcinoma, Non-Small-Cell Lung" || tm[1] !== "Lung Neoplasms") {
    throw new Error(`trial mesh must split on ';' only, not the comma inside a name: ${JSON.stringify(tm)}`);
  }
  if (parseTrialMesh(null).length !== 0) throw new Error("null trial mesh should be empty");
  if (!trialIsLed("Principal Investigator") || trialIsLed("Investigator")) {
    throw new Error("trial role lead/support split wrong");
  }
  if (confidenceOf(0, 0, false, 0, 0, 2, 0) !== "high") throw new Error("two led trials should be high");
  if (confidenceOf(0, 0, false, 0, 0, 0, 1) !== "low") throw new Error("one supporting trial should be low");
  // #2033 -- the four non-match cases must stay distinguishable. Collapsing any
  // of them back to a bare "N" is what made an SME unable to audit a row.
  if (specialtyStatusOf(true, true, true, true) !== "match") throw new Error("match");
  if (specialtyStatusOf(false, false, true, true) !== "code-unmapped") {
    throw new Error("a code no specialty maps to is silence, not disagreement");
  }
  if (specialtyStatusOf(false, true, true, true) !== "other-code") throw new Error("other-code");
  if (specialtyStatusOf(false, true, false, true) !== "specialty-unmapped") {
    throw new Error("member has a specialty we never mapped -- not a contradiction");
  }
  if (specialtyStatusOf(false, true, false, false) !== "no-specialty") throw new Error("no-specialty");
  // Sole authorship counts as first AND last, but is ONE kind -- so it scores 10,
  // not 20. Pinned because "counts as both" reads like it should double.
  const sole: Authorship = {
    pmid: "1", cwid: "x", year: 2024, isFirst: false, isLast: false, isPenultimate: false,
    totalAuthors: 1, meshUis: [],
  };
  if (kindOf(sole) !== "firstOrLast") throw new Error("sole should classify as firstOrLast");
  if (AUTHORSHIP_WEIGHTS[kindOf(sole)] !== 10) throw new Error("sole must score 10, not 20");
  // Comment lines must not become data rows.
  const parsed = parseCsv("# note, with a comma\na,b\n1,2\n");
  if (parsed.length !== 1 || parsed[0].a !== "1") throw new Error(`comment row leaked: ${JSON.stringify(parsed)}`);

  // Suppression: NULL contributor means EVERYONE, and a revoked row is not active.
  const sup = foldSuppressions([
    { entityType: "publication", entityId: "111", contributorCwid: null },
    { entityType: "publication", entityId: "222", contributorCwid: "alice" },
    { entityType: "grant", entityId: "G1", contributorCwid: null },
  ]);
  if (!isAuthorSuppressed(sup, "111", "anyone")) throw new Error("NULL contributor must hide the pub for everyone");
  if (!isAuthorSuppressed(sup, "222", "alice")) throw new Error("per-author hide must apply to that author");
  if (isAuthorSuppressed(sup, "222", "bob")) throw new Error("per-author hide must NOT apply to other authors");
  if (!sup.darkGrantIds.has("G1")) throw new Error("grant takedown missed");

  // Focus: staleness and low confidence both read as peripheral, and recency is
  // reported rather than used to demote. A 2017 last-publication in 2026 is
  // peripheral however strong the evidence was at the time.
  if (focusOf(1, "high", 2017, 2026) !== "peripheral") throw new Error("a 9-year-stale row is peripheral");
  if (focusOf(1, "high", 2024, 2026) !== "primary") throw new Error("recent rank-1 high is primary");
  if (focusOf(2, "high", 2024, 2026) !== "secondary") throw new Error("recent rank-2 high is secondary");
  if (focusOf(1, "low", 2024, 2026) !== "peripheral") throw new Error("low confidence is peripheral");
  if (focusOf(1, "high", 0, 2026) !== "peripheral") throw new Error("no dated publication is peripheral");

  // The noisiest axis must not choose the headline disease. One keyword-resolved
  // PI grant (combined score 10) must NOT outrank nine middle-author papers
  // (combined score 9) for rank 1.
  const rankCodeByUi = new Map<string, Set<string>>([
    ["D001943", new Set(["BREAST"])], // Breast Neoplasms
    ["D008175", new Set(["LUNG"])], // Lung Neoplasms
  ]);
  const rankUiByName = new Map<string, string>([
    ["Breast Neoplasms", "D001943"],
    ["Lung Neoplasms", "D008175"],
  ]);
  const mid = Array.from({ length: 9 }, (_, i) => ({
    pmid: `p${i}`,
    cwid: "x", year: 2024, isFirst: false, isLast: false, isPenultimate: false,
    totalAuthors: 8, meshUis: ["D008175"],
  }));
  const { rows: ranked } = assign(
    [{ cwid: "x", name: "X", program: "", specialties: [], inDirectory: true }],
    mid, rankCodeByUi, rankUiByName, [],
    [{ externalId: "G-1", cwid: "x", role: "PI", meshUis: ["D001943"] }],
  );
  const top = ranked.find((r) => r.rank === 1);
  if (!top || top.code !== "LUNG") {
    throw new Error(`a lone keyword-resolved grant took rank 1 over 9 papers: ${JSON.stringify(ranked.map((r) => [r.rank, r.code, r.pubScore, r.score]))}`);
  }
}

export type RunAssignmentsResult = {
  rows: Assignment[];
  rollup: RollupRow[];
  /** `# schema_version: ...` header line the CLI's CSV output prepends. */
  schemaVersionLine: string;
  /** Same two values folded into `schemaVersionLine`, kept raw for callers
   *  (the ETL step) that want them as `EtlRun.manifestSha256` /
   *  `manifestTaxonomyVersion` rather than reparsing the formatted line. */
  taxonomyManifestSha256: string;
  taxonomyManifestVersion: string;
};

/** The whole pipeline, with the curated inputs passed in as text and the
 *  structured result handed back rather than formatted CSV. `run()` below
 *  (CLI/CSV output) and `etl/cancer-center-disease-assignments/index.ts`
 *  (persisted table) both call THIS, so neither can drift from the other. */
export async function runAssignments(
  rollupCsv: string, specialtyCsv: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<RunAssignmentsResult> {
  selfCheck();
  // `parseCsv` is column-name-agnostic (`Row = Record<string, string>`); the
  // rollup CSV's columns are known and fixed, so narrow to `RollupRow` here.
  const rollup = parseCsv(rollupCsv) as unknown as RollupRow[];
  const specialtyMap = parseCsv(specialtyCsv);

  // Resolve defensively: the named export lands under `.default` when loaded as
  // ESM and at the top level when the bundle is eval'd as CJS.
  const mod = (await import("mariadb")) as unknown as typeof import("mariadb") & {
    default?: typeof import("mariadb");
  };
  const mariadb = mod.default ?? mod;
  const u = new URL(process.env.DATABASE_URL!);
  const conn = await mariadb.createConnection({
    host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: u.pathname.slice(1),
  });
  // try/finally, not a bare `await conn.end()` after the last query: the CLI
  // entrypoint's own catch calls `process.exit(1)` on any throw, which used to
  // paper over a leaked connection by killing the process outright. A caller
  // that instead sets `process.exitCode` and awaits a graceful shutdown (the
  // ETL step) would otherwise hang forever on the still-open socket.
  try {
    const json = (v: unknown) => {
      if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
      return v;
    };

    // `loadCancerTaxonomy` (lib/cancer-taxonomy.ts) is the ONE reader of
    // `CancerTaxonomyDescriptor`; this script stays on the raw `mariadb` driver
    // (deliberately, to avoid dragging Prisma/the mariadb driver into any
    // client-bundled import chain -- see `lib/edit/manageable-units.ts`'s
    // doc-comment for that trap) by handing it two tiny hand-written adapters
    // instead of a Prisma client.
    let taxonomyRunId: string | null = null;
    const taxonomyDb: CancerTaxonomyDescriptorReader = {
      findMany: async () => {
        const rows: Array<{ descriptor_ui: string; topics: unknown; taxonomy_run_id: string }> =
          await conn.query(
            "SELECT descriptor_ui, topics, taxonomy_run_id FROM cancer_taxonomy_descriptor WHERE cancer_relevant = 1",
          );
        if (rows.length === 0) {
          throw new Error(
            "cancer_taxonomy_descriptor is empty -- run `npm run etl:cancer-taxonomy` first",
          );
        }
        // Every row shares one taxonomy_run_id under the generator's
        // full-replace model.
        taxonomyRunId = rows[0].taxonomy_run_id;
        return rows.map((r) => ({ descriptorUi: r.descriptor_ui, topics: json(r.topics) ?? [] }));
      },
    };
    const meshDb: MeshDescriptorNameReader = {
      findMany: async (args) => {
        const uis = args.where.descriptorUi.in;
        if (uis.length === 0) return [];
        const rows: Array<{ descriptor_ui: string; name: string }> = await conn.query(
          `SELECT descriptor_ui, name FROM mesh_descriptor WHERE descriptor_ui IN (${uis.map(() => "?").join(",")})`,
          uis,
        );
        return rows.map((r) => ({ descriptorUi: r.descriptor_ui, name: r.name }));
      },
    };
    const { topicsByUi, nameByUi } = await loadCancerTaxonomy(taxonomyDb, meshDb);
    if (!taxonomyRunId) {
      throw new Error("cancer_taxonomy_descriptor query never ran -- unable to determine taxonomy_run_id");
    }
    const codeByUi = rollupCodeByUi(topicsByUi, rollup);
    const uiByName = invertNameByUi(nameByUi);

    // Provenance line: the ruleset sha256 + paired MeSH version that produced
    // the taxonomy rows this run just read, from the SAME `EtlRun` row --
    // deliberately not a timestamp, so the output stays byte-identical across
    // repeated runs against the same taxonomy generation.
    const etlRunRows = await conn.query(
      "SELECT manifest_sha256, manifest_taxonomy_version FROM etl_run WHERE id = ?",
      [taxonomyRunId],
    );
    const etlRun = etlRunRows[0];
    if (!etlRun || !etlRun.manifest_sha256 || !etlRun.manifest_taxonomy_version) {
      throw new Error(
        `EtlRun ${taxonomyRunId} for cancer_taxonomy_descriptor is missing manifest_sha256/manifest_taxonomy_version`,
      );
    }
    const schemaVersionLine =
      `# schema_version: ruleset:${String(etlRun.manifest_sha256).slice(0, 12)} ${etlRun.manifest_taxonomy_version}`;

    const today = asOf;
    const asOfYear = Number(asOf.slice(0, 4));
    type MemberRow = {
      cwid: string; program_code: string | null; start_date: unknown; end_date: unknown;
      preferred_name: string | null; pops_specialties: unknown; pops_board_certifications: unknown;
    };
    const memberRows: MemberRow[] = await conn.query(
      "SELECT m.cwid, m.program_code, m.start_date, m.end_date, s.preferred_name, " +
        "s.pops_specialties, s.pops_board_certifications FROM center_membership m " +
        "LEFT JOIN scholar s ON s.cwid = m.cwid WHERE m.center_code = 'meyer_cancer_center'",
    );
    const members: Member[] = memberRows
      .filter((r) => {
        const d = (x: unknown) => (x ? new Date(x as string | number | Date).toISOString().slice(0, 10) : null);
        return (!d(r.start_date) || d(r.start_date)! <= today) && (!d(r.end_date) || d(r.end_date)! >= today);
      })
      .map((r) => {
        const names = new Set<string>();
        for (const x of json(r.pops_specialties) ?? []) if (typeof x === "string" && x) names.add(x);
        for (const x of json(r.pops_board_certifications) ?? []) if (x?.specialty) names.add(x.specialty);
        return {
          cwid: r.cwid, name: r.preferred_name ?? r.cwid, program: r.program_code ?? "",
          specialties: [...names].sort(), inDirectory: r.preferred_name != null,
        };
      })
      .sort((a: Member, b: Member) => a.cwid.localeCompare(b.cwid));

    // Active manual suppressions. Loaded whole -- the table is small and this is
    // exactly what the batch ETL does. A person-named artifact headed for SME
    // review must not carry papers that were hidden for cause.
    const suppressionRows: Array<{ entity_type: string; entity_id: string; contributor_cwid: string | null }> =
      await conn.query(
        "SELECT entity_type, entity_id, contributor_cwid FROM suppression " +
          "WHERE entity_type IN ('publication','grant') AND revoked_at IS NULL",
      );
    const sup = foldSuppressions(
      suppressionRows.map((r) => ({
        entityType: r.entity_type, entityId: r.entity_id, contributorCwid: r.contributor_cwid ?? null,
      })),
    );

    const authorships: Authorship[] = [];
    let suppressedPubs = 0;
    for (let i = 0; i < members.length; i += 40) {
      const ids = members.slice(i, i + 40).map((m) => m.cwid);
      const rows = await conn.query(
        "SELECT pa.pmid, pa.cwid, pa.is_first, pa.is_last, pa.is_penultimate, pa.total_authors, p.year, p.mesh_terms " +
          "FROM publication_author pa JOIN publication p ON p.pmid = pa.pmid " +
          `WHERE pa.is_confirmed = 1 AND pa.cwid IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      for (const r of rows) {
        if (isAuthorSuppressed(sup, r.pmid, r.cwid)) { suppressedPubs++; continue; }
        const mt = json(r.mesh_terms);
        authorships.push({
          pmid: r.pmid, cwid: r.cwid, year: r.year == null ? null : Number(r.year),
          isFirst: !!r.is_first, isLast: !!r.is_last,
          isPenultimate: !!r.is_penultimate, totalAuthors: Number(r.total_authors),
          meshUis: Array.isArray(mt)
            ? mt
                .map((x: unknown) => (x && typeof x === "object" ? (x as { ui?: string }).ui : null))
                .filter((ui): ui is string => typeof ui === "string")
            : [],
        });
      }
    }
    // Grants. `JSON_TYPE(...)='ARRAY'` -- NOT `IS NOT NULL`, which a JSON scalar
    // null passes, reporting coverage that isn't there.
    const grants: GrantRow[] = [];
    let suppressedGrants = 0;
    for (let i = 0; i < members.length; i += 40) {
      const ids = members.slice(i, i + 40).map((m) => m.cwid);
      const rows = await conn.query(
        "SELECT external_id, cwid, role, mesh_descriptor_uis FROM `grant` " +
          `WHERE JSON_TYPE(mesh_descriptor_uis) = 'ARRAY' AND JSON_LENGTH(mesh_descriptor_uis) > 0 ` +
          `AND cwid IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      for (const r of rows) {
        // Grant suppressions are whole-entity, keyed on `external_id`.
        if (sup.darkGrantIds.has(r.external_id)) { suppressedGrants++; continue; }
        const uis = json(r.mesh_descriptor_uis);
        grants.push({
          externalId: r.external_id, cwid: r.cwid, role: r.role ?? "",
          meshUis: Array.isArray(uis) ? uis.filter((x: unknown) => typeof x === "string") : [],
        });
      }
    }
    // Clinical trials. `mesh_terms` is a semicolon-delimited list of descriptor
    // NAMES, resolved against `uiByName` inside assign().
    const trials: TrialRow[] = [];
    for (let i = 0; i < members.length; i += 40) {
      const ids = members.slice(i, i + 40).map((m) => m.cwid);
      const rows = await conn.query(
        "SELECT p.cwid, p.role, t.mesh_terms FROM person_clinical_trial p " +
          "JOIN clinical_trial t ON t.protocol_number = p.protocol_number " +
          `WHERE t.mesh_terms IS NOT NULL AND t.mesh_terms <> '' ` +
          `AND p.cwid IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      for (const r of rows) {
        trials.push({ cwid: r.cwid, role: r.role ?? "", meshNames: parseTrialMesh(r.mesh_terms) });
      }
    }

    const { rows } = assign(members, authorships, codeByUi, uiByName, specialtyMap, grants, trials, asOfYear);

    // Non-blocking, but never silent. A roster cwid with no `scholar` row
    // contributes nothing; an incoming hire and a typo look identical here, and
    // only a human reading the list can tell which is which.
    const unmatched = members.filter((m) => !m.inDirectory).map((m) => m.cwid).sort();
    const withRows = new Set(rows.map((r) => r.cwid));
    const noEvidence = members
      .filter((m) => m.inDirectory && !withRows.has(m.cwid)).map((m) => m.cwid).sort();
    process.stderr.write(
      `roster: ${members.length} active | not in directory: ${unmatched.length}` +
        `${unmatched.length ? ` [${unmatched.join(" ")}]` : ""}` +
        ` | in directory, no disease evidence: ${noEvidence.length}\n` +
        `suppressed and excluded: ${suppressedPubs} authorships, ${suppressedGrants} grants\n`,
    );

    return {
      rows, rollup, schemaVersionLine,
      taxonomyManifestSha256: String(etlRun.manifest_sha256),
      taxonomyManifestVersion: String(etlRun.manifest_taxonomy_version),
    };
  } finally {
    await conn.end();
  }
}

/** CSV-formatting wrapper around `runAssignments` -- the CLI's output shape,
 *  unchanged by the split above. */
export async function run(
  rollupCsv: string, specialtyCsv: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<string> {
  const { rows, rollup, schemaVersionLine } = await runAssignments(rollupCsv, specialtyCsv, asOf);
  return schemaVersionLine + "\n" + toCsv(rows, labelsOf(rollup));
}

async function main(): Promise<void> {
  const root = process.cwd();
  process.stdout.write(
    await run(
      readFileSync(path.join(root, "docs/cancer-center-person-rollup.csv"), "utf8"),
      readFileSync(path.join(root, "docs/cancer-center-specialty-map.csv"), "utf8"),
      process.env.ASSIGNMENTS_AS_OF,
    ),
  );
}

// Run only when invoked directly, not when imported (`runAssignments` now also
// has an importer, `etl/cancer-center-disease-assignments/index.ts`, whose own
// path contains this file's name as a substring -- a plain `.includes()` check
// fired for that importer too and double-ran the pipeline under it).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
