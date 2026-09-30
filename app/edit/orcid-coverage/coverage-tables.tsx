/**
 * The two ORCID coverage tables — "By person type" and "By department" — with
 * the Summary / All columns switch they share, the department filter, click-to-
 * sort headers and the top-15 fold.
 *
 * A client island for that view state only. The rows are the server's
 * `CoverageRow`s (aggregates, never a person), already filtered by the page's
 * GET form; nothing here fetches. The department rows arrive in the loader's
 * outreach order, which is the default sort — a click re-sorts, ties keep the
 * loader's order.
 */
"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Input } from "@/components/ui/input";
// TYPE-only: `lib/edit/orcid-coverage` pulls `lib/edit/person-filter`, which
// imports the Prisma runtime — a value import here would drag it into the
// client bundle. The four one-line derivations it exports are mirrored below
// (tests/unit/edit-orcid-coverage-page.test.tsx renders these cells against
// the real `buildOrcidCoverage`, so a drift shows up there).
import type { CoverageRow } from "@/lib/edit/orcid-coverage";
import { cn } from "@/lib/utils";

/** `DEFAULT_ROLE` in lib/edit/orcid-coverage. */
const FULL_TIME_ROLE = "full_time_faculty";
const neither = (c: CoverageRow) => c.people - c.orcid - c.era + c.both;
const nihNoOrcid = (c: CoverageRow) => c.nihPeople - c.nihOrcid;
const piNoEra = (c: CoverageRow) => c.nihPi - c.nihPiEra;
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

type ColKey =
  | "name"
  | "people"
  | "bar"
  | "asserted"
  | "confirmed"
  | "pct"
  | "strong"
  | "weak"
  | "era"
  | "both"
  | "neither"
  | "nih"
  | "nihA"
  | "nihNo"
  | "pi"
  | "piNoEra";

type Col = { key: ColKey; label: string; tip?: string; width: string };

const NAME_COL: Col = { key: "name", label: "", width: "min-w-[150px]" };

const SUMMARY_COLS: Col[] = [
  NAME_COL,
  { key: "people", label: "People", width: "w-[72px]" },
  {
    key: "bar",
    label: "Coverage",
    tip: "Asserted, strong inference, weak inference, neither",
    width: "min-w-[140px] w-[24%]",
  },
  { key: "pct", label: "Asserted", tip: "Share with an asserted ORCID iD", width: "w-[80px]" },
  {
    key: "nih",
    label: "NIH-funded",
    tip: "Any NIH award on file, whatever its dates",
    width: "w-[90px]",
  },
  {
    key: "nihNo",
    label: "NIH-funded, no ORCID",
    tip: "The outreach list. In parentheses: the easy subset with a strong inference",
    width: "w-[130px]",
  },
  {
    key: "piNoEra",
    label: "NIH PI, no eRA",
    tip: "A miss in our RePORTER resolver, not in their account",
    width: "w-[84px]",
  },
];

const ALL_COLS: Col[] = [
  NAME_COL,
  { key: "people", label: "People", width: "" },
  { key: "asserted", label: "Asserted", width: "" },
  { key: "confirmed", label: "Confirmed", width: "" },
  { key: "pct", label: "Asserted %", width: "" },
  { key: "strong", label: "Inferred, strong", width: "" },
  { key: "weak", label: "Inferred, weak", width: "" },
  { key: "era", label: "eRA account", width: "" },
  { key: "both", label: "Both", tip: "ORCID and eRA", width: "" },
  { key: "neither", label: "Neither", width: "" },
  { key: "nih", label: "NIH-funded", width: "" },
  { key: "nihA", label: "NIH-funded, asserted", width: "" },
  {
    key: "nihNo",
    label: "NIH-funded, no ORCID",
    tip: "In parentheses: the easy subset with a strong inference",
    width: "",
  },
  { key: "pi", label: "NIH PI", width: "" },
  { key: "piNoEra", label: "NIH PI, no eRA", width: "" },
];

type ColSet = "summary" | "all";

/** The numeric value a column shows and sorts by. */
function value(r: CoverageRow, key: Exclude<ColKey, "name">): number {
  switch (key) {
    case "people":
      return r.people;
    case "asserted":
      return r.orcid;
    case "confirmed":
      return r.confirmed;
    case "bar":
    case "pct":
      return r.people === 0 ? -1 : r.orcid / r.people;
    case "strong":
      return r.strong;
    case "weak":
      return r.weak;
    case "era":
      return r.era;
    case "both":
      return r.both;
    case "neither":
      return neither(r);
    case "nih":
      return r.nihPeople;
    case "nihA":
      return r.nihOrcid;
    case "nihNo":
      return nihNoOrcid(r);
    case "pi":
      return r.nihPi;
    case "piNoEra":
      return piNoEra(r);
  }
}

/** The asserted share at which a row's percentage is called out in slate. */
const HIGH_SHARE = 0.1;

const width = (n: number, d: number) => `${d === 0 ? 0 : (100 * n) / d}%`;

function CoverageBar({ r }: { r: CoverageRow }) {
  const tip = `${r.orcid.toLocaleString()} asserted · ${r.strong.toLocaleString()} strong · ${r.weak.toLocaleString()} weak · ${(r.people - r.orcid - r.strong - r.weak).toLocaleString()} neither`;
  return (
    <span
      className="bg-apollo-surface-2 flex h-2 flex-1 overflow-hidden rounded-full"
      title={tip}
      role="img"
      aria-label={tip}
    >
      <span className="bg-apollo-slate block h-full" style={{ width: width(r.orcid, r.people) }} />
      <span
        className="bg-apollo-slate/45 block h-full"
        style={{ width: width(r.strong, r.people) }}
      />
      <span
        className="bg-apollo-slate/20 block h-full"
        style={{ width: width(r.weak, r.people) }}
      />
    </span>
  );
}

function Cell({ r, col, isName }: { r: CoverageRow; col: Col; isName: boolean }) {
  if (isName) return <td className="py-2.5 pr-3 pl-[18px] font-medium break-words">{r.label}</td>;
  const key = col.key as Exclude<ColKey, "name">;
  if (key === "bar") {
    return (
      <td className="px-3 py-2.5">
        <span className="flex">
          <CoverageBar r={r} />
        </span>
      </td>
    );
  }
  const base = "px-3 py-2.5 text-right whitespace-nowrap tabular-nums last:pr-[18px]";
  if (key === "pct") {
    const high = r.people > 0 && r.orcid / r.people >= HIGH_SHARE;
    return (
      <td className={cn(base, high && "text-apollo-slate font-semibold")}>
        {pct(r.orcid, r.people)}
      </td>
    );
  }
  if (key === "nihNo") {
    return (
      <td className={cn(base, "font-semibold")}>
        {nihNoOrcid(r).toLocaleString()}
        <span className="text-muted-foreground font-normal"> ({r.nihStrong.toLocaleString()})</span>
      </td>
    );
  }
  if (key === "nihA") {
    return (
      <td className={base}>
        {r.nihOrcid.toLocaleString()}
        <span className="text-muted-foreground"> ({pct(r.nihOrcid, r.nihPeople)})</span>
      </td>
    );
  }
  const v = value(r, key);
  return (
    <td className={cn(base, v === 0 ? "text-apollo-border-strong" : "text-foreground")}>
      {v.toLocaleString()}
    </td>
  );
}

const thBase =
  "text-muted-foreground px-3 py-2.5 align-bottom text-[11.5px] leading-tight font-medium tracking-[0.06em] uppercase";

function Table({
  cols,
  firstHeader,
  caption,
  rows,
  testId,
  highlight,
  sort,
  onSort,
  empty,
}: {
  cols: Col[];
  firstHeader: string;
  caption: string;
  rows: CoverageRow[];
  testId: string;
  highlight?: (r: CoverageRow) => boolean;
  sort?: { key: ColKey; dir: 1 | -1 };
  onSort?: (key: ColKey) => void;
  empty: React.ReactNode;
}) {
  return (
    <table
      className={cn(
        "w-full border-collapse text-sm",
        cols === ALL_COLS ? "min-w-[1180px]" : "min-w-[760px]",
      )}
      data-testid={testId}
    >
      <caption className="sr-only">{caption}</caption>
      <thead className="bg-apollo-surface-2 border-apollo-border-strong border-b">
        <tr>
          {cols.map((col, i) => {
            const label = i === 0 ? firstHeader : col.label;
            const active = sort?.key === col.key;
            const align = i === 0 || col.key === "bar" ? "text-left" : "text-right";
            return (
              <th
                key={col.key}
                scope="col"
                title={col.tip}
                aria-sort={
                  onSort === undefined
                    ? undefined
                    : active
                      ? sort!.dir === 1
                        ? "ascending"
                        : "descending"
                      : "none"
                }
                className={cn(thBase, align, col.width, i === 0 && "pl-[18px]", "last:pr-[18px]")}
              >
                {onSort === undefined ? (
                  label
                ) : (
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className={cn(
                      "cursor-pointer uppercase",
                      align,
                      active ? "text-foreground font-semibold" : "hover:text-foreground",
                    )}
                  >
                    {label}
                    {active ? (
                      <span aria-hidden="true">{sort!.dir === -1 ? " ↓" : " ↑"}</span>
                    ) : null}
                  </button>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="text-muted-foreground px-[18px] py-3" colSpan={cols.length}>
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr
              key={r.key ?? "__null"}
              className={cn(
                "hover:bg-apollo-page",
                i > 0 && "border-apollo-border border-t",
                highlight?.(r) && "bg-apollo-page",
              )}
            >
              {cols.map((col, ci) => (
                <Cell key={col.key} r={r} col={col} isName={ci === 0} />
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

const TOP_DEPTS = 15;

export function CoverageTables({
  byRole,
  byDept,
  roleCaption,
  deptCaption,
  deptScope,
  downloadHref,
  defaultSort,
}: {
  byRole: CoverageRow[];
  byDept: CoverageRow[];
  /** "Every person type in …." — the person-type table's scope. */
  roleCaption: string;
  /** The department table's scope and default order, as one sentence. */
  deptCaption: string;
  /** "Full-time faculty only" — which person types the department table counts. */
  deptScope: string;
  downloadHref: string;
  /** The column the loader's order corresponds to (descending). */
  defaultSort: "nihNo" | "people";
}) {
  const [colset, setColset] = React.useState<ColSet>("summary");
  const [sort, setSort] = React.useState<{ key: ColKey; dir: 1 | -1 }>({
    key: defaultSort,
    dir: -1,
  });
  const [query, setQuery] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const cols = colset === "summary" ? SUMMARY_COLS : ALL_COLS;

  // Full-time faculty first: it is the population the tiles and the default
  // department filter are about.
  const roleRows = [...byRole].sort(
    (a, b) => Number(b.key === FULL_TIME_ROLE) - Number(a.key === FULL_TIME_ROLE),
  );

  const q = query.trim().toLowerCase();
  const filtered = byDept
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => q === "" || r.label.toLowerCase().includes(q));
  const sorted = filtered
    .sort((a, b) => {
      if (sort.key === "name") return sort.dir * a.r.label.localeCompare(b.r.label) || a.i - b.i;
      const k = sort.key as Exclude<ColKey, "name">;
      return sort.dir * (value(a.r, k) - value(b.r, k)) || a.i - b.i;
    })
    .map(({ r }) => r);
  const folded = q === "" && !showAll && sorted.length > TOP_DEPTS;
  const deptRows = folded ? sorted.slice(0, TOP_DEPTS) : sorted;

  const onSort = (key: ColKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 },
    );

  return (
    <>
      <section className="flex flex-col gap-3" data-testid="orcid-coverage-by-role-section">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h2 className="m-0 text-lg font-semibold">By person type</h2>
          <span className="text-muted-foreground text-[13px]">{roleCaption}</span>
          <div className="flex items-center gap-2 sm:ml-auto">
            <span className="text-muted-foreground text-[13px]" id="orcid-coverage-columns-label">
              Columns
            </span>
            <div
              role="radiogroup"
              aria-labelledby="orcid-coverage-columns-label"
              className="border-apollo-border bg-apollo-surface-2 inline-flex rounded-lg border p-[3px]"
              data-testid="orcid-coverage-columns"
            >
              {(
                [
                  ["summary", "Summary"],
                  ["all", `All ${ALL_COLS.length - 1}`],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={colset === k}
                  onClick={() => setColset(k)}
                  data-testid={`orcid-coverage-columns-${k}`}
                  className={cn(
                    "rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap",
                    colset === k
                      ? "bg-apollo-surface text-foreground shadow-xs"
                      : "text-muted-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="border-apollo-border-strong bg-apollo-surface overflow-x-auto rounded-[13px] border">
          <Table
            cols={cols}
            firstHeader="Person type"
            caption={roleCaption}
            rows={roleRows}
            testId="orcid-coverage-by-role"
            highlight={(r) => r.key === FULL_TIME_ROLE}
            empty="No one matches these filters."
          />
        </div>
        {colset === "summary" ? (
          <ul
            className="text-muted-foreground m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12.5px]"
            data-testid="orcid-coverage-legend"
          >
            {(
              [
                ["bg-apollo-slate", "Asserted"],
                ["bg-apollo-slate/45", "Inferred, strong"],
                ["bg-apollo-slate/20", "Inferred, weak"],
                ["bg-apollo-surface-2 border border-apollo-border", "Neither"],
              ] as const
            ).map(([swatch, label]) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                <span className={cn("size-2.5 rounded-[3px]", swatch)} aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" data-testid="orcid-coverage-by-dept-section">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h2 className="m-0 text-lg font-semibold">By department</h2>
          <span className="text-muted-foreground text-[13px]">{deptCaption}</span>
          <Link
            href={downloadHref}
            className="text-apollo-slate inline-flex items-center gap-1.5 text-[13px] hover:underline sm:ml-auto"
            data-testid="orcid-coverage-download"
          >
            <Download className="size-[13px]" aria-hidden="true" />
            Download CSV
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter departments…"
            aria-label="Filter departments"
            className="border-apollo-border-strong h-[34px] w-[220px] text-[13.5px] md:text-[13.5px]"
            data-testid="orcid-coverage-dept-filter"
          />
          <span className="text-muted-foreground text-[13px]">{deptScope}</span>
        </div>
        <div className="border-apollo-border-strong bg-apollo-surface overflow-hidden rounded-[13px] border">
          <div className="overflow-x-auto">
            <Table
              cols={cols}
              firstHeader="Department"
              caption={deptCaption}
              rows={deptRows}
              testId="orcid-coverage-by-dept"
              sort={sort}
              onSort={onSort}
              empty={
                byDept.length === 0 ? "No one matches these filters." : "No departments match."
              }
            />
          </div>
          {q === "" && sorted.length > TOP_DEPTS ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="border-apollo-border bg-apollo-page text-apollo-slate w-full cursor-pointer border-t p-2.5 text-[13px]"
              data-testid="orcid-coverage-dept-more"
            >
              {showAll ? `Show top ${TOP_DEPTS}` : `Show all ${sorted.length}`}
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
