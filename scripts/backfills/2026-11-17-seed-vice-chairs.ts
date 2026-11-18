/**
 * Seed `unit_leadership_role` from the November 2026 web audit of department
 * Vice Chairs (88 rows, 15 departments).
 *
 * The CSV is NOT in this repo (public repo, real people). Pass its path, or
 * ship it to a one-off ECS task as SEED_CSV_GZ_B64 (gzip + base64).
 * Columns: Department, Name, Vice Chair title (as published), Tier,
 * Source type, Source date, Reference URL, Notes. Two optional columns settle
 * what the matcher cannot: `CWID` (an ambiguous or unmatched name) and
 * `DeptCode` (an unmatched department).
 *
 * Every row that resolves to one department and one active scholar is
 * inserted as a live row, `source = 'audit_seed'`. There is no review queue:
 * a steward who sees a wrong or stale row edits or removes it on /edit.
 * A title naming two roles ("Vice Chair, X; Vice Chair, Y") becomes two rows.
 * The tier is read from the published title; a CSV `Tier` that disagrees is
 * printed, not used. Idempotent: a (cwid, unit, display title) already present is skipped.
 *
 * Dry-run by default; pass --apply to write. Prints names and titles (already
 * public on department sites), never CWIDs.
 *   npx tsx scripts/backfills/2026-11-17-seed-vice-chairs.ts <audit.csv> [--apply]
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createConnection } from "mariadb";
import { connectionOptionsFromDsn } from "@/lib/db-tls";
import {
  LEADERSHIP_TIERS,
  detectLeadershipSite,
  isFullTimeFaculty,
  parseLeadershipTitle,
  serializeFunctions,
  type LeadershipTier,
} from "@/lib/unit-leadership";

type Dept = { code: string; name: string; official_name: string | null; compact_name: string | null };
type Person = {
  cwid: string;
  preferred_name: string;
  dept_code: string | null;
  role_category: string | null;
  primary_title?: string | null;
  ed_primary_title?: string | null;
};
type CsvRow = Record<string, string>;

export type SeedRow = {
  cwid: string;
  entityId: string;
  tier: LeadershipTier;
  functions: string;
  areaText: string | null;
  site: string | null;
  displayTitle: string;
  sourceUrl: string | null;
  sourceObservedAt: string | null;
  note: string | null;
};
export type PlanLine = {
  department: string;
  name: string;
  title: string;
  status: "ok" | "no_department" | "no_scholar" | "ambiguous_scholar" | "no_vice_chair_title";
  flags: string[];
  rows: SeedRow[];
};

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines in quotes. */
export function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some((f) => f !== "")) records.push(record);
  const [header, ...rest] = records;
  if (!header) return [];
  const keys = header.map((h) => h.replace(/^﻿/, "").trim());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "2026-06-03" | "2022-05" | "2026" -> a DATE string; anything else -> null. */
export function observedDate(raw: string): string | null {
  const m = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}` : null;
}

/** Pure: what the seed would insert, and why a row would be left out. */
export function planSeed(csv: CsvRow[], depts: Dept[], people: Person[]): PlanLine[] {
  const deptByName = new Map<string, Dept>();
  for (const d of depts) {
    for (const n of [d.name, d.official_name, d.compact_name]) if (n) deptByName.set(norm(n), d);
  }
  const byCwid = new Map(people.map((p) => [p.cwid, p]));
  const named = people.map((p) => ({ p, n: norm(p.preferred_name) }));

  return csv.map((r) => {
    const department = r["Department"] ?? "";
    const name = r["Name"] ?? "";
    const title = r["Vice Chair title (as published)"] ?? "";
    const line: PlanLine = { department, name, title, status: "ok", flags: [], rows: [] };

    const dept =
      depts.find((d) => d.code === r["DeptCode"]) ?? deptByName.get(norm(department.replace(/\s*\(.*\)\s*$/, "")));
    if (!dept) return { ...line, status: "no_department" };

    let person = r["CWID"] ? byCwid.get(r["CWID"]) : undefined;
    if (!person) {
      const tokens = norm(name).split(" ");
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      let hits = named.filter(({ n }) => n.startsWith(first) && n.split(" ").includes(last)).map(({ p }) => p);
      if (hits.length > 1) {
        const inDept = hits.filter((p) => p.dept_code === dept.code);
        if (inDept.length >= 1) hits = inDept;
      }
      if (hits.length === 0) return { ...line, status: "no_scholar" };
      if (hits.length > 1) return { ...line, status: "ambiguous_scholar" };
      person = hits[0];
    }

    const parsed = parseLeadershipTitle(title, dept.name);
    if (parsed.length === 0) return { ...line, status: "no_vice_chair_title" };

    const csvTier = (r["Tier"] ?? "").split(/\s+/)[0].toLowerCase();
    const notes = r["Notes"] ?? "";
    if (!isFullTimeFaculty(person.role_category, person.primary_title, person.ed_primary_title)) {
      line.flags.push(`not full-time faculty (${person.role_category ?? "none"})`);
    }
    if (person.dept_code !== dept.code) line.flags.push("primary department differs");

    for (const p of parsed) {
      // The title is what the department publishes, so its tier wins.
      if ((LEADERSHIP_TIERS as readonly string[]).includes(csvTier) && csvTier !== p.tier) {
        line.flags.push(`tier: title reads ${p.tier}, audit says ${csvTier}`);
      }
      line.rows.push({
        cwid: person.cwid,
        entityId: dept.code,
        tier: p.tier,
        functions: serializeFunctions(p.functions),
        areaText: p.areaText,
        // The site is often only in the audit note ("Chief of Medicine at NYP/Queens").
        site: p.site ?? (/\(site\)/i.test(r["Tier"] ?? "") ? detectLeadershipSite(notes) : null),
        displayTitle: p.displayTitle,
        sourceUrl: r["Reference URL"] || null,
        sourceObservedAt: observedDate(r["Source date"] ?? ""),
        note: notes ? notes.slice(0, 512) : null,
      });
    }
    return line;
  });
}

function readCsv(): string {
  const path = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (path) return readFileSync(path, "utf8");
  const b64 = process.env.SEED_CSV_GZ_B64;
  if (b64) return gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  console.error("usage: 2026-11-17-seed-vice-chairs.ts <audit.csv> [--apply]  (or SEED_CSV_GZ_B64)");
  process.exit(1);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const csv = parseCsv(readCsv());
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }
  const conn = await createConnection(connectionOptionsFromDsn(process.env.DATABASE_URL));
  try {
    const depts: Dept[] = await conn.query("SELECT code, name, official_name, compact_name FROM department");
    const people: Person[] = await conn.query(
      "SELECT cwid, preferred_name, dept_code, role_category, primary_title, ed_primary_title FROM scholar " +
        "WHERE deleted_at IS NULL AND status = 'active'",
    );
    const existing: { cwid: string; entity_id: string; display_title: string }[] = await conn.query(
      "SELECT cwid, entity_id, display_title FROM unit_leadership_role WHERE entity_type = 'department'",
    );
    const have = new Set(existing.map((e) => `${e.cwid}|${e.entity_id}|${e.display_title}`));

    const plan = planSeed(csv, depts, people);
    const counts: Record<string, number> = {};
    let toInsert = 0;
    let present = 0;
    for (const l of plan) {
      counts[l.status] = (counts[l.status] ?? 0) + 1;
      const flags = l.flags.length ? `  [${l.flags.join("; ")}]` : "";
      console.log(`${l.status.padEnd(20)} ${l.department} | ${l.name} | ${l.title}${flags}`);
      for (const r of l.rows) {
        const dupe = have.has(`${r.cwid}|${r.entityId}|${r.displayTitle}`);
        if (dupe) present++;
        else toInsert++;
        console.log(
          `    ${dupe ? "present" : "insert "} ${r.tier} | ${r.functions || "(general)"}` +
            `${r.areaText ? ` | area: ${r.areaText}` : ""}${r.site ? ` | site: ${r.site}` : ""}`,
        );
        if (apply && !dupe) {
          await conn.query(
            "INSERT INTO unit_leadership_role (id, cwid, entity_type, entity_id, role_family, tier, functions, " +
              "area_text, site, display_title, source, source_url, source_observed_at, note, updated_at) " +
              "VALUES (?, ?, 'department', ?, 'vice_chair', ?, ?, ?, ?, ?, 'audit_seed', ?, ?, ?, NOW(3))",
            [
              randomUUID(),
              r.cwid,
              r.entityId,
              r.tier,
              r.functions,
              r.areaText,
              r.site,
              r.displayTitle,
              r.sourceUrl,
              r.sourceObservedAt,
              r.note,
            ],
          );
          have.add(`${r.cwid}|${r.entityId}|${r.displayTitle}`);
        }
      }
    }
    console.log(`\n${csv.length} audit rows: ${JSON.stringify(counts)}`);
    console.log(`${toInsert} role rows ${apply ? "inserted" : "to insert"}, ${present} already present`);
    if (!apply) console.log("Dry run only (default). Re-run with --apply to write.");
  } finally {
    await conn.end();
  }
}

if (process.argv[1]?.includes("2026-11-17-seed-vice-chairs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
