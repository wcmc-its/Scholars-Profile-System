/**
 * Report 2 — NCI Table 2a (reports redesign, 2026-09-25; mockup `NCI Table 2a
 * Redesign.dc.html`). The db-free half: the row shape the loader
 * (`nci-2a-report.server.ts`) and `GET /api/edit/center/[code]/nci-2a` both
 * return, the URL filters (status / program / peer-reviewed / search / sort),
 * the review status of a row, the headline numbers, the chips and the CSV.
 * Safe to import from the client table (`components/edit/reports/nci-2a-table.tsx`).
 *
 * Review status (PR 2b: `cancerRelevantPercentAi` holds what the model said):
 *   - `confirmed`     — `cancerRelevantPercentSource = "human"` and the value
 *                       equals the AI's (or there is no AI value).
 *   - `corrected`     — `"human"`, and the value differs from the AI's
 *                       ("Corrected · AI said X%").
 *   - `ai`            — an LLM value nobody has reviewed yet.
 *   - `not-inferred`  — the percent is null (the Bedrock call failed or the
 *                       import skipped it). Counts under Needs review, and is
 *                       left out of the Cancer-relevant $ figure.
 */

export type Nci2aProgram = { code: string; label: string };

export type Nci2aAllocation = {
  id: string;
  programCode: string | null;
  programLabel: string | null;
  programPercent: number;
  source: "membership" | "llm" | "human";
  annualProgramDirectCosts: number | null;
};

export type Nci2aAward = {
  id: string;
  pi: string;
  specificFundingSource: string;
  projectNumber: string;
  projectTitle: string;
  projectStartDate: string;
  projectEndDate: string;
  annualProjectDirectCosts: number;
  cancerRelevantPercent: number | null;
  cancerRelevantPercentSource: "llm" | "human";
  /** What Bedrock proposed (`cancer_relevant_percent_ai`); null = no AI value. */
  cancerRelevantPercentAi: number | null;
  cancerRelevantRationale: string | null;
  cancerRelevantAnnualProjectDc: number | null;
  isPeerReviewed: boolean;
  grantCwid: string | null;
  applId: number | null;
  /** Where `allocations` came from: `membership` = the PI's CURRENT
   *  `CenterMembership.programCode`, read at request time; `stored` = the
   *  allocation rows the import wrote (no live membership program). */
  programFrom: "membership" | "stored";
  allocations: Nci2aAllocation[];
};

export type Nci2aData = { cycle: string | null; programs: Nci2aProgram[]; awards: Nci2aAward[] };

export type Nci2aStatus = "confirmed" | "corrected" | "ai" | "not-inferred";

export function nci2aStatus(
  a: Pick<
    Nci2aAward,
    "cancerRelevantPercent" | "cancerRelevantPercentSource" | "cancerRelevantPercentAi"
  >,
): Nci2aStatus {
  if (a.cancerRelevantPercent == null) return "not-inferred";
  if (a.cancerRelevantPercentSource !== "human") return "ai";
  return a.cancerRelevantPercentAi != null && a.cancerRelevantPercentAi !== a.cancerRelevantPercent
    ? "corrected"
    : "confirmed";
}

/** Reviewed = a human saved or accepted it (Confirmed or Corrected). */
const reviewed = (s: Nci2aStatus) => s === "confirmed" || s === "corrected";

export const needsReview = (a: Nci2aAward) => !reviewed(nci2aStatus(a));

/** The CSV Review Status column: Confirmed / Corrected / Needs review. */
export function reviewStatusLabel(a: Nci2aAward): "Confirmed" | "Corrected" | "Needs review" {
  const s = nci2aStatus(a);
  return s === "confirmed" ? "Confirmed" : s === "corrected" ? "Corrected" : "Needs review";
}

// ── URL filters ──────────────────────────────────────────────────────────

export type Nci2aStatusFilter = "all" | "needs" | "done";
export type Nci2aPeerFilter = "" | "yes" | "no";
export type Nci2aSortKey = "pi" | "dc" | "pct" | "rel";

export type Nci2aParams = {
  status: Nci2aStatusFilter;
  /** "" = all programs, "none" = no program assigned, else a program code. */
  program: string;
  peer: Nci2aPeerFilter;
  q: string;
  sort: Nci2aSortKey;
  dir: "asc" | "desc";
};

export const NCI2A_UNASSIGNED = "none";
const SORT_KEYS: Nci2aSortKey[] = ["pi", "dc", "pct", "rel"];
/** A newly clicked column's first direction: names A–Z, money and percent high first. */
export const firstDir = (k: Nci2aSortKey): "asc" | "desc" => (k === "pi" ? "asc" : "desc");

export function parseNci2aParams(sp: URLSearchParams): Nci2aParams {
  const status = sp.get("status");
  const peer = sp.get("peer");
  const sort = sp.get("sort") as Nci2aSortKey | null;
  const s: Nci2aSortKey = sort && SORT_KEYS.includes(sort) ? sort : "pi";
  const dir = sp.get("dir");
  return {
    status: status === "needs" || status === "done" ? status : "all",
    program: (sp.get("program") ?? "").trim().slice(0, 32),
    peer: peer === "yes" || peer === "no" ? peer : "",
    q: (sp.get("q") ?? "").trim().slice(0, 200),
    sort: s,
    dir: dir === "asc" || dir === "desc" ? dir : firstDir(s),
  };
}

/** The query string for `p` with `over` applied; defaults are left out. */
export function nci2aQueryString(p: Nci2aParams, over: Partial<Nci2aParams> = {}): string {
  const m = { ...p, ...over };
  const out = new URLSearchParams();
  if (m.status !== "all") out.set("status", m.status);
  if (m.program) out.set("program", m.program);
  if (m.peer) out.set("peer", m.peer);
  if (m.q) out.set("q", m.q);
  if (m.sort !== "pi" || m.dir !== firstDir(m.sort)) {
    out.set("sort", m.sort);
    out.set("dir", m.dir);
  }
  return out.toString();
}

/**
 * The unit part of the report's own links: `center=<code>`, plus `kind=` for a
 * non-center unit. The page resolves the unit from it
 * (`resolveNumberedReportCenterCode`); a link without it sends any actor who
 * can see more than one unit back to the Reports index.
 */
export function nci2aUnitQuery(code: string, kind: string): string {
  const u = new URLSearchParams({ center: code });
  if (kind !== "center") u.set("kind", kind);
  return u.toString();
}

/** A report link: the unit first, then the filter query `q`. */
export const nci2aHref = (basePath: string, unitQuery: string, q: string) =>
  `${basePath}?${unitQuery}${q ? `&${q}` : ""}`;

/** Any filter, status included, narrows the rows (and so the CSV). */
export const nci2aFiltered = (p: Nci2aParams) =>
  p.status !== "all" || p.program !== "" || p.peer !== "" || p.q !== "";

/** The column header's link: the same column flips direction; a new one starts at its first. */
export function sortQuery(p: Nci2aParams, k: Nci2aSortKey): string {
  const dir = p.sort === k ? (p.dir === "asc" ? "desc" : "asc") : firstDir(k);
  return nci2aQueryString(p, { sort: k, dir });
}

function matchesProgram(a: Nci2aAward, program: string): boolean {
  if (!program) return true;
  if (program === NCI2A_UNASSIGNED) return !a.allocations.some((al) => al.programCode);
  return a.allocations.some((al) => al.programCode === program);
}

function matchesQuery(a: Nci2aAward, q: string): boolean {
  if (!q) return true;
  const hay = [a.pi, a.grantCwid ?? "", a.specificFundingSource, a.projectNumber, a.projectTitle]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

const sortValue: Record<Nci2aSortKey, (a: Nci2aAward) => string | number | null> = {
  pi: (a) => a.pi,
  dc: (a) => a.annualProjectDirectCosts,
  pct: (a) => a.cancerRelevantPercent,
  rel: (a) => a.cancerRelevantAnnualProjectDc,
};

/**
 * `base` = every filter but status (the segment counts read it); `rows` =
 * `base` narrowed by status, then sorted. A null percent / relevant DC sorts
 * last in either direction; ties fall back to PI, then project number.
 */
export function filterNci2a(awards: ReadonlyArray<Nci2aAward>, p: Nci2aParams) {
  const base = awards.filter(
    (a) =>
      matchesProgram(a, p.program) &&
      (p.peer === "" || (p.peer === "yes") === a.isPeerReviewed) &&
      matchesQuery(a, p.q),
  );
  const needs = base.filter(needsReview).length;
  const byStatus =
    p.status === "all" ? base : base.filter((a) => (p.status === "needs") === needsReview(a));
  const key = sortValue[p.sort];
  const sign = p.dir === "asc" ? 1 : -1;
  const rows = [...byStatus].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null || y == null) {
      if (x != null) return -1;
      if (y != null) return 1;
    } else {
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      if (c !== 0) return c * sign;
    }
    return a.pi.localeCompare(b.pi) || a.projectNumber.localeCompare(b.projectNumber);
  });
  return { base, rows, counts: { all: base.length, needs, done: base.length - needs } };
}

// ── Headline numbers ─────────────────────────────────────────────────────

export type Nci2aStats = {
  projects: number;
  directCosts: number;
  /** Relevant DC summed over rows WITH a percent. */
  relevant: number;
  /** Direct costs of the rows with a percent — the relevant share's denominator. */
  inferredDirectCosts: number;
  notInferred: number;
  peerDirectCosts: number;
  needsReview: number;
};

export function nci2aStats(rows: ReadonlyArray<Nci2aAward>): Nci2aStats {
  const s: Nci2aStats = {
    projects: rows.length,
    directCosts: 0,
    relevant: 0,
    inferredDirectCosts: 0,
    notInferred: 0,
    peerDirectCosts: 0,
    needsReview: 0,
  };
  for (const a of rows) {
    s.directCosts += a.annualProjectDirectCosts;
    if (a.isPeerReviewed) s.peerDirectCosts += a.annualProjectDirectCosts;
    if (a.cancerRelevantPercent == null) s.notInferred += 1;
    else {
      s.relevant += a.cancerRelevantAnnualProjectDc ?? 0;
      s.inferredDirectCosts += a.annualProjectDirectCosts;
    }
    if (needsReview(a)) s.needsReview += 1;
  }
  return s;
}

/**
 * Cycle-wide review progress over the AI-suggested percentages: `total` = rows
 * with an AI value, `reviewed` = those a human has since confirmed or
 * corrected, `pending` = those still AI-suggested. A not-inferred row has no
 * suggestion, so it is in none of these; `needsReview` is every row still to
 * review, not-inferred included (it drives the "Review N" link, so the link
 * agrees with the Needs review segment, the CSV note and the reports index).
 */
export function reviewProgress(awards: ReadonlyArray<Nci2aAward>) {
  const suggested = awards.filter((a) => a.cancerRelevantPercentAi != null);
  const done = suggested.filter((a) => !needsReview(a)).length;
  const total = suggested.length;
  return {
    reviewed: done,
    total,
    pending: total - done,
    needsReview: awards.filter(needsReview).length,
    pct: total ? Math.round((done / total) * 100) : 100,
  };
}

export const money = (n: number | null) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "$12.3M" at a million and up, else whole dollars. */
export const bigMoney = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : money(n));

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function nci2aStatTiles(s: Nci2aStats): { value: string; label: string }[] {
  const noun = s.projects === 1 ? "project" : "projects";
  const excluded =
    s.notInferred > 0 ? `; excludes ${s.notInferred.toLocaleString()} not inferred` : "";
  return [
    {
      value: bigMoney(s.directCosts),
      label: `Direct costs, ${s.projects.toLocaleString()} ${noun}`,
    },
    {
      value: bigMoney(s.relevant),
      label: `Cancer-relevant (${pctOf(s.relevant, s.inferredDirectCosts)}%${excluded})`,
    },
    { value: `${pctOf(s.peerDirectCosts, s.directCosts)}%`, label: "Peer-reviewed funding" },
  ];
}

export function nci2aDownloadNote(
  cycle: string,
  s: Nci2aStats,
  filtered = false,
): { text: string; pending: boolean } {
  const scope = filtered
    ? ` Filtered: this file holds only the ${s.projects.toLocaleString()} ${s.projects === 1 ? "project" : "projects"} these filters select, not the whole cycle.`
    : "";
  const head = `Cycle ${cycle} · annual figures.${scope}`;
  if (s.needsReview === 0)
    return { text: `${head} Every percentage in this file has been reviewed.`, pending: false };
  const rows =
    s.needsReview === 1 ? "1 row still needs" : `${s.needsReview.toLocaleString()} rows still need`;
  return {
    text: `${head} ${rows} review and ${s.needsReview === 1 ? "is" : "are"} flagged in the file.`,
    pending: true,
  };
}

// ── Chips ────────────────────────────────────────────────────────────────

export function nci2aChips(p: Nci2aParams, programs: ReadonlyArray<Nci2aProgram>) {
  const chips: { group: string; value: string; removeQuery: string }[] = [];
  if (p.program) {
    const label =
      p.program === NCI2A_UNASSIGNED
        ? "Unassigned"
        : (programs.find((x) => x.code === p.program)?.label ?? p.program);
    chips.push({
      group: "Program",
      value: label,
      removeQuery: nci2aQueryString(p, { program: "" }),
    });
  }
  if (p.peer) {
    chips.push({
      group: "Peer-reviewed",
      value: p.peer === "yes" ? "Yes" : "No",
      removeQuery: nci2aQueryString(p, { peer: "" }),
    });
  }
  if (p.q) chips.push({ group: "Search", value: p.q, removeQuery: nci2aQueryString(p, { q: "" }) });
  return chips;
}

// ── A save, applied locally ──────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `a` as the PATCH (or bulk Accept) just wrote it: the percent, `source: "human"`, and the
 * dollars derived from it (the same arithmetic as the loader). The table shows
 * this until the server row catches up, so a lagged read-replica refresh can't
 * put the old AI value (and an Accept bound to it) back on screen.
 */
export function applyNci2aWrite(a: Nci2aAward, pct: number): Nci2aAward {
  const relevantRaw = a.annualProjectDirectCosts * (pct / 100);
  return {
    ...a,
    cancerRelevantPercent: pct,
    cancerRelevantPercentSource: "human",
    cancerRelevantAnnualProjectDc: round2(relevantRaw),
    allocations: a.allocations.map((al) => ({
      ...al,
      annualProgramDirectCosts: round2(relevantRaw * (al.programPercent / 100)),
    })),
  };
}

/** The server row already shows the write, so the local copy can go. The AI
 *  original is left as it is: it is what tells Confirmed from Corrected. */
export const nci2aWriteLanded = (a: Nci2aAward, pct: number) =>
  a.cancerRelevantPercentSource === "human" && a.cancerRelevantPercent === pct;

// ── Bulk Accept ──────────────────────────────────────────────────────────

/** Most awards one `POST .../nci-2a/accept` takes (one transaction). */
export const NCI2A_ACCEPT_CAP = 50;

export type Nci2aAcceptSkipReason = "already_reviewed" | "no_percent" | "not_found";

export type Nci2aAcceptResult = {
  accepted: Array<{ awardId: string; cancerRelevantPercent: number }>;
  skipped: Array<{ awardId: string; reason: Nci2aAcceptSkipReason }>;
};

/** The AI-suggested rows among `shown`, up to the route's cap, in order. */
export const bulkAcceptTargets = (shown: ReadonlyArray<Nci2aAward>) =>
  shown.filter((a) => nci2aStatus(a) === "ai").slice(0, NCI2A_ACCEPT_CAP);

/** The pill text: Corrected names what the model said. */
export function statusPillLabel(
  a: Pick<
    Nci2aAward,
    "cancerRelevantPercent" | "cancerRelevantPercentSource" | "cancerRelevantPercentAi"
  >,
): string {
  switch (nci2aStatus(a)) {
    case "ai":
      return "AI-suggested";
    case "not-inferred":
      return "Not inferred";
    case "corrected":
      return `Corrected · AI said ${a.cancerRelevantPercentAi}%`;
    default:
      return "Confirmed";
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────

/** RFC4180-ish quoting (titles and names may carry commas or quotes). */
function csvCell(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const NCI2A_CSV_HEADER = [
  "PI",
  "Specific Funding Source",
  "Project Number",
  "Project Start",
  "Project End",
  "Project Title",
  "Annual Project Direct Costs",
  "Peer-Reviewed",
  "Cancer-Relevant Percent",
  "Review Status",
  "Cancer-Relevant Annual Project DC",
  "Program Code",
  "Program Percent",
  "Annual Program Direct Costs",
] as const;

/** `-filtered` in the name whenever the file isn't the whole cycle. */
export const nci2aCsvFilename = (cycle: string, filtered: boolean) =>
  `nci-table-2a-${cycle}${filtered ? "-filtered" : ""}.csv`;

/**
 * The NCI worksheet shape: one line per program allocation, the award columns
 * on the first. Award-grain NCI submission data, exempt from
 * SCHOLAR_EXPORT_CAP (approved 2026-09-25) on the condition that it carries NO
 * CWID column — PI names only. An award with no allocation still gets a line.
 */
export function nci2aCsv(awards: ReadonlyArray<Nci2aAward>): string {
  const lines = [NCI2A_CSV_HEADER.join(",")];
  for (const a of awards) {
    const allocations: Array<Pick<
      Nci2aAllocation,
      "programCode" | "programPercent" | "annualProgramDirectCosts"
    > | null> = a.allocations.length ? a.allocations : [null];
    allocations.forEach((al, i) => {
      const first = i === 0;
      lines.push(
        [
          first ? a.pi : "",
          first ? a.specificFundingSource : "",
          first ? a.projectNumber : "",
          first ? a.projectStartDate : "",
          first ? a.projectEndDate : "",
          first ? a.projectTitle : "",
          first ? a.annualProjectDirectCosts : "",
          first ? (a.isPeerReviewed ? "Yes" : "No") : "",
          first ? (a.cancerRelevantPercent ?? "") : "",
          first ? reviewStatusLabel(a) : "",
          first ? (a.cancerRelevantAnnualProjectDc ?? "") : "",
          al?.programCode ?? "",
          al?.programPercent ?? "",
          al?.annualProgramDirectCosts ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    });
  }
  return lines.join("\n");
}
