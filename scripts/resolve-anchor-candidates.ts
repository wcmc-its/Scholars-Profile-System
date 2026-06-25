/**
 * Semi-automated resolver for the #1258 lay-term anchor candidates.
 *
 *   tsx scripts/resolve-anchor-candidates.ts
 *
 * Reads `docs/mesh-anchor-lay-term-candidates.csv` and runs every `query_term`
 * through the REAL search resolver (`resolveMeshDescriptor`) against whatever DB
 * `DATABASE_URL` points at. Point it at an env whose `mesh_descriptor` /
 * `mesh_curated_*` tables are populated (staging) — not an empty local DB.
 *
 * Per row it decides empirically (overriding the hand-written `note`):
 *   - ALREADY WORKS  query resolves AND that descriptor already anchors the topic → nothing to do.
 *   - ANCHOR-ONLY    query resolves but no anchor to the topic → emit one anchor row (resolved UI → topic).
 *   - NEEDS ALIAS    query resolves to nothing → resolve `candidate_mesh_descriptor`
 *                    instead; emit an alias row (term → that UI) AND an anchor row (UI → topic).
 *   - UNRESOLVED     neither the term nor the candidate descriptor name is in MeSH → manual.
 *   - WARN <3 chars  normalized query is below MIN_QUERY_LEN (3); an alias can't rescue it.
 *
 * Writes two review fragments (NOT the production files — eyeball, then append):
 *   etl/mesh-anchors/curated.candidates.csv   (descriptor_ui,parent_topic_id,source_note)
 *   etl/mesh-aliases/curated.candidates.csv   (alias,descriptor_ui,source_note)
 *
 * The resolved descriptor is authoritative for search — if a `query_term`
 * resolves to a descriptor you didn't expect, the report prints its name so a
 * human can reject the row before merging. That's the "semi" in semi-automated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert";
import { resolveMeshDescriptor } from "@/lib/api/search-taxonomy";

const IN = "docs/mesh-anchor-lay-term-candidates.csv";
const ANCHOR_OUT = "etl/mesh-anchors/curated.candidates.csv";
const ALIAS_OUT = "etl/mesh-aliases/curated.candidates.csv";
const MIN_QUERY_LEN = 3; // mirrors lib/api/search-taxonomy.ts

/** RFC4180-ish single-line splitter: handles "quoted, commas" and "" escapes. */
function parseRow(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

// ponytail: one check — the only non-trivial logic here is the CSV tokenizer.
assert.deepStrictEqual(parseRow('a,"b, c","d""e",f'), ["a", "b, c", 'd"e', "f"]);

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`;
const normLen = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").length;

async function main() {
  const lines = readFileSync(IN, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = parseRow(lines[0]);
  assert.deepStrictEqual(header, ["query_term", "target_topic_id", "candidate_mesh_descriptor", "note"]);

  const anchorRows: string[] = [];
  const aliasRows: string[] = [];
  const report = { works: [] as string[], anchor: [] as string[], alias: [] as string[], unresolved: [] as string[], warn: [] as string[] };
  const seenAnchor = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const [term, topic, candidate] = parseRow(lines[i]);
    if (!term || !topic) continue;

    if (normLen(term) < MIN_QUERY_LEN) {
      report.warn.push(`${term} → ${topic}  (normalized <${MIN_QUERY_LEN} chars; resolver early-returns null — alias can't help, pick a longer surface form)`);
      continue;
    }

    const res = await resolveMeshDescriptor(term);
    // `partial` = the decompose-and-resolve fallback matched a single stray
    // word window ("gut bacteria" → Bacteria, "AI in medicine" → Medicine).
    // That's not a clean concept hit — never anchor it; route to the alias
    // path so the intended descriptor wins instead. (Verified live on staging.)
    if (res && String(res.confidence) !== "partial") {
      const amb = res.ambiguous ? " ⚠AMBIGUOUS" : "";
      if (res.curatedTopicAnchors.includes(topic)) {
        report.works.push(`${term} → ${res.descriptorUi} ${res.name} (already anchors ${topic})`);
        continue;
      }
      const key = `${res.descriptorUi}|${topic}`;
      if (!seenAnchor.has(key)) {
        seenAnchor.add(key);
        anchorRows.push(`${res.descriptorUi},${topic},${csvField(`#1258 lay-term "${term}" → ${res.name} (${res.confidence}). Review.`)}`);
      }
      report.anchor.push(`${term} → ${res.descriptorUi} ${res.name} [${res.confidence}]${amb} ⇒ anchor ${topic}`);
      continue;
    }

    // term resolves to nothing → alias it onto the intended descriptor
    if (!candidate || candidate === "?") {
      report.unresolved.push(`${term} → ${topic}  (no resolve, no candidate descriptor — needs a new MeSH concept or a different layer)`);
      continue;
    }
    const tgt = await resolveMeshDescriptor(candidate);
    if (!tgt) {
      report.unresolved.push(`${term} → ${topic}  (candidate "${candidate}" not found in mesh_descriptor — fix the name)`);
      continue;
    }
    aliasRows.push(`${csvField(term)},${tgt.descriptorUi},${csvField(`#1258 lay-term alias → ${tgt.name}`)}`);
    const key = `${tgt.descriptorUi}|${topic}`;
    if (!seenAnchor.has(key)) {
      seenAnchor.add(key);
      anchorRows.push(`${tgt.descriptorUi},${topic},${csvField(`#1258 lay-term "${term}" via alias → ${tgt.name}. Review.`)}`);
    }
    report.alias.push(`${term} → alias ${tgt.descriptorUi} ${tgt.name} ⇒ anchor ${topic}`);
  }

  writeFileSync(ANCHOR_OUT, "descriptor_ui,parent_topic_id,source_note\n" + anchorRows.join("\n") + "\n");
  writeFileSync(ALIAS_OUT, "alias,descriptor_ui,source_note\n" + aliasRows.join("\n") + "\n");

  const p = (label: string, arr: string[]) => {
    console.log(`\n=== ${label} (${arr.length}) ===`);
    arr.forEach((l) => console.log("  " + l));
  };
  p("ALREADY WORKS — skip", report.works);
  p("ANCHOR-ONLY — rows in " + ANCHOR_OUT, report.anchor);
  p("NEEDS ALIAS — rows in both fragments", report.alias);
  p("UNRESOLVED — manual", report.unresolved);
  p("WARN — below min query length", report.warn);
  console.log(`\nWrote ${anchorRows.length} anchor + ${aliasRows.length} alias candidate rows. Eyeball, then append to the production curated.csv files.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
