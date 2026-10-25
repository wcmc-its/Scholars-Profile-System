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
export type DecidedSort = "least" | "recent" | "scholar";

export const DECIDED_TABS: ReadonlyArray<DecidedTab> = ["confirmed", "rejected", "unproven"];
export const DECIDED_PAGE_SIZE = 50;
/** Scholars per page when grouped. */
export const DECIDED_GROUP_PAGE_SIZE = 25;
/** The scorer's thresholds (etl/reporter-grants/score.ts), for the margin line. */
export const SHOW_AT = 2;
export const HIDE_AT = -2;
export const PRIOR = -2;

export type DecidedParams = {
  tab: DecidedTab;
  by: DecidedBy;
  /** Confirmed only: just the awards the check showed again since the last run. */
  changed: boolean;
  group: boolean;
  sort: DecidedSort;
  q: string;
  page: number;
};

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The queue page's tab, from `?tab=`. Anything unknown is To review. */
export function parseQueueTab(sp: Raw): "pending" | DecidedTab {
  const t = one(sp.tab);
  return (DECIDED_TABS as readonly string[]).includes(t) ? (t as DecidedTab) : "pending";
}

export function parseDecidedParams(sp: Raw, tab: DecidedTab): DecidedParams {
  const by = one(sp.by);
  const sort = one(sp.sort);
  const page = Number.parseInt(one(sp.page), 10);
  return {
    tab,
    by: by === "curator" || by === "auto" ? by : "all",
    changed: tab === "confirmed" && one(sp.changed) === "1",
    group: one(sp.group) === "1",
    sort: sort === "recent" || sort === "scholar" ? sort : tab === "unproven" ? "recent" : "least",
    q: one(sp.q).trim().slice(0, 200),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** The query string for a decided tab's state; defaults are left out. */
export function decidedHref(p: DecidedParams, over: Partial<DecidedParams> = {}): string {
  const n = { ...p, ...over };
  const qs = new URLSearchParams({ tab: n.tab });
  if (n.by !== "all") qs.set("by", n.by);
  if (n.changed) qs.set("changed", "1");
  if (n.group) qs.set("group", "1");
  if (n.sort !== (n.tab === "unproven" ? "recent" : "least")) qs.set("sort", n.sort);
  if (n.q) qs.set("q", n.q);
  if (n.page > 1) qs.set("page", String(n.page));
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

/** How far a score sits inside its band: small is close to the line. */
export function certainty(tab: DecidedTab, score: number): number {
  if (tab === "confirmed") return score - SHOW_AT;
  return HIDE_AT - score;
}

/** The line under a score: "2 over", "at the line", "6 under". */
export function marginText(tab: DecidedTab, score: number, by: "curator" | "auto"): string {
  if (by === "curator") return "curator decided";
  if (tab === "unproven") return "nothing found";
  const m = certainty(tab, score);
  if (m === 0) return tab === "confirmed" ? "confirms at +2" : "hides at −2";
  return tab === "confirmed" ? `${m} over the line` : `${m} under the line`;
}

/** "+4", "−8", "0". */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

/** A name in parts, for the name comparison table. RePORTER prints
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
  if (order === "last-first") {
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

/** Compare two name parts: same, one an initial of the other, or different. */
export function partsDiffer(a: string, b: string): boolean {
  const x = a.replace(/[^A-Za-z]/g, "").toLowerCase();
  const y = b.replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return false;
  if (x.length === 1 || y.length === 1) return x[0] !== y[0];
  return true;
}

/** The checks that ran and found nothing, for the evidence panel. Only checks
 *  every award goes through are listed; ones the cues can't speak to (an
 *  unavailable source) are left out rather than claimed. */
export function checkedNothingFound(cueIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!cueIds.has("pub_linked")) out.push("No confirmed paper of the scholar cites this award");
  if (!cueIds.has("rejected_pmids")) out.push("No paper the scholar rejected cites it");
  if (!cueIds.has("profile_proven"))
    out.push("The NIH profile isn't linked by the scholar's accepted papers");
  if (!cueIds.has("wcm_org") && !cueIds.has("wcm_org_shared_name")) out.push("Not held at WCM");
  if (!cueIds.has("prior_institution")) out.push("Not held where the scholar trained");
  if (!cueIds.has("copi_coauthor")) out.push("No co-PI co-authors with the scholar");
  if (!cueIds.has("infoed_other_wcm_pi") && !cueIds.has("infoed_other_wcm_pi_named"))
    out.push("InfoEd names no other WCM investigator");
  if (!cueIds.has("timeline_impossible") && !cueIds.has("timeline_unlikely"))
    out.push("The award fits the scholar's career stage");
  if (!cueIds.has("middle_initial_conflict")) out.push("No middle-initial conflict");
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
    name: string;
    degrees: string | null;
    department: string | null;
    career: string | null;
    names: string[];
  };
};

export type DecidedGroup = {
  cwid: string;
  rows: DecidedRow[];
  /** Rows matching the filters; `here` counts the whole tab. */
  shown: number;
  /** This scholar's awards on this tab, and on the other tabs. */
  here: number;
  total: number;
  elsewhere: Partial<Record<DecidedTab | "pending", number>>;
};

export type DecidedPage = {
  params: DecidedParams;
  counts: Record<DecidedTab, { all: number; curator: number; auto: number }>;
  /** Confirmed rows the check showed again since the previous run. */
  changed: number;
  /** Rows (or groups) matching the filters, before paging. */
  matched: number;
  rows: DecidedRow[];
  groups: DecidedGroup[] | null;
};
