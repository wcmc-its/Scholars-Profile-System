/**
 * The honor lists the scheduled scraper reads (`etl/honors/scrape-lists.ts`),
 * as plain metadata the console can import too.
 *
 * 🔴 Imports NOTHING. The Sources tab (a server page) and the Run now route read
 * this; the ETL's per-list parsers live under `etl/honors/lists/` and key on the
 * same `id`. Keeping the metadata here and the fetch/parse code there means the
 * app bundle never pulls in a scraper.
 *
 * `organization` and `honorName` are written verbatim onto every `honor` row a
 * list proposes, and the scraper's de-dup keys on (cwid, organization, name), so
 * they MUST match the strings the seed import already used for the same honor
 * (and `HONOR_PRESTIGE` in `lib/edit/honor-queue.ts`). Changing one re-proposes
 * every already-decided honor from that list as a fresh pending row.
 *
 * Only lists whose public roster was reachable and parseable without a browser
 * are here. The other honor lists the queue carries (the national academies,
 * HHMI, ASCI, AAP, Sloan, Pew, MacArthur, Searle, Damon Runyon, PECASE, the
 * American Academy of Arts and Sciences) either refuse non-browser clients
 * (HTTP 403), load their roster by client-side script, or sit behind a member
 * login, so they stay on the operator-run seed import until a workable feed is
 * found. See the per-list notes in `etl/honors/lists/`.
 */
export type HonorListCategory = "ACADEMY_MEMBERSHIP" | "INVESTIGATORSHIP" | "PRIZE" | "OTHER";

export type HonorListMeta = {
  /** Stable key: `honor_list_run.list_id`, the Run now body, `HONORS_LISTS`. */
  readonly id: string;
  /** The honor as written on `honor.name`. */
  readonly honorName: string;
  /** The conferring body as written on `honor.organization`. */
  readonly organization: string;
  readonly category: HonorListCategory;
  /** The public roster page. Also the first segment of every row's `sourceRef`,
   *  which is how the Sources tab ties seeded rows to the same list. */
  readonly rosterUrl: string;
  /** `honor.source` for rows this list proposes (VARCHAR(32)). */
  readonly source: string;
};

export const HONOR_LISTS: readonly HonorListMeta[] = [
  {
    id: "nai-fellows",
    honorName: "Fellow",
    organization: "National Academy of Inventors",
    category: "ACADEMY_MEMBERSHIP",
    rosterUrl: "https://academyofinventors.org/search-fellows/",
    source: "LIST:NAI",
  },
  {
    id: "aaas-fellows",
    honorName: "Fellow",
    organization: "American Association for the Advancement of Science",
    category: "ACADEMY_MEMBERSHIP",
    rosterUrl: "https://www.aaas.org/fellows/listing",
    source: "LIST:AAAS",
  },
  {
    id: "bwf-cams",
    honorName: "Career Award",
    organization: "Burroughs Wellcome Fund",
    category: "PRIZE",
    rosterUrl:
      "https://www.bwfund.org/grants/biomedical-sciences/career-awards-for-medical-scientists/",
    source: "LIST:BWF",
  },
];

/** Every list runs on the one weekly honors schedule (`scholars-honors-<env>`). */
export const HONOR_LIST_SCHEDULE_LABEL = "Weekly";

const BY_ID = new Map(HONOR_LISTS.map((l) => [l.id, l]));

export function honorListById(id: string): HonorListMeta | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve `HONORS_LISTS` ("all", empty, or comma-separated ids) to list
 * metadata, in registry order. An unknown id THROWS rather than being skipped:
 * a typo'd id must not turn into a quiet no-op run.
 */
export function selectHonorLists(raw: string | undefined): HonorListMeta[] {
  const value = (raw ?? "").trim();
  if (value === "" || value === "all") return [...HONOR_LISTS];
  const ids = new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const unknown = [...ids].filter((id) => !BY_ID.has(id));
  if (unknown.length) throw new Error(`unknown honor list id(s): ${unknown.join(", ")}`);
  return HONOR_LISTS.filter((l) => ids.has(l.id));
}

/** Host shown next to a list ("aaas.org"). */
export function honorListHost(list: Pick<HonorListMeta, "rosterUrl">): string {
  return new URL(list.rosterUrl).hostname.replace(/^www\./, "");
}

/**
 * The `honor_list_run.status` values. `queued` is written by the Run now route
 * before the job starts; the job moves it to `running`, then to one of the three
 * terminal states. `partial` = the list was read, but not all of it (a page
 * failed mid-walk), so on-list counts are a floor.
 */
export const HONOR_LIST_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "partial",
  "failed",
] as const;
export type HonorListRunStatus = (typeof HONOR_LIST_RUN_STATUSES)[number];

/**
 * A queued or running row older than this is treated as dead (the task never
 * started, or was killed without writing its end state). It no longer blocks
 * Run now and shows as "Did not finish". The state machine's own timeout is well
 * under this.
 */
export const HONOR_LIST_RUN_STALE_MS = 3 * 60 * 60 * 1000;

export function isHonorListRunActive(
  run: { status: string; createdAt: Date | string },
  now: number = Date.now(),
): boolean {
  if (run.status !== "queued" && run.status !== "running") return false;
  return now - new Date(run.createdAt).getTime() < HONOR_LIST_RUN_STALE_MS;
}
