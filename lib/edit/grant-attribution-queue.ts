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
  /** Cue `rejected_pmids` from a run that recorded them: the papers RePORTER
   *  links to the award that the scholar rejected in ReCiter (capped). The
   *  title is PubMed's, null when the ETL could not fetch it. */
  rejected?: GrantAttributionRejectedPaper[];
};

export type GrantAttributionRejectedPaper = { pmid: string; title: string | null };

/** A stored cue's `rejected` list, or undefined when absent or malformed. */
export function asRejectedPapers(v: unknown): GrantAttributionRejectedPaper[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const ok = v.every(
    (p) => !!p && typeof p.pmid === "string" && (p.title === null || typeof p.title === "string"),
  );
  return ok ? v.map((p) => ({ pmid: p.pmid, title: p.title })) : undefined;
}

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
  /** The review id; for an Unproven award, which has no review, its grant externalId. */
  id: string;
  /** The grant's externalId, `reporter:{cwid}:{core}`. */
  grantId: string;
  /** Unproven: the weekly check found nothing either way and opened no review.
   *  A decision on it goes by grant. */
  unproven: boolean;
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
  /** RePORTER's name for the scholar's PI entry, from the latest scoring. */
  reporterName: string | null;
  /** The scholar's names on record, to mark where RePORTER's differs. */
  scholarNames: string[];
};

/** An award the weekly check hid or queued, then showed again on new evidence
 *  (its hide revoked as `system-rescored`), that no curator has decided. */
export type GrantAttributionAutoItem = {
  /** The grant's externalId, `reporter:{cwid}:{core}`. */
  id: string;
  cwid: string;
  slug: string | null;
  scholarName: string;
  scholarNames: string[];
  department: string | null;
  award: GrantAttributionAward;
  reporterName: string | null;
  /** What it was before the check showed it. */
  was: "hidden" | "queued";
  decidedAt: string;
  reason: string;
};

/** One weekly scoring run's totals (`grant_attribution_run`). */
export type GrantAttributionRunTotals = {
  ranAt: string;
  scholars: number;
  show: number;
  hide: number;
  queue: number;
  recovered: number;
  cues: Record<string, number>;
};

/** The one-line "why" for an award's band, from its cues (strongest first). */
export function decidingReason(
  band: string,
  cues: ReadonlyArray<Pick<GrantAttributionCue, "id" | "weight" | "reason">>,
): string {
  if (band === "show") {
    return (
      cues.find((c) => c.weight > 0)?.reason ??
      "Every NIH profile was matched by the scholar's publications"
    );
  }
  if (band === "hide") {
    return (
      cues.find(isVetoCue)?.reason ??
      cues.find((c) => c.weight < 0)?.reason ??
      "Nothing ties it to the scholar, and the NIH profile was matched by name only"
    );
  }
  return "The evidence is weak or points both ways";
}

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
  wcm_org_shared_name: "Held at WCM, name shared",
  infoed_other_wcm_pi_named: "Another WCM investigator's award",
  infoed_other_wcm_pi: "Another WCM PI in InfoEd",
  rejected_pmids: "Papers rejected in ReCiter",
  timeline_impossible: "Impossible timeline",
  timeline_unlikely: "Unlikely timeline",
  middle_initial_conflict: "Middle initial differs",
  prior_institution: "Trained there",
  affiliate_org: "Held at a WCM affiliate",
  copi_coauthor: "Co-PI is a co-author",
  topic_match: "Topics match",
  topic_mismatch: "Topics differ",
  profile_proven: "NIH profile linked by accepted papers",
  name_rare: "Rare name",
  name_common: "Common name",
  pi_name_mismatch: "PI has a different surname",
  pi_given_name_mismatch: "PI has a different first name",
};

export function cueLabel(id: string): string {
  return CUE_LABELS[id] ?? id;
}

/** RePORTER project page for the award, when its appl_id is known. */
export function reporterProjectUrl(applId: number | null): string | null {
  return applId ? nihReporterProjectUrl(applId) : null;
}

/** A strong negative (|weight| ≥ STRONG in score.ts). The named InfoEd cue
 *  counts too: reviews stored before 2026-10-24 carry it at weight 0. */
export function isVetoCue(c: Pick<GrantAttributionCue, "id" | "weight">): boolean {
  return c.id === "infoed_other_wcm_pi_named" || c.weight <= -4;
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

/** RePORTER's name for display, word by word, each marked when the scholar's
 *  names on record have no match for it. An initial matches a word it starts
 *  ("D." and "David"), so only a real difference is marked. */
export function reporterNameParts(
  raw: string,
  scholarNames: ReadonlyArray<string>,
): Array<{ text: string; differs: boolean }> {
  // "Last, First M" lists the surname first; "First M Last" last. Initials
  // match given names only, so a lone "H" never matches the surname.
  const words = scholarNames.map((n) => {
    const w = n
      .split(/[\s,-]+/)
      .map(letters)
      .filter(Boolean);
    return { all: w, given: n.includes(",") ? w.slice(1) : w.slice(0, -1) };
  });
  const all = words.flatMap((w) => w.all);
  const given = words.flatMap((w) => w.given);
  const matches = (t: string) =>
    all.includes(t) ||
    (t.length === 1 && given.some((g) => g.startsWith(t))) ||
    given.some((g) => g.length === 1 && t.startsWith(g));
  return reporterNameForDisplay(raw)
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const parts = text.split("-").map(letters).filter(Boolean);
      return { text, differs: parts.length > 0 && !parts.every(matches) };
    });
}

/** Report 14's evidence rows: each cue in plain words and which way it
 *  points. */
export const EVIDENCE_ROWS: ReadonlyArray<{
  ids: readonly string[];
  label: string;
  toward: boolean;
}> = [
  { ids: ["pub_linked"], label: "A paper of theirs cites the award", toward: true },
  { ids: ["profile_proven"], label: "NIH profile linked by their accepted papers", toward: true },
  { ids: ["copi_coauthor"], label: "A co-PI co-authors with them", toward: true },
  { ids: ["wcm_org"], label: "Held at WCM", toward: true },
  {
    ids: ["wcm_org_shared_name"],
    label: "Held at WCM, but another WCM person shares the name",
    toward: true,
  },
  { ids: ["prior_institution"], label: "They trained there", toward: true },
  { ids: ["affiliate_org"], label: "Held at a WCM affiliate", toward: true },
  { ids: ["topic_match"], label: "Topics match their papers", toward: true },
  { ids: ["name_rare"], label: "Rare name: the only NIH PI profile with it", toward: true },
  { ids: ["middle_initial_conflict"], label: "Middle initial differs", toward: false },
  { ids: ["timeline_impossible"], label: "Impossible timeline", toward: false },
  { ids: ["rejected_pmids"], label: "Papers rejected in ReCiter", toward: false },
  {
    ids: ["infoed_other_wcm_pi_named"],
    label: "InfoEd names another WCM PI, and the NIH profile matches their name",
    toward: false,
  },
  { ids: ["infoed_other_wcm_pi"], label: "Another WCM investigator in InfoEd", toward: false },
  { ids: ["timeline_unlikely"], label: "Unlikely timeline", toward: false },
  { ids: ["topic_mismatch"], label: "Topics differ", toward: false },
  {
    ids: ["name_common"],
    label: "Common name: 10 or more NIH PI profiles share it",
    toward: false,
  },
  {
    ids: ["pi_name_mismatch"],
    label: "The NIH profile's PI has a different surname",
    toward: false,
  },
  {
    ids: ["pi_given_name_mismatch"],
    label: "The NIH profile's PI has the scholar's surname but a different first name",
    toward: false,
  },
];
