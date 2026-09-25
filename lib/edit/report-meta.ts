/**
 * Editable report metadata for the `/edit/reports` console (`report_meta`) —
 * the NAME, one-line SUMMARY, optional rich-text DESCRIPTION and URL SLUG of
 * each numbered report (`/edit/reports/{1..7}`), moved out of the hardcoded
 * `ALL_REPORTS` / `PROGRAM_UNIT` literals in `app/edit/reports/page.tsx` and
 * the per-page `<h1>` / `metadata.title` strings so a superuser can edit them
 * in place ("Edit details", `components/edit/report-details-sheet.tsx` →
 * `app/api/edit/report-meta/[n]`).
 *
 * `REPORT_META_DEFAULTS` is the FALLBACK for a report with no row — the
 * migration (`prisma/migrations/20260920120000_report_meta`) is DDL only,
 * since migrations never INSERT (#584, `migrations-empty-db-safe.test.ts`),
 * and `npm run seed` is the synthetic-fixture wiper, not a config channel. So
 * the table starts EMPTY everywhere and every page renders from these until a
 * superuser saves; `loadReportMeta` fills every `ReportKey` either way. A row,
 * once present, wins ENTIRELY (its `descriptionHtml` included, so a superuser
 * can clear report 7's default description to none — a `?? default` there
 * would make NULL unreachable). Only report 7 has a default description: the
 * former hardcoded "Sources" disclosure of the report 7 page (now `components/edit/reports/mentored-publications-body.tsx`), as
 * bullets.
 *
 * `loadReportMeta` is wrapped in React's `cache()` so a report page's
 * `generateMetadata` and its `ReportHeader` share ONE `findMany` per request
 * (the `loadConsoleTabs` precedent, `lib/edit/console-tabs.server.ts`).
 *
 * The description is sanitized on WRITE by the route (`sanitizeOverview`) and
 * the sanitizer's output is what is stored; the render path re-runs
 * `sanitizeOverviewHtml` on read as defense in depth (the overview precedent,
 * `lib/api/manual-layer.ts` `getEffectiveOverview`).
 *
 * The slug is the report's future address (`/edit/reports/<slug>`, the
 * registry plan of 2026-09-20); the NUMBER stays the stable key, so a slug is
 * a renameable field, not an identity. Unique in the table; stored but not
 * yet routed on — nothing reads it until the dynamic page lands.
 *
 * Server-only (reads `@/lib/db`); imported by server pages, `ReportHeader`
 * and the route handler, never by a `"use client"` component — the editor
 * island takes the meta as props.
 */
import { cache } from "react";

import { db } from "@/lib/db";

// Re-exported for server callers (the route); the client editor imports the
// db-free module directly — this one drags `@/lib/db` into any bundle.
export { isValidReportSlug, REPORT_SLUG_MAX } from "@/lib/edit/report-slug";

/** The seven numbered reports, as the `report_key` column spells them. */
export const REPORT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** Whether `v` is one of {@link REPORT_KEYS} — a string, never the number. */
export function isReportKey(v: unknown): v is ReportKey {
  return typeof v === "string" && (REPORT_KEYS as readonly string[]).includes(v);
}

/** Cap on `name` (the `report_meta.name` column width). */
export const REPORT_NAME_MAX = 120;
/** Cap on `summary` (the `report_meta.summary` column width). The description
 *  cap is `OVERVIEW_MAX_LENGTH` (`lib/edit/validators.ts`), shared with the
 *  sanitizer. */
export const REPORT_SUMMARY_MAX = 500;

/** Report 7's default description — what the page's hardcoded "Sources"
 *  disclosure used to say (one entry per mentorship type in filter order, then
 *  the source not yet loaded), on the `overview` tag allowlist. Re-sanitized on
 *  read like a stored row (`ReportHeader`). */
const MENTORED_PUBS_DESCRIPTION_HTML = [
  '<p>Pairs come from these sources. Each is a checkbox under "Type of mentorship".</p>',
  "<ul>",
  "<li><strong>MD</strong> — MD students' pairs, recorded by the Areas of Concentration (AOC) program — the MD scholarly-concentration program — in its pairing sheet. Carries the graduation year and, for recent classes, the entry year.</li>",
  "<li><strong>MD-PhD (program office)</strong> — Pairs from the MD-PhD program office's list, loaded with the AOC sheet. No entry or graduation years yet.</li>",
  "<li><strong>ECR</strong> — Early Career Research pairs from the same sheet (classes 2018–2023). Carries the graduation year.</li>",
  "<li><strong>PhD / MD-PhD thesis advisor</strong> — Thesis-advisor pairs from the Graduate School's Jenzabar records (MAJSP). Conferral year known; start year not.</li>",
  "<li><strong>Postdoc supervisor</strong> — The postdoc's reporting manager from the ED appointment record, with appointment start and end dates. For roughly one in seven, the manager on record is a lab administrator rather than the PI.</li>",
  "<li><strong>Likely mentee (from co-authorship)</strong> — Not on any roster: a trainee-type co-author who publishes repeatedly with this faculty member. Inferred, unconfirmed.</li>",
  "<li><strong>Possible mentee (from co-authorship)</strong> — The same inference for research staff or MD alumni, who may be peers rather than trainees. Off by default.</li>",
  "<li><strong>Faculty-asserted</strong> — Added by the mentor on their Scholars profile, or confirmed there from a co-authorship suggestion.</li>",
  "</ul>",
  "<p>Not yet a source: the Faculty Review Tool's self-reported mentees — the mentoring extract from that system has not been provided.</p>",
].join("\n");

/** The hardcoded defaults — the strings `app/edit/reports/page.tsx` and the
 *  seven pages used to carry inline, minus the "N. " prefix (`reportLabel`
 *  re-adds it). The fallback for a report with no `report_meta` row; a row
 *  wins over these entirely. */
export const REPORT_META_DEFAULTS: Record<
  ReportKey,
  { slug: string; name: string; summary: string; descriptionHtml: string | null }
> = {
  "1": {
    slug: "optimize-membership",
    name: "Optimize membership",
    summary:
      "REMOVE / ADD membership recommendations from PubMed co-authorship and MeSH cancer-relevance signals.",
    descriptionHtml: null,
  },
  "2": {
    slug: "nci-table-2a",
    name: "NCI Table 2a",
    summary:
      "NCI CCSG Data Table 2A funding review — confirm or correct the AI-suggested Cancer-Relevant Percent; Program comes from center membership.",
    descriptionHtml: null,
  },
  "3": {
    slug: "publications",
    // Kind-neutral wording: for a core this report's set is confirmed core
    // usages, not member publications. One shared catalog serves all four
    // kinds, so the blurb must be true of each.
    name: "Publications",
    summary:
      "This unit's publications, joined to Journal Impact Factor and paper-level impact-score data.",
    descriptionHtml: null,
  },
  "4": {
    slug: "grants",
    name: "Grants",
    summary: "Active grants for the center's members, as of a chosen date.",
    descriptionHtml: null,
  },
  "5": {
    slug: "clinical-trials",
    name: "Clinical Trials",
    summary:
      "Active clinical trials involving the center's members, with ClinicalTrials.gov links.",
    descriptionHtml: null,
  },
  "6": {
    slug: "nih-funded-pubs",
    name: "NIH-funded pubs",
    summary: "This unit's publications with a matched NIH RePORTER funding link.",
    descriptionHtml: null,
  },
  "7": {
    slug: "mentored-publications",
    name: "Mentored publications",
    summary:
      "Every publication a learner co-authored with a mentor — the MD program's AOC pairing sheet, MD-PhD program office, Jenzabar thesis advisors, ED postdoc appointments, co-authorship inferences — with impact factor and citations. Access is granted per person.",
    descriptionHtml: MENTORED_PUBS_DESCRIPTION_HTML,
  },
  "8": {
    slug: "article-count",
    name: "Article counts",
    summary:
      "Distinct articles per calendar or fiscal year for the scholars matching a person type, primary department, article type, minimum Journal Impact Factor and author position. Open to every unit administrator.",
    descriptionHtml: null,
  },
  "9": {
    slug: "high-impact-publications",
    name: "Top clinical and high-impact journal publications",
    summary:
      "Articles in top-tier journals (JAMA, Lancet, NEJM, JCO, Sci Transl Med, Nature, Blood, Circulation, Science, Cell) with impact factor, WCM first/last authors, Entrez date and NIH citations. Access is granted per person.",
    descriptionHtml: null,
  },
};

/** One report's editable metadata as the pages consume it. `descriptionHtml`
 *  is the stored (write-sanitized) HTML, or `null` for "no description". */
export type ReportMeta = {
  key: ReportKey;
  slug: string;
  name: string;
  summary: string;
  descriptionHtml: string | null;
};

/**
 * Every report's metadata, keyed by {@link ReportKey} — the table's row where
 * one exists, else that report's {@link REPORT_META_DEFAULTS} entry, so every
 * key is present whether or not its row exists. A row wins whole (a stored
 * NULL description is "none", not "fall back"). One `findMany` per request
 * (`cache()`): a page's `generateMetadata` and its header both call this and
 * share the read.
 */
export const loadReportMeta = cache(async (): Promise<Map<ReportKey, ReportMeta>> => {
  const rows = await db.read.reportMeta.findMany({
    select: { reportKey: true, slug: true, name: true, summary: true, descriptionHtml: true },
  });
  const byKey = new Map(rows.map((r) => [r.reportKey, r] as const));
  const out = new Map<ReportKey, ReportMeta>();
  for (const key of REPORT_KEYS) {
    const src = byKey.get(key) ?? REPORT_META_DEFAULTS[key];
    out.set(key, {
      key,
      slug: src.slug,
      name: src.name,
      summary: src.summary,
      descriptionHtml: src.descriptionHtml,
    });
  }
  return out;
});

/** One report's metadata — {@link loadReportMeta} narrowed to `key`. Always
 *  resolves (the defaults guarantee every key). */
export async function reportMetaFor(key: ReportKey): Promise<ReportMeta> {
  const meta = (await loadReportMeta()).get(key);
  // Unreachable — `loadReportMeta` sets every `REPORT_KEYS` entry — but the
  // Map type can't say so.
  if (!meta) throw new Error(`report_meta: no entry for report ${key}`);
  return meta;
}

/** Cap on `requestedBy` (the `report_meta.requested_by` column width). */
export const REPORT_REQUESTED_BY_MAX = 200;
/** Cap on `requestMemo` (a TEXT column; the cap keeps a paste bounded). */
export const REPORT_REQUEST_MEMO_MAX = 5000;

/** Who asked for a report, when, and what was asked (`requested_on` as
 *  `YYYY-MM-DD`), plus when the row was last saved. Report editors only: the
 *  header loads it for a superuser and hands it to the "Edit details" sheet;
 *  nothing renders it on the report. All null for a report with no row. */
export type ReportRequestRecord = {
  requestedBy: string | null;
  requestedOn: string | null;
  requestMemo: string | null;
  updatedAt: string | null;
};

export async function loadReportRequestRecord(key: ReportKey): Promise<ReportRequestRecord> {
  const row = await db.read.reportMeta.findUnique({
    where: { reportKey: key },
    select: { requestedBy: true, requestedOn: true, requestMemo: true, updatedAt: true },
  });
  return {
    requestedBy: row?.requestedBy ?? null,
    requestedOn: row?.requestedOn ? row.requestedOn.toISOString().slice(0, 10) : null,
    requestMemo: row?.requestMemo ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** The numbered label the index cards and page `<h1>`s show — `"3. Publications"`. */
export function reportLabel(meta: Pick<ReportMeta, "key" | "name">): string {
  return `${meta.key}. ${meta.name}`;
}

/** The `generateMetadata` value for `/edit/reports/[n]` — the report's name
 *  in the console's `<title>` pattern, noindex like every `/edit/*` page. */
export async function reportPageMetadata(
  key: ReportKey,
): Promise<{ title: string; robots: { index: false; follow: false } }> {
  const meta = await reportMetaFor(key);
  return {
    title: `${meta.name} — Scholars Console`,
    robots: { index: false, follow: false },
  };
}
