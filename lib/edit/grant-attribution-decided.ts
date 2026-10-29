/**
 * #3071 — the decided tabs of the grant attribution queue: Confirmed, Not this
 * person and Unproven. Pure and client-safe; the loader is the `.server`
 * sibling.
 *
 * Where an award lands. A curator's decision wins: confirmed goes to
 * Confirmed, rejected to Not this person. Otherwise the weekly check's band
 * decides: show is Auto-confirmed; hide is Auto-rejected when some evidence
 * points away, and Unproven when nothing was found either way. A pending
 * review is in To review, never here.
 */
import {
  isVetoCue,
  type GrantAttributionAward,
  type GrantAttributionCue,
} from "./grant-attribution-queue";

export type DecidedTab = "confirmed" | "rejected" | "unproven";
export type DecidedBy = "all" | "curator" | "auto";
/** Score high to low, low to high, or Scholar A–Z. */
export type DecidedSort = "high" | "low" | "name";
/** The evidence scale's keys (`EVIDENCE_LEVELS` in grant-attribution-board.ts). */
export type DecidedLevel =
  "all" | "supports" | "leans-for" | "mixed" | "none" | "leans-against" | "against";

export const DECIDED_TABS: ReadonlyArray<DecidedTab> = ["confirmed", "rejected", "unproven"];
export const DECIDED_PAGE_SIZE = 200;
const DECIDED_LEVELS: ReadonlyArray<DecidedLevel> = [
  "all",
  "supports",
  "leans-for",
  "mixed",
  "none",
  "leans-against",
  "against",
];
/** The scorer's thresholds (etl/reporter-grants/score.ts), for the margin line. */
export const SHOW_AT = 2;
export const HIDE_AT = -2;
export const PRIOR = -2;

export type DecidedParams = {
  tab: DecidedTab;
  by: DecidedBy;
  /** Just the awards the latest weekly check moved here on its own: shown
   *  again (Confirmed) or newly hidden (Not this person). */
  changed: boolean;
  level: DecidedLevel;
  sort: DecidedSort;
  q: string;
  page: number;
  /** "Show all": every matching row on one page, no pager. */
  all: boolean;
};

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The queue page's tab, from `?tab=`. Anything unknown is To review. */
export function parseQueueTab(sp: Raw): "pending" | DecidedTab {
  const t = one(sp.tab);
  return (DECIDED_TABS as readonly string[]).includes(t) ? (t as DecidedTab) : "pending";
}

/** Confirmed reads least certain first (score low to high); the others high
 *  to low. */
export function defaultDecidedSort(tab: DecidedTab): DecidedSort {
  return tab === "confirmed" ? "low" : "high";
}

export function parseDecidedParams(sp: Raw, tab: DecidedTab): DecidedParams {
  const by = one(sp.by);
  const sort = one(sp.sort);
  const level = one(sp.level) as DecidedLevel;
  const page = Number.parseInt(one(sp.page), 10);
  return {
    tab,
    by: by === "curator" || by === "auto" ? by : "all",
    changed: tab !== "unproven" && one(sp.changed) === "1",
    level: DECIDED_LEVELS.includes(level) ? level : "all",
    sort: sort === "high" || sort === "low" || sort === "name" ? sort : defaultDecidedSort(tab),
    q: one(sp.q).trim().slice(0, 200),
    page: Number.isFinite(page) && page > 1 ? page : 1,
    all: one(sp.all) === "1",
  };
}

/** The query string for a decided tab's state; defaults are left out. */
export function decidedHref(p: DecidedParams, over: Partial<DecidedParams> = {}): string {
  const n = { ...p, ...over };
  const qs = new URLSearchParams({ tab: n.tab });
  if (n.by !== "all") qs.set("by", n.by);
  if (n.changed) qs.set("changed", "1");
  if (n.level !== "all") qs.set("level", n.level);
  if (n.sort !== defaultDecidedSort(n.tab)) qs.set("sort", n.sort);
  if (n.q) qs.set("q", n.q);
  if (n.all) qs.set("all", "1");
  else if (n.page > 1) qs.set("page", String(n.page));
  return `?${qs.toString()}`;
}

/** Some cue points away from the scholar. Name rarity alone never counts. */
export function pointsAway(
  cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight">>,
): boolean {
  return cues.some((c) => (c.weight < 0 && c.id !== "name_common") || isVetoCue(c));
}

/** Which decided tab an award is in, or null (To review, or nowhere). */
export function decidedTabOf(input: {
  reviewStatus: string | null;
  band: string | null;
  cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight">>;
}): { tab: DecidedTab; by: "curator" | "auto" } | null {
  if (input.reviewStatus === "confirmed") return { tab: "confirmed", by: "curator" };
  if (input.reviewStatus === "rejected") return { tab: "rejected", by: "curator" };
  if (input.reviewStatus === "pending") return null;
  if (input.band === "show") return { tab: "confirmed", by: "auto" };
  if (input.band === "hide")
    return { tab: pointsAway(input.cues) ? "rejected" : "unproven", by: "auto" };
  return null;
}

/** "+4", "−8", "0". */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

/** A name in parts, for sorting by surname. RePORTER prints
 *  "LAST, FIRST M"; Scholars names read "First M. Last" (postnominals after a
 *  comma are dropped). */
export function nameParts(
  raw: string,
  order: "last-first" | "first-last",
): {
  last: string;
  first: string;
  middle: string;
} {
  const tidy = (s: string) =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((w) =>
        w
          .split("-")
          .map((p) =>
            p.length <= 2 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase(),
          )
          .join("-"),
      );
  // RePORTER sometimes prints "First Last" with no comma.
  if (order === "last-first" && raw.includes(",")) {
    const [last = "", rest = ""] = raw.split(",").map((x) => x.trim());
    const r = tidy(rest.replace(/\./g, ""));
    return { last: tidy(last).join(" "), first: r[0] ?? "", middle: r.slice(1).join(" ") };
  }
  const base = raw.split(",")[0]!.replace(/\./g, "").trim();
  const w = base.split(/\s+/).filter(Boolean);
  if (w.length === 0) return { last: "", first: "", middle: "" };
  return { last: w[w.length - 1]!, first: w[0]!, middle: w.slice(1, -1).join(" ") };
}

/** "Lindqvist, Priya S", the queue's sortable display name. */
export function sortableName(fullName: string): string {
  const p = nameParts(fullName, "first-last");
  return [p.last, [p.first, p.middle].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** The checks that ran and found nothing, for the evidence panel. Only checks
 *  every award goes through are listed; ones the cues can't speak to (an
 *  unavailable source) are left out rather than claimed. `heldAtWcm`: WCM is in
 *  the award's org history, so a WCM cue that didn't fire was withheld, not
 *  missed. */
export function checkedNothingFound(cueIds: ReadonlySet<string>, heldAtWcm = false): string[] {
  const out: string[] = [];
  if (!cueIds.has("pub_linked")) out.push("No confirmed paper of the scholar cites this award");
  if (!cueIds.has("rejected_pmids")) out.push("No paper the scholar rejected cites it");
  if (!cueIds.has("profile_proven"))
    out.push("The NIH profile isn't linked by the scholar's accepted papers");
  if (!cueIds.has("wcm_org") && !cueIds.has("wcm_org_shared_name"))
    out.push(
      heldAtWcm
        ? "Held at WCM, not counted: the NIH profile came from a WCM grant, and the PI's name doesn't rule out another WCM person"
        : "Not held at WCM",
    );
  if (!cueIds.has("prior_institution")) out.push("Not held where the scholar trained");
  if (!cueIds.has("affiliate_org")) out.push("Not held at a WCM affiliate");
  if (!cueIds.has("copi_coauthor")) out.push("No co-PI co-authors with the scholar");
  if (!cueIds.has("infoed_other_wcm_pi") && !cueIds.has("infoed_other_wcm_pi_named"))
    out.push("InfoEd names no other WCM investigator");
  if (!cueIds.has("timeline_impossible") && !cueIds.has("timeline_unlikely"))
    out.push("The award fits the scholar's career stage");
  if (!cueIds.has("middle_initial_conflict")) out.push("No middle-initial conflict");
  if (!cueIds.has("pi_name_mismatch") && !cueIds.has("pi_given_name_mismatch"))
    out.push("The NIH profile's PI has the scholar's name");
  return out;
}

/** One award on a decided tab, as the page renders it. */
export type DecidedRow = {
  /** The grant's external id: what the decision and requeue routes take. */
  grantId: string;
  reviewId: string | null;
  tab: DecidedTab;
  by: "curator" | "auto";
  /** Auto-confirmed rows the check had hidden or queued before. */
  was: "hidden" | "queued" | null;
  /** The latest weekly check moved it here on its own: shown again, or newly
   *  hidden. */
  changed: boolean;
  /** Auto-confirmed, but the check could not lift its hide yet (revoking was
   *  off that run): still off the profile until the next run. */
  stillHidden: boolean;
  when: string | null;
  decidedByName: string | null;
  rejectionReason: string | null;
  score: number;
  cues: GrantAttributionCue[];
  award: GrantAttributionAward;
  reporterName: string | null;
  reason: string;
  scholar: {
    cwid: string;
    slug: string | null;
    /** "Lindqvist, Priya S", for sorting. */
    name: string;
    /** As the profile renders it, postnominals included. */
    displayName: string;
    degrees: string | null;
    title: string | null;
    department: string | null;
    career: string | null;
    names: string[];
  };
};

export type DecidedPage = {
  params: DecidedParams;
  counts: Record<DecidedTab, { all: number; curator: number; auto: number }>;
  /** Per tab, the rows the latest weekly check moved there on its own. */
  changed: Record<DecidedTab, number>;
  /** Rows matching the filters, before paging. */
  matched: number;
  rows: DecidedRow[];
  /** Every Unproven award's grant externalId: the To review tab lists them
   *  beside the pending reviews. */
  unprovenIds: string[];
};
