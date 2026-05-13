/**
 * Autocomplete ranking v1 — pure logic for #231.
 *
 * Splits `suggestEntities` orchestration from the ranking algorithm so the
 * rules can be unit-tested without standing up OpenSearch or Prisma. All
 * exports here are pure: same input → same output.
 *
 * See `~/Dropbox/Projects/Scholars-Profile-System/231-autocomplete-v1.md`
 * for the v1 scope (algorithm only; A/B infra, fixture eval, and pubCountBucket
 * re-index are deferred to #254 / v2).
 */
import type { EntityKind } from "@/lib/api/search";

export type QueryShape = "name-like" | "topic-like" | "ambiguous";

export type PersonRanking = {
  text: string;
  cwid: string;
  slug: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  personType: string | null;
  lastNameSort: string | null;
};

export type TopicRanking = { id: string; label: string };
export type SubtopicRanking = { id: string; label: string; displayName: string | null };
export type NamedRanking = { name: string };

export type RankingSources = {
  person: PersonRanking[];
  topic: TopicRanking[];
  subtopic: SubtopicRanking[];
  department: NamedRanking[];
  division: NamedRanking[];
  center: NamedRanking[];
};

/** Default fallback order when shape doesn't pin a lead. */
const DEFAULT_KIND_ORDER: EntityKind[] = [
  "department",
  "division",
  "center",
  "topic",
  "subtopic",
  "person",
];

// Real codes from etl/ed/index.ts deriveRoleCategory. The spec used placeholder
// names; this map is the authoritative one. Full-time faculty rank first;
// affiliated faculty (voluntary, adjunct, emeritus, visiting) ahead of postdoc
// because the WCM scholar audience recognizes voluntary faculty as professors,
// not trainees.
const PERSON_ROLE_RANK: Record<string, number> = {
  full_time_faculty: 0,
  affiliated_faculty: 1,
  postdoc: 2,
  fellow: 3,
  non_faculty_academic: 4,
  instructor: 5,
  lecturer: 6,
  doctoral_student: 7,
  non_academic: 8,
};
const PERSON_ROLE_RANK_OTHER = 9;

const NAME_LIKE_RE = /^[A-ZÀ-Ý][a-zA-ZÀ-ÿ' -]+$/;
const TOPIC_STOPWORD_RE = /\b(of|and|the|in|for|via)\b/i;
const HAS_DIGIT_OR_SLASH_RE = /[0-9/]/;

/**
 * §2 — first-match shape classifier. `length < 3` forces ambiguous so no
 * shape-based lead leaks past the plausibility-gate minimum.
 */
export function classifyQueryShape(prefix: string): QueryShape {
  const q = prefix.trim();
  if (q.length < 3) return "ambiguous";
  if (NAME_LIKE_RE.test(q)) return "name-like";
  if (HAS_DIGIT_OR_SLASH_RE.test(q) || TOPIC_STOPWORD_RE.test(q)) return "topic-like";
  if (q === q.toLowerCase() && q.length >= 4) return "topic-like";
  return "ambiguous";
}

/**
 * Tokenize on whitespace + punctuation (treat all non-alphanum + non-apostrophe
 * as token boundaries). Used by the dept/div/center plausibility predicate so
 * `min` hits "Mind-Body" via the second token.
 */
function tokenizeEntityName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9']+/i)
    .filter(Boolean);
}

function firstToken(name: string | null | undefined): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0].toLowerCase();
}

/**
 * §1 — strong-hit plausibility predicates. Minimum prefix length 3 for any
 * kind; shorter prefixes return an empty set.
 *
 * Spec deviation: the spec checks "top result only" assuming OS-style
 * scoring puts the best match on top. People come from OpenSearch completion
 * suggester (so top-row is the canonical signal), but topics, subtopics,
 * depts, divisions, and centers come from Prisma sorted alphabetically by
 * label/name — so "top result" isn't a meaningful relevance signal there.
 * For those kinds we widen the predicate to "any fetched row", which matches
 * the spec's intent of "is there a confident match in this kind."
 *
 * Strong-hit ≠ displayability: dept "Department of Cardiomyopathy" still
 * surfaces for `cardio` via Prisma `contains`. The tokenwise predicate uses
 * `startsWith`, not `contains`, so departments named only by a substring
 * (e.g. "Pediatric Cardiomyopathy Research" tokenized) don't claim a hit
 * unless one of their tokens actually starts with the prefix.
 */
export function plausibilityHits(
  prefix: string,
  sources: RankingSources,
): Set<EntityKind> {
  const hits = new Set<EntityKind>();
  const p = prefix.trim().toLowerCase();
  if (p.length < 3) return hits;

  // Person — top-result-only, OS-scored signal.
  const topPerson = sources.person[0];
  if (topPerson) {
    const last = (topPerson.lastNameSort ?? "").toLowerCase();
    const first = firstToken(topPerson.text);
    if (last.startsWith(p) || first.startsWith(p)) hits.add("person");
  }

  // Topic / subtopic — any fetched row whose label starts with the prefix.
  if (sources.topic.some((r) => r.label.toLowerCase().startsWith(p))) {
    hits.add("topic");
  }
  if (sources.subtopic.some((r) => r.label.toLowerCase().startsWith(p))) {
    hits.add("subtopic");
  }

  // Dept / div / center — any fetched row with a tokenwise startsWith.
  for (const [kind, list] of [
    ["department", sources.department],
    ["division", sources.division],
    ["center", sources.center],
  ] as const) {
    if (list.some((r) => tokenizeEntityName(r.name).some((tok) => tok.startsWith(p)))) {
      hits.add(kind);
    }
  }

  return hits;
}

/**
 * §4 — resolve kind ordering. Pure: takes the plausibility set and the
 * classified shape, returns an ordered list of kinds. Cap fill applies after.
 *
 * Four branches:
 *   - exactly one plausibility hit → that kind leads
 *   - multiple hits → shape decides (name-like → person; topic-like → topic
 *     then subtopic; ambiguous → first hit in default order)
 *   - zero hits → fall back to shape (name-like → person; topic-like → topic;
 *     ambiguous → person)
 *
 * Remaining kinds always follow in default order minus what's already placed.
 */
export function chooseKindOrder(
  shape: QueryShape,
  hits: Set<EntityKind>,
): EntityKind[] {
  const out: EntityKind[] = [];
  const seen = new Set<EntityKind>();
  const push = (k: EntityKind) => {
    if (!seen.has(k)) {
      out.push(k);
      seen.add(k);
    }
  };

  let lead: EntityKind | null = null;

  if (hits.size === 1) {
    lead = [...hits][0]!;
  } else if (hits.size > 1) {
    if (shape === "name-like" && hits.has("person")) lead = "person";
    else if (shape === "topic-like" && hits.has("topic")) lead = "topic";
    else if (shape === "topic-like" && hits.has("subtopic")) lead = "subtopic";
    else {
      // Ambiguous / fallthrough: first plausibility hit in default order.
      for (const k of DEFAULT_KIND_ORDER) if (hits.has(k)) { lead = k; break; }
    }
  } else {
    // Zero hits.
    if (shape === "name-like") lead = "person";
    else if (shape === "topic-like") lead = "topic";
    else lead = "person";
  }

  if (lead) push(lead);

  // Strong-hit kinds next (not yet placed), in default order.
  for (const k of DEFAULT_KIND_ORDER) if (hits.has(k)) push(k);

  // Then the rest in default order.
  for (const k of DEFAULT_KIND_ORDER) push(k);

  return out;
}

/**
 * §3 — full-name carve-out. Returns the unique person to collapse to, or null
 * if the carve-out doesn't apply.
 *
 * Conditions (all required):
 *   1. Query trimmed contains ≥ 1 whitespace AND length ≥ 5.
 *   2. Exactly one person result.
 *   3. Person's preferred-name token set (lowercased, middle-initial and
 *      postnominal stripped) equals the query token set.
 */
export function tryFullNameCarveOut(
  prefix: string,
  people: PersonRanking[],
): PersonRanking | null {
  const q = prefix.trim();
  if (q.length < 5) return null;
  if (!/\s/.test(q)) return null;
  if (people.length !== 1) return null;
  const candidate = people[0]!;

  const qTokens = normalizeNameTokens(q);
  const nTokens = normalizeNameTokens(candidate.text);
  if (qTokens.length === 0 || nTokens.length === 0) return null;
  if (qTokens.length !== nTokens.length) return null;
  const qSet = new Set(qTokens);
  for (const t of nTokens) if (!qSet.has(t)) return null;
  return candidate;
}

const POSTNOMINAL_RE =
  /^(jr\.?|sr\.?|i{1,3}|iv|vi{0,3}|esq\.?|md|do|phd|dvm|mph|mba|jd|rn|np|pa|mhs|mhsc|msc|ms|ma|bs|ba|facp|faap|facog|faha|facc)[,.]?$/i;
const MIDDLE_INITIAL_RE = /^[a-z]\.?$/i;

function normalizeNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[,()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !MIDDLE_INITIAL_RE.test(t))
    .filter((t) => !POSTNOMINAL_RE.test(t));
}

/**
 * §6 — deterministic person ordering. v1 drops key 1 (`pubCountBucket`,
 * deferred with §10). Remaining stable-sort keys:
 *   2. role rank (full_time_faculty < voluntary_faculty < postdoc < ...)
 *   3. sortable surname via Intl.Collator base sensitivity
 *   4. cwid ascending (final deterministic key)
 */
export function tiebreakPeople(rows: PersonRanking[]): PersonRanking[] {
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  return rows
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => {
      const ra = personRoleRank(a.r.personType);
      const rb = personRoleRank(b.r.personType);
      if (ra !== rb) return ra - rb;
      const sa = a.r.lastNameSort ?? "";
      const sb = b.r.lastNameSort ?? "";
      const c = collator.compare(sa, sb);
      if (c !== 0) return c;
      if (a.r.cwid !== b.r.cwid) return a.r.cwid < b.r.cwid ? -1 : 1;
      return a.idx - b.idx;
    })
    .map(({ r }) => r);
}

function personRoleRank(role: string | null): number {
  if (!role) return PERSON_ROLE_RANK_OTHER;
  const r = PERSON_ROLE_RANK[role];
  return r === undefined ? PERSON_ROLE_RANK_OTHER : r;
}

/**
 * §5 — cap-fill algorithm. 12-row budget; position-anchored caps
 * `[5, 3, 2, 1, 1, 1]`. Empty kinds skip without consuming a slot, so a
 * dead lead slides the next kind into slot 0.
 */
const POSITION_CAPS = [5, 3, 2, 1, 1, 1];
const TOTAL_BUDGET = 12;

export function capFill<T>(
  order: EntityKind[],
  rowsByKind: Partial<Record<EntityKind, T[]>>,
): Array<{ kind: EntityKind; rows: T[] }> {
  const output: Array<{ kind: EntityKind; rows: T[] }> = [];
  let remaining = TOTAL_BUDGET;
  for (const kind of order) {
    if (remaining === 0) break;
    const rows = rowsByKind[kind] ?? [];
    if (rows.length === 0) continue;
    const slot = output.length;
    const cap = POSITION_CAPS[slot] ?? 1;
    const take = Math.min(cap, rows.length, remaining);
    output.push({ kind, rows: rows.slice(0, take) });
    remaining -= take;
  }
  return output;
}

/**
 * Stable sort that promotes rows where `getName(row)` startsWith the prefix
 * to the front; ties broken by original order (alpha-by-label from Prisma).
 * Tokenwise-aware for entity names — same predicate as `plausibilityHits`'s
 * dept/div/center branch.
 *
 * Solves the case where Prisma `contains` + alpha sort returns "Breast Cancer"
 * before "Cancer Biology" for query `cancer`: even though both are valid
 * matches, the row that *starts* with the prefix is the better lead.
 */
export function promoteStartsWith<T>(
  rows: T[],
  prefix: string,
  getName: (row: T) => string,
  mode: "label" | "tokenwise" = "label",
): T[] {
  const p = prefix.trim().toLowerCase();
  if (!p) return rows.slice();
  const hits: T[] = [];
  const rest: T[] = [];
  for (const r of rows) {
    const name = (getName(r) ?? "").toLowerCase();
    const matches =
      mode === "label"
        ? name.startsWith(p)
        : tokenizeEntityName(name).some((tok) => tok.startsWith(p));
    if (matches) hits.push(r);
    else rest.push(r);
  }
  return [...hits, ...rest];
}

/** Test-only export — kept stable so equivalence tests don't drift. */
export const _internal = {
  DEFAULT_KIND_ORDER,
  POSITION_CAPS,
  TOTAL_BUDGET,
  normalizeNameTokens,
  tokenizeEntityName,
};
