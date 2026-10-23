/**
 * #3071 — the grant attribution queue (`/edit/grant-attribution-queue`): types,
 * the flag, the viewer predicates, and labels.
 *
 * 🔴 CLIENT-BUNDLED. `components/edit/grant-attribution-queue.tsx` imports this
 * module at runtime, so it must never import `@/lib/db` or anything that builds
 * a Prisma client at module scope (the mariadb driver would break the Next
 * build on `fs`/`net`). The loaders live in `grant-attribution-queue.server.ts`
 * and take the client as a parameter.
 *
 * WHO. Deciding is superuser or comms_steward: exactly who `authorizeRevoke`
 * already lets lift any suppression, so the queue grants no new power. Observers
 * and content editors read it. Never the scholar, a proxy or a unit admin: a
 * scholar must not clear the hold on their own disputed award. Always `||` with
 * `isSuperuser`, never a bare role read (the session route reports some role
 * flags false FOR a superuser).
 */
import { nihReporterProjectUrl } from "@/lib/nih-reporter";

export function isGrantAttributionQueueEnabled(): boolean {
  return process.env.GRANT_ATTRIBUTION_QUEUE === "on";
}

type Viewer = {
  isSuperuser: boolean;
  isCommsSteward?: boolean;
  isObserver?: boolean;
  isContentEditor?: boolean;
};

/** Who may decide a queued award (the decision route re-checks this).
 *
 *  🔴 The READ session (`getEffectiveEditSession`) gives observers and content
 *  editors a synthetic `isCommsSteward: true` so they can see steward pages;
 *  the write path strips it. So this must refuse both explicitly, exactly as
 *  `canPinTitles` does, or the page renders live controls the route 403s. */
export function canDecideGrantAttribution(session: Viewer): boolean {
  return (
    (session.isSuperuser || session.isCommsSteward === true) &&
    session.isObserver !== true &&
    session.isContentEditor !== true
  );
}

/** Who may read the queue: the deciders, plus observers and content editors. */
export function canViewGrantAttributionQueue(session: Viewer): boolean {
  return (
    session.isSuperuser ||
    session.isCommsSteward === true ||
    session.isObserver === true ||
    session.isContentEditor === true
  );
}

/** Read-only for anyone who cannot decide, and for anyone acting under View
 *  as: the decision route refuses every impersonated decision. */
export function isGrantAttributionQueueReadOnly(session: Viewer, viewingAs = false): boolean {
  return viewingAs || !canDecideGrantAttribution(session);
}

/** The tab predicate AND the page gate: the same function, so the tab never
 *  shows to someone the page refuses. */
export function isGrantAttributionQueueTabVisible(session: Viewer): boolean {
  return isGrantAttributionQueueEnabled() && canViewGrantAttributionQueue(session);
}

export type GrantAttributionStatus = "pending" | "confirmed" | "rejected";

export type GrantAttributionPaper = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
};

export type GrantAttributionCue = {
  id: string;
  weight: number;
  reason: string;
  /** Cue `copi_coauthor` from a run that recorded it: the co-PI, as RePORTER
   *  names them, and the papers they share with the scholar (newest first). */
  coPi?: { name: string; total: number; papers: GrantAttributionPaper[] };
};

export type GrantAttributionAward = {
  title: string | null;
  awardNumber: string | null;
  coreProjectNum: string | null;
  activityCode: string | null;
  applId: number | null;
  startYear: number | null;
  endYear: number | null;
  orgs: Array<{ name: string; from: number | null; to: number | null; wcm?: boolean }>;
  piNames: string[];
};

export type GrantAttributionItem = {
  id: string;
  cwid: string;
  slug: string | null;
  /** The name as the profile renders it. */
  scholarName: string;
  /** For marking the scholar in the RePORTER PI list. */
  scholarSurname: string | null;
  title: string | null;
  department: string | null;
  score: number;
  band: string;
  cues: GrantAttributionCue[];
  award: GrantAttributionAward;
  status: GrantAttributionStatus;
  firstSeenAt: string;
  /** Set when a later run reopened this item on new evidence. */
  reopenedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectionReason: string | null;
};

/** "Not this person" reasons. Free text is allowed too (VARCHAR 255). A reason
 *  is required. */
export const GRANT_REJECTION_REASONS = [
  "A different person with the same name",
  "Another WCM investigator's award",
  "Outside the scholar's career",
] as const;

/** The Suppression.reason a "Not this person" decision writes. Prefixed so the
 *  scholar-facing funding card can say "hidden by a curator". */
export const NOT_THIS_PERSON_REASON_PREFIX = "Not this person (grant attribution review)";

/** Longest stored reason: the column is VARCHAR(255). */
export const GRANT_REJECTION_REASON_MAX = 255;

/** Most items one bulk decision may touch, so its undo stays one all-or-nothing
 *  call. */
export const GRANT_ATTRIBUTION_BULK_MAX = 50;

/** Short labels for the cue chips, by scorer cue id. */
export const CUE_LABELS: Readonly<Record<string, string>> = {
  pub_linked: "Linked publication",
  wcm_org: "Held at WCM",
  infoed_other_wcm_pi_named: "Another WCM investigator's award",
  infoed_other_wcm_pi: "Another WCM PI in InfoEd",
  rejected_pmids: "Papers rejected in ReCiter",
  timeline_impossible: "Impossible timeline",
  timeline_unlikely: "Unlikely timeline",
  middle_initial_conflict: "Middle initial differs",
  prior_institution: "Trained there",
  copi_coauthor: "Co-PI is a co-author",
  topic_match: "Topics match",
  topic_mismatch: "Topics differ",
  profile_proven: "NIH profile proven",
};

export function cueLabel(id: string): string {
  return CUE_LABELS[id] ?? id;
}

/** RePORTER project page for the award, when its appl_id is known. */
export function reporterProjectUrl(applId: number | null): string | null {
  return applId ? nihReporterProjectUrl(applId) : null;
}

/** Confidence levels, strongest first. Rule-based on the cues that fired, until
 *  they can be checked against past decisions. */
export const ATTRIBUTION_LEVELS = [
  { key: "high", label: "High" },
  { key: "likely", label: "Likely" },
  { key: "conflict", label: "Conflicting" },
  { key: "unclear", label: "Unclear" },
  { key: "out", label: "Ruled out" },
] as const;

export type AttributionLevel = (typeof ATTRIBUTION_LEVELS)[number]["key"];

/** A cue that settles an award against the scholar on its own: the scorer's
 *  decisive cue, or a strong negative (|weight| ≥ STRONG in score.ts). */
export function isVetoCue(c: Pick<GrantAttributionCue, "id" | "weight">): boolean {
  return c.id === "infoed_other_wcm_pi_named" || c.weight <= -4;
}

/** The cues are only a co-PI co-author and a topic match: weak by design. */
export function isCoauthorshipOnly(cues: ReadonlyArray<Pick<GrantAttributionCue, "id">>): boolean {
  return cues.length > 0 && cues.every((c) => c.id === "copi_coauthor" || c.id === "topic_match");
}

export function attributionLevel(cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight">>): {
  level: AttributionLevel;
  veto: string | null;
} {
  const veto = cues.find(isVetoCue);
  if (veto) return { level: "out", veto: veto.id };
  const pos = cues.filter((c) => c.weight > 0);
  const neg = cues.some((c) => c.weight < 0);
  if (pos.length > 0 && neg) return { level: "conflict", veto: null };
  if (pos.some((c) => c.id === "pub_linked") || pos.length >= 2)
    return { level: "high", veto: null };
  if (pos.length === 1) return { level: "likely", veto: null };
  return { level: "unclear", veto: null };
}

const titleWord = (w: string) =>
  w
    .split("-")
    .map((p) => (p.length <= 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase()))
    .join("-");

/** "CHOI, AUGUSTINE M." → "Augustine M. Choi". Names without a comma are only
 *  title-cased. */
export function reporterNameForDisplay(raw: string): string {
  const [last = "", rest = ""] = raw.split(",").map((x) => x.trim());
  if (!raw.includes(",")) return raw.split(/\s+/).filter(Boolean).map(titleWord).join(" ");
  return [...rest.split(/\s+/).filter(Boolean), last].map(titleWord).join(" ");
}

const letters = (x: string) =>
  x
    .normalize("NFD")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase();

/** The RePORTER PI ("LAST, FIRST" or "First Last") carries the scholar's
 *  surname. */
export function isScholarPi(raw: string, surname: string | null): boolean {
  if (!surname) return false;
  const last = letters(
    raw.includes(",") ? raw.split(",")[0]! : (raw.trim().split(/\s+/).pop() ?? ""),
  );
  return last.length > 0 && last === letters(surname);
}
