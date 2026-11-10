/**
 * Report 20 (Shared resource usage): the pure half. A center's shared
 * resources (SRs) and the iLab core names billed under each, the fiscal
 * quarter arithmetic, the URL params, and `computeSharedResourceUsage`, which
 * turns one quarter of `core_charge` rows plus the center's research
 * memberships into every view the body draws. No DB: the loader is
 * `shared-resource-usage.server.ts`.
 *
 * Dollars are iLab "Total Price" summed over every line, the researcher's share
 * and the separate subsidy line alike (refunds are negative), so a core's total
 * is what the work cost. Sums run in whole cents.
 */
import { isCenterMembershipActive } from "@/lib/api/center-member-count";
import { INVITED_ROLE_KEY } from "@/lib/org-unit-roles";

export type SharedResource = {
  name: string;
  /** iLab "Core Name"s (trimmed) billed under this SR. */
  cores: readonly string[];
  /** The core set is not confirmed by the center yet. */
  provisional?: boolean;
};

/**
 * Center code -> its shared resources, each with the iLab core names billed
 * under it. ponytail: a code constant; it moves to a DB table if a second
 * center wants one or MCC needs to edit it in the UI.
 */
export const SHARED_RESOURCES: Readonly<Record<string, readonly SharedResource[]>> = {
  meyer_cancer_center: [
    {
      name: "Imaging",
      cores: [
        "Citigroup Biomedical Imaging Center",
        "Optical Microscopy Core",
        "Automated Optical Microscopy",
      ],
      provisional: true,
    },
    {
      name: "Genomics and Epigenomics",
      cores: ["Genomics Resources Core Facility", "Epigenomics Core"],
    },
    { name: "Flow Cytometry", cores: ["Flow Cytometry Core Facility"] },
    { name: "Proteomics and Metabolomics", cores: ["Proteomics and Metabolomics Core Facility"] },
  ],
};

/** The group a charge by a PI who is not a research member on its date falls in. */
export const NON_MEMBER = "Non-MCC";
/** The group of a research member with no program. */
export const NO_PROGRAM = "No program";

// ── Fiscal quarters ─────────────────────────────────────────────────────────

export type FiscalQuarter = {
  /** URL value, e.g. "FY27Q1". */
  key: string;
  /** e.g. "FY27 Q1 (Jul–Sep 2026)". */
  label: string;
  /** Inclusive start, `YYYY-MM-DD`. */
  start: string;
  /** Exclusive end, `YYYY-MM-DD`. */
  end: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, "0")}-01`;

/** Quarter `q` (1–4) of fiscal year `fy` (FY27 runs 2026-07-01 to 2027-06-30). */
export function fiscalQuarter(fy: number, q: number): FiscalQuarter {
  const first = 6 + (q - 1) * 3; // months after Jan of fy-1; Q1 starts in July
  const y = fy - 1 + Math.floor(first / 12);
  const m0 = first % 12;
  const endM = m0 + 3;
  const yy = String(fy % 100).padStart(2, "0");
  return {
    key: `FY${yy}Q${q}`,
    label: `FY${yy} Q${q} (${MONTHS[m0]}–${MONTHS[m0 + 2]} ${y})`,
    start: iso(y, m0),
    end: iso(y + Math.floor(endM / 12), endM % 12),
  };
}

/** The fiscal quarter a `YYYY-MM-DD` date falls in. */
export function fiscalQuarterOf(date: string): FiscalQuarter {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)); // 1–12
  return fiscalQuarter(m >= 7 ? y + 1 : y, Math.floor(((m + 5) % 12) / 3) + 1);
}

/** "FY27Q1" -> that quarter; anything else -> null. */
export function parseFiscalQuarterKey(raw: string | null | undefined): FiscalQuarter | null {
  const m = /^FY(\d{2})Q([1-4])$/.exec(raw ?? "");
  return m ? fiscalQuarter(2000 + Number(m[1]), Number(m[2])) : null;
}

// ── Params ──────────────────────────────────────────────────────────────────

export type SharedResourceParams = {
  /** A fiscal quarter key; null = the latest quarter with charges. */
  quarter: string | null;
  /** Narrows the subsidy-by-lab table (and its export) to one iLab core; null = all. */
  core: string | null;
};

/** One parser for the page and the xlsx route. */
export function parseSharedResourceParams(sp: URLSearchParams): SharedResourceParams {
  return {
    quarter: parseFiscalQuarterKey(sp.get("quarter"))?.key ?? null,
    core: sp.get("core")?.trim() || null,
  };
}

export function sharedResourceQuery(p: SharedResourceParams): string {
  const u = new URLSearchParams();
  if (p.quarter) u.set("quarter", p.quarter);
  if (p.core) u.set("core", p.core);
  return u.toString();
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export type UsageCharge = {
  coreName: string;
  customerLab: string | null;
  piCwid: string | null;
  ilabMcc: boolean;
  totalPrice: number;
  isSubsidy: boolean;
  /** `YYYY-MM-DD`: the date the charge went to the ERP, which places it in the quarter. */
  erpDate: string;
};

export type UsageMembership = {
  cwid: string;
  programCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
  membershipRoleKey: string | null;
};

/** Dollars by group (program code, `NO_PROGRAM`, `NON_MEMBER`). */
export type GroupDollars = { byGroup: Record<string, number>; total: number };

export type ShareCell = { users: number; members: number };

export type LabRow = {
  coreName: string;
  customerLab: string;
  group: string;
  total: number;
  subsidy: number;
  charges: number;
};

export type SharedResourceUsage = {
  /** Member groups in display order: the center's programs, any other code a member holds, then `NO_PROGRAM` if any member has none. */
  groups: string[];
  /** View 1: SR x program, members only. */
  srByProgram: Array<{ sr: string } & GroupDollars>;
  /** View 2: SR x programs + `NON_MEMBER`. */
  srByAll: Array<{ sr: string } & GroupDollars>;
  /** View 3: per SR, per group, distinct member PIs netting above $0 there over the group's members (both by roster group). */
  programShare: Array<{ sr: string; byGroup: Record<string, ShareCell> }>;
  /** View 4: per SR, distinct member PIs using it over all members. */
  memberShare: Array<{ sr: string } & ShareCell>;
  /** View 5: every iLab core, member dollars by group, largest first. */
  coresByProgram: Array<{ core: string } & GroupDollars>;
  /** View 6: one row per core, lab and group, largest subsidy first within a core. */
  labs: LabRow[];
  /** Research members active at any point in the quarter. */
  memberCount: number;
  chargeCount: number;
  dataQuality: {
    /** Subsidy lines on charges iLab does not flag MCC. */
    subsidyToNonMcc: { lines: number; amount: number; labs: number };
    /** Subsidy dollars at cores outside every SR. */
    subsidyOutsideSr: number;
    /** Labs with a member PI whose charges iLab does not flag MCC. */
    memberLabsNotFlagged: string[];
  };
};

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Membership overlaps `[start, end)`. Invited rows never count. */
function activeInWindow(m: UsageMembership, start: string, end: string): boolean {
  if (m.membershipRoleKey === INVITED_ROLE_KEY) return false;
  const s = dayOf(m.startDate);
  const e = dayOf(m.endDate);
  return (s === null || s < end) && (e === null || e >= start);
}

function addTo(map: Map<string, Map<string, number>>, row: string, group: string, c: number) {
  const r = map.get(row) ?? new Map<string, number>();
  r.set(group, (r.get(group) ?? 0) + c);
  map.set(row, r);
}

function toDollars(r: Map<string, number> | undefined): GroupDollars {
  const byGroup: Record<string, number> = {};
  let total = 0;
  for (const [g, c] of r ?? []) {
    byGroup[g] = dollars(c);
    total += c;
  }
  return { byGroup, total: dollars(total) };
}

export function computeSharedResourceUsage(input: {
  charges: readonly UsageCharge[];
  /** The center's research memberships (any dates); this filters by date. */
  memberships: readonly UsageMembership[];
  /** The center's program codes, in display order. */
  programs: readonly string[];
  resources: readonly SharedResource[];
  quarter: FiscalQuarter;
}): SharedResourceUsage {
  const { quarter, resources } = input;
  const srOf = new Map(resources.flatMap((r) => r.cores.map((c) => [c, r.name] as const)));
  const byCwid = new Map<string, UsageMembership[]>();
  for (const m of input.memberships) byCwid.set(m.cwid, [...(byCwid.get(m.cwid) ?? []), m]);

  // Member group on a date: the program on the membership active that day.
  const groupOn = (cwid: string | null, date: string): string => {
    const m = cwid ? byCwid.get(cwid)?.find((x) => isCenterMembershipActive(x, date)) : undefined;
    return m ? (m.programCode ?? NO_PROGRAM) : NON_MEMBER;
  };

  // Denominators: members active at any point in the quarter, by their latest such row's program.
  const roster = new Map<string, string>();
  for (const [cwid, rows] of byCwid) {
    const active = rows
      .filter((m) => activeInWindow(m, quarter.start, quarter.end))
      .sort((a, b) => (dayOf(a.startDate) ?? "").localeCompare(dayOf(b.startDate) ?? ""));
    const last = active.at(-1);
    if (last) roster.set(cwid, last.programCode ?? NO_PROGRAM);
  }
  const membersIn = (g: string) => [...roster.values()].filter((x) => x === g).length;

  const charges = input.charges.filter(
    (c) => c.erpDate >= quarter.start && c.erpDate < quarter.end,
  );
  const srAll = new Map<string, Map<string, number>>();
  const cores = new Map<string, Map<string, number>>();
  const net = new Map<string, Map<string, number>>(); // sr -> member cwid -> net cents
  const labs = new Map<string, LabRow & { totalC: number; subsidyC: number }>();
  const dq = {
    lines: 0,
    amountC: 0,
    labs: new Set<string>(),
    outsideC: 0,
    notFlagged: new Set<string>(),
  };
  const seen = new Set(roster.values());

  for (const c of charges) {
    const group = groupOn(c.piCwid, c.erpDate);
    const member = group !== NON_MEMBER;
    const sr = srOf.get(c.coreName);
    const amt = cents(c.totalPrice);
    const lab = c.customerLab ?? "(no lab)";
    if (member) seen.add(group);

    if (sr) {
      addTo(srAll, sr, group, amt);
      if (member && c.piCwid) addTo(net, sr, c.piCwid, amt);
    }
    if (member) addTo(cores, c.coreName, group, amt);

    const key = JSON.stringify([c.coreName, lab, group]);
    const row = labs.get(key) ?? {
      coreName: c.coreName,
      customerLab: lab,
      group,
      total: 0,
      subsidy: 0,
      charges: 0,
      totalC: 0,
      subsidyC: 0,
    };
    row.totalC += amt;
    row.charges += 1;
    if (c.isSubsidy) row.subsidyC += amt;
    labs.set(key, row);

    if (c.isSubsidy && !c.ilabMcc) {
      dq.lines += 1;
      dq.amountC += amt;
      dq.labs.add(lab);
    }
    if (c.isSubsidy && !sr) dq.outsideC += amt;
    if (member && !c.ilabMcc) dq.notFlagged.add(lab);
  }

  // Codes outside the center's programs (e.g. retired) still get a group, so no dollars drop out of a bar.
  const extra = [...seen].filter((g) => g !== NO_PROGRAM && !input.programs.includes(g)).sort();
  const groups = [...input.programs, ...extra, ...(seen.has(NO_PROGRAM) ? [NO_PROGRAM] : [])];
  // A user nets above $0 at the SR in the quarter (a refund-only line is not use), and
  // is counted in their roster group so views 3 and 4 share one denominator rule.
  const users = new Map<string, Map<string, Set<string>>>(); // sr -> group -> cwids
  for (const [sr, byPi] of net) {
    const g = new Map<string, Set<string>>();
    for (const [cwid, c] of byPi) {
      if (c <= 0) continue;
      const grp = roster.get(cwid) ?? NO_PROGRAM;
      g.set(grp, (g.get(grp) ?? new Set()).add(cwid));
    }
    users.set(sr, g);
  }
  const memberOnly = (r: GroupDollars): GroupDollars => {
    const byGroup = Object.fromEntries(Object.entries(r.byGroup).filter(([g]) => g !== NON_MEMBER));
    return { byGroup, total: dollars(Object.values(byGroup).reduce((s, v) => s + cents(v), 0)) };
  };
  const distinct = (sets: Iterable<Set<string>>) => new Set([...sets].flatMap((s) => [...s])).size;

  return {
    groups,
    srByProgram: resources.map((r) => ({
      sr: r.name,
      ...memberOnly(toDollars(srAll.get(r.name))),
    })),
    srByAll: resources.map((r) => ({ sr: r.name, ...toDollars(srAll.get(r.name)) })),
    programShare: resources.map((r) => ({
      sr: r.name,
      byGroup: Object.fromEntries(
        groups.map((g) => [
          g,
          { users: users.get(r.name)?.get(g)?.size ?? 0, members: membersIn(g) },
        ]),
      ),
    })),
    memberShare: resources.map((r) => ({
      sr: r.name,
      users: distinct(users.get(r.name)?.values() ?? []),
      members: roster.size,
    })),
    coresByProgram: [...cores]
      .map(([core, m]) => ({ core, ...toDollars(m) }))
      .sort((a, b) => b.total - a.total || a.core.localeCompare(b.core)),
    labs: [...labs.values()]
      .map(({ totalC, subsidyC, ...r }) => ({
        ...r,
        total: dollars(totalC),
        subsidy: dollars(subsidyC),
      }))
      .sort(
        (a, b) =>
          a.coreName.localeCompare(b.coreName) ||
          b.subsidy - a.subsidy ||
          a.customerLab.localeCompare(b.customerLab),
      ),
    memberCount: roster.size,
    chargeCount: charges.length,
    dataQuality: {
      subsidyToNonMcc: { lines: dq.lines, amount: dollars(dq.amountC), labs: dq.labs.size },
      subsidyOutsideSr: dollars(dq.outsideC),
      memberLabsNotFlagged: [...dq.notFlagged].sort(),
    },
  };
}

/** A whole percent of `n / d`, "–" when `d` is 0. */
export function sharePct(n: number, d: number): string {
  return d > 0 ? `${Math.round((100 * n) / d)}%` : "–";
}

/** "$1,234" (whole dollars; negative as "-$12"). */
export function usd(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}
