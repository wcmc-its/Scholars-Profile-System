/**
 * #3071 — the grant attribution queue's one layout for all three tabs: a list
 * beside the focused award's detail. Pure and client-safe; the To review cards
 * (`GrantAttributionItem`) and the decided tabs' rows (`DecidedRow`) both
 * become a `BoardRow` here.
 *
 * Evidence and decision are kept apart. The evidence level is read off the
 * weekly check's score and cues only; who placed the award in its tab (a
 * curator, or the check on its own) is the decision, shown beside it and never
 * folded into the score.
 */
import { HIDE_AT, SHOW_AT, type DecidedRow, type DecidedTab } from "./grant-attribution-decided";
import {
  isVetoCue,
  type GrantAttributionAward,
  type GrantAttributionCue,
  type GrantAttributionItem,
} from "./grant-attribution-queue";

export type BoardTab = "pending" | Exclude<DecidedTab, "unproven">;

/** The read-only evidence scale, from the score. */
export const EVIDENCE_LEVELS = [
  { key: "supports", label: "Supports", desc: `Meets the +${SHOW_AT} confirm line.` },
  {
    key: "leans-for",
    label: "Leans for",
    desc: `Evidence for, but below the +${SHOW_AT} confirm line.`,
  },
  { key: "mixed", label: "Mixed", desc: "Cues point both ways." },
  { key: "none", label: "None found", desc: "Nothing found for or against." },
  {
    key: "leans-against",
    label: "Leans against",
    desc: `Evidence against, above the −${Math.abs(HIDE_AT)} hide line.`,
  },
  {
    key: "against",
    label: "Against",
    desc: `At or below the −${Math.abs(HIDE_AT)} hide line, with evidence against.`,
  },
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]["key"];

export function isEvidenceLevel(v: string): v is EvidenceLevel {
  return EVIDENCE_LEVELS.some((l) => l.key === v);
}

export function evidenceLevelLabel(l: EvidenceLevel): string {
  return EVIDENCE_LEVELS.find((x) => x.key === l)!.label;
}

/** A cue that points away from the scholar. The named InfoEd cue counts at any
 *  weight: reviews stored before 2026-10-24 carry it at 0. */
const against = (c: Pick<GrantAttributionCue, "id" | "weight">) => c.weight < 0 || isVetoCue(c);

/** Where the score and cues put an award on the evidence scale. */
export function evidenceLevel(
  score: number,
  cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight">>,
): EvidenceLevel {
  const pos = cues.some((c) => c.weight > 0);
  const neg = cues.some(against);
  if (score >= SHOW_AT) return "supports";
  if (!pos && !neg) return "none";
  if (score <= HIDE_AT && neg) return "against";
  if (pos && neg) return "mixed";
  return pos ? "leans-for" : "leans-against";
}

/** "Color: slate means evidence for, amber means evidence against, neutral
 *  means none or mixed." */
export function levelTone(l: EvidenceLevel): "for" | "against" | "neutral" {
  if (l === "supports" || l === "leans-for") return "for";
  if (l === "against" || l === "leans-against") return "against";
  return "neutral";
}

export type BoardSort = "high" | "low" | "name";

/** To review and Not this person read score high to low; Confirmed low to
 *  high, so the least certain awards come first. */
export function defaultSort(tab: BoardTab | DecidedTab): BoardSort {
  return tab === "confirmed" ? "low" : "high";
}

/** One award on any tab, as the board renders it. */
export type BoardRow = {
  /** The list key, and what a To review decision posts: the review id, or for
   *  an award with no review yet, its grant externalId. */
  id: string;
  grantId: string;
  reviewId: string | null;
  /** To review, with no review yet: the check found nothing either way. */
  unproven: boolean;
  tab: BoardTab;
  /** Null on To review: nobody has decided it. */
  by: "curator" | "auto" | null;
  when: string | null;
  decidedByName: string | null;
  rejectionReason: string | null;
  was: "hidden" | "queued" | null;
  stillHidden: boolean;
  /** New, reopened, shown again or hidden by the latest weekly check. */
  changed: "new" | "reopened" | "shown" | "hidden" | null;
  reopenedNote: string | null;
  score: number;
  /** Strongest first. */
  cues: GrantAttributionCue[];
  level: EvidenceLevel;
  award: GrantAttributionAward;
  reporterName: string | null;
  scholar: {
    cwid: string;
    slug: string | null;
    /** As the profile renders it, postnominals included. */
    name: string;
    /** Last name first, for Scholar A–Z. */
    sortName: string;
    /** Title · department · doctorate, whichever are known. */
    sub: string;
    names: string[];
  };
};

const byStrength = (cues: ReadonlyArray<GrantAttributionCue>) =>
  [...cues].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

function sortNameOf(display: string): string {
  const words = display.split(",")[0]!.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return display;
  return `${words[words.length - 1]}, ${words.slice(0, -1).join(" ")}`;
}

/** A To review card. `since`: when the previous weekly check finished, for
 *  "changed this run". */
export function fromQueueItem(it: GrantAttributionItem, since: string | null): BoardRow {
  const after = (iso: string | null) => !!iso && (since === null || iso > since);
  const reopened = after(it.reopenedAt);
  return {
    id: it.id,
    grantId: it.grantId,
    reviewId: it.unproven ? null : it.id,
    unproven: it.unproven,
    tab: "pending",
    by: null,
    when: null,
    decidedByName: it.decidedByName,
    rejectionReason: it.rejectionReason,
    was: null,
    stillHidden: false,
    // An Unproven award's date is its latest scoring, so it is never "new".
    changed: reopened ? "reopened" : !it.unproven && after(it.firstSeenAt) ? "new" : null,
    reopenedNote: it.reopenedAt
      ? it.decidedAt !== null && it.decidedAt === it.reopenedAt
        ? `Sent back to review by ${it.decidedByName ?? "a curator"}; the weekly check had settled it on its own.`
        : it.decidedByName
          ? `Reopened: the evidence changed after a decision by ${it.decidedByName}, which stands until this is decided again.`
          : "Reopened: the evidence changed after a decision."
      : null,
    score: it.score,
    cues: byStrength(it.cues),
    level: evidenceLevel(it.score, it.cues),
    award: it.award,
    reporterName: it.reporterName,
    scholar: {
      cwid: it.cwid,
      slug: it.slug,
      name: it.scholarName,
      sortName: sortNameOf(it.scholarName),
      sub: [it.title, it.department].filter(Boolean).join(" · "),
      names: it.scholarNames,
    },
  };
}

/** A Confirmed or Not this person row. */
export function fromDecidedRow(r: DecidedRow): BoardRow {
  return {
    id: r.grantId,
    grantId: r.grantId,
    reviewId: r.reviewId,
    unproven: false,
    tab: r.tab === "rejected" ? "rejected" : "confirmed",
    by: r.by,
    when: r.when,
    decidedByName: r.decidedByName,
    rejectionReason: r.rejectionReason,
    was: r.was,
    stillHidden: r.stillHidden,
    changed: r.changed ? (r.tab === "confirmed" ? "shown" : "hidden") : null,
    reopenedNote: null,
    score: r.score,
    cues: byStrength(r.cues),
    level: evidenceLevel(r.score, r.cues),
    award: r.award,
    reporterName: r.reporterName,
    scholar: {
      cwid: r.scholar.cwid,
      slug: r.scholar.slug,
      name: r.scholar.displayName,
      sortName: r.scholar.name,
      sub: [r.scholar.title, r.scholar.department, r.scholar.career].filter(Boolean).join(" · "),
      names: r.scholar.names,
    },
  };
}

/** The ledger's "Main reason": the cue that put the award where it is. */
export function mainCue(row: Pick<BoardRow, "tab" | "cues">): GrantAttributionCue | null {
  if (row.tab === "confirmed") return row.cues.find((c) => c.weight > 0) ?? null;
  if (row.tab === "rejected") return row.cues.find(against) ?? null;
  return row.cues.find((c) => c.weight !== 0) ?? null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The quiet line under a list row: who placed it and when. */
export function provenance(row: BoardRow): string {
  if (row.by === null) {
    return row.changed === "reopened"
      ? "Reopened this run"
      : row.changed === "new"
        ? "New this run"
        : "";
  }
  const d = fmtDate(row.when);
  if (row.by === "curator") return ["Curator", d].filter(Boolean).join(" · ");
  const extra = row.stillHidden
    ? "still hidden until the next run"
    : row.was === "hidden"
      ? "was hidden"
      : row.was === "queued"
        ? "was in review"
        : "";
  return ["Automatic", d, extra].filter(Boolean).join(" · ");
}

/** The Decision cell: who placed the award in its tab, and what can still
 *  change it. */
export function decisionSummary(row: BoardRow): { title: string; note: string } {
  if (row.by === null) {
    if (row.reopenedNote) return { title: "Not decided", note: row.reopenedNote };
    return {
      title: "Not decided",
      note:
        row.level === "none"
          ? "Off the profile. Rechecked weekly; moves to Confirmed on its own if evidence turns up."
          : "Off the profile until a curator decides.",
    };
  }
  const confirmed = row.tab === "confirmed";
  const verb = confirmed ? "Confirmed" : "Marked not this person";
  const d = fmtDate(row.when);
  if (row.by === "curator") {
    const who = row.decidedByName ?? "a curator";
    return {
      title: [`${verb} by ${who}`, d].filter(Boolean).join(" · "),
      note: [
        confirmed ? "On the profile." : "Off the profile.",
        !confirmed && row.rejectionReason ? `Reason: ${row.rejectionReason}.` : "",
        "Won’t change on its own.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  return {
    title: [`${verb} automatically`, d].filter(Boolean).join(" · "),
    note: [
      confirmed
        ? row.stillHidden
          ? "Still off the profile until the next run."
          : "On the profile."
        : "Off the profile.",
      row.was === "hidden"
        ? "Was hidden before."
        : row.was === "queued"
          ? "Was in review before."
          : "",
      `Can move if the weekly check finds evidence ${confirmed ? "against" : "for"}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export type BoardFilters = {
  q: string;
  level: EvidenceLevel | "all";
  by: "all" | "curator" | "auto";
  changed: boolean;
  sort: BoardSort;
};

/** What the search box matches: the scholar, the award, the PIs. */
export function haystack(row: BoardRow): string {
  return [
    row.scholar.name,
    row.scholar.cwid,
    row.award.title,
    row.award.awardNumber,
    row.award.coreProjectNum,
    row.reporterName,
    ...row.award.piNames,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function compareRows(sort: BoardSort): (a: BoardRow, b: BoardRow) => number {
  if (sort === "name")
    return (a, b) => a.scholar.sortName.localeCompare(b.scholar.sortName) || b.score - a.score;
  if (sort === "low")
    return (a, b) => a.score - b.score || a.scholar.sortName.localeCompare(b.scholar.sortName);
  return (a, b) => b.score - a.score || a.scholar.sortName.localeCompare(b.scholar.sortName);
}

/** To review's filter and sort, done in the browser: it holds every card. */
export function filterRows(rows: ReadonlyArray<BoardRow>, f: BoardFilters): BoardRow[] {
  const needle = f.q.trim().toLowerCase();
  return rows
    .filter(
      (r) =>
        (f.level === "all" || r.level === f.level) &&
        (f.by === "all" || r.by === f.by) &&
        (!f.changed || r.changed !== null) &&
        (!needle || haystack(r).includes(needle)),
    )
    .sort(compareRows(f.sort));
}

/** Where a score sits on the ledger's scale, −8 to +6, in percent. */
export function scalePct(score: number): number {
  return Math.max(2, Math.min(98, ((score + 8) / 14) * 100));
}
