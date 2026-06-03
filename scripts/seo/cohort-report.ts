/**
 * Rank-stratified name-search report (#684).
 *
 *   npm run seo:cohort                         # newest cohort snapshot → markdown
 *   npm run seo:cohort -- --snapshot data/seo/snapshots/rank-2026-06-03.json
 *   npm run seo:cohort -- --out docs/seo-cohort-2026-06-03.md
 *
 * Reads a snapshot produced from a `--mode cohort` basket (rows carry `rankTier`)
 * and answers, reproducibly and by seniority: when someone searches a scholar's
 * own name, does the scholar PROFILE win, or is it buried by the person's other
 * WCM pages (lab / dept / clinical) — or is there no WCM result at all?
 *
 * Taxonomy (mutually exclusive, using the `wcm-any` umbrella target whose hosts
 * suffix-match every WCM property, so it is a superset of the profile hosts):
 *   - profile wins      — the best WCM result IS the profile (new/vivo)
 *   - profile buried    — a WCM page exists but it's NOT the profile (or the
 *                         profile is absent while another WCM page ranks)
 *   - no WCM result     — no WCM page at all in the window (indexing gap or name
 *                         ambiguity; `--capture-top` lets the report show #1)
 *
 * Pure read of a committed-format snapshot. No DB, no network.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { hostOf } from "@/lib/seo/serpapi";
import type { RankSnapshot, SnapshotRow } from "@/lib/seo/rank-basket";

const SNAPSHOT_DIR = path.resolve(process.cwd(), "data", "seo", "snapshots");

interface Args {
  snapshot: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { snapshot: get("--snapshot") ?? null, out: get("--out") ?? null };
}

/** Newest `rank-*.json` in the snapshots dir (lexical = chronological, colon-free ISO). */
async function newestSnapshot(): Promise<string> {
  const files = (await fs.readdir(SNAPSHOT_DIR))
    .filter((f) => f.startsWith("rank-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No rank-*.json snapshots in ${SNAPSHOT_DIR}`);
  return path.join(SNAPSHOT_DIR, files[files.length - 1]);
}

const TIER_ORDER = ["Instructor", "Assistant Professor", "Associate Professor", "Professor (full)"];

function pos(row: SnapshotRow, targetKey: string): number | null {
  return row.placements.find((p) => p.targetKey === targetKey)?.position ?? null;
}
function url(row: SnapshotRow, targetKey: string): string | null {
  return row.placements.find((p) => p.targetKey === targetKey)?.url ?? null;
}

type Verdict = "wins" | "buried" | "none";

interface RowView {
  name: string;
  tier: string;
  slug?: string;
  profilePos: number | null; // best across research-profiles targets (new/vivo)
  profileUrl: string | null;
  anyPos: number | null; // best across all WCM hosts (umbrella)
  anyUrl: string | null;
  verdict: Verdict;
  /** The non-WCM #1 organic, for classifying a "none" row (indexing gap vs name ambiguity). */
  topOrganic: { position: number; title?: string; link?: string; host: string | null } | null;
}

function classify(profilePos: number | null, anyPos: number | null): Verdict {
  if (anyPos === null) return "none";
  if (profilePos !== null && profilePos === anyPos) return "wins";
  return "buried";
}

function buildView(rows: SnapshotRow[], profileKeys: string[], anyKey: string): RowView[] {
  return rows.map((r) => {
    const profileCands = profileKeys
      .map((k) => ({ p: pos(r, k), u: url(r, k) }))
      .filter((x) => x.p !== null) as { p: number; u: string | null }[];
    const best = profileCands.sort((a, b) => a.p - b.p)[0];
    const profilePos = best?.p ?? null;
    const anyPos = pos(r, anyKey);
    const top = (r.topResults ?? [])[0];
    return {
      name: r.label ?? r.query,
      tier: r.rankTier ?? "?",
      slug: r.slug,
      profilePos,
      profileUrl: best?.u ?? null,
      anyPos,
      anyUrl: url(r, anyKey),
      verdict: classify(profilePos, anyPos),
      topOrganic: top
        ? { position: top.position, title: top.title, link: top.link, host: hostOf(top.link) }
        : null,
    };
  });
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

function fmtPos(n: number | null): string {
  return n === null ? "—" : `#${n}`;
}

function report(snap: RankSnapshot, basket: string): string {
  const profileKeys = snap.targets
    .filter((t) => t.surfaceType === "research-profiles")
    .map((t) => t.key);
  const anyTarget = snap.targets.find((t) => t.key === "wcm-any");
  if (!anyTarget)
    throw new Error("snapshot has no 'wcm-any' umbrella target — not a cohort snapshot");
  const anyKey = anyTarget.key;

  const cohortRows = snap.rows.filter((r) => r.type === "branded" && r.rankTier);
  if (cohortRows.length === 0) {
    throw new Error(
      "snapshot has no branded rows with rankTier — was it built with --mode cohort?",
    );
  }
  const views = buildView(cohortRows, profileKeys, anyKey);
  const captured = cohortRows.some((r) => (r.topResults?.length ?? 0) > 0);

  const tiers = TIER_ORDER.filter((t) => views.some((v) => v.tier === t));
  const L: string[] = [];

  L.push(`# Name-search rank by faculty seniority (#684)`);
  L.push("");
  L.push(
    `Snapshot \`${path.basename(basket)}\` captured ${snap.capturedAt} — ${views.length} scholars, ` +
      `branded query \`"<name> weill cornell"\`. "Profile" = the Scholars/VIVO research-profiles ` +
      `surface; "any WCM" = any weill.cornell.edu / med.cornell.edu / weillcornell.org page.`,
  );
  L.push("");
  L.push(
    `> The new \`scholars.weill.cornell.edu\` host is firewalled pre-cutover (#502/#125), so it is ` +
      `absent by construction; the ranking profile surface today is the legacy VIVO that the new ` +
      `host inherits via 301.`,
  );
  L.push("");

  // ── Per-tier rollup ──────────────────────────────────────────────────────
  L.push("## By seniority");
  L.push("");
  L.push("| Tier | n | Profile wins | Profile buried | No WCM result | Profile #1–3 |");
  L.push("|---|--:|--:|--:|--:|--:|");
  for (const t of tiers) {
    const vs = views.filter((v) => v.verdict !== undefined && v.tier === t);
    const wins = vs.filter((v) => v.verdict === "wins").length;
    const buried = vs.filter((v) => v.verdict === "buried").length;
    const none = vs.filter((v) => v.verdict === "none").length;
    const top3 = vs.filter((v) => v.profilePos !== null && v.profilePos <= 3).length;
    L.push(
      `| ${t} | ${vs.length} | ${wins} (${pct(wins, vs.length)}) | ${buried} | ${none} | ${top3} |`,
    );
  }
  const all = views;
  const winsAll = all.filter((v) => v.verdict === "wins").length;
  const buriedAll = all.filter((v) => v.verdict === "buried").length;
  const noneAll = all.filter((v) => v.verdict === "none").length;
  const top3All = all.filter((v) => v.profilePos !== null && v.profilePos <= 3).length;
  L.push(
    `| **All** | **${all.length}** | **${winsAll} (${pct(winsAll, all.length)})** | **${buriedAll}** | **${noneAll}** | **${top3All}** |`,
  );
  L.push("");

  // ── Profile buried: which WCM page outranks it ───────────────────────────
  const buriedRows = views.filter((v) => v.verdict === "buried");
  if (buriedRows.length) {
    L.push("## Profile buried — the WCM page that outranks it");
    L.push("");
    L.push("| Scholar | Tier | Profile | Top WCM page | Host |");
    L.push("|---|---|--:|--:|---|");
    for (const v of buriedRows.sort(
      (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
    )) {
      L.push(
        `| ${v.name} | ${v.tier} | ${fmtPos(v.profilePos)} | ${fmtPos(v.anyPos)} | ${hostOf(v.anyUrl) ?? "—"} |`,
      );
    }
    L.push("");
  }

  // ── No WCM result at all ─────────────────────────────────────────────────
  const noneRows = views.filter((v) => v.verdict === "none");
  L.push("## No WCM result at all");
  L.push("");
  if (noneRows.length === 0) {
    L.push("_None — every scholar in the cohort surfaced at least one WCM page._");
  } else {
    L.push(
      captured
        ? "Classify each as an **indexing gap** (right person, no WCM page indexed) vs **name ambiguity** " +
            "(the #1 result is a different person/entity), from the top organic result:"
        : "_Run `seo:track --capture-top 5` to capture the #1 organic result for classification._",
    );
    L.push("");
    L.push("| Scholar | Tier | #1 organic result | Host |");
    L.push("|---|---|---|---|");
    for (const v of noneRows) {
      const t = v.topOrganic;
      const desc = t ? (t.title ?? t.link ?? "—") : "—";
      L.push(`| ${v.name} | ${v.tier} | ${desc.replace(/\|/g, "\\|")} | ${t?.host ?? "—"} |`);
    }
  }
  L.push("");

  // ── Full per-row appendix (transparency) ─────────────────────────────────
  L.push("## All rows");
  L.push("");
  L.push("| Scholar | Tier | Profile | Best WCM | Verdict |");
  L.push("|---|---|--:|--:|---|");
  for (const v of views.sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      (a.profilePos ?? 99) - (b.profilePos ?? 99),
  )) {
    L.push(
      `| ${v.name} | ${v.tier} | ${fmtPos(v.profilePos)} | ${fmtPos(v.anyPos)}${v.anyUrl ? ` (${hostOf(v.anyUrl)})` : ""} | ${v.verdict} |`,
    );
  }
  L.push("");

  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = args.snapshot ?? (await newestSnapshot());
  const snap = JSON.parse(await fs.readFile(file, "utf8")) as RankSnapshot;
  const md = report(snap, file);
  if (args.out) {
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, md, "utf8");
    console.error(`[seo:cohort] wrote ${args.out}`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
