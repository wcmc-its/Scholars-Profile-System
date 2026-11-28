/** Report 27's Connections view (`downstream-reach-connections.ts`, its panel,
 *  the Bibliometrics line, the Connections sheet): the pairing rule, THE RULE
 *  (each count equals the length of the list its link opens), the URL
 *  round-trip of every link, the flag, access, query shape, and that the
 *  report's other views and the Bibliometrics block are unchanged when the
 *  view is not open.
 *
 *  As in `downstream-reach-report.test.ts`, `$queryRaw` is answered by a small
 *  model of the tables (`answer`), which reads the params of the call being
 *  answered (`cur`) and returns what the database would. The model applies
 *  what the SQL applies to authorships (confirmed, first or senior, active,
 *  the who filter, the cited paper's filters; never the viewer's units on the
 *  other end, plan decision 8) but NOT the SQL's "not the same scholar" test:
 *  it returns those rows too, so the loader's own fold (`foldConnections`) is
 *  what drops them. The SQL text is asserted separately; nothing here runs it.
 *
 *  Fixture people and papers are invented. */
import { createElement, Fragment, type ReactNode } from "react";
import { cleanup, render, within } from "@testing-library/react";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  manageable: vi.fn(),
  session: vi.fn(),
  identity: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      topic: { findMany: vi.fn(async () => []) },
      suppression: { findMany: vi.fn(async () => []) },
      publicationAuthor: { findMany: vi.fn(async () => []) },
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: h.manageable }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));
vi.mock("@/lib/edit/bibliometrics-access", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/bibliometrics-access")>()),
  loadBibliometricsAccess: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: (p: { cwid: string; children: ReactNode }) =>
    createElement("span", { "data-testid": "hover-card", "data-cwid": p.cwid }, p.children),
}));
vi.mock("@/components/publication/publication-modal", () => ({
  PublicationModalProvider: (p: { children: ReactNode }) => createElement("div", { "data-testid": "modal-provider" }, p.children),
  usePublicationModal: () => ({ open: vi.fn(), close: vi.fn(), state: null }),
}));
// The Bibliometrics route's own collaborators; its part=reach path is real.
vi.mock("@/lib/edit/request", async () => {
  const { NextResponse } = await import("next/server");
  return {
    resolveEditIdentity: h.identity,
    editOk: (payload: Record<string, unknown>) => NextResponse.json({ ok: true, ...payload }),
    editError: (status: number, error: string) => NextResponse.json({ ok: false, error }, { status }),
    logEditFailure: vi.fn(),
  };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeCvExport: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/bibliometrics-loader", () => ({ loadBibliometricsReport: vi.fn() }));
vi.mock("@/lib/edit/bibliometrics-docx", () => ({ buildBibliometricsDocx: vi.fn() }));
vi.mock("@/lib/edit/bibliometrics-patents", () => ({ patentReportHref: vi.fn() }));

import { GET as bibliometricsGET } from "@/app/api/edit/bibliometrics/route";
import { GET as downloadGET } from "@/app/api/edit/reports/downstream-reach/route";
import { loadConnectionsPage } from "@/components/edit/reports/downstream-reach-connections";
import { renderDownstreamReachReport } from "@/components/edit/reports/downstream-reach-body";
import {
  coauthorsSql,
  connectionLinks,
  connectionLinksSql,
  connectionsSheet,
  dropCoauthors,
  foldConnections,
  loadConnectionStageMix,
  loadReachConnections,
  MIN_CONNECTION_PAPERS,
  stageMixParams,
  type ConnectionLink,
  type ReachConnections,
} from "@/lib/edit/downstream-reach-connections";
import {
  loadScholarConnections,
  loadScholarReach,
  REACH_REPORT_PATH,
  scholarConnectionsParams,
} from "@/lib/edit/downstream-reach-entry";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import {
  describeReachCriteria,
  loadReach,
  parseReachParams,
  REACH_TYPES,
  reachChips,
  reachLinks,
  reachQueryString,
  resolveReachParams,
  stageKeyOf,
  type ReachParams,
} from "@/lib/edit/downstream-reach-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { Prisma } from "@/lib/generated/prisma/client";

const parse = (qs = "") => parseReachParams(new URLSearchParams(qs));
const SUPER = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false };
const ADMIN = { cwid: "adm0001", isSuperuser: false, isCommsSteward: false };
const units = (departments: { code: string }[] = []) => ({
  departments,
  divisions: [],
  centers: [],
  cores: [],
  institutions: [],
  total: 0,
});
const N2_ADMIN = () => h.manageable.mockResolvedValue(units([{ code: "N2" }]));

// ---------------------------------------------------------------------------
// The in-memory dataset
// ---------------------------------------------------------------------------

type Scholar = { cwid: string; name: string; dept: string; active: boolean };
type Pos = "first" | "last" | "middle";
type Pub = {
  pmid: string;
  year: number;
  stage: string | null;
  confidence: string | null;
  authors: { cwid: string; position: Pos; confirmed?: boolean }[];
};

const S = "sss0001";
const SCHOLARS: Scholar[] = [
  { cwid: S, name: "Sam Example", dept: "N1", active: true },
  { cwid: "bbb0002", name: "Bea Sample", dept: "N2", active: true },
  // Cites Sam three times, but once wrote a paper with Sam.
  { cwid: "ccc0003", name: "Cal Placeholder", dept: "N2", active: true },
  // Two citing papers only.
  { cwid: "ddd0004", name: "Dee Instance", dept: "N1", active: true },
  // No longer active.
  { cwid: "eee0005", name: "Eli Former", dept: "N2", active: false },
  // Four citing papers: one at a different stage, the rest low-confidence, unstaged or the same stage (all count).
  { cwid: "ggg0007", name: "Gil Same", dept: "N2", active: true },
  // Sam cites them.
  { cwid: "hhh0008", name: "Hal Other", dept: "N2", active: true },
  { cwid: "iii0009", name: "Ivy Extra", dept: "N2", active: true },
  { cwid: "jjj0010", name: "Ada Tie", dept: "N1", active: true },
  // Their authorships are not confirmed.
  { cwid: "kkk0011", name: "Kim Unconfirmed", dept: "N2", active: true },
  // A middle author on one of three citing papers.
  { cwid: "mmm0012", name: "Mo Middle", dept: "N2", active: true },
];
const pub = (pmid: string, year: number, stage: string | null, confidence: string | null, ...authors: Pub["authors"]): Pub => ({
  pmid,
  year,
  stage,
  confidence,
  authors,
});
const a = (cwid: string, position: Pos, confirmed = true) => ({ cwid, position, confirmed });
const PUBS: Pub[] = [
  // Sam's.
  pub("1001", 2021, "T0", "high", a(S, "first")),
  pub("1002", 2022, "T0", "medium", a(S, "last")),
  pub("1003", 2023, "T1", "high", a(S, "first")),
  pub("1004", 2022, "T0", "high", a(S, "middle")),
  pub("1005", 2022, "T0", "low", a(S, "first")),
  pub("1006", 2022, null, null, a(S, "first")),
  pub("1007", 2021, "T2", "high", a(S, "first")),
  pub("1008", 2019, "T0", "high", a(S, "first")),
  // Sam citing Sam (the import leaves these out; the loader must too).
  pub("1009", 2024, "T2", "high", a(S, "first")),
  // Bea's.
  pub("2001", 2024, "T2", "high", a("bbb0002", "first")),
  pub("2002", 2023, "T2", "high", a("bbb0002", "last")),
  pub("2003", 2025, "T3-4", "high", a("bbb0002", "first")),
  pub("2004", 2024, "T2", "high", a("bbb0002", "first")),
  pub("2005", 2024, "T2", "high", a("bbb0002", "first")),
  pub("2006", 2024, "T2", "high", a("bbb0002", "first")),
  pub("2007", 2024, "T2", "high", a("bbb0002", "middle")),
  pub("2009", 2022, "T2", "high", a("bbb0002", "first")),
  // Cal's, and the one paper Cal and Sam share (middle authors both, no stage, long ago).
  pub("3001", 2023, "T2", "high", a("ccc0003", "first")),
  pub("3002", 2023, "T2", "high", a("ccc0003", "first")),
  pub("3003", 2023, "T2", "high", a("ccc0003", "first")),
  pub("3009", 2015, "NA", null, a("ccc0003", "middle"), a(S, "middle")),
  pub("4001", 2023, "T2", "high", a("ddd0004", "first")),
  pub("4002", 2023, "T2", "high", a("ddd0004", "first")),
  pub("5001", 2023, "T2", "high", a("eee0005", "first")),
  pub("5002", 2023, "T2", "high", a("eee0005", "first")),
  pub("5003", 2023, "T2", "high", a("eee0005", "first")),
  pub("6001", 2023, "T2", "low", a("ggg0007", "first")),
  pub("6002", 2023, null, null, a("ggg0007", "first")),
  pub("6003", 2023, "T2", "high", a("ggg0007", "first")),
  pub("6004", 2023, "T0", "high", a("ggg0007", "first")),
  pub("7001", 2023, "T2", "high", a("kkk0011", "first", false)),
  pub("7002", 2023, "T2", "high", a("kkk0011", "first", false)),
  pub("7003", 2023, "T2", "high", a("kkk0011", "first", false)),
  // Hal's: cited by Sam.
  pub("8001", 2018, "T2", "high", a("hhh0008", "first")),
  pub("8002", 2020, "T3-4", "high", a("hhh0008", "last")),
  pub("8003", 2021, "T2", "high", a("hhh0008", "first")),
  pub("8004", 2021, "T0", "high", a("hhh0008", "first")),
  pub("9001", 2022, "T1", "high", a("iii0009", "first")),
  pub("9002", 2023, "T1", "high", a("iii0009", "first")),
  pub("9003", 2024, "T1", "high", a("iii0009", "last")),
  pub("9004", 2024, "T1", "high", a("iii0009", "first")),
  pub("9101", 2021, "T3-4", "high", a("jjj0010", "last")),
  pub("9102", 2021, "T3-4", "high", a("jjj0010", "last")),
  pub("9103", 2021, "T3-4", "high", a("jjj0010", "last")),
  pub("9201", 2023, "T2", "high", a("mmm0012", "first")),
  pub("9202", 2023, "T2", "high", a("mmm0012", "last")),
  pub("9203", 2023, "T2", "high", a("mmm0012", "middle")),
];
/** [cited, citing]. */
const CITES: [string, string][] = [
  ["1001", "2001"], ["1002", "2001"], ["1003", "2002"], ["1001", "2003"],
  ["1004", "2004"], ["1005", "2005"], ["1007", "2006"], ["1001", "2007"],
  ["1001", "3001"], ["1001", "3002"], ["1001", "3003"],
  ["1001", "4001"], ["1001", "4002"],
  ["1001", "5001"], ["1001", "5002"], ["1001", "5003"],
  ["1001", "6001"], ["1001", "6002"], ["1001", "6003"], ["1001", "6004"],
  ["1001", "7001"], ["1001", "7002"], ["1001", "7003"],
  ["1001", "9001"], ["1002", "9002"], ["1001", "9003"], ["1002", "9004"], ["1001", "9004"],
  ["1003", "9101"], ["1003", "9102"], ["1003", "9103"],
  ["1001", "9201"], ["1001", "9202"], ["1001", "9203"],
  ["1001", "1009"],
  // Sam's papers citing others'.
  ["8001", "1001"], ["8002", "1001"], ["8003", "1003"], ["8001", "1002"], ["8004", "1008"],
  ["2009", "1001"], ["2009", "1002"], ["2009", "1003"],
];

const scholar = (cwid: string) => SCHOLARS.find((s) => s.cwid === cwid);
const paper = (pmid: string) => PUBS.find((p) => p.pmid === pmid)!;
const inUnits = (s: Scholar, values: readonly string[]) => values.some((v) => v === `dept:${s.dept}`);
const fs = (x: Pub["authors"][number]) => x.confirmed !== false && x.position !== "middle";
const active = (cwid: string | undefined) => !!cwid && scholar(cwid)?.active === true;

/** The params of the loader call being answered. */
let cur: ReachParams = parse();

/** `citedPaperSql` on X: years, stage filter, (no research area in the fixture). */
const paperOk = (x: Pub, p: ReachParams) =>
  (p.from === null || x.year >= p.from) &&
  (p.to === null || x.year <= p.to) &&
  (p.stages.length === 0 || p.stages.includes(stageKeyOf(x.stage, x.confidence)));
const whoOk = (cwid: string, p: ReachParams) => p.units.length === 0 || inUnits(scholar(cwid)!, p.units);

/** `connectionLinksSql`, less its `pa_o.cwid <> ?` (see the file comment). */
function linkRows(p: ReachParams, cwid: string, dir: "cited" | "cites") {
  const rows: Record<string, unknown>[] = [];
  if (!active(cwid)) return rows;
  for (const own of PUBS.filter((x) => x.authors.some((y) => y.cwid === cwid && fs(y)))) {
    const ends = CITES.filter(([cited, citing]) => (dir === "cited" ? cited : citing) === own.pmid).map(([cited, citing]) =>
      paper(dir === "cited" ? citing : cited),
    );
    for (const end of ends) {
      const [x, y] = dir === "cited" ? [own, end] : [end, own];
      if (!paperOk(x, p)) continue;
      if (dir === "cited" && !whoOk(cwid, p)) continue;
      for (const au of end.authors.filter((z) => fs(z) && active(z.cwid))) {
        if (dir === "cites" && !whoOk(au.cwid, p)) continue;
        rows.push({
          x_pmid: x.pmid, x_year: x.year, x_stage: x.stage, x_confidence: x.confidence,
          y_pmid: y.pmid, y_year: y.year, y_stage: y.stage, y_confidence: y.confidence,
          other: au.cwid,
        });
      }
    }
  }
  return rows;
}

/** report 27's `policyScopeSql` + `reachPubSql`, for the Publications view behind a stage-mix count. */
function inScope(p: ReachParams) {
  return PUBS.filter((x) => paperOk(x, p) && (!p.pmid || x.pmid === p.pmid)).filter((x) =>
    x.authors.some((y) => {
      const s = scholar(y.cwid);
      if (!s || !s.active || y.confirmed === false) return false;
      if (p.scope !== null && !inUnits(s, p.scope)) return false;
      if (p.units.length > 0 && !inUnits(s, p.units)) return false;
      if (p.people.length > 0 && !p.people.includes(y.cwid)) return false;
      return p.positions.length === 0 || p.positions.includes(y.position);
    }),
  );
}

function answer(text: string, values: unknown[]): unknown[] {
  const p = cur;
  if (text.includes("AS x_pmid")) {
    const dir = text.includes("JOIN publication_citation c ON c.cited_pmid = p.pmid") ? "cited" : "cites";
    return linkRows(p, values[0] as string, dir);
  }
  if (text.includes("GROUP BY pa_o.cwid")) {
    const [cwid, ...candidates] = values as string[];
    return candidates
      .filter((c) => PUBS.some((x) => [cwid, c].every((w) => x.authors.some((y) => y.cwid === w && y.confirmed !== false))))
      .map((c) => ({ cwid: c }));
  }
  if (text.includes("SELECT s.cwid, s.preferred_name FROM scholar s WHERE s.cwid = ")) {
    const s = scholar(values[0] as string);
    return s && s.active && (p.scope === null || inUnits(s, p.scope)) ? [{ cwid: s.cwid, preferred_name: s.name }] : [];
  }
  if (text.includes("s.primary_org_code FROM scholar s WHERE s.cwid IN")) {
    return SCHOLARS.filter((s) => values.includes(s.cwid)).map((s) => ({
      cwid: s.cwid, preferred_name: s.name, primary_department: `Department ${s.dept}`, role_category: null, primary_org_code: null,
    }));
  }
  if (text.includes("SELECT s.cwid, s.preferred_name FROM scholar s WHERE s.cwid IN")) {
    return SCHOLARS.filter((s) => values.includes(s.cwid) && (p.scope === null || inUnits(s, p.scope))).map((s) => ({ cwid: s.cwid, preferred_name: s.name }));
  }
  if (text.includes("AS confidence, COUNT(DISTINCT p.pmid) AS n")) {
    const cwids = SCHOLARS.map((s) => s.cwid).filter((c) => values.includes(c));
    const out = new Map<string, { cwid: string; stage: string | null; confidence: string | null; n: number }>();
    for (const c of cwids) {
      for (const x of inScope({ ...stageMixParams(p, c, "T0"), stages: [] })) {
        const k = `${c}|${x.stage}|${x.confidence}`;
        const r = out.get(k) ?? { cwid: c, stage: x.stage, confidence: x.confidence, n: 0 };
        out.set(k, r);
        r.n += 1;
      }
    }
    return [...out.values()];
  }
  if (text.includes("SELECT p.pmid, p.title, p.journal FROM publication p")) {
    return PUBS.filter((x) => values.includes(x.pmid)).map((x) => ({ pmid: x.pmid, title: `Paper ${x.pmid}`, journal: "Journal of Examples" }));
  }
  // Report 27's own queries, for the lists a stage-mix count opens. Nothing in
  // this fixture is cited by a clinical study, trial, guideline or patent.
  if (text.includes("COUNT(DISTINCT p.pmid) AS n")) return [{ n: inScope(p).length }];
  if (text.includes("ORDER BY year DESC, p.pmid DESC")) {
    const [limit, offset] = values.slice(-2).map(Number);
    return inScope(p)
      .sort((x, y) => y.year - x.year || y.pmid.localeCompare(x.pmid))
      .slice(offset, offset + limit)
      .map((x) => ({ pmid: x.pmid, year: x.year, stage: x.stage, confidence: x.confidence }));
  }
  if (text.includes("MAX(p.translational_stage) AS stage")) return [];
  if (text.includes("SELECT g.level, g.unit, g.papers, g.rep")) return [];
  if (text.includes("HAVING COUNT(*) >=")) return [];
  if (text.includes("SELECT p.pmid, p.title, p.journal, p.doi, s.cwid")) return [];
  throw new Error(`unmodelled query: ${text.slice(0, 200)}`);
}

const calls = () =>
  h.queryRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
  });
const flat = (sql: Prisma.Sql) => ({ text: sql.sql.replace(/\s+/g, " "), values: sql.values });
const touchesCitations = () => calls().filter((c) => c.text.includes("publication_citation"));

async function resolved(qs: string, session = SUPER): Promise<ReachParams> {
  cur = parse(qs);
  cur = await resolveReachParams(parse(qs), session);
  return cur;
}
async function connections(qs: string, session = SUPER): Promise<ReachConnections> {
  return loadReachConnections(await resolved(qs, session));
}
const ok = (c: ReachConnections) => {
  if (c.status !== "ok") throw new Error(`expected ok, got ${c.status}`);
  return c;
};
const rowsOf = (c: ReachConnections, dir: "cited" | "cites") => ok(c)[dir].map((r) => [r.name, r.papers]);
const BIG = 100_000;
/** Every link must come back unchanged through the parser (`page` rides only when asked for). */
const roundTrips = (qs: string) => expect(reachQueryString(parse(qs), { page: parse(qs).page }), qs).toBe(qs);

beforeEach(() => {
  cur = parse();
  h.queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    return answer(sql.sql.replace(/\s+/g, " "), sql.values);
  });
  h.manageable.mockReset().mockResolvedValue(units());
  h.session.mockReset().mockResolvedValue(SUPER);
  h.identity.mockReset().mockResolvedValue({ session: SUPER, realCwid: SUPER.cwid, impersonatedCwid: null });
  vi.stubEnv("DOWNSTREAM_REACH_REPORT", "on");
  vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("foldConnections: the pairing rule over link rows", () => {
  const link = (over: Partial<ConnectionLink>): ConnectionLink => ({
    x: "1", xYear: 2020, xStage: "T0", xConfidence: "high",
    y: "11", yYear: 2021, yStage: "T2", yConfidence: "high",
    other: "bbb0002",
    ...over,
  });

  it("counts distinct citing papers, and needs at least the minimum", () => {
    expect(MIN_CONNECTION_PAPERS).toBe(3);
    const two = [link({ y: "11" }), link({ y: "12" }), link({ y: "12", x: "2" })];
    expect(foldConnections(two, S)).toEqual([]);
    const three = [...two, link({ y: "13", yYear: 2024 })];
    const [g] = foldConnections(three, S);
    expect(g.cwid).toBe("bbb0002");
    expect(g.pairs.map((x) => x.citing.pmid)).toEqual(["13", "12", "11"]);
    // One row per citing paper, with every cited paper it cites beside it.
    expect(g.pairs.find((x) => x.citing.pmid === "12")!.cited.map((c) => c.pmid).sort()).toEqual(["1", "2"]);
  });

  it("keeps a paper pair whatever the two stages: unstaged, low-confidence and same-stage pairs count", () => {
    const rows = [
      link({ y: "11" }),
      link({ y: "12", yStage: "T0" }), // same stage
      link({ y: "13", yConfidence: "low" }), // citing stage not displayed
      link({ y: "14", xConfidence: "low" }), // cited stage not displayed
      link({ y: "15", yStage: null }),
      link({ y: "16", xStage: "NA" }),
      link({ y: "17", yStage: "T3-4", yConfidence: null }), // no confidence recorded: shown
      link({ y: "18", yStage: "T1" }),
      link({ y: "19", xStage: null, xConfidence: null, yStage: null, yConfidence: null }), // neither staged
    ];
    const [g] = foldConnections(rows, S);
    expect(g.pairs.map((x) => x.citing.pmid).sort()).toEqual(["11", "12", "13", "14", "15", "16", "17", "18", "19"]);
    // The stage rides along as context: the displayed stage, or null.
    const byY = new Map(g.pairs.map((x) => [x.citing.pmid, x]));
    expect(byY.get("12")!.citing.stage).toBe("T0");
    expect(byY.get("12")!.cited[0].stage).toBe("T0");
    expect(byY.get("13")!.citing.stage).toBeNull();
    expect(byY.get("16")!.cited[0].stage).toBeNull();
    expect(byY.get("17")!.citing.stage).toBe("T3-4");
    // Three same-stage, unstaged citing papers are a connection on their own.
    const unstaged = [link({ y: "21", yStage: null }), link({ y: "22", yStage: "T0" }), link({ y: "23", xStage: null, yStage: null })];
    expect(foldConnections(unstaged, S).map((x) => [x.cwid, x.pairs.length])).toEqual([["bbb0002", 3]]);
  });

  it("never pairs a scholar with themselves", () => {
    expect(foldConnections([link({ y: "11", other: S }), link({ y: "12", other: S }), link({ y: "13", other: S })], S)).toEqual([]);
  });

  it("drops whole scholars who share a publication", () => {
    const g = foldConnections([link({ y: "11" }), link({ y: "12" }), link({ y: "13" })], S);
    expect(dropCoauthors(g, new Set(["bbb0002"]))).toEqual([]);
    expect(dropCoauthors(g, new Set(["zzz0000"]))).toEqual(g);
  });
});

describe("loadReachConnections", () => {
  it("lists, in both directions, exactly the pairs the rule allows", async () => {
    const c = await connections(`view=connections&person=${S}&stage=any`);
    // Bea 5; Gil and Ivy 4 each, by name; Ada 3. Not Cal (co-author), Dee (2), Eli (inactive),
    // Kim (unconfirmed), Mo (one middle authorship), nor Sam's own paper 1009.
    expect(rowsOf(c, "cited")).toEqual([["Bea Sample", 5], ["Gil Same", 4], ["Ivy Extra", 4], ["Ada Tie", 3]]);
    // Sam's 1001, 1002 and 1003 cite Hal's, and 1008 (T0) cites Hal's 8004 (T0): the same stage counts.
    expect(rowsOf(c, "cites")).toEqual([["Hal Other", 4], ["Bea Sample", 3]]);
    expect(ok(c).scholar).toEqual({ cwid: S, name: "Sam Example" });
  });

  it("first or senior on both ends: a middle authorship on either paper is no pair", async () => {
    const c = ok(await connections(`view=connections&person=${S}&stage=any`));
    const bea = c.cited.find((r) => r.cwid === "bbb0002")!;
    // 2004 cites Sam's 1004 (Sam a middle author); 2007 has Bea as a middle author.
    expect(bea.pairs.map((x) => x.citing.pmid)).toEqual(["2003", "2006", "2005", "2001", "2002"]);
    expect(bea.pairs.flatMap((x) => x.cited.map((y) => y.pmid))).not.toContain("1004");
    expect(c.cited.find((r) => r.cwid === "mmm0012")).toBeUndefined();
  });

  it("low-confidence, unstaged and same-stage papers are pairs, on either end", async () => {
    const c = ok(await connections(`view=connections&person=${S}&stage=any`));
    const pairsOf = (cwid: string) => c.cited.find((r) => r.cwid === cwid)!.pairs;
    // Bea's 2005 cites Sam's low-confidence 1005; Bea's T2 2006 cites Sam's T2 1007.
    const bea = new Map(pairsOf("bbb0002").map((x) => [x.citing.pmid, x]));
    expect(bea.get("2005")!.cited).toEqual([{ pmid: "1005", year: 2022, stage: null }]);
    expect(bea.get("2006")!.cited).toEqual([{ pmid: "1007", year: 2021, stage: "T2" }]);
    expect(bea.get("2006")!.citing.stage).toBe("T2");
    // Gil: low-confidence 6001, unstaged 6002, T2 6003 and T0 6004 (Sam's 1001 is T0) all count.
    expect(pairsOf("ggg0007").map((x) => [x.citing.pmid, x.citing.stage])).toEqual([
      ["6004", "T0"], ["6003", "T2"], ["6002", null], ["6001", null],
    ]);
    // Without the unstaged and same-stage pairs Gil would have one citing paper: the rule no longer asks for it.
    expect(pairsOf("ggg0007").filter((x) => x.citing.stage && x.citing.stage !== "T0")).toHaveLength(1);
  });

  it("the report's years and stage apply to the cited paper; its unit to the cited scholar", async () => {
    // T0 only, on the cited paper X: Ada's (Sam's T1 1003) goes, and of Bea's, 2002 (cites 1003),
    // 2005 (cites the low-confidence 1005) and 2006 (cites the T2 1007). The citing papers' stages do not matter.
    expect(rowsOf(await connections(`view=connections&person=${S}&stage=T0`), "cited")).toEqual([["Gil Same", 4], ["Ivy Extra", 4]]);
    // From 2022, on X: Sam's 1001 and 1007 (2021) go. The citing papers' years do not matter.
    expect(rowsOf(await connections(`view=connections&person=${S}&stage=any&from=2022`), "cited")).toEqual([["Ada Tie", 3], ["Bea Sample", 3]]);
    // The default stage filter (T0 and T1) still narrows X: in "Sam cites" only Hal's T0 8004 is left, one citing paper.
    expect(rowsOf(await connections(`view=connections&person=${S}`), "cites")).toEqual([]);
    // A unit: Sam is in N1, the colleagues Sam cites in N2.
    const n2 = await connections(`view=connections&person=${S}&stage=any&unit=dept:N2`);
    expect(rowsOf(n2, "cited")).toEqual([]);
    expect(rowsOf(n2, "cites")).toEqual([["Hal Other", 4], ["Bea Sample", 3]]);
    const n1 = await connections(`view=connections&person=${S}&stage=any&unit=dept:N1`);
    expect(rowsOf(n1, "cited")).toHaveLength(4);
    expect(rowsOf(n1, "cites")).toEqual([]);
  });

  it("does not depend on the citing-type filter or the own-work toggle", async () => {
    const base = await connections(`view=connections&person=${S}&stage=any`);
    expect(await connections(`view=connections&person=${S}&stage=any&ctype=patent&own=in`)).toEqual(base);
  });

  it("needs exactly one scholar, and reads nothing without one", async () => {
    expect(await connections("view=connections&stage=any")).toEqual({ status: "pick" });
    expect(await connections(`view=connections&person=${S}&person=bbb0002`)).toEqual({ status: "pick" });
    expect(calls()).toEqual([]);
  });

  it("is unavailable for an inactive scholar, and reads no link", async () => {
    expect(await connections("view=connections&person=eee0005")).toEqual({ status: "unavailable", cwid: "eee0005" });
    expect(touchesCitations()).toEqual([]);
  });
});

describe("the SQL", () => {
  const p = { ...parse(`view=connections&person=${S}&stage=any`), scope: null };
  it("every link query is driven from the scholar's first- or senior-author papers, with a pmid predicate on the link table", () => {
    for (const dir of ["cited", "cites"] as const) {
      const { text, values } = flat(connectionLinksSql(p, S, dir));
      expect(text.startsWith("SELECT STRAIGHT_JOIN")).toBe(true);
      expect(text).toMatch(/FROM publication_author pa_s JOIN scholar s ON s\.cwid = pa_s\.cwid JOIN publication (p|y) ON \1\.pmid = pa_s\.pmid/);
      expect(text).toContain(dir === "cited" ? "JOIN publication_citation c ON c.cited_pmid = p.pmid" : "JOIN publication_citation c ON c.citing_pmid = y.pmid");
      expect(text).toContain("pa_s.cwid = ? AND pa_s.is_confirmed = 1 AND (pa_s.is_first = 1 OR pa_s.is_last = 1)");
      expect(text).toContain("pa_o.is_confirmed = 1 AND (pa_o.is_first = 1 OR pa_o.is_last = 1) AND pa_o.cwid <> ?");
      // No stage condition of its own (decision 7): with every stage, none at all; Y never has one.
      expect(text).not.toMatch(/translational_stage (<>|IN|=)|translational_stage_confidence (<>|IS)/);
      expect(text).not.toMatch(/y\.translational_stage\w*\s+(?!AS\b)/);
      // The report's stage filter (here the default, T0 and T1) is on the cited paper X only.
      const dflt = flat(connectionLinksSql({ ...parse(`view=connections&person=${S}`), scope: null }, S, dir));
      expect(dflt.text).toContain("p.translational_stage IN (?,?)");
      expect(dflt.text).not.toMatch(/y\.translational_stage\w*\s+(?!AS\b)/);
      expect(dflt.values).toEqual(expect.arrayContaining(["T0", "T1"]));
      expect(text).toContain("s.deleted_at IS NULL AND s.status = 'active'");
      expect(text).toContain("o.deleted_at IS NULL AND o.status = 'active'");
      expect(text).not.toMatch(/EXISTS|IN \(SELECT/);
      expect(values[0]).toBe(S);
    }
  });

  it("the co-author test is one query, from the scholar's authorships, cut to the candidates", () => {
    const { text, values } = flat(coauthorsSql(S, ["bbb0002", "ccc0003"]));
    expect(text).toContain("SELECT STRAIGHT_JOIN pa_o.cwid AS cwid FROM publication_author pa_s JOIN publication_author pa_o ON pa_o.pmid = pa_s.pmid");
    expect(text).not.toMatch(/EXISTS|IN \(SELECT/);
    expect(values).toEqual([S, "bbb0002", "ccc0003"]);
  });

  it("one page runs each query once: two link queries, one co-author test, however many links", async () => {
    await loadConnectionsPage(await resolved(`view=connections&person=${S}&stage=any`), 0, BIG);
    const texts = calls().map((c) => c.text);
    expect(texts.filter((t) => t.includes("publication_citation"))).toHaveLength(2);
    expect(texts.filter((t) => t.includes("GROUP BY pa_o.cwid"))).toHaveLength(1);
    for (const t of touchesCitations()) expect(t.text).toMatch(/c\.(cited|citing)_pmid = (p|y)\.pmid/);
  });
});

describe("every number opens its list", () => {
  const QS = [
    `view=connections&person=${S}&stage=any`,
    `view=connections&person=${S}`,
    `view=connections&person=${S}&stage=T0`,
    `view=connections&person=${S}&stage=any&unit=dept:N2`,
    `view=connections&person=${S}&stage=any&from=2022`,
    "view=connections&person=bbb0002&stage=any",
  ];

  it("a row's count is the length of the pairs list its link opens, which pages to the end", async () => {
    let seen = 0;
    for (const qs of QS) {
      const p = await resolved(qs);
      const c = ok(await loadReachConnections(p));
      for (const dir of ["cited", "cites"] as const) {
        for (const r of c[dir]) {
          const link = connectionLinks(p).pairs(r.cwid, dir);
          roundTrips(link);
          expect(parse(link)).toMatchObject({ view: "connections", people: p.people, with: r.cwid, dir });
          const page = await loadConnectionsPage(await resolved(link), 0, BIG);
          if (page.status !== "pairs") throw new Error(page.status);
          expect(page.total, `${qs} ${dir} ${r.cwid}`).toBe(r.papers);
          expect(page.pairs).toHaveLength(r.papers);
          // Two at a time: the pages together are the list.
          const pages = [];
          for (let off = 0; off < r.papers; off += 2) {
            const pg = await loadConnectionsPage(await resolved(link), off, 2);
            if (pg.status !== "pairs") throw new Error(pg.status);
            pages.push(...pg.pairs);
          }
          expect(pages).toEqual(page.pairs);
          seen += 1;
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("each stage-mix count is the length of report 27's Publications view its link opens", async () => {
    let seen = 0;
    for (const [qs, session] of [
      [`view=connections&person=${S}&stage=any`, SUPER],
      [`view=connections&person=${S}`, SUPER],
      ["view=connections&person=bbb0002&stage=any", ADMIN],
    ] as const) {
      if (session === ADMIN) N2_ADMIN();
      const p = await resolved(qs, session);
      const c = ok(await loadReachConnections(p));
      const cwids = [...new Set([...c.cited, ...c.cites].map((r) => r.cwid))];
      const mix = await loadConnectionStageMix(p, cwids);
      for (const cwid of cwids) {
        for (const [stage, n] of Object.entries(mix.get(cwid) ?? {})) {
          const link = connectionLinks(p).stageMix(cwid, stage as "T0");
          roundTrips(link);
          const lp = await resolved(link, session);
          expect(lp).toMatchObject({ view: "publications", people: [cwid], positions: ["first", "last"], stages: [stage], showAll: true });
          const data = await loadReach(lp, { views: ["publications"], limit: BIG });
          expect(data.pubs, `${qs} ${cwid} ${stage}`).toHaveLength(n);
          expect(data.pubMatched).toBe(n);
          seen += 1;
        }
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it("a unit administrator sees a colleague outside their units, with no stage mix (that list would be empty for them)", async () => {
    N2_ADMIN();
    const p = await resolved("view=connections&person=bbb0002&stage=any", ADMIN);
    const c = ok(await loadReachConnections(p));
    // Bea (N2) cites Sam (N1): listed for an N2 administrator too (decision 8).
    expect(rowsOf(c, "cites")).toEqual([["Sam Example", 5]]);
    // Sam has no papers in that administrator's Publications view, so no stage-mix count is shown for Sam.
    expect((await loadConnectionStageMix(p, [S])).get(S)).toBeUndefined();
  });

  it("the Bibliometrics line's number is the length of the list its link opens", async () => {
    for (const cwid of [S, "bbb0002", "hhh0008"]) {
      const want = scholarConnectionsParams(cwid)!;
      cur = await resolveReachParams(want, SUPER);
      const line = await loadScholarConnections(cwid, SUPER);
      expect(line).not.toBeNull();
      expect(line!.href.startsWith(`${REACH_REPORT_PATH}?`)).toBe(true);
      const qs = line!.href.slice(REACH_REPORT_PATH.length + 1);
      roundTrips(qs);
      expect(parse(qs)).toMatchObject({ view: "connections", people: [cwid], stages: [], from: null, to: null, with: null });
      expect(line!.colleagues, cwid).toBe(ok(await connections(qs)).cited.length);
    }
    cur = await resolveReachParams(scholarConnectionsParams(S)!, SUPER);
    // Every stage and all years: Bea, Gil, Ivy and Ada.
    expect((await loadScholarConnections(S, SUPER))!.colleagues).toBe(4);
  });

  it("the view's other links round-trip, and a tab or another view drops the pairs list", async () => {
    const p = await resolved(`view=connections&person=${S}&stage=any&with=bbb0002&dir=cites&page=2`);
    expect(p).toMatchObject({ with: "bbb0002", dir: "cites", page: 2 });
    roundTrips(reachQueryString(p, { page: 2 }));
    roundTrips(connectionLinks(p).lists());
    expect(parse(connectionLinks(p).lists()).with).toBeNull();
    expect(parse(reachLinks(p).view("connections")).with).toBeNull();
    expect(reachLinks(p).view("people")).not.toContain("with=");
    expect(reachQueryString({ ...p, view: "publications" })).not.toMatch(/with=|dir=/);
    // A stray value is dropped.
    expect(parse("view=connections&with=not%20a%20cwid&dir=sideways")).toMatchObject({ with: null, dir: "cited" });
  });

  it("the Connections tab widens the default T0 and T1 to every stage, and keeps a stage pick of the user's own", async () => {
    const fromDefault = parse(reachLinks(parse(`person=${S}`)).view("connections"));
    expect(fromDefault).toMatchObject({ view: "connections", stages: [] });
    const picked = parse(reachLinks(parse(`person=${S}&stage=T2`)).view("connections"));
    expect(picked.stages).toEqual(["T2"]);
    // Other tabs keep the default.
    expect(parse(reachLinks(parse(`person=${S}`)).view("people")).stages).toEqual(["T0", "T1"]);
  });
});

describe("filters the view does not apply", () => {
  it("pos, pmid and doc are dropped on the Connections view, so no chip or Criteria row names them", async () => {
    const qs = `person=${S}&stage=any&pmid=1001&doc=5&pos=middle`;
    const pubs = parse(qs);
    expect(pubs).toMatchObject({ pmid: "1001", docs: [5], positions: ["middle"] });
    const tab = reachLinks(pubs).view("connections");
    const p = parse(tab);
    expect(p).toMatchObject({ view: "connections", people: [S], pmid: null, docs: [], positions: [] });
    expect(reachQueryString(p)).not.toMatch(/pmid=|doc=|pos=/);
    const chips = reachChips(p).map((c) => c.group);
    expect(chips).not.toContain("Paper");
    expect(chips).not.toContain("Cited by");
    const criteria = new Map(describeReachCriteria(p, new Date(0)));
    expect(criteria.get("Paper (PMID)")).toBe("All");
    // The lists are the same as without them.
    expect(await connections(tab)).toEqual(await connections(`view=connections&person=${S}&stage=any`));
    // Another view keeps them.
    expect(parse(`${qs}&view=people`)).toMatchObject({ pmid: "1001", docs: [5], positions: ["middle"] });
  });
});

describe("flag and access", () => {
  it("with the flag off: no Bibliometrics line, no page, no download, and nothing read", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    expect(await loadScholarConnections(S, SUPER)).toBeNull();
    await expect(
      renderDownstreamReachReport({ session: SUPER, searchParams: { view: "connections", person: S }, basePath: "/x" } as unknown as AdminReportProps),
    ).rejects.toThrow();
    expect((await downloadGET(new Request(`https://example.org/api?view=connections&person=${S}`))).status).toBe(404);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("a viewer who cannot open report 27 gets no Bibliometrics line", async () => {
    expect(await loadScholarConnections(S, ADMIN)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("a unit administrator: only for a scholar inside their units, with colleagues from anywhere", async () => {
    N2_ADMIN();
    expect(await connections(`view=connections&person=${S}&stage=any`, ADMIN)).toEqual({ status: "unavailable", cwid: S });
    expect(touchesCitations()).toEqual([]);
    cur = await resolveReachParams(scholarConnectionsParams(S)!, ADMIN);
    expect(await loadScholarConnections(S, ADMIN)).toBeNull();
    // Bea is in N2; Sam, in N1, cites Bea and is cited by Bea: listed for this viewer as for a superuser (decision 8).
    const c = ok(await connections("view=connections&person=bbb0002&stage=any", ADMIN));
    expect(c.cited.map((r) => r.cwid)).toContain(S);
    expect(c.cites.map((r) => r.cwid)).toContain(S);
    expect(scholar(S)!.dept).toBe("N1");
    const sup = ok(await connections("view=connections&person=bbb0002&stage=any"));
    expect({ cited: c.cited, cites: c.cites }).toEqual({ cited: sup.cited, cites: sup.cites });
    // The SQL puts no unit on the other end, in either direction.
    const scoped = await resolved("view=connections&person=bbb0002&stage=any", ADMIN);
    expect(scoped.scope).toEqual(["dept:N2"]);
    for (const dir of ["cited", "cites"] as const) {
      const { text, values } = flat(connectionLinksSql(scoped, "bbb0002", dir));
      expect(text).not.toMatch(/o\.dept_code|ocm\./);
      expect(text).not.toContain("1 = 0");
      expect(values).not.toContain("N2");
    }
    // The scope is in the gate, never in the link.
    expect(connectionLinks(await resolved("view=connections&person=bbb0002", ADMIN)).pairs(S, "cites")).not.toContain("N2");
  });
});

describe("the page", () => {
  async function page(query: Record<string, string | string[]>, session = SUPER) {
    cur = await resolveReachParams(parseReachParams(new URLSearchParams(query as Record<string, string>)), session);
    const out = await renderDownstreamReachReport({ n: "27", session, searchParams: query, basePath: "/edit/reports/27" } as unknown as AdminReportProps);
    return render(createElement(Fragment, null, createElement("div", { "data-testid": "aside" }, out.aside), out.main));
  }

  it("without one scholar: a prompt to pick one, and no count", async () => {
    const view = await page({ view: "connections" });
    const pick = view.getByTestId("downstream-reach-connections-pick");
    expect(pick.textContent).toContain("Pick one scholar");
    expect(pick.textContent).not.toMatch(/\d/);
    expect(view.getByTestId("downstream-reach-view-connections").textContent).toBe("Connections");
    expect(touchesCitations()).toEqual([]);
  });

  it("with one scholar: the two lists, names through the hover card, CWIDs in monospace, every count a link", async () => {
    const view = await page({ view: "connections", person: S, stage: "any" });
    const cited = within(view.getByTestId("downstream-reach-connections-section-cited"));
    expect(cited.getByRole("heading").textContent).toBe("Cite Sam Example's work");
    expect(cited.getAllByTestId("hover-card").map((e) => e.textContent)).toEqual(["Bea Sample", "Gil Same", "Ivy Extra", "Ada Tie"]);
    expect(cited.getByText("iii0009").className).toContain("font-mono");
    const counts = cited.getAllByTestId("downstream-reach-connections-count");
    expect(counts.map((e) => e.textContent)).toEqual(["5", "4", "4", "3"]);
    expect(counts[0].getAttribute("aria-label")).toBe("5 of Bea Sample's papers cite Sam Example's work: the pairs of papers");
    for (const e of counts) roundTrips(e.getAttribute("href")!.split("?")[1]);
    const cites = within(view.getByTestId("downstream-reach-connections-section-cites"));
    expect(cites.getByRole("heading").textContent).toBe("Sam Example cites");
    expect(cites.getAllByTestId("downstream-reach-connections-count")[0].parentElement!.textContent).toBe("4 of Sam Example's papers cite their work");
    // Ivy's stage mix: four first-author T1 papers, a link into the Publications view.
    const mix = view.getByTestId("downstream-reach-connections-mix-iii0009-T1");
    expect(mix.textContent).toBe("T1: 4");
    expect(parse(mix.getAttribute("href")!.split("?")[1])).toMatchObject({ view: "publications", people: ["iii0009"], stages: ["T1"], showAll: true });
    const note = view.getByTestId("downstream-reach-connections-note").textContent!;
    expect(note).toContain("citing-type filter and the own-work setting do not apply");
    expect(note).toContain("apply to the cited paper only");
    expect(note).toContain("the default stage filter, T0 and T1, limits the cited papers");
    expect(note).toContain("may be in any unit");
    expect(note).not.toMatch(/stages? (must )?differ|different (translational )?stage|other stages|another stage/);
    expect(view.getByTestId("aside").textContent).toContain("Connections and Criteria sheets");
  });

  it("the pairs list: one row per citing paper, newest first, each paper with its stage or none", async () => {
    const view = await page({ view: "connections", person: S, stage: "any", with: "bbb0002" });
    expect(view.getByTestId("downstream-reach-connections-pairs-heading").textContent).toBe("Papers by Bea Sample that cite Sam Example's work");
    const rows = view.getAllByTestId("downstream-reach-connections-pair");
    expect(rows.map((r) => within(r).getAllByTestId("downstream-reach-title")[0].textContent)).toEqual([
      "Paper 2003", "Paper 2006", "Paper 2005", "Paper 2001", "Paper 2002",
    ]);
    // 2001 cites two of Sam's papers.
    expect(within(rows[3]).getAllByTestId("downstream-reach-title").map((e) => e.textContent)).toEqual(["Paper 2001", "Paper 1002", "Paper 1001"]);
    expect(within(rows[3]).getAllByTestId("pub-row-stage")).toHaveLength(3);
    // 2005 cites Sam's low-confidence 1005: that paper shows no stage badge.
    expect(within(rows[2]).getAllByTestId("pub-row-stage")).toHaveLength(1);
    expect(rows[2].textContent).toContain(NO_STAGE_LABEL);
    expect(view.getByTestId("downstream-reach-connections-pager").textContent).toContain("1–5 of 5");
  });

  it("the pairs list for someone who is not a connection says so", async () => {
    const view = await page({ view: "connections", person: S, stage: "any", with: "ccc0003" });
    expect(view.getByTestId("downstream-reach-connections-not-connection")).toBeTruthy();
    expect(view.queryByTestId("downstream-reach-connections-pairs")).toBeNull();
  });

  it("the other views run no Connections query", async () => {
    for (const v of ["publications", "documents", "people"]) {
      h.queryRaw.mockClear();
      const view = await page({ view: v, person: S });
      expect(view.getByTestId("downstream-reach-view-connections").textContent).toBe("Connections");
      expect(view.queryByTestId(/downstream-reach-connections-/)).toBeNull();
      expect(touchesCitations(), v).toEqual([]);
      expect(view.getByTestId("aside").textContent).toContain("People and Criteria sheets");
      cleanup();
    }
  });
});

describe("the download", () => {
  async function workbook(qs: string) {
    cur = await resolveReachParams({ ...parse(qs), showAll: false }, SUPER);
    const res = await downloadGET(new Request(`https://example.org/api/edit/reports/downstream-reach?${qs}`));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    return wb;
  }
  const rowsOfSheet = (ws: ExcelJS.Worksheet) =>
    ws.getSheetValues().slice(2).map((r) => (r as unknown[]).slice(1));

  it("from the Connections view with a scholar: both lists, one row per pair, no contact fields, and the Criteria rows", async () => {
    const wb = await workbook(`view=connections&person=${S}&stage=any`);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "Citing documents", "People", "Connections", "Criteria"]);
    const ws = wb.getWorksheet("Connections")!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([
      "List", "Name", "CWID", "Org unit", "Person type", "Primary institution", "Citing papers", "Cited papers", "Citing PMIDs", "Cited PMIDs",
    ]);
    const rows = rowsOfSheet(ws);
    expect(rows.map((r) => [r[0], r[1], r[6]])).toEqual([
      ["Cite Sam Example's work", "Bea Sample", 5],
      ["Cite Sam Example's work", "Gil Same", 4],
      ["Cite Sam Example's work", "Ivy Extra", 4],
      ["Cite Sam Example's work", "Ada Tie", 3],
      ["Sam Example cites", "Hal Other", 4],
      ["Sam Example cites", "Bea Sample", 3],
    ]);
    // The count is the number of citing PMIDs listed beside it.
    for (const r of rows) expect(String(r[8]).split("; ")).toHaveLength(r[6] as number);
    expect(JSON.stringify(rows)).not.toMatch(/@|mail|phone/i);
    const criteria = new Map(rowsOfSheet(wb.getWorksheet("Criteria")!).map((r) => [r[0], r[1]]));
    expect(criteria.get("Connections scholar")).toBe(`Sam Example (${S})`);
    expect(String(criteria.get("Connections rule"))).toContain("at least 3 citing papers");
    for (const k of ["Connections rule", "Connections filters", "Connections sheet"]) {
      expect(String(criteria.get(k)), k).not.toMatch(/stages? (must )?differ|different (translational )?stage|other stages|another stage/);
    }
    expect(String(criteria.get("Connections sheet"))).toContain("exempt from the 50-person limit");
  });

  it("above the 50-scholar cap the Connections sheet still lists every colleague (decision 9), with no contact fields", async () => {
    const row = (i: number) => ({
      cwid: `zzz${String(i).padStart(4, "0")}`, name: `Person ${i}`, orgUnit: null, personType: "", institution: "",
      papers: 3, pairs: [],
    });
    const n = SCHOLAR_EXPORT_CAP + 25;
    const c: Extract<ReachConnections, { status: "ok" }> = {
      status: "ok", scholar: { cwid: S, name: "Sam Example" },
      cited: Array.from({ length: n }, (_, i) => row(i)), cites: Array.from({ length: n }, (_, i) => row(i + n)),
    };
    const wb = new ExcelJS.Workbook();
    const sheet = connectionsSheet(c);
    sheet.addSheet(wb);
    const ws = wb.getWorksheet("Connections")!;
    const rows = rowsOfSheet(ws);
    expect(rows).toHaveLength(2 * n);
    expect(new Set(rows.map((r) => r[2])).size).toBe(2 * n);
    expect((ws.getRow(1).values as unknown[]).join(" ")).not.toMatch(/mail|phone|address/i);
    const note = new Map(sheet.criteria).get("Connections sheet")!;
    expect(note).toBe(
      `Lists all ${n} colleagues who cite Sam Example's work and all ${n} whose work Sam Example cites, one row per pair, with no contact details. Citing papers is the count shown on the page. Like the People sheet, this sheet is exempt from the 50-person limit on scholar exports (decided 2026-11-28).`,
    );
    expect(note).not.toMatch(/Not listed|applies to this sheet/);
  });

  it("from any other view, or without a scholar: no Connections sheet, and no Connections query", async () => {
    for (const qs of [`person=${S}&stage=any`, "view=connections&stage=any", `view=people&person=${S}`]) {
      h.queryRaw.mockClear();
      const wb = await workbook(qs);
      expect(wb.worksheets.map((w) => w.name), qs).toEqual(["Publications", "Citing documents", "People", "Criteria"]);
      expect(touchesCitations()).toEqual([]);
    }
  });
});

describe("the Bibliometrics tab's request", () => {
  const get = async (qs: string) => (await bibliometricsGET(new NextRequest(`https://example.org/api/edit/bibliometrics?${qs}`))).json();
  // The model answers under the Connections line's params (the block's own queries answer the same either way).
  beforeEach(async () => {
    cur = await resolveReachParams(scholarConnectionsParams(S)!, SUPER);
  });

  it("part=reach carries the Connections line beside the block's own lines", async () => {
    const body = await get(`cwid=${S}&part=reach`);
    expect(body.reach.lines.map((l: { type: string }) => l.type)).toEqual([...REACH_TYPES]);
    expect(body.reach.connections.colleagues).toBe(4);
    expect(body.reach.connections.href).toBe(`${REACH_REPORT_PATH}?person=${S}&stage=any&basis=cy&view=connections`);
  });

  it("the block's own lines are unchanged by it, and the line is absent where the view would not open", async () => {
    const withLine = (await get(`cwid=${S}&part=reach`)).reach;
    expect({ ...withLine, connections: undefined }).toEqual({ ...(await loadScholarReach(S, SUPER)), connections: undefined });
    // An inactive scholar: the block, no line.
    const inactive = (await get("cwid=eee0005&part=reach")).reach;
    expect(inactive.lines.map((l: { type: string }) => l.type)).toEqual([...REACH_TYPES]);
    expect(inactive).not.toHaveProperty("connections");
  });

  it("the report request itself runs no Connections query", async () => {
    await get(`cwid=${S}`).catch(() => null);
    expect(touchesCitations()).toEqual([]);
  });
});
