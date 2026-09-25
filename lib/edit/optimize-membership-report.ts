/**
 * Report 1 ("Optimize membership") — the pure half shared by the page, its
 * client table (`components/edit/cancer-center-collab-report-card.tsx`) and
 * the two `.xlsx` routes (`/api/edit/center/[code]/collab-report/xlsx` and
 * `/selected`). DB-free and client-safe: no `@/lib/db`, no exceljs.
 *
 * The thresholds, the tab, the search box and the institution select are URL
 * params (`c`, `cmode`, `x`, `xmode`, `tab`, `q`, `inst`; the #2792 pattern,
 * plan D6), so a shared link and the download reproduce the same lists. A
 * param at its default is left out of the URL.
 *
 * The three lists (unchanged from the card they replace):
 *   remove  — current member, zero co-authored papers with the center. Fixed,
 *             not threshold-driven.
 *   collab  — non-member clearing BOTH the collaboration and the
 *             cancer-relevance bar.
 *   recruit — non-member clearing the cancer-relevance bar but NOT the
 *             collaboration bar (exclusive of `collab`).
 */
import { ADD_THRESHOLD, pct } from "@/lib/center-collaboration/recommendations-core";

export type CollabRow = {
  cwid: string;
  surname: string;
  givenName: string;
  primaryDepartment: string;
  /** Display name of the ED primary organization; "" when unknown. */
  institution: string;
  totalPapersPostCutoff: number;
  collaborationsWithCenter: number;
  cancerRelatedPapers: number;
  isCurrentMember: boolean;
  currentProgramCode: string | null;
  /** `CenterProgram.label` for `currentProgramCode`; null when none or unknown. */
  programLabel: string | null;
};

export type ThresholdMode = "count" | "percent";
export type OptimizeTab = "remove" | "collab" | "recruit";

export type OptimizeParams = {
  c: number;
  cmode: ThresholdMode;
  x: number;
  xmode: ThresholdMode;
  tab: OptimizeTab;
  q: string;
  inst: string;
};

/** The mockup's defaults per mode: collaboration 2 papers / 10 %,
 *  cancer-relevance 3 papers / 20 %. Switching mode resets to these. */
export const THRESHOLD_DEFAULTS: Record<"c" | "x", Record<ThresholdMode, number>> = {
  c: { count: ADD_THRESHOLD, percent: 10 },
  x: { count: 3, percent: 20 },
};

export const OPTIMIZE_TABS: ReadonlyArray<{ key: OptimizeTab; label: string; sheet: string }> = [
  { key: "remove", label: "Remove", sheet: "Remove" },
  { key: "collab", label: "Add: collaborators", sheet: "Add collaborators" },
  { key: "recruit", label: "Add: recruits", sheet: "Add recruits" },
];

export const DEFAULT_OPTIMIZE_PARAMS: OptimizeParams = {
  c: THRESHOLD_DEFAULTS.c.count,
  cmode: "count",
  x: THRESHOLD_DEFAULTS.x.count,
  xmode: "count",
  tab: "remove",
  q: "",
  inst: "",
};

const isMode = (v: string | null): v is ThresholdMode => v === "count" || v === "percent";
const isTab = (v: string | null): v is OptimizeTab =>
  v === "remove" || v === "collab" || v === "recruit";

/** A threshold value: a non-negative whole number, at most 100 in percent
 *  mode. Anything else (missing, junk, negative) falls back to the default. */
export function clampThreshold(raw: unknown, mode: ThresholdMode, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === "" || !Number.isFinite(n) || n < 0) return fallback;
  const whole = Math.floor(n);
  return mode === "percent" ? Math.min(whole, 100) : whole;
}

export function parseOptimizeParams(sp: URLSearchParams): OptimizeParams {
  const cmode = isMode(sp.get("cmode")) ? (sp.get("cmode") as ThresholdMode) : "count";
  const xmode = isMode(sp.get("xmode")) ? (sp.get("xmode") as ThresholdMode) : "count";
  const tab = sp.get("tab");
  return {
    c: clampThreshold(sp.get("c"), cmode, THRESHOLD_DEFAULTS.c[cmode]),
    cmode,
    x: clampThreshold(sp.get("x"), xmode, THRESHOLD_DEFAULTS.x[xmode]),
    xmode,
    tab: isTab(tab) ? tab : "remove",
    q: (sp.get("q") ?? "").trim().slice(0, 200),
    inst: (sp.get("inst") ?? "").slice(0, 200),
  };
}

/** The params as a query string, defaults left out. `withTab` false for the
 *  download, which carries every list whatever tab is open. */
export function optimizeQueryString(p: OptimizeParams, withTab = true): string {
  const out = new URLSearchParams();
  if (p.cmode !== "count") out.set("cmode", p.cmode);
  if (p.c !== THRESHOLD_DEFAULTS.c[p.cmode]) out.set("c", String(p.c));
  if (p.xmode !== "count") out.set("xmode", p.xmode);
  if (p.x !== THRESHOLD_DEFAULTS.x[p.xmode]) out.set("x", String(p.x));
  if (withTab && p.tab !== "remove") out.set("tab", p.tab);
  if (p.q.trim()) out.set("q", p.q.trim());
  if (p.inst) out.set("inst", p.inst);
  return out.toString();
}

/** Does `count` (out of the row's post-cutoff papers) clear `value`? */
export function clears(row: CollabRow, count: number, mode: ThresholdMode, value: number): boolean {
  return mode === "percent" ? pct(count, row.totalPapersPostCutoff) >= value : count >= value;
}

/** The search box and institution select. Name, department or institution;
 *  case-insensitive. */
export function filterRows(
  rows: ReadonlyArray<CollabRow>,
  p: Pick<OptimizeParams, "q" | "inst">,
): CollabRow[] {
  const q = p.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!p.inst || r.institution === p.inst) &&
      (!q ||
        `${r.givenName} ${r.surname} ${r.primaryDepartment} ${r.institution}`
          .toLowerCase()
          .includes(q)),
  );
}

export type OptimizeLists = Record<OptimizeTab, CollabRow[]>;

/** The three lists for these thresholds, each narrowed by the search box and
 *  institution select. */
export function bucketLists(rows: ReadonlyArray<CollabRow>, p: OptimizeParams): OptimizeLists {
  const pool = filterRows(rows, p);
  const cOk = (r: CollabRow) => clears(r, r.collaborationsWithCenter, p.cmode, p.c);
  const xOk = (r: CollabRow) => clears(r, r.cancerRelatedPapers, p.xmode, p.x);
  return {
    remove: pool.filter((r) => r.isCurrentMember && r.collaborationsWithCenter === 0),
    collab: pool.filter((r) => !r.isCurrentMember && xOk(r) && cOk(r)),
    recruit: pool.filter((r) => !r.isCurrentMember && xOk(r) && !cOk(r)),
  };
}

function collabPhrase(p: OptimizeParams): string {
  return p.cmode === "count"
    ? `${p.c} co-authored ${p.c === 1 ? "paper" : "papers"} with members`
    : `${p.c}% of papers co-authored with members`;
}

function cancerPhrase(p: OptimizeParams): string {
  return p.xmode === "count"
    ? `${p.x} cancer-related ${p.x === 1 ? "paper" : "papers"}`
    : `${p.x}% of papers cancer-related`;
}

/** The sentence under the tabs saying who is on the list, with the live thresholds. */
export function ruleText(tab: OptimizeTab, p: OptimizeParams): string {
  switch (tab) {
    case "remove":
      return "Current members who haven’t co-authored any papers with other members. Worth checking whether they are still active in the center.";
    case "collab":
      return `Not members, but already co-author with members (at least ${collabPhrase(p)}) and have at least ${cancerPhrase(p)}. The strongest candidates to add.`;
    case "recruit":
      return `Not members and not yet connected (fewer than ${collabPhrase(p)}), but have at least ${cancerPhrase(p)}. Candidates for outreach.`;
  }
}

export type OptimizeSortKey = "name" | "papers" | "collab" | "cancer";

/** Header sort. Name sorts by surname, then given name; the numbers break
 *  ties on the same. `dir` 1 ascending, -1 descending. */
export function sortRows(
  rows: ReadonlyArray<CollabRow>,
  key: OptimizeSortKey,
  dir: 1 | -1,
): CollabRow[] {
  const byName = (a: CollabRow, b: CollabRow) =>
    a.surname.localeCompare(b.surname) || a.givenName.localeCompare(b.givenName);
  const num: Record<Exclude<OptimizeSortKey, "name">, (r: CollabRow) => number> = {
    papers: (r) => r.totalPapersPostCutoff,
    collab: (r) => r.collaborationsWithCenter,
    cancer: (r) => r.cancerRelatedPapers,
  };
  return [...rows].sort((a, b) => {
    if (key === "name") return byName(a, b) * dir;
    return (num[key](a) - num[key](b)) * dir || byName(a, b);
  });
}

/** Distinct non-empty institutions, alphabetically, for the select. */
export function institutionOptions(rows: ReadonlyArray<CollabRow>): string[] {
  return [...new Set(rows.map((r) => r.institution).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** "Sep 20, 2026, 8:05 AM" (New York time) — fixed format, so the server and
 *  the browser agree. */
export function formatRefreshed(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One list sheet's stand-in above the cap: never a truncated list. */
export function listWithheldNote(label: string, people: number, cap: number): string {
  return `${label}: ${people.toLocaleString()} people exceeds the ${cap}-person export limit, so this list is withheld. Raise the thresholds or narrow the search to ${cap} or fewer to include it.`;
}

/** The download button's subtext: which lists this view's workbook carries. */
export function optimizeDownloadNote(
  lists: OptimizeLists,
  cap: number,
): { text: string; withheld: boolean } {
  const over = OPTIMIZE_TABS.filter((t) => lists[t.key].length > cap);
  if (over.length === 0) {
    return {
      text: "One sheet per list, plus a Criteria sheet with the thresholds.",
      withheld: false,
    };
  }
  const names = over.map((t) => `${t.label} (${lists[t.key].length.toLocaleString()})`).join(", ");
  return {
    text: `One sheet per list, plus Criteria. A list over ${cap} people is withheld, not cut short: ${names}. Raise the thresholds to include it.`,
    withheld: true,
  };
}

function thresholdCriterion(value: number, mode: ThresholdMode, noun: string): string {
  return mode === "count"
    ? `At least ${value} ${noun} (count)`
    : `At least ${value}% of papers ${noun}`;
}

/** The Criteria sheet's rows: every threshold and filter, "All" when unset. */
export function describeOptimizeCriteria(
  p: OptimizeParams,
  centerName: string,
  generatedAt: Date,
  refreshedAt: string | null,
  cap: number,
): Array<[string, string]> {
  return [
    ["Report", "Optimize membership (report 1)"],
    ["Center", centerName],
    ["Generated", generatedAt.toISOString()],
    ["Data last refreshed", refreshedAt ?? "Not yet run"],
    ["Collaboration threshold", thresholdCriterion(p.c, p.cmode, "co-authored with members")],
    ["Cancer-relevance threshold", thresholdCriterion(p.x, p.xmode, "cancer-related")],
    ["Search", p.q.trim() || "All"],
    ["Institution", p.inst || "All"],
    ["Remove", ruleText("remove", p)],
    ["Add: collaborators", ruleText("collab", p)],
    ["Add: recruits", ruleText("recruit", p)],
    [
      "Export limit",
      `A list of more than ${cap} people is withheld (a note in its place), never truncated.`,
    ],
    [
      "Scope",
      "Full-time faculty. Papers are post-cutoff Academic Articles; cancer-related means at least one MeSH term in the cancer taxonomy. Advisory only: nothing here changes the roster.",
    ],
  ];
}

/** The table's columns, shared by both workbooks. */
export const OPTIMIZE_SHEET_HEADER = [
  "CWID",
  "Name",
  "Department",
  "Institution",
  "Papers",
  "With members",
  "With members %",
  "Cancer-related",
  "Cancer-related %",
  "Program code",
  "Program",
] as const;

export function optimizeSheetRow(r: CollabRow): Array<string | number> {
  return [
    r.cwid,
    `${r.givenName} ${r.surname}`.trim(),
    r.primaryDepartment,
    r.institution,
    r.totalPapersPostCutoff,
    r.collaborationsWithCenter,
    pct(r.collaborationsWithCenter, r.totalPapersPostCutoff),
    r.cancerRelatedPapers,
    pct(r.cancerRelatedPapers, r.totalPapersPostCutoff),
    r.currentProgramCode ?? "",
    r.programLabel ?? "",
  ];
}
