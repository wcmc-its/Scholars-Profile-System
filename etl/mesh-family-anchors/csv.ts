/**
 * Minimal CSV parser for the curated family-anchor seed file (issue #879). The
 * file is small and the schema is fixed: five columns,
 * `supercategory,family_label,descriptor_ui,confidence,source_note`. Family
 * labels and source notes may contain commas, so any field may be double-quoted;
 * embedded double quotes are escaped by doubling per RFC 4180.
 *
 * Mirrors `etl/mesh-aliases/csv.ts` — same tokenizer, different header — for the
 * same reason: a small parser is easier to audit than a dependency.
 */
import type { FamilyAnchorRow } from "./types";

export function parseFamilyAnchorCsv(text: string): FamilyAnchorRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];
  const header = parseRow(lines[0]);
  const expected = ["supercategory", "family_label", "descriptor_ui", "confidence", "source_note"];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new Error(
        `Family-anchor CSV header mismatch at column ${i + 1}: expected ${expected[i]}, got ${header[i] ?? "(missing)"}`,
      );
    }
  }
  const out: FamilyAnchorRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    if (row.length !== 5) {
      throw new Error(
        `Family-anchor CSV row ${i + 1}: expected 5 columns, got ${row.length} — line: ${lines[i]}`,
      );
    }
    const [supercategory, familyLabel, descriptorUi, confidence, sourceNote] = row;
    if (!supercategory || !familyLabel || !descriptorUi) {
      throw new Error(
        `Family-anchor CSV row ${i + 1}: supercategory, family_label and descriptor_ui are required`,
      );
    }
    if (confidence !== "curated" && confidence !== "derived") {
      throw new Error(
        `Family-anchor CSV row ${i + 1}: confidence must be 'curated' or 'derived', got "${confidence}"`,
      );
    }
    out.push({
      supercategory,
      familyLabel,
      descriptorUi,
      confidence,
      sourceNote: sourceNote === "" ? null : sourceNote,
    });
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
