/**
 * ORCID librarian queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md):
 * the flag, the viewer predicate, the band/tab vocabulary, the row types, and
 * the pure rules the page and the three routes share.
 *
 * 🔴 CLIENT-BUNDLED. `components/edit/orcid-queue.tsx` imports this module at
 * runtime, so it must never import `@/lib/db` or anything that builds a Prisma
 * client at module scope. The loaders and writers live in
 * `orcid-queue.server.ts` and take the client as a parameter.
 *
 * WHO. Librarians are superusers; there is no new role. The page, every route
 * and the subnav tab read `isSuperuser` — never a comms_steward, observer or
 * content editor, and never an impersonated decision (the routes refuse View
 * as, so `orcid_confirmed_by` is always the real librarian).
 */

/** `ORCID_LIBRARIAN_QUEUE`: exactly "on" shows the page, the tab and the routes. */
export function isOrcidLibrarianQueueEnabled(): boolean {
  return process.env.ORCID_LIBRARIAN_QUEUE === "on";
}

/** The tab predicate AND the page gate: the same function (I2 parity). */
export function isOrcidQueueTabVisible(session: { isSuperuser: boolean }): boolean {
  return isOrcidLibrarianQueueEnabled() && session.isSuperuser;
}

/** etl/orcid-evidence's bands, strongest first. */
export const ORCID_QUEUE_BANDS = [
  "email_verified",
  "strong",
  "shared_only",
  "moderate",
  "weak",
] as const;
export type OrcidQueueBand = (typeof ORCID_QUEUE_BANDS)[number];

/** The bands plus Conflicts (the scholar holds a DIFFERENT iD on file). */
export const ORCID_QUEUE_TABS = [...ORCID_QUEUE_BANDS, "conflicts"] as const;
export type OrcidQueueTab = (typeof ORCID_QUEUE_TABS)[number];
export const DEFAULT_ORCID_QUEUE_TAB: OrcidQueueTab = "strong";

export const ORCID_QUEUE_TAB_LABEL: Record<OrcidQueueTab, string> = {
  email_verified: "Email verified",
  strong: "Strong",
  shared_only: "Shared papers",
  moderate: "Moderate",
  weak: "Weak",
  conflicts: "Conflicts",
};

export function isOrcidQueueTab(v: unknown): v is OrcidQueueTab {
  return typeof v === "string" && (ORCID_QUEUE_TABS as readonly string[]).includes(v);
}

/** Only these bands are bulk-confirmable, and only after a passed sample. */
export const ORCID_SAMPLE_BANDS = ["strong", "shared_only"] as const;
export type OrcidSampleBand = (typeof ORCID_SAMPLE_BANDS)[number];
export const ORCID_QUEUE_SAMPLE_SIZE = 50;

export function isOrcidSampleBand(v: unknown): v is OrcidSampleBand {
  return typeof v === "string" && (ORCID_SAMPLE_BANDS as readonly string[]).includes(v);
}

/** Where a candidate pair stands against what is on file. Pure. */
export type PairState = "queue" | "on_file" | "dismissed" | "conflict";
export function pairState(orcid: string, held: string | null, dismissed: boolean): PairState {
  if (held === orcid) return "on_file";
  if (dismissed) return "dismissed";
  if (held !== null) return "conflict";
  return "queue";
}

/** open = undecided rows and no dismissal; passed = all decided, none
 *  dismissed; locked = any dismissal (bulk stays off for the band). Pure. */
export type SampleStatus = "open" | "passed" | "locked";
export function sampleStatus(rows: ReadonlyArray<{ decision: string | null }>): SampleStatus {
  if (rows.some((r) => r.decision === "dismissed")) return "locked";
  if (rows.length > 0 && rows.every((r) => r.decision !== null)) return "passed";
  return "open";
}

export type OrcidQueueSampleState = {
  id: string;
  band: OrcidSampleBand;
  startedAt: string;
  total: number;
  decided: number;
  dismissed: number;
  status: SampleStatus;
};

export type OrcidQueueWork = {
  title: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  source: string | null;
};

export type OrcidQueueRow = {
  cwid: string;
  orcid: string;
  slug: string | null;
  name: string;
  title: string | null;
  department: string | null;
  band: OrcidQueueBand;
  instMatch: boolean;
  emailVerified: boolean;
  nameAgrees: boolean;
  shared: number;
  competitor: boolean;
  competitors: Array<{ cwid: string; name: string }>;
  competitorOrcids: string[];
  worksTotal: number;
  newWorks: number;
  newWorksSample: OrcidQueueWork[];
  /** Conflicts tab: the iD on file. Email verified tab: the auto-confirmed iD. */
  onFileOrcid: string | null;
  /** Email verified tab: already confirmed by the ETL (shows Undo). */
  autoConfirmed: boolean;
  /** This row's decision in the band's current sample; undefined = not sampled. */
  sampleDecision?: "confirmed" | "dismissed" | null;
};

/** What the page hands the client: one tab's rows and every tab's count. */
export type OrcidQueueData = {
  tab: OrcidQueueTab;
  rows: OrcidQueueRow[];
  counts: Record<OrcidQueueTab, number>;
  /** The band's latest sample (Strong / Shared papers only). */
  sample: OrcidQueueSampleState | null;
  /** Rows a passed sample's "Confirm remaining N" would confirm now. */
  remaining: number | null;
};
