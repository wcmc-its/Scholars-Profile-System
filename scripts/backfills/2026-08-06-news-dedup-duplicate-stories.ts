/**
 * Collapse news_mention rows that are the SAME story under two upstream slugs
 * (#2241, one-shot per DB).
 *
 * The feed publishes some articles twice — same date, same excerpt, same body,
 * different slug, and titles that are word-order variants of each other:
 *
 *   /april-awards-honors   "April: Awards & Honors"
 *   /awards-honors-april   "Awards & Honors: April"
 *
 * `@@unique([cwid, url])` sees two rows, so the story renders twice on a
 * profile (measured on prod: /david-c-lyden rows 4 and 5; /geraldine-mcginty
 * shows the SAME story as both of its 2 mentions).
 *
 * The ETL stops creating new ones as of this change (see `storyKey` in
 * etl/news/seed.ts and the `storedElsewhere` guard in etl/news/index.ts); this
 * clears what is already stored.
 *
 * WHICH ROW SURVIVES. Human decisions outrank everything: a row a human touched
 * (`entered_by_cwid`) wins, then the oldest so re-runs agree. The group is then
 * folded conservatively — a hide anywhere wins, `rejected` is terminal, and a
 * reviewer's identity carries over — so no review state is lost to the merge.
 *
 * Idempotent: groups of one are skipped, so a completed group is never revisited.
 *
 *   --dry-run   report the groups it WOULD collapse; write nothing.
 *   --limit=N   cap the groups collapsed (sample against staging first).
 *
 * Run (operator-driven, per scripts/backfills/README.md) — dry-run first. NOTE
 * these run on the ETL task family, not the app family: the app image ships
 * production deps only and has no `tsx`.
 *   npx tsx scripts/backfills/2026-08-06-news-dedup-duplicate-stories.ts --dry-run
 *   npx tsx scripts/backfills/2026-08-06-news-dedup-duplicate-stories.ts
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";
import { storyKey } from "../../etl/news/seed";

const log = (msg: string) => console.log(msg);

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;

type Row = {
  id: string;
  cwid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  status: "published" | "pending" | "rejected";
  showOnProfile: boolean;
  enteredByCwid: string | null;
  createdAt: Date;
};

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);

/**
 * How well a url's slug agrees with the row's title, 0..1.
 *
 * This is what tells a correctly-mapped row from a mis-mapped one. The first
 * version of the #2232 repoint resolved 53 staging rows to a real-but-wrong
 * article (it followed an inline prose link instead of the source-link field),
 * so a group can hold one row whose slug matches its title and one whose does
 * not. Exported for tests.
 */
export function slugAgreement(title: string, url: string): number {
  const t = words(title);
  if (t.length === 0) return 0;
  const slug = new Set(words(decodeURIComponent(url.split("/").pop() ?? "")));
  return t.filter((w) => slug.has(w)).length / t.length;
}

/**
 * Fold a duplicate story group into one row.
 *
 * Review state and identity come from the human-touched row (else the oldest, so
 * re-runs agree). The URL is chosen SEPARATELY, by slug agreement — the surviving
 * row must not inherit a mis-mapped url just because a human happened to touch
 * that copy. Every human decision still carries forward: a hide anywhere wins,
 * `rejected` is terminal, and a reviewer's identity is preserved.
 */
export function collapse(rows: Row[]): {
  winner: Row;
  losers: Row[];
  url: string;
  status: Row["status"];
  showOnProfile: boolean;
  enteredByCwid: string | null;
} {
  const winner =
    rows.find((r) => r.enteredByCwid !== null) ??
    [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  // Best slug agreement wins the url; ties keep the winner's own.
  const best = [...rows].sort(
    (a, b) => slugAgreement(b.title, b.url) - slugAgreement(a.title, a.url),
  )[0];
  const url =
    slugAgreement(best.title, best.url) > slugAgreement(winner.title, winner.url)
      ? best.url
      : winner.url;
  return {
    winner,
    losers: rows.filter((r) => r.id !== winner.id),
    url,
    status: rows.some((r) => r.status === "rejected") ? "rejected" : winner.status,
    showOnProfile: rows.every((r) => r.showOnProfile),
    enteredByCwid: winner.enteredByCwid ?? rows.find((r) => r.enteredByCwid)?.enteredByCwid ?? null,
  };
}

async function main(): Promise<void> {
  const all = (await db.write.newsMention.findMany({
    select: {
      id: true,
      cwid: true,
      url: true,
      title: true,
      publishedAt: true,
      status: true,
      showOnProfile: true,
      enteredByCwid: true,
      createdAt: true,
    },
  })) as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of all) {
    const k = storyKey(r.title, r.publishedAt);
    if (!k) continue; // undated: only one weak signal, never merge
    const key = `${r.cwid} ${k}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // A group is only a duplicate if the rows sit under DIFFERENT urls.
  const dupes = [...groups.values()].filter(
    (g) => g.length > 1 && new Set(g.map((r) => r.url)).size > 1,
  );
  const targeted = LIMIT > 0 ? dupes.slice(0, LIMIT) : dupes;

  log(
    `[news-dedup] ${all.length} rows; ${dupes.length} duplicated story group(s); ` +
      `collapsing ${targeted.length}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  let removed = 0;
  const affectedCwids = new Set<string>();
  let repointed = 0;
  for (const g of targeted) {
    const { winner, losers, url, status, showOnProfile, enteredByCwid } = collapse(g);
    const touched = g.filter((r) => !r.showOnProfile || r.enteredByCwid !== null).length;
    const fixed = url !== winner.url;
    if (fixed) repointed++;
    log(
      `[news-dedup] ${g.length} -> 1  ${winner.cwid}  "${winner.title.slice(0, 44)}"  ` +
        `humanTouched=${touched}${fixed ? "  URL-REPOINTED" : ""}\n` +
        `[news-dedup]        keep ${url.split("/").pop()}` +
        (fixed ? `\n[news-dedup]        was  ${winner.url.split("/").pop()}` : ""),
    );
    affectedCwids.add(winner.cwid);
    removed += losers.length;
    if (!DRY_RUN) {
      await db.write.$transaction(async (tx) => {
        await tx.newsMention.deleteMany({ where: { id: { in: losers.map((l) => l.id) } } });
        await tx.newsMention.update({
          where: { id: winner.id },
          data: { url, status, showOnProfile, enteredByCwid },
        });
      });
    }
  }
  if (repointed > 0) {
    log(
      `[news-dedup] ${repointed} surviving row(s) also had their url corrected — ` +
        `these were mis-mapped by the first #2232 pass (see slugAgreement).`,
    );
  }

  log(
    `[news-dedup] ${DRY_RUN ? "WOULD REMOVE" : "REMOVED"} ${removed} duplicate row(s) ` +
      `across ${affectedCwids.size} scholar(s)`,
  );
  if (!DRY_RUN && removed > 0) {
    log("[news-dedup] profiles are ISR-cached per deploy sha; no action needed for the next deploy.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => db.write.$disconnect());
}
