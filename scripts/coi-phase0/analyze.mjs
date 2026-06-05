#!/usr/bin/env node
/**
 * Track A — Phase 0 offline precision harness (dependency-free Node ESM).
 *
 * Reads the prepped corpus CSVs (knowns/conflicts/disclosed/faculty) from OUT_DIR,
 * runs the candidate pipeline, and writes:
 *   - candidates.csv : one row per surfaced candidate gap (the human-labeling sheet)
 *   - report.md      : population, gap rate vs the 2022 capstone (~37%), tier +
 *                      heuristic failure-mode histograms, sample candidates
 * Also prints the report to stdout.
 *
 * The pipeline mirrors the feasibility design so its tuning carries into Phase 1:
 *   segment -> attribute-to-scholar -> extract entities -> normalize+diff vs
 *   disclosed set -> confidence tier. The pure functions below are intentionally
 *   framework-free and portable to TypeScript.
 *
 * Track A scope/caveats (stated in the report too):
 *   - Population = faculty with a valid cwid in BOTH knowns and the disclosed
 *     export, so each has a KNOWN, COMPLETE disclosed set. This excludes
 *     zero-disclosure faculty (the highest-gap group), so our statement-level gap
 *     rate is expected to sit at or BELOW the capstone's 37%.
 *   - The 2022 export is paper-level text with no author roster, so attribution is
 *     by in-clause initials/surname only (Track B adds ReCiter targetAuthor).
 *   - The entity extractor is a rule+gazetteer v0; precision is decided by HUMAN
 *     labels on candidates.csv, not by this script. The auto failure-mode column
 *     is a heuristic preview only.
 *
 * Usage: node analyze.mjs [OUT_DIR]   (default /tmp/coi-phase0)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.argv[2] || "/tmp/coi-phase0";

// ----------------------------- CSV io -----------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function readCsvObjects(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (!rows.length) return [];
  const hdr = rows[0];
  return rows.slice(1).filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ""])));
}
function csvCell(s) {
  s = String(s ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(path, header, rows) {
  const out = [header.join(",")];
  for (const r of rows) out.push(header.map(h => csvCell(r[h])).join(","));
  writeFileSync(path, out.join("\n") + "\n");
}

// ------------------------- pure pipeline ---------------------------

// A statement is pure boilerplate (no disclosure) if, after stripping all
// negation/none phrases, almost nothing of substance remains.
const NEG_PHRASE = /\b(no(ne)?|not|nothing|without)\b[^.;]*?\b(competing|conflict|conflicts|interest|interests|disclos\w*|relevant financial|financial relationship|to declare|to disclose|to report)\b/gi;
const NEG_SIMPLE = /\b(the authors? (have|has|declare|report)?\s*(no|none|nothing)|nothing to (disclose|declare|report)|no (competing|conflict|relevant|financial|potential)\b[^.;]*?(interest|relationship|disclos)\w*|declares? (no|none)|none (declared|to declare|reported))/gi;
function isPureNegation(text) {
  if (!text || !text.trim()) return true;
  let t = text.replace(NEG_PHRASE, " ").replace(NEG_SIMPLE, " ");
  // residual meaningful tokens (drop common scaffolding words)
  t = t.replace(/\b(competing|conflict|conflicts|of|interest|interests|disclosure|disclosures|disclose|declared|declare|financial|the|authors?|author|all|other|relevant|potential|report|reported|reports|have|has|was|were|is|are|and|to|a|an|in|on|with|statement|coi|none|no|not|nothing|this|study|work|paper|manuscript|article|research)\b/gi, " ");
  t = t.replace(/[^A-Za-z]+/g, " ").trim();
  // if <2 residual alpha tokens of length>2, it's negation/boilerplate
  const toks = t.split(/\s+/).filter(w => w.length > 2);
  return toks.length < 2;
}

// Split a statement into clause-level units, protecting abbreviations/initials.
function segment(text) {
  let t = " " + text.replace(/\s+/g, " ").trim() + " ";
  // protect dots in abbreviations & single-letter initials so we don't split on them
  t = t.replace(/\b(Dr|Drs|Mr|Ms|Mrs|Prof|Inc|Ltd|Co|Corp|Mt|St|vs|U\.S|U\.K|Ph\.D|M\.D|Jr|Sr)\./gi, (m) => m.replace(".", ""));
  t = t.replace(/\b([A-Z])\.(?=\s?[A-Z][.\s])/g, "$1"); // R.B. style
  t = t.replace(/\b([A-Z])\.(?=\s[A-Z][a-z])/g, "$1"); // R. Kumar style
  const parts = t.split(/[.;]\s+|\s+[•·]\s+/);
  return parts
    .map(s => s.replace(//g, ".").trim())
    .filter(s => s.length > 0);
}

function deriveScholar(first, last) {
  const fi = (first || "").trim()[0] || "";
  const li = (last || "").trim()[0] || "";
  const surname = (last || "").trim();
  return {
    surname,
    surnameRe: surname ? new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null,
    initials: (fi + li).toUpperCase(),       // e.g. John Leonard -> JL
    initialsAlt: (li + fi).toUpperCase(),     // surname-first variant
  };
}

// Author-reference initials groups in AUTHOR-REF POSITION only: at clause start,
// or immediately before a reporting verb. This is the key correctness guard — a
// bare initials run anywhere in a sponsor list (e.g. "HalioDx SAS", "MSD") must
// NOT be read as an author, or one author's disclosure list bleeds onto another.
const REPORTING_VERB = "(?:has|have|is|are|was|were|reports?|reported|receives?|received|serves?|served|declares?|disclos\\w+|owns?|holds?|consults?|sits?|acts?)";
function authorRefInitials(clause) {
  const out = new Set();
  // clause-start group (allow a leading "Dr"/"Drs"/"Prof")
  let m = clause.match(/^\s*(?:Drs?\.?\s+|Prof\.?\s+)?([A-Z]\.?\s?){2,4}\b/);
  if (m) {
    const letters = m[0].replace(/[^A-Z]/g, "");
    if (letters.length >= 2 && letters.length <= 4) out.add(letters);
  }
  // group immediately before a reporting verb anywhere in the clause
  const re = new RegExp(`\\b([A-Z]\\.?\\s?){2,4}\\s+${REPORTING_VERB}\\b`, "g");
  let g;
  while ((g = re.exec(clause))) {
    const letters = g[0].replace(new RegExp(`\\s+${REPORTING_VERB}\\b.*$`), "").replace(/[^A-Z]/g, "");
    if (letters.length >= 2 && letters.length <= 4) out.add(letters);
  }
  return [...out];
}

// "Dr <Surname>" / "Dr R.B. Kumar" -> the referenced surname (for scholar vs other).
function drSurnames(clause) {
  const out = [];
  const re = /\bDrs?\.?\s+(?:[A-Z]\.?\s*){0,3}([A-Z][a-z]{2,})/g;
  let m;
  while ((m = re.exec(clause))) out.push(m[1]);
  return out;
}

// Attribute a clause to the scholar, another author, or nobody.
function attribute(clause, scholar) {
  const surnameHit = scholar.surnameRe && scholar.surnameRe.test(clause);
  const refs = authorRefInitials(clause);
  const drs = drSurnames(clause);
  const scholarInit = refs.some(g => g === scholar.initials || g === scholar.initialsAlt);
  const drScholar = drs.some(s => s.toLowerCase() === scholar.surname.toLowerCase());
  const otherInit = refs.some(g => g !== scholar.initials && g !== scholar.initialsAlt);
  const drOther = drs.some(s => s.toLowerCase() !== scholar.surname.toLowerCase());
  const otherRef = otherInit || drOther;
  const scholarRef = surnameHit || scholarInit || drScholar;
  const allAuthors = /\b(the |all )?authors?\b/i.test(clause) && !scholarRef && !otherRef;

  if (scholarRef && otherRef)
    return { level: "scholar", score: 0.55, reason: `scholar named alongside another author — ambiguous` };
  if (surnameHit || drScholar)
    return { level: "scholar", score: 0.9, reason: `surname "${scholar.surname}" in clause` };
  if (scholarInit)
    return { level: "scholar", score: 0.75, reason: `initials ${scholar.initials} match (author-ref position)` };
  if (otherRef)
    return { level: "other", score: 0.85, reason: `names other author (${refs.join(",") || drs.join(",")})` };
  if (allAuthors) return { level: "unattributed", score: 0.45, reason: `"the authors" — collective` };
  return { level: "unattributed", score: 0.5, reason: "no author named in clause" };
}

// Known org gazetteer (frequent pharma/device/biotech) — boosts extraction.
const GAZETTEER = [
  "Pfizer","Merck","Novartis","Genentech","Roche","AbbVie","Bristol-Myers Squibb","Bristol Myers Squibb",
  "Boston Scientific","Medtronic","Gilead","Amgen","Janssen","Johnson & Johnson","Bayer","Novo Nordisk",
  "AstraZeneca","GlaxoSmithKline","GSK","Sanofi","Eli Lilly","Lilly","Regeneron","Biogen","Vertex","Takeda",
  "Celgene","Abbott","Stryker","Edwards Lifesciences","Acerta","Pharmacyclics","Sunesis","Verastem","Gelesis",
  "Vivus","Preventice","Jansen","Jazz Pharmaceuticals","Incyte","Seattle Genetics","Seagen","BeiGene","Kite",
  "Karyopharm","MorphoSys","Epizyme","ADC Therapeutics","Genmab","TG Therapeutics","Alexion","Ionis","Moderna",
  "BioNTech","Daiichi Sankyo","Exelixis","Blueprint Medicines","Mirati","Deciphera","Servier","UCB","Grifols",
  "CSL Behring","Octapharma","Shire","Alnylam","Sarepta","Ultragenyx","BioMarin","Intuitive Surgical","Olympus",
  "Cook Medical","Baxter","Becton Dickinson","Siemens","Philips","GE Healthcare","UpToDate","Elsevier","Wolters Kluwer",
  "Chromadex","ChromaDex","Mannkind","NuRevelation","Critica","Broadview Ventures","Vaniam Group","Optum",
];
const GAZ_RE = GAZETTEER.map(n => ({ n, re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") }));

// Relationship cues after which an org typically follows.
const PERSONAL_CUE = /\b(consultant|consulting|consults?|advisor[y]?|advis\w+|advisory board|scientific advisory|speaker|speakers' ?bureau|honorari\w+|equity|stock|shares?|shareholder|ownership|owns?|founder|co-?founder|board of directors|royalt\w+|licens\w+|patent|fees? from|received (?:personal )?fees|compensation from)\b/i;
const FUNDER_CUE = /\b(research (?:support|funding|grant)s?|grants?(?: from| support| funding)?|grant (?:support|funding)|funded by|sponsored by|supported by|support from|study sponsor|institutional (?:support|funding))\b/i;
const EMPLOYER_CUE = /\b(employee of|employed by|salary from|full-?time|works? for)\b/i;

const ENTITY_STOP = new Set([
  "the","a","an","of","and","for","from","to","in","on","with","is","are","has","have","received","serves",
  "serve","member","board","advisory","scientific","consultant","speaker","company","companies","author","authors",
  "research","support","funding","grant","grants","fees","honoraria","honorarium","equity","stock","shares","other",
  "interests","interest","competing","conflict","conflicts","disclosure","disclosures","clinical","investigator",
  "study","trial","data","drug","device","this","that","work","manuscript","relationships","relationship","reports",
  "report","outside","submitted","during","conduct","personal","institution","none","no","i","we","he","she","they",
  "bureau","speakers","role","roles","consulting","advisor","advisors","fees","fee","funds","funding","payments",
  "declaration","conflicting","declared","declare","disclosures","statement","statements","following","potential",
]);

// The scholar's own institution(s) — employment/IP via the home university is not
// the external-relationship target; surfacing it is an obvious false positive.
const HOME_INSTITUTION = /\b(weill cornell|cornell university|cornell medic\w+|newyork[- ]?presbyterian|new york[- ]?presbyterian|\bNYP\b|memorial sloan[- ]?kettering|hospital for special surgery)\b/i;

// A captured phrase that is actually a person's name (dotted initials + surname,
// e.g. "A. A. Sauve", "Y. Yang", "F. Sultana Mohammed", "R. B. Kumar").
function looksLikePersonName(p) {
  if (/^(?:[A-Z]\.\s*){1,3}[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(p.trim())) return true; // A. A. Sauve
  if (/^[A-Z]\.\s+[A-Z][a-z]+$/.test(p.trim())) return true;                                // Y. Yang
  return false;
}

// A grant/award identifier, never an org entity (e.g. K23 HL140199, R01CA123456, U01, P30).
function looksLikeGrantId(p) {
  const t = p.trim();
  if (/\b[A-Z]\d{2}\b/.test(t)) return true;                 // K23, R01, U01, P30, T32 ...
  if (/^[A-Z]{1,3}\s?\d{3,}/.test(t)) return true;            // HL140199, CA123456
  if (/\bgrant\b/i.test(t) && /\d/.test(t)) return true;      // "NIH grant 12345"
  return false;
}

// Capture proper-noun org phrases from a clause (rule-based), split on list connectors.
function captureProperNouns(clause) {
  const out = [];
  // token stream
  const tokens = clause.split(/\s+/);
  let cur = [];
  const flush = () => {
    if (cur.length) {
      let phrase = cur.join(" ").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, "").trim();
      // drop trailing/leading stopwords
      const words = phrase.split(/\s+/).filter(Boolean);
      while (words.length && ENTITY_STOP.has(words[0].toLowerCase().replace(/[^a-z]/gi, ""))) words.shift();
      while (words.length && ENTITY_STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/gi, ""))) words.pop();
      phrase = words.join(" ");
      if (phrase && /[A-Za-z]{2,}/.test(phrase) && !/^[A-Z]\.?[A-Z]?\.?$/.test(phrase)) out.push(phrase);
      cur = [];
    }
  };
  for (let raw of tokens) {
    const t = raw.replace(/[,;:]+$/, "");
    const connector = /^(and|&|\/|,)$/i.test(t);
    const cap = /^[A-Z]/.test(t) || /^[A-Z0-9].*[A-Z]/.test(t);
    const joinWord = /^(of|the|for|de|von|van)$/i.test(t) && cur.length;
    if (connector) { flush(); continue; }
    if (cap || joinWord || /^[A-Z]/.test(raw)) {
      cur.push(t);
      if (/[,;]$/.test(raw)) flush();
    } else {
      flush();
    }
  }
  flush();
  return out;
}

function extractEntities(clause) {
  const found = new Map(); // raw -> score
  // gazetteer hits (high confidence)
  for (const g of GAZ_RE) if (g.re.test(clause)) found.set(g.n, Math.max(found.get(g.n) || 0, 0.9));
  // cue-driven proper nouns
  const personal = PERSONAL_CUE.test(clause);
  const funder = FUNDER_CUE.test(clause);
  const employer = EMPLOYER_CUE.test(clause);
  if (personal || funder || employer) {
    for (const p of captureProperNouns(clause)) {
      if (looksLikePersonName(p) || HOME_INSTITUTION.test(p) || looksLikeGrantId(p)) continue; // co-author / home inst / grant id
      const words = p.split(/\s+/).length;
      const hasSuffix = /\b(Inc|LLC|Ltd|LP|LLP|PLC|GmbH|Corp|Co|Pharmaceuticals?|Pharma|Therapeutics|Biosciences?|Sciences?|Technologies|Biotech|Ventures|Group|Holdings|Foundation|University|Institute|Hospital|Medical|Health|Genomics|Diagnostics)\b/i.test(p);
      let score = words >= 2 || hasSuffix ? 0.7 : 0.5;
      const cat = funder && !personal ? "funder" : employer && !personal ? "employer" : "personal";
      const prev = found.get(p);
      if (!prev || score > prev) found.set(p, score);
      // tag category alongside
      found.set(p, { score: (typeof found.get(p) === "object" ? found.get(p).score : found.get(p)) ?? score, cat });
    }
  }
  // normalize to {raw, score, cat}
  const res = [];
  for (const [raw, v] of found) {
    if (typeof v === "object") res.push({ raw, score: v.score, cat: v.cat });
    else res.push({ raw, score: v, cat: "personal" });
  }
  return res;
}

const CORP_SUFFIX = /\b(inc|llc|ltd|lp|llp|plc|gmbh|co|corp|corporation|company|pharmaceuticals?|pharma|therapeutics|biosciences?|sciences?|science|technologies|technology|biotech|ag|sa|bv|nv|holdings|group|intl|international|ventures|partners)\b/g;
function normalizeEntity(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(CORP_SUFFIX, " ")
    .replace(/^\s*the\s+/, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s) { return new Set(normalizeEntity(s).split(" ").filter(w => w.length > 1)); }
function fuzzy(a, b) {
  const na = normalizeEntity(a), nb = normalizeEntity(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const jacc = inter / union;
  const contain = inter / Math.min(A.size, B.size);
  return Math.max(jacc, contain * 0.95);
}

// Fix common double-encoded UTF-8 mojibake + curly punctuation seen in the corpus.
function cleanText(s) {
  return String(s || "")
    .replace(/‚Äô|’|`/g, "'")
    .replace(/‚Äú|‚Äù|“|”/g, '"')
    .replace(/‚Äì|‚Äî|–|—/g, "-")
    .replace(/Â|�/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ASCO/ICMJE-style structured disclosure blobs: "Name Category: orgs Name Category: orgs".
// These have no sentence delimiters, so prose segmentation collapses every author onto
// whoever's surname happens to appear. We instead slice out ONLY the scholar's own section.
const CAT_ALT = "Honoraria|Consulting or Advisory Role|Advisory Role|Research Funding|Speakers?'?s? Bureau|Stock and Other Ownership Interests|Stock and Other Ownership|Ownership Interests|Employment|Expert Testimony|Patents, Royalties, Other Intellectual Property|Patents, Royalties|Leadership|Travel, Accommodations, Expenses|Other Relationship";
const CAT_COLON = new RegExp(`\\b(?:${CAT_ALT})\\s*:`, "g");
// A person-name header that introduces a new author's section (FirstName [M.] [particle] LastName).
const NAME_HEADER = new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z]\\.?)?(?:\\s+(?:van|von|de|del|della|di|la))?\\s+[A-Z][a-z]+)\\s+(?=(?:${CAT_ALT})\\s*:)`, "g");

function isStructured(stmt) {
  const m = stmt.match(CAT_COLON);
  return m && m.length >= 3;
}

// Return the scholar's own section text, or null if it can't be cleanly bounded
// (in which case the caller conservatively suppresses the whole blob).
// Words that begin org/section fragments, not author first names — block them from
// posing as a new-author header (else "Clinical Oncology" truncates a real section).
const NOT_A_NAME_LEADER = new Set([
  "american","national","other","research","memorial","foundation","university","institute","society",
  "center","clinical","personal","travel","patents","stock","consulting","honoraria","employment","royalties",
  "ownership","leadership","expert","accommodations","expenses","new","the","board","scientific","advisory",
  "international","european","college","association","department","medical","health","cancer","oncology","school",
]);
function scholarSlice(stmt, scholar) {
  if (!scholar.surnameRe) return null;
  const headers = [];
  let m;
  NAME_HEADER.lastIndex = 0;
  while ((m = NAME_HEADER.exec(stmt))) {
    const lead = m[1].trim().split(/\s+/)[0].toLowerCase();
    if (NOT_A_NAME_LEADER.has(lead)) continue;
    headers.push({ name: m[1], index: m.index, end: m.index + m[1].length });
  }
  if (!headers.length) return null;
  const si = headers.findIndex(h => scholar.surnameRe.test(h.name));
  if (si === -1) return null;                       // scholar not a clean section header -> suppress
  const start = headers[si].index;
  const end = si + 1 < headers.length ? headers[si + 1].index : stmt.length;
  return stmt.slice(start, end);
}

function catClass(catName) {
  if (/research funding|grant/i.test(catName)) return "funder";
  if (/employment/i.test(catName)) return "employer";
  return "personal";
}

function splitOrgs(text) {
  return text
    .replace(/\((?:Inst|I)\)/gi, " ")             // institutional/immediate-family markers
    .split(/,| and | & |\//i)
    .map(s => s.replace(/[^A-Za-z0-9 .&'-]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Turn the scholar's structured section into attributed entity units.
function structuredEntities(slice, scholar) {
  const units = [];
  const re = new RegExp(`\\b(${CAT_ALT})\\s*:\\s*([^]*?)(?=\\b(?:${CAT_ALT})\\s*:|$)`, "g");
  let m;
  while ((m = re.exec(slice))) {
    const cat = catClass(m[1]);
    const entities = [];
    for (const org of splitOrgs(m[2])) {
      if (org.length < 2) continue;
      if (looksLikePersonName(org) || HOME_INSTITUTION.test(org) || looksLikeGrantId(org)) continue;
      if (scholar.surname && fuzzy(org, scholar.surname) >= 0.8) continue;
      const words = org.split(/\s+/).filter(Boolean);
      if (words.every(w => ENTITY_STOP.has(w.toLowerCase().replace(/[^a-z]/gi, "")))) continue;
      const gaz = GAZ_RE.some(g => g.re.test(org));
      entities.push({ raw: org, score: gaz ? 0.9 : 0.75, cat });
    }
    if (entities.length)
      units.push({
        attribution: { level: "scholar", score: 0.85, reason: "ASCO-structured section header" },
        entities, source: `${m[1]}: ${m[2].trim()}`.slice(0, 400),
      });
  }
  return units;
}

// Unified: return attributed entity units for a statement (prose or structured).
function statementUnits(stmtRaw, scholar) {
  const stmt = cleanText(stmtRaw);
  if (isStructured(stmt)) {
    const slice = scholarSlice(stmt, scholar);
    if (!slice) {
      const present = scholar.surnameRe && scholar.surnameRe.test(stmt);
      return { units: [], unparsedStructured: !!present };
    }
    return { units: structuredEntities(slice, scholar), unparsedStructured: false };
  }
  const units = segment(stmt).map(clause => ({
    attribution: attribute(clause, scholar),
    entities: extractEntities(clause),
    source: clause,
  }));
  return { units, unparsedStructured: false };
}

const NEAR_DISCLOSED = 0.6; // recall-biased: >= this vs a disclosed entity => treat as disclosed

function nearestDisclosed(entity, disclosedEntities) {
  let best = { score: 0, entity: "" };
  for (const d of disclosedEntities) {
    const s = fuzzy(entity, d);
    if (s > best.score) best = { score: s, entity: d };
  }
  return best;
}

function tierOf({ attribution, entityScore, cat, nearScore }) {
  if (nearScore >= NEAR_DISCLOSED) return { tier: "Low", why: "near a disclosed entity (treat as disclosed)" };
  if (cat !== "personal") return { tier: "Low", why: `${cat} clause — no WRG analog` };
  if (attribution.level === "other") return { tier: "Low", why: "attributed to another author" };
  if (attribution.level === "scholar" && attribution.score >= 0.7 && entityScore >= 0.7)
    return { tier: "High", why: "scholar-attributed + strong entity, not disclosed" };
  if (entityScore >= 0.5 && attribution.level !== "other")
    return { tier: "Medium", why: "plausible but soft attribution or weak entity" };
  return { tier: "Low", why: "weak signal" };
}

function failureModeGuess({ attribution, cat, nearScore, entityScore }) {
  if (attribution.level === "other") return "co-author";
  if (cat === "funder") return "funder";
  if (cat === "employer") return "employer";
  if (nearScore >= 0.4 && nearScore < NEAR_DISCLOSED) return "entity-variant?";
  if (entityScore < 0.6) return "extraction-noise?";
  return "candidate-TRUE?";
}

// ------------------------------ run --------------------------------
function main() {
  const faculty = readCsvObjects(join(OUT_DIR, "faculty.csv"));
  const knowns = readCsvObjects(join(OUT_DIR, "knowns.csv"));
  const conflicts = readCsvObjects(join(OUT_DIR, "conflicts.csv"));
  const disclosed = readCsvObjects(join(OUT_DIR, "disclosed.csv"));

  const stmtByPmid = new Map(conflicts.map(c => [c.pmid, c.statement]));
  const pmidsByCwid = new Map();
  for (const k of knowns) {
    if (!pmidsByCwid.has(k.cwid)) pmidsByCwid.set(k.cwid, []);
    pmidsByCwid.get(k.cwid).push(k.pmid);
  }
  const disclosedByCwid = new Map();
  for (const d of disclosed) {
    if (!disclosedByCwid.has(d.cwid)) disclosedByCwid.set(d.cwid, []);
    // only Self relationships are personal-disclosable analogs
    disclosedByCwid.get(d.cwid).push(d);
  }
  const facById = new Map(faculty.map(f => [f.cwid, f]));

  const candidates = [];
  const stat = {
    facultyEvaluated: 0, stmtsEvaluated: 0, pureNegation: 0,
    stmtsWithCandidate: 0, stmtsWithHiMed: 0,
    coauthorSuppressed: 0, nearDisclosedSuppressed: 0, funderEmployerSuppressed: 0,
    unparsedStructured: 0,
  };
  const tierHist = { High: 0, Medium: 0, Low: 0 };
  const fmHist = {};

  for (const f of faculty) {
    const pmids = pmidsByCwid.get(f.cwid) || [];
    const disc = (disclosedByCwid.get(f.cwid) || []);
    const discSelf = disc.filter(d => /self/i.test(d.relatesTo)).map(d => d.entity).filter(Boolean);
    const discAll = disc.map(d => d.entity).filter(Boolean);
    const scholar = deriveScholar(f.first, f.last);
    let evaluatedAny = false;
    const perFacCand = new Map(); // normalized entity -> best candidate (dedupe)

    for (const pmid of pmids) {
      const stmt = stmtByPmid.get(pmid);
      if (stmt === undefined) continue;           // no COI text for this pmid
      evaluatedAny = true;
      stat.stmtsEvaluated++;
      if (isPureNegation(stmt)) { stat.pureNegation++; continue; }

      let stmtHasCand = false, stmtHasHiMed = false;
      const { units, unparsedStructured } = statementUnits(stmt, scholar);
      if (unparsedStructured) stat.unparsedStructured++;
      for (const unit of units) {
        const attribution = unit.attribution;
        const ents = unit.entities;
        const clause = unit.source;
        for (const e of ents) {
          // skip the scholar's own name as an "entity"
          if (scholar.surname && fuzzy(e.raw, scholar.surname) >= 0.8) continue;
          // drop junk: bare corporate suffix ("Inc.", "Co"), all-stopword fragments, too-short
          const norm = normalizeEntity(e.raw);
          if (!norm || norm.replace(/\s/g, "").length < 3) continue;
          const nd = nearestDisclosed(e.raw, discSelf.length ? discSelf : discAll);
          const t = tierOf({ attribution, entityScore: e.score, cat: e.cat, nearScore: nd.score });
          const fm = failureModeGuess({ attribution, cat: e.cat, nearScore: nd.score, entityScore: e.score });
          tierHist[t.tier]++;
          fmHist[fm] = (fmHist[fm] || 0) + 1;
          if (t.tier === "Low") {
            if (attribution.level === "other") stat.coauthorSuppressed++;
            else if (nd.score >= NEAR_DISCLOSED) stat.nearDisclosedSuppressed++;
            else if (e.cat !== "personal") stat.funderEmployerSuppressed++;
            continue; // suppressed — not surfaced
          }
          stmtHasCand = true;
          if (t.tier === "High" || t.tier === "Medium") stmtHasHiMed = true;
          const key = normalizeEntity(e.raw);
          const cand = {
            cwid: f.cwid, last: f.last, first: f.first, pmid,
            tier: t.tier, attribution: attribution.level, attribution_reason: attribution.reason,
            extracted_entity: e.raw, normalized: key, entity_score: e.score.toFixed(2),
            nearest_disclosed: nd.entity, nearest_score: nd.score.toFixed(2),
            failure_mode_guess: fm, tier_why: t.why,
            source_sentence: clause, LABEL: "",
          };
          const prev = perFacCand.get(key);
          const rank = { High: 3, Medium: 2, Low: 1 };
          if (!prev || rank[cand.tier] > rank[prev.tier]) perFacCand.set(key, cand);
        }
      }
      if (stmtHasCand) stat.stmtsWithCandidate++;
      if (stmtHasHiMed) stat.stmtsWithHiMed++;
    }
    if (evaluatedAny) stat.facultyEvaluated++;
    for (const c of perFacCand.values()) candidates.push(c);
  }

  // ---- write candidates.csv ----
  const header = ["cwid","last","first","pmid","tier","attribution","attribution_reason",
    "extracted_entity","normalized","entity_score","nearest_disclosed","nearest_score",
    "failure_mode_guess","tier_why","source_sentence","LABEL"];
  candidates.sort((a, b) => ({High:0,Medium:1,Low:2}[a.tier] - {High:0,Medium:1,Low:2}[b.tier]) || a.cwid.localeCompare(b.cwid));
  writeCsv(join(OUT_DIR, "candidates.csv"), header, candidates);

  const surfaced = candidates.length;
  const hi = candidates.filter(c => c.tier === "High").length;
  const med = candidates.filter(c => c.tier === "Medium").length;
  const facWithGap = new Set(candidates.filter(c => c.tier !== "Low").map(c => c.cwid)).size;
  const substantive = stat.stmtsEvaluated - stat.pureNegation;
  const gapRate = substantive ? (100 * stat.stmtsWithHiMed / substantive) : 0;

  // ---- report.md ----
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "—";
  const lines = [];
  lines.push("# Track A — Phase 0 precision harness — run report");
  lines.push("");
  lines.push("> Validates the extraction/normalization/diff/attribution core against the 2022 reference corpus.");
  lines.push("> Precision is decided by HUMAN labels on `candidates.csv` (LABEL column); the numbers below are the");
  lines.push("> automated gap rate + a heuristic failure-mode preview, not a precision claim.");
  lines.push("");
  lines.push("## Population");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Faculty evaluated (valid cwid in both files) | ${stat.facultyEvaluated} |`);
  lines.push(`| Statements evaluated (pmids with COI text) | ${stat.stmtsEvaluated} |`);
  lines.push(`| — pure negation / boilerplate (no disclosure) | ${stat.pureNegation} (${pct(stat.pureNegation, stat.stmtsEvaluated)}) |`);
  lines.push(`| — substantive statements | ${substantive} |`);
  lines.push("");
  lines.push("## Gap rate (vs capstone ~37% of statements undeclared)");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Substantive statements with ≥1 High/Medium candidate | ${stat.stmtsWithHiMed} |`);
  lines.push(`| **Statement-level gap rate (High/Medium)** | **${gapRate.toFixed(1)}%** |`);
  lines.push(`| Faculty with ≥1 surfaced gap | ${facWithGap} / ${stat.facultyEvaluated} (${pct(facWithGap, stat.facultyEvaluated)}) |`);
  lines.push("");
  lines.push("> Caveat: population excludes zero-disclosure faculty (we require a known disclosed set), so this rate is");
  lines.push("> expected at or BELOW the capstone's 37% which included them. A rate in a plausible band (~20–40%) with");
  lines.push("> sane failure modes validates the core; the exact number is not the deliverable — precision is.");
  lines.push("");
  lines.push("## Candidate tiers (surfaced)");
  lines.push("");
  lines.push("| Tier | Count |");
  lines.push("|---|---|");
  lines.push(`| High (would render on /edit) | ${hi} |`);
  lines.push(`| Medium (shown above suppression floor) | ${med} |`);
  lines.push(`| Surfaced total (deduped per faculty+entity) | ${surfaced} |`);
  lines.push("");
  lines.push("## Suppression — the false-positive avoidance Track A demonstrates");
  lines.push("");
  lines.push("| Suppressed because | Count |");
  lines.push("|---|---|");
  lines.push(`| Attributed to a co-author (the dominant FP) | ${stat.coauthorSuppressed} |`);
  lines.push(`| Near a disclosed entity (Case 2 / entity-variant) | ${stat.nearDisclosedSuppressed} |`);
  lines.push(`| Funder/employer clause (no WRG analog) | ${stat.funderEmployerSuppressed} |`);
  lines.push(`| Structured ASCO blob with scholar present but section unbounded (whole blob suppressed — conservative) | ${stat.unparsedStructured} |`);
  lines.push("");
  lines.push("## Heuristic failure-mode preview (NOT human labels)");
  lines.push("");
  lines.push("| Auto guess | Count |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(fmHist).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## Sample High-tier candidates (eyeball precision)");
  lines.push("");
  const sampleHi = candidates.filter(c => c.tier === "High").slice(0, 12);
  for (const c of sampleHi) {
    lines.push(`- **${c.extracted_entity}** — ${c.first} ${c.last} (PMID ${c.pmid})`);
    lines.push(`  - attribution: ${c.attribution} (${c.attribution_reason}); nearest disclosed: "${c.nearest_disclosed}" @ ${c.nearest_score}`);
    lines.push(`  - source: _"${c.source_sentence}"_`);
  }
  lines.push("");
  lines.push("## Sample suppressed co-author cases (the FP avoidance)");
  lines.push("");
  // re-derive a few by scanning (not stored when suppressed); show note
  lines.push("_Co-author suppressions are counted above but not written to candidates.csv (they are correctly not surfaced)._");
  lines.push("");
  lines.push(`Outputs: \`candidates.csv\` (${surfaced} rows — label the LABEL column), \`report.md\` (this file).`);
  const report = lines.join("\n") + "\n";
  writeFileSync(join(OUT_DIR, "report.md"), report);
  process.stdout.write(report);
}

main();
