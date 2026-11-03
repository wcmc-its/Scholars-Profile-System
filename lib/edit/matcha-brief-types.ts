/**
 * Matcha Phase 3 briefs: the CLIENT-SAFE half. Wire shapes and pure display helpers shared by the
 * server (`lib/api/matcha-brief.ts`, which re-exports the shapes) and the console panel
 * (`components/edit/matcha-panel.tsx`, a "use client" module).
 *
 * Never import `@/lib/db`, `@/lib/llm/*` or anything else server-only here: the panel bundles this
 * file, and a db import would drag the mariadb driver into the client build.
 */

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
  topics: BriefTopic[];
  /** How many unsupported statements the fact-check removed. A count only — never the claim. */
  removedCount: number;
};

/** The officer's version. A field present here wins over `generated`; absent = not edited. */
export type BriefEdited = { why?: string; topics?: BriefTopic[] };

export type BriefRecords = {
  funding: {
    mechanism: string | null;
    funder: string;
    title: string;
    endYear: number;
    applId: number | null;
    roleLabel: string;
  }[];
  translation: { title: string; patentStatus: string | null; url: string }[];
  secondaryAppointments: { title: string; organization: string }[];
  centers: string[];
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
    return s.year != null ? `${s.year} · ${shortTitle(s.title)}` : shortTitle(s.title);
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
