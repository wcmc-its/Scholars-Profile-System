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
  /** 1-2 sentences: the concrete role this PI could play for the requester. Absent on briefs
   *  drafted before it existed; read it through `briefAngle`, which treats absent as "". */
  angle?: string;
  topics: BriefTopic[];
  /** How many unsupported statements the fact-check removed. A count only — never the claim. */
  removedCount: number;
};

/** The officer's version. A field present here wins over `generated`; absent = not edited. */
export type BriefEdited = { why?: string; angle?: string; topics?: BriefTopic[] };

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

/** The partnership angle on screen; "" for a brief drafted before angles existed. */
export function briefAngle(b: Pick<BriefWire, "generated" | "edited">): string {
  return b.edited?.angle ?? b.generated.angle ?? "";
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
