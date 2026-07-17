/**
 * Validation for an `honor` row (#1760) — the pure, side-effect-free shape check
 * shared by the create + update legs of `POST /api/edit/honor`. Kept out of the
 * route so it is unit-testable without a request / DB harness.
 *
 * Only `category` is controlled (the schema's `HonorCategory` enum) — it drives
 * which profile heading the row renders under. `name` ("Member", "Fellow",
 * "Lasker Award") and `organization` (the conferring body) are REQUIRED free
 * text (trimmed, ≤255). `year` is OPTIONAL (an honor whose year nobody can
 * source still belongs on the profile); when present it is an integer in
 * [1800, next calendar year]. `sourceRef` is OPTIONAL free text (trimmed, ≤512;
 * blank → null) — the roster URL a curator cites, and the key a Phase 3 feed
 * de-dups on. `showOnProfile` is optional and falls back to the column default
 * (true).
 *
 * `organization` is deliberately FREE TEXT with no vocabulary check.
 * `CONFERRING_BODIES` is a spelling-consistency CONVENIENCE the /edit card
 * offers as dropdown options — never a validation gate. An honor conferred by a
 * body the seed list omits must still be enterable, so validation caps length
 * and nothing else.
 *
 * `status` is NOT accepted from a request body. Phase 1 ships no approval
 * affordance: the route pins `published` at create and never mutates it. The
 * enum carries `pending`/`rejected` only so the Phase 3 feed needs no migration.
 */
import type { HonorCategory } from "@/lib/generated/prisma/enums";

/**
 * The categories in SCHEMA ENUM ORDER — this drives the /edit dropdown's option
 * order. The PROFILE does not render the category at all (2026-07-16: the row
 * already names its conferring body, so a category heading only restated it), so
 * this order is now an /edit and Phase 3 concern, not a reader-facing one.
 * `satisfies` pins every member to a real `HonorCategory`; the
 * `HONOR_CATEGORY_LABELS` record below (keyed `Record<HonorCategory, string>`)
 * is what forces the reverse direction — a category added to the schema without
 * being listed here is a compile error there.
 */
export const HONOR_CATEGORIES = [
  "ACADEMY_MEMBERSHIP",
  "INVESTIGATORSHIP",
  "PRIZE",
  "OTHER",
] as const satisfies readonly HonorCategory[];

export function isHonorCategory(value: unknown): value is HonorCategory {
  return typeof value === "string" && (HONOR_CATEGORIES as readonly string[]).includes(value);
}

/** Human labels for the /edit category dropdown. The profile does not render the
 *  category — see `HONOR_CATEGORIES` above. */
export const HONOR_CATEGORY_LABELS: Record<HonorCategory, string> = {
  ACADEMY_MEMBERSHIP: "Academy membership",
  INVESTIGATORSHIP: "Investigatorship",
  PRIZE: "Prize",
  OTHER: "Other",
};

/**
 * Seed dropdown options for the `organization` field — the conferring bodies
 * behind the honors in the spec appendix (docs/2026-07-15-honors-distinctions-spec.md).
 * Alphabetical: the card renders them as datalist/select options over a free-text
 * input, so this is a typing aid that keeps "Howard Hughes Medical Institute"
 * from being stored five ways — NOT an allowlist. The spec is explicit that the
 * appendix is "a proposed seed, not the source of truth"; WCM Faculty Affairs'
 * list is authoritative and this should be reconciled against it.
 */
export const CONFERRING_BODIES: readonly string[] = [
  "Albert and Mary Lasker Foundation",
  "Alfred P. Sloan Foundation",
  "American Academy of Arts & Sciences",
  "American Association for the Advancement of Science",
  "American Philosophical Society",
  "American Society for Clinical Investigation",
  "Association of American Physicians",
  "Breakthrough Prize Foundation",
  "Burroughs Wellcome Fund",
  "Chan Zuckerberg Initiative",
  "Columbia University",
  "Damon Runyon Cancer Research Foundation",
  "David and Lucile Packard Foundation",
  "Gairdner Foundation",
  "Gruber Foundation",
  "Howard Hughes Medical Institute",
  "John D. and Catherine T. MacArthur Foundation",
  "Kavli Foundation",
  "National Academy of Engineering",
  "National Academy of Inventors",
  "National Academy of Medicine",
  "National Academy of Sciences",
  "National Science Foundation",
  "Nobel Foundation",
  "Office of Science and Technology Policy",
  "Paul G. Allen Frontiers Group",
  "Pew Charitable Trusts",
  "Royal Society",
  "Sabin Vaccine Institute",
  "Searle Scholars Program",
  "Shaw Prize Foundation",
  "Vilcek Foundation",
  "Warren Alpert Foundation",
  "Weill Cornell Medicine",
  "Wolf Foundation",
];

/** VarChar(255) cap on `name` / `organization`. */
export const HONOR_TEXT_MAX = 255;
/** VarChar(512) cap on `sourceRef` (a URL). */
export const HONOR_SOURCE_REF_MAX = 512;
/**
 * Floor on `year`. The oldest honors a WCM profile could plausibly carry are
 * 19th-century society memberships; 1800 rejects a transposed digit (`190`,
 * `20222`) without second-guessing a real historical election.
 */
export const HONOR_YEAR_MIN = 1800;

/**
 * Ceiling on `year`, computed per call rather than frozen at module load: a
 * constant would silently start rejecting the current year on Jan 1. Next year
 * is allowed because prizes are routinely announced ahead of the conferral year.
 */
export function honorYearMax(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** The normalized, storable shape a valid create/update body resolves to. */
export interface HonorInput {
  category: HonorCategory;
  name: string;
  organization: string;
  year: number | null;
  sourceRef: string | null;
  showOnProfile: boolean;
}

export type HonorInputResult =
  | { ok: true; value: HonorInput }
  | { ok: false; error: string; field: string };

/** A required free-text field: a string that is non-empty after trim and ≤max. */
function validateRequiredText(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value: string } | { ok: false; error: string; field: string } {
  if (typeof value !== "string") return { ok: false, error: "invalid_value", field };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: "required", field };
  if (trimmed.length > max) return { ok: false, error: "too_long", field };
  return { ok: true, value: trimmed };
}

/** An optional free-text field: absent / null / blank → null; else trimmed ≤max. */
function validateOptionalText(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; error: string; field: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "invalid_value", field };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: "too_long", field };
  return { ok: true, value: trimmed };
}

/**
 * Validate + normalize a create/update payload for an `honor`. On success the
 * value is directly storable (free text trimmed, optionals nulled). The first
 * failing field short-circuits.
 */
export function validateHonorInput(body: Record<string, unknown>): HonorInputResult {
  if (!isHonorCategory(body.category)) {
    return { ok: false, error: "invalid_category", field: "category" };
  }
  const category = body.category;

  const name = validateRequiredText(body.name, "name", HONOR_TEXT_MAX);
  if (!name.ok) return name;
  const organization = validateRequiredText(body.organization, "organization", HONOR_TEXT_MAX);
  if (!organization.ok) return organization;

  // year — absent / null → null (the honor is real, the year just isn't sourced).
  let year: number | null = null;
  if (body.year !== undefined && body.year !== null) {
    if (
      typeof body.year !== "number" ||
      !Number.isInteger(body.year) ||
      body.year < HONOR_YEAR_MIN ||
      body.year > honorYearMax()
    ) {
      return { ok: false, error: "invalid_year", field: "year" };
    }
    year = body.year;
  }

  const sourceRef = validateOptionalText(body.sourceRef, "sourceRef", HONOR_SOURCE_REF_MAX);
  if (!sourceRef.ok) return sourceRef;

  let showOnProfile = true;
  if (body.showOnProfile !== undefined) {
    if (typeof body.showOnProfile !== "boolean") {
      return { ok: false, error: "invalid_value", field: "showOnProfile" };
    }
    showOnProfile = body.showOnProfile;
  }

  return {
    ok: true,
    value: {
      category,
      name: name.value,
      organization: organization.value,
      year,
      sourceRef: sourceRef.value,
      showOnProfile,
    },
  };
}
