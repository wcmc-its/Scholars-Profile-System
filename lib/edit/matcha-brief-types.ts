/**
 * Matcha Phase 3 briefs: the CLIENT-SAFE half. Wire shapes and pure display helpers shared by the
 * server (`lib/api/matcha-brief.ts`, which re-exports the shapes) and the console panel
 * (`components/edit/matcha-panel.tsx`, a "use client" module).
 *
 * Never import `@/lib/db`, `@/lib/llm/*` or anything else server-only here: the panel bundles this
 * file, and a db import would drag the mariadb driver into the client build.
 */

import { htmlToPlainText } from "@/lib/utils";

/** A topic's supporting fact, resolved from the model's key — never model-written. */
export type BriefSource =
  | { kind: "pub"; pmid: string; year: number | null; title: string }
  | {
      kind: "grant";
      mechanism: string | null;
      funder: string;
      endYear: number;
      applId: number | null;
    };

export type BriefTopic = {
  /** One of the candidate's matched concept terms, verbatim from the saved search. */
  concept: string;
  text: string;
  /** Empty on a topic the officer edited (it is then their own, unsourced). */
  sources: BriefSource[];
};

export type BriefGenerated = {
  why: string;
  /** 1-2 sentences: the research collaboration this PI could offer the requester, or
   *  `NO_LAB_ANGLE` when the draft found none. Absent on briefs drafted before it existed; read
   *  it through `briefAngle`, which treats absent as "". */
  angle?: string;
  /** A 3-5 word noun phrase: the role the angle sentence is built around ("Disease-model validation partner"),
   *  shown bold with a trailing period before it (`angleRoleLead`); the sentence does not restate
   *  it. Absent on briefs drafted before it existed and when the model gave no valid one;
   *  read it through `briefAngleRole`. */
  angleRole?: string;
  /** The names in `records.methods` the model labelled data sources (registries, claims/EHR data,
   *  cohorts, biobanks, national databases, trial datasets). Each is one of the method names it
   *  was given, never invented. Absent on older briefs = no split (every method is a "Method"). */
  dataSources?: string[];
  /** The model's curated "Methods and tools": at most `MAX_METHOD_PILLS` short labels, most
   *  relevant to the ask first, aliases merged, generic statistics left out. `from` lists the
   *  `records.methods` names each pill stands for (post-checked: each names a given method).
   *  Absent on older briefs; read it through `briefMethodPills`. When present, `dataSources` is
   *  derived from it (every `from` name of a "data" pill). */
  methodPills?: MethodPill[];
  topics: BriefTopic[];
  /** How many unsupported statements the fact-check removed. A count only — never the claim. */
  removedCount: number;
};

/** The officer's version. A field present here wins over `generated`; absent = not edited. */
export type BriefEdited = {
  why?: string;
  angle?: string;
  angleRole?: string;
  topics?: BriefTopic[];
};

/** The stored angle of a brief whose draft found no laboratory or disease-mechanism collaboration
 *  to propose. Shown to the officer as this sentence; everywhere else it counts as no angle
 *  (`hasAngle`). */
export const NO_LAB_ANGLE = "No laboratory collaboration angle is evident.";

/** Whether `angle` is a real partnership angle: not empty, and not the `NO_LAB_ANGLE` sentence. */
export function hasAngle(angle: string | null | undefined): boolean {
  const a = (angle ?? "").trim();
  return a !== "" && a !== NO_LAB_ANGLE;
}

/** Longest role phrase the model or an officer may store. */
export const MAX_ANGLE_ROLE_CHARS = 60;

/** One curated method pill as stored. */
export type MethodPill = { label: string; kind: "data" | "method"; from: string[] };
/** At most this many pills per brief. */
export const MAX_METHOD_PILLS = 12;
/** Longest pill label kept; a longer one is not a short label and is dropped. */
export const MAX_METHOD_PILL_CHARS = 40;

export type BriefRecords = {
  funding: {
    mechanism: string | null;
    funder: string;
    title: string;
    endYear: number;
    applId: number | null;
    roleLabel: string;
    /** NIH institute code ("NIDDK"); the report's short sponsor. Absent/null when not NIH. */
    nihIc?: string | null;
    /** InfoEd program type ("Grant", "BioPharma Alliance Agreement", …): the report's funder-type
     *  label for an award with no mechanism code. */
    programType?: string;
  }[];
  translation: { title: string; patentStatus: string | null; url: string }[];
  secondaryAppointments: { title: string; organization: string }[];
  centers: string[];
  /** All `ScholarTool` rows (up to a sanity cap) by distinct papers, strongest first. */
  methods: { name: string; category: string | null; papers: number }[];
  /** Distinct clinical trials on record (`PersonClinicalTrial`). */
  trialCount: number;
};

/** One brief as `/api/edit/matcha/brief` ships it (GET, POST stream lines, PATCH). */
export type BriefWire = {
  cwid: string;
  generated: BriefGenerated;
  edited: BriefEdited | null;
  /** Shared by everyone who opens the paste. NEVER exported. */
  note: string | null;
  model: string;
  draftedAt: string;
  updatedAt: string;
};

/** The text the officer sees: their edit when present, else the generated text. */
export function briefWhy(b: Pick<BriefWire, "generated" | "edited">): string {
  return b.edited?.why ?? b.generated.why;
}

/** The partnership angle on screen; "" for a brief drafted before angles existed, and the
 *  `NO_LAB_ANGLE` sentence when the draft found none (test with `hasAngle`). */
export function briefAngle(b: Pick<BriefWire, "generated" | "edited">): string {
  return b.edited?.angle ?? b.generated.angle ?? "";
}

/** The bold role before the angle; "" for a brief drafted before roles existed (the angle then
 *  prints unbolded). */
export function briefAngleRole(b: Pick<BriefWire, "generated" | "edited">): string {
  return b.edited?.angleRole ?? b.generated.angleRole ?? "";
}

/** The bold lead before the angle sentence: the role with a trailing period ("Clinical-trial
 *  lead."), unless it already ends in sentence punctuation. "" for no role. */
export function angleRoleLead(role: string): string {
  const r = role.trim();
  if (!r) return "";
  return /[.!?]$/.test(r) ? r : `${r}.`;
}

/** The brief's curated method pills, each with a paper count: the most papers of any `methods`
 *  row (the live records) the pill stands for, 0 when none is on record any more. [] for an older
 *  brief with no pills; callers then fall back to `splitMethods`. */
export function briefMethodPills(
  b: Pick<BriefWire, "generated">,
  methods: readonly { name: string; papers: number }[],
): { label: string; kind: "data" | "method"; papers: number }[] {
  const pills = b.generated.methodPills ?? [];
  if (pills.length === 0) return [];
  const papersByName = new Map<string, number>();
  for (const m of methods) {
    const key = normalizeMethodName(m.name);
    papersByName.set(key, Math.max(papersByName.get(key) ?? 0, m.papers));
  }
  return pills.map((p) => ({
    label: p.label,
    kind: p.kind,
    papers: Math.max(0, ...p.from.map((n) => papersByName.get(normalizeMethodName(n)) ?? 0)),
  }));
}

/** The method names the model labelled data sources; [] for an older brief (no split). */
export function briefDataSources(b: Pick<BriefWire, "generated">): string[] {
  return b.generated.dataSources ?? [];
}

/** A method name folded for matching: lowercase, every run of whitespace/punctuation collapsed to
 *  one space. "RNA-seq" and "RNA seq" fold together. */
export function normalizeMethodName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

/** Merge methods whose names fold together (`normalizeMethodName`), keeping the row with the most
 *  papers, at the position of the first occurrence. */
export function dedupeMethods<T extends { name: string; papers: number }>(methods: readonly T[]): T[] {
  const out: T[] = [];
  const at = new Map<string, number>();
  for (const m of methods) {
    const key = normalizeMethodName(m.name);
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push(m);
    } else if (m.papers > out[i].papers) {
      out[i] = m;
    }
  }
  return out;
}

/** Split a methods list into the ones named in `dataSourceNames` (matched case- and
 *  punctuation-insensitively) and the rest, each keeping its order. No names = all methods. */
export function splitMethods<T extends { name: string }>(
  methods: readonly T[],
  dataSourceNames: readonly string[],
): { dataSources: T[]; methods: T[] } {
  const names = new Set(dataSourceNames.map(normalizeMethodName));
  const dataSources: T[] = [];
  const rest: T[] = [];
  for (const m of methods) (names.has(normalizeMethodName(m.name)) ? dataSources : rest).push(m);
  return { dataSources, methods: rest };
}

export function briefTopics(b: Pick<BriefWire, "generated" | "edited">): BriefTopic[] {
  return b.edited?.topics ?? b.generated.topics;
}

/** The compact row's one-liner: the first sentence of Why this PI. Derived, so it cannot go stale
 *  after an edit. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^.*?[.!?](?=\s|$)/s.exec(t);
  return (m ? m[0] : t).trim();
}

/** A publication title cut to a few words, for an inline source label. */
export function shortTitle(title: string, maxWords = 6): string {
  const words = title
    .trim()
    .replace(/[.\s]+$/, "")
    .split(/\s+/);
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")}…`;
}

/** "2024 · Endothelial barrier function in…" / "R01 (through 2028)". */
export function briefSourceLabel(s: BriefSource): string {
  if (s.kind === "pub") {
    // Strip PubMed markup BEFORE the word cut, so a cut can never leave an
    // unclosed `<i>` and entities (`&lt;18`) read as characters.
    const title = shortTitle(htmlToPlainText(s.title, Number.POSITIVE_INFINITY));
    return s.year != null ? `${s.year} · ${title}` : title;
  }
  return `${s.mechanism ?? s.funder} (through ${s.endYear})`;
}

/** The public link for a source, or null when there is none to give. */
export function briefSourceUrl(s: BriefSource): string | null {
  if (s.kind === "pub") return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(s.pmid)}/`;
  return s.applId != null ? reporterUrl(s.applId) : null;
}

export function reporterUrl(applId: number): string {
  return `https://reporter.nih.gov/project-details/${applId}`;
}

/** The label a topic line carries when it has no source: an edited or new line, or a generated
 *  line whose sources no longer hold. */
export const UNSOURCED_LABEL = "your edit, unsourced";

/** "Name · N papers" for one method row. */
export function methodLabel(m: { name: string; papers: number }): string {
  return `${m.name} · ${m.papers} ${m.papers === 1 ? "paper" : "papers"}`;
}

/** The collapsed "Methods and tools" control's text: "Methods and tools · 23 · 2 clinical trials
 *  on record", each count omitted when zero. */
export function methodsSummary(methodCount: number, trialCount: number): string {
  return [
    "Methods and tools",
    ...(methodCount > 0 ? [String(methodCount)] : []),
    ...(trialCount > 0
      ? [`${trialCount} clinical ${trialCount === 1 ? "trial" : "trials"} on record`]
      : []),
  ].join(" · ");
}
