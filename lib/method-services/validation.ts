/**
 * Method services: the types and the pure validation shared by
 * `/api/edit/method-service` and the Method services editor section
 * (`components/edit/method-services-section.tsx`).
 *
 * No imports from `@/lib/db` or anything that constructs prisma: the client
 * bundle imports this module by VALUE (the same `lib/cores/cwid-block.ts`
 * split, for the same `lib/edit/manageable-units.ts` reason).
 */
import { validateUnitUrl } from "@/lib/edit/validators";
import { authorNameKey } from "@/lib/method-services/author-names";

/** The unit kinds that may own a method service. */
export const METHOD_SERVICE_ENTITY_TYPES = ["department", "core"] as const;
export type MethodServiceEntityType = (typeof METHOD_SERVICE_ENTITY_TYPES)[number];

export function isMethodServiceEntityType(value: unknown): value is MethodServiceEntityType {
  return (
    typeof value === "string" && (METHOD_SERVICE_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/** A method family, by the stable key a method page resolves on. */
export type MethodServiceFamily = { supercategory: string; familyLabel: string };

/** One service as the editor shows it. */
export type MethodServiceView = {
  id: number;
  entityType: MethodServiceEntityType;
  entityId: string;
  name: string;
  url: string;
  families: MethodServiceFamily[];
  supportedPmids: string[];
  excludedPmids: string[];
  countStaffPapers: boolean;
  /** Text that identifies the unit's authors in a PubMed affiliation. */
  affiliationPhrases: string[];
  /** The unit's authors as PubMed lists them: family name then first initial. */
  authorNames: string[];
  /** The supported PMIDs with an author whose PubMed affiliation contains one
   *  of the phrases, or who is one of the named authors. Worked out by the
   *  server on save, never sent by a client. */
  coauthoredPmids: string[];
  /** The ones among `coauthoredPmids` found by an author name and not by an
   *  affiliation. Worked out by the server on save, never sent by a client. */
  nameMatchedPmids: string[];
};

/**
 * A service as a unit's own editor gets it: everything but the affiliation
 * phrases and author names, which only a superuser sees or sets.
 */
export type MethodServicePublicationsView = Omit<
  MethodServiceView,
  "affiliationPhrases" | "authorNames"
>;

/** Drop what a unit's editor is not sent. */
export function toPublicationsView(view: MethodServiceView): MethodServicePublicationsView {
  // Named one by one: a field added to the full view later is not sent to a
  // unit's editor until someone decides it should be.
  return {
    id: view.id,
    entityType: view.entityType,
    entityId: view.entityId,
    name: view.name,
    url: view.url,
    families: view.families,
    supportedPmids: view.supportedPmids,
    excludedPmids: view.excludedPmids,
    countStaffPapers: view.countStaffPapers,
    coauthoredPmids: view.coauthoredPmids,
    nameMatchedPmids: view.nameMatchedPmids,
  };
}

/**
 * What an edit page hands the Method services section: the whole editor for a
 * superuser (`manage`), or the unit's own part of it (`publications`).
 */
export type MethodServicesForViewer =
  | { mode: "manage"; services: ReadonlyArray<MethodServiceView> }
  | { mode: "publications"; services: ReadonlyArray<MethodServicePublicationsView> };

/** One row of the family picker (`GET /api/edit/method-families`). */
export type MethodFamilyOption = MethodServiceFamily & {
  supercategoryLabel: string;
  scholarCount: number;
};

/** Matches the `@db.VarChar(255)` column. */
export const SERVICE_NAME_MAX_LENGTH = 255;
export const SERVICE_FAMILIES_MAX = 25;
export const SERVICE_PMIDS_MAX = 5000;
export const SERVICE_PHRASES_MAX = 10;
export const SERVICE_PHRASE_MIN_LENGTH = 3;
export const SERVICE_PHRASE_MAX_LENGTH = 120;
export const SERVICE_AUTHOR_NAMES_MAX = 50;
export const SERVICE_AUTHOR_NAME_MIN_LENGTH = 2;
export const SERVICE_AUTHOR_NAME_MAX_LENGTH = 80;
/** `scholar_family.supercategory` / `.family_label` column widths. */
const SUPERCATEGORY_MAX_LENGTH = 128;
const FAMILY_LABEL_MAX_LENGTH = 255;

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/** A core counts its own staff's publications by default; a department, where
 *  only some of the unit works on the service, does not. */
export function defaultCountStaffPapers(entityType: MethodServiceEntityType): boolean {
  return entityType === "core";
}

/** Service name: trimmed, 1 to 255 characters. */
export function validateServiceName(
  input: unknown,
): Result<string, "invalid_value" | "name_required" | "name_too_long"> {
  if (typeof input !== "string") return { ok: false, error: "invalid_value" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "name_required" };
  if (trimmed.length > SERVICE_NAME_MAX_LENGTH) return { ok: false, error: "name_too_long" };
  return { ok: true, value: trimmed };
}

/** Service page: `validateUnitUrl` (https only, 512), except that a service
 *  must have one, so the empty value that clears a unit's website is refused. */
export function validateServiceUrl(
  input: unknown,
): Result<string, "invalid_value" | "url_required" | "url_too_long" | "invalid_url"> {
  if (typeof input !== "string") return { ok: false, error: "invalid_value" };
  const r = validateUnitUrl(input);
  if (!r.ok) {
    return { ok: false, error: r.error === "url_too_long" ? "url_too_long" : "invalid_url" };
  }
  if (r.value === "") return { ok: false, error: "url_required" };
  return { ok: true, value: r.value };
}

export const methodFamilyKey = (f: MethodServiceFamily): string =>
  `${f.supercategory}::${f.familyLabel}`;

/**
 * The families a service supports: each needs a non-empty `supercategory` and
 * `familyLabel` (trimmed), duplicates collapse to the first, and there are 1 to
 * 25 of them. Shape only; whether a family is real and publicly visible is the
 * route's check against `scholar_family` and the overlay gate.
 */
export function validateServiceFamilies(
  input: unknown,
): Result<MethodServiceFamily[], "invalid_value" | "families_required" | "too_many_families"> {
  if (!Array.isArray(input)) return { ok: false, error: "invalid_value" };
  const out: MethodServiceFamily[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "invalid_value" };
    const { supercategory, familyLabel } = item as Record<string, unknown>;
    if (typeof supercategory !== "string" || typeof familyLabel !== "string") {
      return { ok: false, error: "invalid_value" };
    }
    const family = { supercategory: supercategory.trim(), familyLabel: familyLabel.trim() };
    if (
      family.supercategory.length === 0 ||
      family.familyLabel.length === 0 ||
      family.supercategory.length > SUPERCATEGORY_MAX_LENGTH ||
      family.familyLabel.length > FAMILY_LABEL_MAX_LENGTH
    ) {
      return { ok: false, error: "invalid_value" };
    }
    const key = methodFamilyKey(family);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(family);
  }
  if (out.length === 0) return { ok: false, error: "families_required" };
  if (out.length > SERVICE_FAMILIES_MAX) return { ok: false, error: "too_many_families" };
  return { ok: true, value: out };
}

/** `PMID: 12345`, `PMID 12345`, `pmid12345`: the label goes, the digits stay. */
const PMID_LABEL = /\bPMID\s*:?\s*(?=\d)/gi;
/** A PubMed article link, with or without the scheme, a trailing slash or a
 *  query string. */
const PUBMED_URL = /^(?:https?:\/\/)?(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:[?#].*)?$/i;
const PMID_DIGITS = /^\d{1,9}$/;

/**
 * Split a pasted block on any run of whitespace, commas or semicolons and
 * classify each token as a PMID or `invalid`, in `parseCwidBlock`'s house
 * style (nothing is silently dropped). A PMID is 1 to 9 digits; a
 * `PMID: 12345` label and a `pubmed.ncbi.nlm.nih.gov/12345` link are read as
 * the number they carry. Leading zeros are removed, so `0012345` and `12345`
 * are one PMID; a token of only zeros is invalid. De-duplicated, first-seen
 * order. Pure. The 5000 cap is NOT applied here: see {@link validatePmidList}.
 */
export function parsePmidBlock(text: string): { pmids: string[]; invalid: string[] } {
  const tokens = text
    .replace(PMID_LABEL, "")
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const pmids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const digits = PUBMED_URL.exec(t)?.[1] ?? t;
    const pmid = PMID_DIGITS.test(digits) ? digits.replace(/^0+/, "") : "";
    if (pmid === "") {
      invalid.push(t);
    } else if (!seen.has(pmid)) {
      seen.add(pmid);
      pmids.push(pmid);
    }
  }
  return { pmids, invalid };
}

/**
 * A PMID list as the API receives it: an array of strings, re-parsed with
 * {@link parsePmidBlock} (never trusting the client). Any token that is not a
 * PMID, or more than 5000 PMIDs, is an error: a list is never silently
 * shortened.
 */
export function validatePmidList(
  input: unknown,
): Result<string[], "invalid_value" | "invalid_pmids" | "too_many_pmids"> {
  if (!Array.isArray(input) || !input.every((v) => typeof v === "string")) {
    return { ok: false, error: "invalid_value" };
  }
  const { pmids, invalid } = parsePmidBlock((input as string[]).join("\n"));
  if (invalid.length > 0) return { ok: false, error: "invalid_pmids" };
  if (pmids.length > SERVICE_PMIDS_MAX) return { ok: false, error: "too_many_pmids" };
  return { ok: true, value: pmids };
}

/** The editor's textareas: one affiliation phrase, or one author name, per
 *  line, blank lines dropped. */
export function parsePhraseBlock(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/**
 * Affiliation phrases as the API receives them: an array of 0 to 10 strings,
 * each 3 to 120 characters once trimmed and with runs of whitespace collapsed.
 * Duplicates (ignoring case) collapse to the first. An empty string is an
 * error, never silently dropped.
 */
export function validateAffiliationPhrases(
  input: unknown,
): Result<string[], "invalid_value" | "phrase_too_short" | "phrase_too_long" | "too_many_phrases"> {
  if (!Array.isArray(input) || !input.every((v) => typeof v === "string")) {
    return { ok: false, error: "invalid_value" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input as string[]) {
    const phrase = raw.replace(/\s+/g, " ").trim();
    if (phrase.length < SERVICE_PHRASE_MIN_LENGTH) return { ok: false, error: "phrase_too_short" };
    if (phrase.length > SERVICE_PHRASE_MAX_LENGTH) return { ok: false, error: "phrase_too_long" };
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  if (out.length > SERVICE_PHRASES_MAX) return { ok: false, error: "too_many_phrases" };
  return { ok: true, value: out };
}

/**
 * Author names as the API receives them: an array of 0 to 50 strings, each 2
 * to 80 characters once trimmed and with runs of whitespace collapsed, and
 * each a family name followed by a first initial ("Rivera Stone B"). An entry
 * with no initial is an error (`authorNameKey`), never silently dropped.
 * Entries that name the same author (the same family-name letters and first
 * initial) collapse to the first.
 */
export function validateAuthorNames(
  input: unknown,
): Result<
  string[],
  | "invalid_value"
  | "author_name_too_short"
  | "author_name_too_long"
  | "author_name_no_initial"
  | "too_many_author_names"
> {
  if (!Array.isArray(input) || !input.every((v) => typeof v === "string")) {
    return { ok: false, error: "invalid_value" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input as string[]) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (name.length < SERVICE_AUTHOR_NAME_MIN_LENGTH) {
      return { ok: false, error: "author_name_too_short" };
    }
    if (name.length > SERVICE_AUTHOR_NAME_MAX_LENGTH) {
      return { ok: false, error: "author_name_too_long" };
    }
    const key = authorNameKey(name);
    if (key === null) return { ok: false, error: "author_name_no_initial" };
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > SERVICE_AUTHOR_NAMES_MAX) return { ok: false, error: "too_many_author_names" };
  return { ok: true, value: out };
}
