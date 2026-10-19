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

/** Who may decide a queued award (the decision route re-checks this). */
export function canDecideGrantAttribution(session: Viewer): boolean {
  return session.isSuperuser || session.isCommsSteward === true;
}

/** Who may read the queue: the deciders, plus observers and content editors. */
export function canViewGrantAttributionQueue(session: Viewer): boolean {
  return (
    canDecideGrantAttribution(session) ||
    session.isObserver === true ||
    session.isContentEditor === true
  );
}

export function isGrantAttributionQueueReadOnly(session: Viewer): boolean {
  return !canDecideGrantAttribution(session);
}

/** The tab predicate AND the page gate: the same function, so the tab never
 *  shows to someone the page refuses. */
export function isGrantAttributionQueueTabVisible(session: Viewer): boolean {
  return isGrantAttributionQueueEnabled() && canViewGrantAttributionQueue(session);
}

export type GrantAttributionStatus = "pending" | "confirmed" | "rejected";

export type GrantAttributionCue = { id: string; weight: number; reason: string };

export type GrantAttributionAward = {
  title: string | null;
  awardNumber: string | null;
  coreProjectNum: string | null;
  activityCode: string | null;
  applId: number | null;
  startYear: number | null;
  endYear: number | null;
  orgs: Array<{ name: string; from: number | null; to: number | null }>;
  piNames: string[];
};

export type GrantAttributionItem = {
  id: string;
  cwid: string;
  slug: string | null;
  /** The name as the profile renders it. */
  scholarName: string;
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

/** "Not this person" reasons. Free text is allowed too (VARCHAR 255). */
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
};

export function cueLabel(id: string): string {
  return CUE_LABELS[id] ?? id;
}

/** RePORTER project page for the award, when its appl_id is known. */
export function reporterProjectUrl(applId: number | null): string | null {
  return applId ? nihReporterProjectUrl(applId) : null;
}
