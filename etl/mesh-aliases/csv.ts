/**
 * Minimal CSV parser for the curated-alias seed file (issue #642). The file
 * is small (≤50 rows) and the schema is fixed: three columns,
 * `alias,descriptor_ui,source_note`. Source notes may contain commas, so
 * they're double-quoted; embedded double quotes are escaped by doubling per
 * RFC 4180.
 *
 * Mirrors `etl/mesh-anchors/csv.ts` — same tokenizer, different header — for
 * the same reason: a 30-line parser is easier to audit than a dependency.
 */
import type { AliasRow } from "./types";

export function parseAliasCsv(text: string): AliasRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];
  const header = parseRow(lines[0]);
  const expected = ["alias", "descriptor_ui", "source_note"];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new Error(
        `Alias CSV header mismatch at column ${i + 1}: expected ${expected[i]}, got ${header[i] ?? "(missing)"}`,
      );
    }
  }
  const out: AliasRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    if (row.length !== 3) {
      throw new Error(
        `Alias CSV row ${i + 1}: expected 3 columns, got ${row.length} — line: ${lines[i]}`,
      );
    }
    const [alias, descriptorUi, sourceNote] = row;
    if (!alias || !descriptorUi) {
      throw new Error(`Alias CSV row ${i + 1}: alias and descriptor_ui are required`);
    }
    out.push({ alias, descriptorUi, sourceNote: sourceNote === "" ? null : sourceNote });
  }
  return out;
}

function splitLines(text: string): string[] {
  // Strip BOM, split on \r\n or \n, drop a single trailing empty line.
  const stripped = text.replace(/^﻿/, "");
  const lines = stripped.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseRow(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cell = "";
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      out.push(cell);
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  out.push(cell);
  return out;
}
