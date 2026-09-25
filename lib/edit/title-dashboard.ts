/**
 * The display-titles report (`/edit/reports/display-titles`) — who is listed
 * and why. Plan: `2026-09-25-display-title-dashboard-plan.md` (Projects).
 *
 * NOT all ~9.4k scholars: the ~100–150 whose title an operator may want to
 * look at. A scholar is listed when ANY reason holds:
 *
 *   leadership      best candidate ranks 1–8.5 (Dean … Vice Chair), or they
 *                   hold a department-chair, division-chief or center-director
 *                   role assignment;
 *   pinned          a `field_override(primaryTitle)` is set;
 *   contested       two or more candidates rank 1–8.5 (EA's coin flips);
 *   leadershipLost  a leadership or director candidate (rank ≤ 10) lost to a
 *                   lower-ranked KIND of title — the pre-#2804 BMRI pattern;
 *   mismatch        a role and the title text disagree: a department-chair
 *                   role with no chair text (chairs have no title tier of
 *                   their own, so the chair goes unshown), or chair/chief
 *                   text with no role. A chief role with no chief text is
 *                   NOT one — the chief tier titles them from the role. Dean-family text has no role source to confirm it
 *                   against, so it is never a mismatch — review those by rank.
 *
 * Computed per request from `loadTitleCandidates`, the SAME function the ED
 * ETL post-pass resolves from, so the report cannot disagree with the
 * nightly. No table, no migration. Server-only (reads the database).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadTitleCandidates, type TitleResolutionClient, type TitleCandidates } from "@/etl/ed/title-resolution";
import { isTitleResolutionEnabled, loadChairedDepartments } from "@/lib/edit/title-picker";
import {
  rankTitleText,
  resolveFromOptions,
  TITLE_RANK,
  TITLE_TIER_LABEL,
  TITLE_TIERS,
  type TitleOption,
  type TitleTier,
} from "@/lib/scholar-title";

export type TitleReason = "leadership" | "pinned" | "contested" | "leadershipLost" | "mismatch";

export const TITLE_REASONS: readonly TitleReason[] = [
  "leadership",
  "pinned",
  "contested",
  "leadershipLost",
  "mismatch",
] as const;

export const TITLE_REASON_LABEL: Record<TitleReason, string> = {
  leadership: "Leadership",
  pinned: "Pinned",
  contested: "Contested",
  leadershipLost: "Leadership lost",
  mismatch: "Mismatch",
};

/** Rank 1–8.5: Dean through Vice Chair. */
const isLeadershipRank = (rank: number) => rank <= TITLE_RANK.viceChair;

export type TitleRoles = { chair: boolean; chief: boolean; centerDirector: boolean };

export type TitleDashboardRow = {
  cwid: string;
  name: string;
  /** `Scholar.primaryTitle` — what the site shows today. */
  displayed: string | null;
  /** The ladder's pick ignoring any pin; null only when no tier has a value. */
  winner: TitleOption | null;
  /** The best remaining candidate with a DIFFERENT title string. */
  runnerUp: TitleOption | null;
  /** The pin, when one is set (`""` un-pins, so it is not one). */
  pin: string | null;
  /** True when the pin equals the ladder's own winner: a candidate to un-pin. */
  pinRedundant: boolean;
  reasons: TitleReason[];
  /** Why `mismatch` fired, operator-facing. Empty when it did not. */
  mismatchNotes: string[];
  /** Every tier row, for the inline picker. */
  options: TitleOption[];
};

/**
 * Classify one scholar. Pure: the loader below does the reads. Returns null
 * when no reason holds (the scholar is not listed).
 */
export function classifyTitleRow(
  c: Pick<TitleCandidates, "cwid" | "primaryTitle" | "override" | "options" | "texts">,
  roles: TitleRoles,
  name: string,
): TitleDashboardRow | null {
  const present = c.options.filter((o) => o.value !== null);
  const winner = present[0] ?? null;
  const runnerUp = present.find((o) => o.value !== winner?.value) ?? null;
  const pin = resolveFromOptions(c.options, c.override).overridden ? c.override!.trim() : null;

  // Role vs text, over EVERY raw title string: the options keep only the
  // best appointment, which would hide a Dean's second office as Chair.
  const textRanks = c.texts.map((t) => ({ title: t.title, rank: rankTitleText(t.title, t.department) }));
  const hasText = (rank: number) =>
    textRanks.some((t) => t.rank === rank) ||
    // An ED-tier option ranked with the chaired department in hand (a
    // director title naming the department they chair) — `textRanks` can't.
    present.some((o) => o.rank === rank && (o.tier === "working" || o.tier === "primary"));
  const mismatchNotes: string[] = [];
  if (roles.chair && !hasText(TITLE_RANK.chair)) mismatchNotes.push("Chair role, no Chair title");
  if (!roles.chair && textRanks.some((t) => t.rank === TITLE_RANK.chair && !/director/i.test(t.title))) {
    // A director title naming its own department ranks as Chair by design
    // (BMRI, #2804) — it has no chair role and is not a mismatch.
    mismatchNotes.push("Chair title, no Chair role");
  }
  if (!roles.chief && hasText(TITLE_RANK.divisionChief)) mismatchNotes.push("Chief title, no Chief role");

  const reasons: TitleReason[] = [];
  if ((winner && isLeadershipRank(winner.rank)) || roles.chair || roles.chief || roles.centerDirector) {
    reasons.push("leadership");
  }
  if (pin !== null) reasons.push("pinned");
  if (new Set(present.filter((o) => isLeadershipRank(o.rank)).map((o) => o.value)).size >= 2) {
    reasons.push("contested");
  }
  // A leadership or director title lost to a non-leadership kind: the
  // pre-#2804 BMRI pattern, "Director, … Institute" (10) beaten by an endowed
  // professorship (9), or a pin that chose an academic title over a chair.
  const shown = pin ?? winner?.value ?? null;
  const isOffice = (rank: number) => isLeadershipRank(rank) || rank === TITLE_RANK.unitCenterDirector;
  const shownRank = pin !== null ? rankTitleText(pin) : (winner?.rank ?? TITLE_RANK.unranked);
  if (!isOffice(shownRank) && present.some((o) => o.value !== shown && isOffice(o.rank))) {
    reasons.push("leadershipLost");
  }
  if (mismatchNotes.length > 0) reasons.push("mismatch");
  if (reasons.length === 0) return null;

  return {
    cwid: c.cwid,
    name,
    displayed: c.primaryTitle,
    winner,
    runnerUp,
    pin,
    pinRedundant: pin !== null && pin === winner?.value,
    reasons,
    mismatchNotes,
    options: c.options,
  };
}

type DashboardClient = TitleResolutionClient & Pick<PrismaClient, "scholar">;

/** Every listed scholar, by name. One pass over ~9.4k candidates in memory. */
export async function loadTitleDashboard(client: DashboardClient): Promise<TitleDashboardRow[]> {
  const [candidates, chairRows, chiefRows, centerRows] = await Promise.all([
    loadTitleCandidates(client, { applyDerivedTiers: isTitleResolutionEnabled() }),
    // Chairs of academic departments only (`loadChairedDepartments`): not an
    // administrative department's `director`, not Graduate School / MD-PhD.
    loadChairedDepartments(client),
    roleCwids(client, "division"),
    roleCwids(client, "center", "director"),
  ]);
  const listed = candidates.flatMap((c) => {
    const row = classifyTitleRow(
      c,
      { chair: chairRows.has(c.cwid), chief: chiefRows.has(c.cwid), centerDirector: centerRows.has(c.cwid) },
      "",
    );
    return row ? [row] : [];
  });
  const names = await client.scholar.findMany({
    where: { cwid: { in: listed.map((r) => r.cwid) } },
    select: { cwid: true, preferredName: true },
  });
  const nameByCwid = new Map(names.map((n) => [n.cwid, n.preferredName]));
  return listed
    .map((r) => ({ ...r, name: nameByCwid.get(r.cwid) ?? r.cwid }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** cwids holding a leadership role on a unit of `entityType`. */
async function roleCwids(
  client: DashboardClient,
  entityType: string,
  roleKey?: string,
): Promise<Set<string>> {
  const rows = await client.orgUnitRoleAssignment.findMany({
    where: { entityType, role: { roleGroup: "leadership", ...(roleKey ? { key: roleKey } : {}) } },
    select: { cwid: true },
  });
  return new Set(rows.map((r) => r.cwid));
}

/** The report's filters, from the URL. Every key optional; unset = all. */
export type TitleDashboardParams = {
  reason: TitleReason | null;
  /** "1-8.5" leadership, "9-10" endowed/unit director, "11+" the rest. */
  band: "leadership" | "director" | "other" | null;
  pinned: boolean | null;
  /** The winning tier; "override" = pinned rows. */
  rule: TitleTier | "override" | null;
  q: string;
};

export type TitleBand = NonNullable<TitleDashboardParams["band"]>;
export type TitleRule = NonNullable<TitleDashboardParams["rule"]>;

export const TITLE_BANDS: readonly TitleBand[] = ["leadership", "director", "other"] as const;

export const TITLE_BAND_LABEL: Record<TitleBand, string> = {
  leadership: "Leadership (ranks 1–8.5)",
  director: "Endowed / unit director (9–10)",
  other: "Everything else (11+)",
};

/** Every tier, then "override" (the pin). */
export const TITLE_RULES: readonly TitleRule[] = [...TITLE_TIERS, "override"];

/** A winning rule as the operator reads it: the tier's label, "Pinned" for a pin. */
export function titleRuleLabel(rule: TitleRule): string {
  return rule === "override" ? "Pinned" : TITLE_TIER_LABEL[rule];
}

/** A ladder rank for display: "4", "8.5"; "—" for unranked or none. */
export function formatTitleRank(rank: number | null | undefined): string {
  return rank === null || rank === undefined || rank >= TITLE_RANK.unranked ? "—" : String(rank);
}

/** The operator notes on a row: the mismatch reasons, then the redundant pin. */
export function titleRowNotes(r: TitleDashboardRow): string[] {
  return [...r.mismatchNotes, ...(r.pinRedundant ? ["Pin matches ladder — can unpin"] : [])];
}

/** The rank of what is displayed by rule: the pin's (its tier row when it is
 *  one, else its text), otherwise the ladder winner's. */
export function winningRank(r: TitleDashboardRow): number | null {
  if (r.pin !== null) return r.options.find((o) => o.value === r.pin)?.rank ?? rankTitleText(r.pin);
  return r.winner?.rank ?? null;
}

export function parseTitleDashboardParams(sp: URLSearchParams): TitleDashboardParams {
  const reason = sp.get("reason");
  const band = sp.get("band");
  const pinned = sp.get("pinned");
  const rule = sp.get("rule");
  return {
    reason: (TITLE_REASONS as readonly string[]).includes(reason ?? "") ? (reason as TitleReason) : null,
    band: band === "leadership" || band === "director" || band === "other" ? band : null,
    pinned: pinned === "yes" ? true : pinned === "no" ? false : null,
    rule: (TITLE_RULES as readonly string[]).includes(rule ?? "") ? (rule as TitleRule) : null,
    q: (sp.get("q") ?? "").trim(),
  };
}

/** The rule that decides what is displayed: the pin, else the winner's tier. */
export function winningRule(r: TitleDashboardRow): TitleTier | "override" | null {
  return r.pin !== null ? "override" : (r.winner?.tier ?? null);
}

export function filterTitleDashboard(
  rows: readonly TitleDashboardRow[],
  p: TitleDashboardParams,
): TitleDashboardRow[] {
  const q = p.q.toLowerCase();
  return rows.filter((r) => {
    if (p.reason && !r.reasons.includes(p.reason)) return false;
    if (p.pinned !== null && (r.pin !== null) !== p.pinned) return false;
    if (p.rule && winningRule(r) !== p.rule) return false;
    if (p.band) {
      // The DISPLAYED title's rank (a pin's, when pinned) — what the Rank column shows.
      const rank = winningRank(r) ?? TITLE_RANK.unranked;
      const band = isLeadershipRank(rank) ? "leadership" : rank <= TITLE_RANK.unitCenterDirector ? "director" : "other";
      if (band !== p.band) return false;
    }
    if (q && !`${r.name} ${r.cwid} ${r.displayed ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The query string for `p` (the download link, chip removal); unset keys omitted. */
export function titleDashboardQueryString(p: TitleDashboardParams): string {
  const out = new URLSearchParams();
  if (p.reason) out.set("reason", p.reason);
  if (p.band) out.set("band", p.band);
  if (p.pinned !== null) out.set("pinned", p.pinned ? "yes" : "no");
  if (p.rule) out.set("rule", p.rule);
  if (p.q) out.set("q", p.q);
  return out.toString();
}

/** Every filter as `[criterion, value]`, "All" when unset — the export's
 *  Criteria sheet. */
export function titleDashboardCriteria(p: TitleDashboardParams): Array<readonly [string, string]> {
  return [
    ["Reason", p.reason ? TITLE_REASON_LABEL[p.reason] : "All"],
    ["Rank band", p.band ? TITLE_BAND_LABEL[p.band] : "All"],
    ["Pinned", p.pinned === null ? "All" : p.pinned ? "Yes" : "No"],
    ["Winning rule", p.rule ? titleRuleLabel(p.rule) : "All"],
    ["Search", p.q || "All"],
  ];
}
