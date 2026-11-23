/**
 * RPM ORCID candidates → `orcid_candidate`. Mirrors, from ReciterDB, the ORCID
 * iDs the ReCiter Publication Manager holds per WCM person that SPS does NOT
 * treat as asserted:
 *
 *   - `pubsource_orcid_person` where `confidence_type = 'inferred'` and the key
 *     is a CWID → `source = 'rpm_inferred'`, with `articles_accepted` /
 *     `articles_rejected` (how many of the person's accepted / rejected RPM
 *     articles carry that ORCID on their PubMed author record).
 *   - The NetID rows (`source_provided`, the Cornell library's Affiliation Manager
 *     map) → `source = 'cornell_affiliation_manager'` on Cornell Ithaca rows only,
 *     when ITHACA_ORCID_CURATION is "on" (Ithaca ORCID plan, step 2). Off, the
 *     source reads empty and the delete pass removes its rows.
 *   - `pubsource_web_orcid_inference` live rows (Cornell web-page inferences, ReCiterDB
 *     webPageOrcid.py) → `source = 'web_page_seed'` on Cornell Ithaca rows only, with
 *     `articles_accepted` = the inference's votes, when ITHACA_WEB_SEED_ORCID is also "on"
 *     (Ithaca ORCID plan, step 5). `source_detail` names the kinds of page the voting
 *     papers were listed on (Cornell profile, lab / personal site, CV), from the
 *     inference's evidence_json and `pubsource_web_page.kind`.
 *   - `admin_orcid` → `source = 'rpm_admin'` (hand-entered by an RPM admin;
 *     frozen since RPM stopped writing it 2026-04-05, and SPS never writes it).
 *     A row SPS's Remove deleted comes back here every morning; readers drop
 *     it via `orcid_dismissal` (`withoutDismissed`), so the mirror stays a
 *     plain copy of the source.
 *
 * Full mirror each run for its own source values (`rpm_inferred` / `rpm_admin`):
 * rows RPM no longer has are deleted, so the table never accumulates a retracted
 * candidate. The table key is (cwid, orcid, source), so `etl/orcid-registry`'s
 * `orcid_*` row for the same person and iD sits beside ours — neither mirror
 * ever overwrites the other's row, and the delete pass is scoped to our sources.
 * Within this mirror one row per (cwid, orcid, source) — an admin row and an
 * inferred row for the SAME iD both survive, so the "seen on N of your accepted
 * publications" evidence is still there after the iD is confirmed (the
 * Identifiers & Profiles card shows it under the on-file iD) and a strong
 * inference is still there the morning after the admin row is removed. The
 * verdict (`orcidVerdict`) reads the admin row as asserted regardless. A pair
 * that disappears from the source leaves its stale row to the delete pass.
 * Only cwids that exist in `scholar` are written (FK); the rest are
 * counted. `scholar.orcid` (WCM Identity) is untouched — this table is read by
 * `/edit/orcid-coverage` only.
 *
 * Usage: `npm run etl:orcid-candidates`. Runs on the sources task family
 * (needs `SCHOLARS_RECITERDB_*`).
 */
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { withEtlRun } from "@/lib/etl-run";
import { assertSourceVolume } from "@/lib/etl-guard";

const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const BATCH = 500;
/** The source values this mirror owns; the delete pass never touches any other. */
const RPM_SOURCES = ["rpm_inferred", "rpm_admin", "cornell_affiliation_manager", "web_page_seed"];
/** Ithaca sources: matched to `campus = 'ithaca'` rows only. */
const ITHACA_SOURCES = new Set<string>(["cornell_affiliation_manager", "web_page_seed"]);
/** 370 live inferences on the 2026-11-21 dry run; a short read would silently drop them. */
const WEB_SEED_FLOOR = 200;
/** 6,620 NetID rows on 2026-11-16; a short read would silently drop Ithaca seeds. */
const AFFILIATION_MANAGER_FLOOR = 5_000;

export type SourceRow = {
  cwid: string;
  orcid: string;
  source: "rpm_inferred" | "rpm_admin" | "cornell_affiliation_manager" | "web_page_seed";
  articlesAccepted: number;
  articlesRejected: number;
  sourceUpdatedAt: Date | null;
  /** web_page_seed only (see `webPageDetail`). */
  sourceDetail?: string | null;
};

export type InferredRow = {
  personIdentifier: string;
  orcid: string | null;
  articles_accepted: number | null;
  articles_rejected: number | null;
  updated_at: Date | string | null;
};
export type AdminRow = { personIdentifier: string; orcid: string | null };
export type NetidRow = { personIdentifier: string; orcid: string | null; updated_at: Date | string | null };
/** A live `pubsource_web_orcid_inference` row (ReCiterDB webPageOrcid.py). */
export type WebSeedRow = {
  netid: string;
  orcid: string | null;
  votes: number;
  inferred_at: Date | string | null;
  /** [{doi, pages: [{url}]}] for the papers that voted for this iD. */
  evidence_json?: string | null;
};

/** `pubsource_web_page.kind` → the words a reviewer reads. `pubs` is the Publications page
 *  followed from a lab or personal site (ReCiterDB web seeds step 3). */
const PAGE_KIND_WORDS: Record<string, string> = {
  profile: "Cornell profile",
  lab: "lab site",
  personal: "personal site",
  pubs: "lab or personal site",
  cv: "CV",
};
const PAGE_KIND_ORDER = ["profile", "lab", "personal", "pubs", "cv"];

/** Page URLs in an inference's evidence_json; [] when absent or malformed. Pure. */
export function evidencePageUrls(evidenceJson: string | null | undefined): string[] {
  try {
    const ev = JSON.parse(evidenceJson ?? "[]") as Array<{ pages?: Array<{ url?: unknown }> }>;
    return [...new Set(ev.flatMap((d) => (d.pages ?? []).map((p) => String(p.url ?? ""))).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Page kinds → "Cornell profile, lab site and CV"; null when none are known. Pure. */
export function webPageDetail(kinds: Iterable<string | null | undefined>): string | null {
  const have = new Set([...kinds].filter((k): k is string => !!k && k in PAGE_KIND_WORDS));
  const words = [...new Set(PAGE_KIND_ORDER.filter((k) => have.has(k)).map((k) => PAGE_KIND_WORDS[k]))];
  if (words.length === 0) return null;
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Source rows → candidate rows: trims, lowercases the cwid, drops malformed ORCIDs. Pure. */
export function toCandidates(
  inferred: InferredRow[],
  admin: AdminRow[],
  affiliationManager: NetidRow[] = [],
  webSeed: WebSeedRow[] = [],
  pageKind: Map<string, string> = new Map(),
): { rows: SourceRow[]; invalid: number } {
  const rows: SourceRow[] = [];
  let invalid = 0;
  for (const r of inferred) {
    const orcid = String(r.orcid ?? "").trim();
    if (!ORCID_PATTERN.test(orcid)) {
      invalid++;
      continue;
    }
    rows.push({
      cwid: String(r.personIdentifier).trim().toLowerCase(),
      orcid,
      source: "rpm_inferred",
      articlesAccepted: Number(r.articles_accepted ?? 0),
      articlesRejected: Number(r.articles_rejected ?? 0),
      sourceUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
    });
  }
  for (const r of admin) {
    const orcid = String(r.orcid ?? "").trim();
    if (!ORCID_PATTERN.test(orcid)) {
      invalid++;
      continue;
    }
    rows.push({
      cwid: String(r.personIdentifier).trim().toLowerCase(),
      orcid,
      source: "rpm_admin",
      articlesAccepted: 0,
      articlesRejected: 0,
      sourceUpdatedAt: null,
    });
  }
  for (const r of affiliationManager) {
    const orcid = String(r.orcid ?? "").trim();
    if (!ORCID_PATTERN.test(orcid)) {
      invalid++;
      continue;
    }
    rows.push({
      cwid: String(r.personIdentifier).trim().toLowerCase(),
      orcid,
      source: "cornell_affiliation_manager",
      articlesAccepted: 0,
      articlesRejected: 0,
      sourceUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
    });
  }
  for (const r of webSeed) {
    const orcid = String(r.orcid ?? "").trim();
    if (!ORCID_PATTERN.test(orcid)) {
      invalid++;
      continue;
    }
    rows.push({
      cwid: String(r.netid).trim().toLowerCase(),
      orcid,
      source: "web_page_seed",
      // The papers on the person's own web pages that carry the iD (the inference's votes).
      articlesAccepted: Number(r.votes ?? 0),
      articlesRejected: 0,
      sourceUpdatedAt: r.inferred_at ? new Date(r.inferred_at) : null,
      sourceDetail: webPageDetail(evidencePageUrls(r.evidence_json).map((u) => pageKind.get(u))),
    });
  }
  return { rows, invalid };
}

/** Keeps rows for known scholars, one per (cwid, orcid, source) — the table's
 *  key — so an admin row and an inferred row for the same iD coexist. Pure. */
export function mergeForScholars(
  rows: SourceRow[],
  scholars: Set<string>,
  ithaca: Set<string> = new Set(),
): { keep: SourceRow[]; noScholar: number } {
  const byKey = new Map<string, SourceRow>();
  let noScholar = 0;
  for (const r of rows) {
    // Each source matches its own campus: a NetID that equals some WCM CWID must
    // never land on the WCM row.
    if (!(ITHACA_SOURCES.has(r.source) ? ithaca : scholars).has(r.cwid)) {
      noScholar++;
      continue;
    }
    const k = `${r.cwid}|${r.orcid}|${r.source}`;
    if (!byKey.has(k)) byKey.set(k, r);
  }
  return { keep: [...byKey.values()], noScholar };
}

async function main(): Promise<number> {
  const ithacaOn = process.env.ITHACA_ORCID_CURATION === "on";
  let read: { rows: SourceRow[]; invalid: number } = { rows: [], invalid: 0 };
  await withReciterConnection(async (conn) => {
    const inferred = (await conn.query(
      `SELECT personIdentifier, orcid, articles_accepted, articles_rejected, updated_at
       FROM pubsource_orcid_person
       WHERE confidence_type = 'inferred' AND personIdentifierType = 'CWID'`,
    )) as InferredRow[];
    const admin = (await conn.query(
      `SELECT personIdentifier, orcid FROM admin_orcid`,
    )) as AdminRow[];
    const netid = ithacaOn
      ? ((await conn.query(
          `SELECT personIdentifier, orcid, updated_at FROM pubsource_orcid_person
           WHERE personIdentifierType = 'NetID' AND confidence_type = 'source_provided'`,
        )) as NetidRow[])
      : [];
    if (ithacaOn) {
      assertSourceVolume("orcid-candidates-affiliation-manager", {
        incoming: netid.length,
        floor: AFFILIATION_MANAGER_FLOOR,
      });
    }
    // Ithaca ORCID plan, step 5: web-page inferences, a separate switch so they can
    // stay off in prod until the hand-check (plan M3). Off, the source reads empty
    // and the delete pass removes its rows.
    const webSeedOn = ithacaOn && process.env.ITHACA_WEB_SEED_ORCID === "on";
    const webSeed = webSeedOn
      ? ((await conn.query(
          `SELECT netid, orcid, votes, inferred_at, evidence_json FROM pubsource_web_orcid_inference
           WHERE superseded_at IS NULL`,
        )) as WebSeedRow[])
      : [];
    const urls = [...new Set(webSeed.flatMap((r) => evidencePageUrls(r.evidence_json)))];
    const pageKind = new Map<string, string>();
    for (let i = 0; i < urls.length; i += BATCH) {
      const part = urls.slice(i, i + BATCH);
      const kinds = (await conn.query(
        `SELECT url, kind FROM pubsource_web_page WHERE url IN (${part.map(() => "?").join(",")})`,
        part,
      )) as Array<{ url: string; kind: string }>;
      for (const k of kinds) pageKind.set(k.url, k.kind);
    }
    if (webSeedOn) {
      assertSourceVolume("orcid-candidates-web-page-seed", {
        incoming: webSeed.length,
        floor: WEB_SEED_FLOOR,
      });
    }
    read = toCandidates(inferred, admin, netid, webSeed, pageKind);
  });
  console.log(
    `ReciterDB: ${read.rows.length} candidate rows (${read.invalid} skipped: malformed ORCID).`,
  );
  if (read.rows.length === 0) {
    // Fail loud rather than wipe: an empty read is a source outage, not "nobody has an ORCID".
    throw new Error("0 candidate rows read from ReciterDB — refusing to mirror an empty source");
  }

  const rowsOn = async (campus: string) =>
    new Set(
      (await db.write.scholar.findMany({ where: { campus }, select: { cwid: true } })).map((s) =>
        s.cwid.toLowerCase(),
      ),
    );
  const { keep, noScholar } = mergeForScholars(
    read.rows,
    await rowsOn("wcm"),
    ithacaOn ? await rowsOn("ithaca") : new Set(),
  );
  console.log(
    `${keep.length} rows for known scholars (${noScholar} rows for cwids not in scholar).`,
  );

  // Mirror: upsert everything, then delete what the source no longer has — scoped to
  // OUR sources so this never wipes `etl/orcid-registry`'s rows (or vice-versa).
  // `source` is part of the key, so an `orcid_*` row for the same (cwid, orcid)
  // is a different row and is never touched here.
  const now = new Date();
  for (let i = 0; i < keep.length; i += BATCH) {
    const batch = keep.slice(i, i + BATCH);
    await db.write.$transaction(
      batch.map((r) =>
        db.write.orcidCandidate.upsert({
          where: { cwid_orcid_source: { cwid: r.cwid, orcid: r.orcid, source: r.source } },
          create: { ...r, sourceDetail: r.sourceDetail ?? null, syncedAt: now },
          update: {
            articlesAccepted: r.articlesAccepted,
            articlesRejected: r.articlesRejected,
            sourceDetail: r.sourceDetail ?? null,
            sourceUpdatedAt: r.sourceUpdatedAt,
            syncedAt: now,
          },
        }),
      ),
    );
  }
  const { count: removed } = await db.write.orcidCandidate.deleteMany({
    where: { source: { in: RPM_SOURCES }, syncedAt: { lt: now } },
  });
  const bySource = keep.reduce<Record<string, number>>(
    (m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m),
    {},
  );
  console.log(
    `orcid_candidate mirrored: ${keep.length} rows (${JSON.stringify(bySource)}), ${removed} stale rows removed.`,
  );
  return keep.length;
}

// Run only when invoked directly (`npm run etl:orcid-candidates` / the nightly task) — the
// module is also imported by its unit test for the pure row transforms.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  withEtlRun("RPM-orcid-candidates", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
      await closeReciterPool();
    });
}
