/**
 * Minimal CSV parser for the curated-anchor seed file. The file is small
 * (≤50 rows) and the schema is fixed: three columns,
 * `descriptor_ui,parent_topic_id,source_note`. Source notes may contain
 * commas, so they're double-quoted; embedded double quotes are escaped
 * by doubling per RFC 4180.
 *
 * Not pulling in a CSV library — the format is tightly constrained and a
 * 30-line tokenizer is easier to audit than a dependency.
 */
import type { CuratedRow } from "./types";

export function parseCuratedCsv(text: string): CuratedRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];
  const header = parseRow(lines[0]);
  const expected = ["descriptor_ui", "parent_topic_id", "source_note"];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new Error(
        `Curated CSV header mismatch at column ${i + 1}: expected ${expected[i]}, got ${header[i] ?? "(missing)"}`,
      );
    }
  }
  const out: CuratedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    if (row.length !== 3) {
      throw new Error(
        `Curated CSV row ${i + 1}: expected 3 columns, got ${row.length} — line: ${lines[i]}`,
      );
    }
    const [descriptorUi, parentTopicId, sourceNote] = row;
    if (!descriptorUi || !parentTopicId) {
      throw new Error(
        `Curated CSV row ${i + 1}: descriptor_ui and parent_topic_id are required`,
      );
    }
    out.push({
      descriptorUi,
      parentTopicId,
      sourceNote: sourceNote === "" ? null : sourceNote,
    });
  }
  return out;
}

function splitLines(text: string): string[] {
  // Strip BOM, split on \r\n or \n, drop trailing empty line.
  const stripped = text.replace(/^﻿/, "");
  const lines = stripped.split(/\r?\n/);
  // Drop a single trailing empty line (the typical POSIX final newline)
  // but keep intentional blanks in the middle for the row-count error
  // reporting to remain accurate.
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
