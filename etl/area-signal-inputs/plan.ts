/**
 * Pure half of `etl:area-signal-inputs`: text keys, the AREAINPUT items sent to
 * ReciterAI, and the plan for the `area_text_key` columns. No Prisma, no AWS,
 * so tests/unit/area-signal-inputs.test.ts drives it directly.
 *
 * Keyed by TEXT, not by person or award. Every grant row sharing a title and
 * abstract (multi-PI, the subawards of one project, yearly renewals that kept
 * their text) maps to one key and is scored once; every trial sharing a CT.gov
 * record maps to one key. ReciterAI never sees a CWID or an InfoEd id, and an
 * InfoEd externalId re-key (#2224) changes nothing upstream.
 */
import { createHash } from "node:crypto";

import { AREA_GRANT_FULL_TEXT_MIN_CHARS } from "@/lib/area-signals";
import { grantAbstractMatchesTitle } from "@/lib/grant-abstract-match";
import { replaceFloor } from "../dynamodb/projection-replace";

/** The constant partition every input item shares (IAM pins `dynamodb:LeadingKeys` to it). */
export const AREA_INPUT_PK = "AREAINPUT";

export type AreaSignalKind = "grant" | "trial";

/**
 * Whitespace-collapsed, case-folded, NFKC text. Case and spacing never change
 * what a text is about, and InfoEd and CT.gov disagree on both for the same
 * study, so they must not mint a second key (and a second scoring call).
 */
export function normalizeAreaText(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 32 hex chars of SHA-256 over the kind and the normalized parts. */
export function areaTextKey(kind: AreaSignalKind, parts: ReadonlyArray<string | null | undefined>): string {
  const h = createHash("sha256");
  h.update(kind);
  for (const p of parts) h.update("\u0000" + normalizeAreaText(p));
  return h.digest("hex").slice(0, 32);
}

/** `'; '`-joined upstream lists (conditions, interventions) as an array. */
export function splitList(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * The AREAINPUT item contract, shared with ReciterAI's `pipeline_area_signals`
 * drain. Snake case because the drain is Python and the sibling SUBMISSION
 * items are snake case. `status` starts `pending`; the drain owns it after.
 */
export type AreaInputItem = {
  PK: typeof AREA_INPUT_PK;
  SK: string; // `${kind}#${text_key}`
  kind: AreaSignalKind;
  text_key: string;
  /** `full`: synopsize `text`. `title`: no synopsis; the title stands in for one. */
  mode: "full" | "title";
  title: string;
  /** Grant abstract or trial brief summary; may be empty. */
  text: string;
  funder: string | null;
  mechanism: string | null;
  phase: string | null;
  study_type: string | null;
  conditions: string[];
  interventions: string[];
  start_year: number | null;
  status: "pending";
  created_at: string;
};

export type GrantInputRow = {
  id: string;
  title: string;
  abstract: string | null;
  startDate: Date;
  primeSponsor: string | null;
  directSponsor: string | null;
  nihIc: string | null;
  mechanism: string | null;
};

export type TrialInputRow = {
  protocolNumber: string;
  title: string;
  briefSummary: string | null;
  startDate: string | null;
  principalSponsor: string | null;
  phase: string | null;
  studyType: string | null;
  conditions: string | null;
  interventions: string | null;
};

/**
 * The abstract this grant is scored on: its own, unless it fails the title check
 * (#3071 — a wrong award number pulls in another project's RePORTER abstract).
 * A dropped abstract sends the grant as title-only, and the key follows the text
 * actually sent, so the wrong abstract's scores go inert the night it is dropped
 * and the title-only text is queued as a new key.
 */
export function grantScoredAbstract(g: Pick<GrantInputRow, "title" | "abstract">): string | null {
  return grantAbstractMatchesTitle(g.title, g.abstract) ? g.abstract : null;
}

export function grantTextKey(g: Pick<GrantInputRow, "title" | "abstract">): string {
  return areaTextKey("grant", [g.title, grantScoredAbstract(g)]);
}

export function trialTextKey(
  t: Pick<TrialInputRow, "title" | "briefSummary" | "conditions" | "interventions">,
): string {
  return areaTextKey("trial", [t.title, t.briefSummary, t.conditions, t.interventions]);
}

function grantItem(g: GrantInputRow, key: string, createdAt: string): AreaInputItem {
  const text = (grantScoredAbstract(g) ?? "").trim();
  return {
    PK: AREA_INPUT_PK,
    SK: `grant#${key}`,
    kind: "grant",
    text_key: key,
    mode: text.length >= AREA_GRANT_FULL_TEXT_MIN_CHARS ? "full" : "title",
    title: g.title.trim(),
    // Title mode still carries any short funder text: the pilot's title arm put
    // it in the scorer's abstract slot.
    text,
    // The pilot's "Funder and mechanism" line is `${funder} ${mechanism}`.
    funder: [g.primeSponsor ?? g.directSponsor, g.nihIc].filter(Boolean).join(" ") || null,
    mechanism: g.mechanism,
    phase: null,
    study_type: null,
    conditions: [],
    interventions: [],
    start_year: g.startDate.getUTCFullYear(),
    status: "pending",
    created_at: createdAt,
  };
}

function trialItem(t: TrialInputRow, key: string, createdAt: string): AreaInputItem {
  const text = (t.briefSummary ?? "").trim();
  const year = Number.parseInt((t.startDate ?? "").slice(0, 4), 10);
  return {
    PK: AREA_INPUT_PK,
    SK: `trial#${key}`,
    kind: "trial",
    text_key: key,
    mode: text.length > 0 ? "full" : "title",
    title: t.title.trim(),
    text,
    funder: t.principalSponsor,
    mechanism: null,
    phase: t.phase,
    study_type: t.studyType,
    conditions: splitList(t.conditions),
    interventions: splitList(t.interventions),
    start_year: Number.isFinite(year) ? year : null,
    status: "pending",
    created_at: createdAt,
  };
}

export type InputPlan = {
  /** Grant id -> key, for every eligible grant row. */
  grantKeys: Map<string, string>;
  /** Protocol number -> key, for every eligible trial. */
  trialKeys: Map<string, string>;
  /** One item per distinct key, by SK. */
  items: Map<string, AreaInputItem>;
  /** Grant rows whose abstract failed the title check and went title-only. */
  grantAbstractsDropped: number;
};

/**
 * Keys and items for the eligible rows (eligibility is the caller's: see
 * lib/area-signals.ts). When several rows share a key the item carries the
 * EARLIEST-starting row's metadata, so the item does not depend on read order.
 */
export function buildInputPlan(
  grants: readonly GrantInputRow[],
  trials: readonly TrialInputRow[],
  now: Date,
): InputPlan {
  const createdAt = now.toISOString();
  const grantKeys = new Map<string, string>();
  const trialKeys = new Map<string, string>();
  const items = new Map<string, AreaInputItem>();
  let grantAbstractsDropped = 0;
  const grantOrder = [...grants].sort(
    (a, b) => a.startDate.getTime() - b.startDate.getTime() || a.id.localeCompare(b.id),
  );
  for (const g of grantOrder) {
    if (g.abstract && grantScoredAbstract(g) === null) grantAbstractsDropped += 1;
    const key = grantTextKey(g);
    grantKeys.set(g.id, key);
    if (!items.has(`grant#${key}`)) items.set(`grant#${key}`, grantItem(g, key, createdAt));
  }
  const trialOrder = [...trials].sort(
    (a, b) =>
      (a.startDate ?? "").localeCompare(b.startDate ?? "") ||
      a.protocolNumber.localeCompare(b.protocolNumber),
  );
  for (const t of trialOrder) {
    const key = trialTextKey(t);
    trialKeys.set(t.protocolNumber, key);
    if (!items.has(`trial#${key}`)) items.set(`trial#${key}`, trialItem(t, key, createdAt));
  }
  return { grantKeys, trialKeys, items, grantAbstractsDropped };
}

export type KeyColumnPlan = {
  /** Rows whose key is new or changed: id -> key. */
  set: Map<string, string>;
  /** Rows that hold a key but are no longer eligible. */
  clear: string[];
  /** Why `clear` was withheld this run, when it was. */
  clearSkipped: string | null;
};

/**
 * Reconcile one table's `area_text_key` column: write the keys that changed,
 * null the keys of rows that left the eligible set. The clear is withheld when
 * the eligible set is implausibly small next to the keys already held (the
 * guardedReplace floor), so a truncated source read can never strip every
 * row's signal; setting keys is always safe.
 */
export function planKeyColumn(
  desired: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): KeyColumnPlan {
  const set = new Map<string, string>();
  for (const [id, key] of desired) if (current.get(id) !== key) set.set(id, key);
  const stale = [...current.keys()].filter((id) => !desired.has(id));
  const floor = replaceFloor(current.size);
  if (stale.length > 0 && desired.size < floor) {
    return {
      set,
      clear: [],
      clearSkipped: `eligible ${desired.size} is below the floor ${floor} (keyed ${current.size})`,
    };
  }
  return { set, clear: stale, clearSkipped: null };
}
