/**
 * Center staging-mirror backfill (2026-07-04, one-shot per DB).
 *
 * Reconciles the prod `center` set to staging (the curated source of truth) —
 * created because there is no cross-env promotion path (ADR-005 non-goal) and
 * the two sides had diverged in both directions:
 *
 *   CREATE (5) — centers hand-created on staging (source=manual) but absent from
 *   prod; each has zero members and zero programs (verified), so it is a pure
 *   center row. Definitions are verbatim from staging. This also carries the
 *   `weill_metabolic_health` homepage URL edit (centers store url in-row).
 *
 *   DELETE (2) — `computational_biomed` + `iris_cantor_womens_health` were
 *   removed from the canonical seed (`prisma/center-seed-data.ts`) and already
 *   dropped on staging; prod is stale. Hard-delete cascades their memberships
 *   (verified: 0 and 2 respectively). Mirrors the "hard-delete removed centers"
 *   step in 2026-06-12-org-unit-comms-update.ts.
 *
 * OUT OF SCOPE (separate workstream): the Meyer Cancer Center program/membership
 * setup (5 programs + ~342 classified memberships) is staging-only on prod and
 * needs Andria's source file (data/center-members/meyer-cancer-center.txt) via
 * the meyer backfills — not handled here.
 *
 * Idempotent: creates are upserts keyed on `code`; deletes are `deleteMany`
 * (no-op if already absent). Safe to repeat.
 *
 *   --dry-run   report intended changes; write nothing.
 *
 * Run (operator-driven, per scripts/backfills/README.md) after this ships and
 * the target image is rebuilt, as a one-shot ECS task — dry-run first, then live:
 *   npx tsx scripts/backfills/2026-07-04-center-staging-mirror.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";

type CenterDef = {
  code: string;
  name: string;
  slug: string;
  description: string;
  url: string | null;
  centerType: string;
  directorCwid: string | null;
  sortOrder: number;
};

/** 5 staging-only centers to create on prod (source=manual; zero members/programs). */
const CREATE: ReadonlyArray<CenterDef> = [
  {
    code: "appel_alzheimers",
    name: "Appel Alzheimer's Disease Research Institute",
    slug: "appel-alzheimers",
    description:
      "Research on the mechanisms, early detection, and treatment of Alzheimer's disease and related neurodegenerative disorders.",
    url: null,
    centerType: "institute",
    directorCwid: "lig2033",
    sortOrder: 130,
  },
  {
    code: "drukier_childrens_health",
    name: "Drukier Institute for Children's Health",
    slug: "drukier-childrens-health",
    description:
      "Pediatric research spanning immunology, genomics, and the biological origins of childhood disease.",
    url: null,
    centerType: "institute",
    directorCwid: "vip2021",
    sortOrder: 100,
  },
  {
    code: "friedman_nutrition",
    name: "Friedman Center for Nutrition",
    slug: "friedman-nutrition",
    description:
      "Nutrition science and its role in metabolic health, disease prevention, and clinical practice.",
    url: null,
    centerType: "center",
    directorCwid: null,
    sortOrder: 140,
  },
  {
    code: "global_health",
    name: "Center for Global Health",
    slug: "global-health",
    description:
      "Global health research and training addressing infectious disease and health-system challenges in resource-limited settings.",
    url: null,
    centerType: "center",
    directorCwid: "dwf2001",
    sortOrder: 120,
  },
  {
    code: "weill_metabolic_health",
    name: "Weill Center for Metabolic Health",
    slug: "weill-metabolic-health",
    description:
      "Research on diabetes, obesity, and metabolic disease, from molecular mechanisms to clinical care.",
    url: "https://metabolichealth.weill.cornell.edu/",
    centerType: "center",
    directorCwid: "lca4001",
    sortOrder: 110,
  },
];

/** Centers removed from the canonical seed + already dropped on staging. */
const DELETE_CODES: ReadonlyArray<string> = ["computational_biomed", "iris_cantor_womens_health"];

/** Safety: refuse to cascade-delete a center with more members than this — a
 *  guard against silently nuking a center that gained data since verification
 *  (verified counts at authoring time: 0 and 2). */
const DELETE_MEMBER_GUARD = 10;

const log = (m: string) => console.log(m);

async function run(dryRun: boolean) {
  log(`Center staging-mirror${dryRun ? " (dry run)" : ""}`);

  log(`\n--- Create/upsert ${CREATE.length} staging-only centers ---`);
  for (const c of CREATE) {
    log(`  ${c.code} (${c.name})${c.url ? ` url=${c.url}` : ""}`);
    if (!dryRun) {
      const data = {
        name: c.name,
        slug: c.slug,
        description: c.description,
        url: c.url,
        centerType: c.centerType,
        directorCwid: c.directorCwid,
        sortOrder: c.sortOrder,
        source: "manual",
      };
      await db.write.center.upsert({
        where: { code: c.code },
        create: { code: c.code, ...data },
        update: data,
      });
    }
  }

  log(`\n--- Hard-delete ${DELETE_CODES.length} seed-removed centers (cascade) ---`);
  for (const code of DELETE_CODES) {
    const members = await db.write.centerMembership.count({ where: { centerCode: code } });
    const exists = (await db.write.center.count({ where: { code } })) > 0;
    if (!exists) {
      log(`  ${code}: already absent — skip`);
      continue;
    }
    if (members > DELETE_MEMBER_GUARD) {
      log(`  ! SKIP ${code}: ${members} members exceeds guard ${DELETE_MEMBER_GUARD} — investigate before deleting`);
      continue;
    }
    log(`  ${code}: delete (cascades ${members} membership row${members === 1 ? "" : "s"})`);
    if (!dryRun) {
      await db.write.center.deleteMany({ where: { code } });
    }
  }

  // Verification read-back.
  const total = await db.write.center.count();
  const created = await db.write.center.count({ where: { code: { in: CREATE.map((c) => c.code) } } });
  const removed = await db.write.center.count({ where: { code: { in: [...DELETE_CODES] } } });
  log(
    `\nDone${dryRun ? " (dry run — nothing written)" : ""}: ${total} centers total; ` +
      `${created}/${CREATE.length} target creates present; ${removed} target deletes remaining.`,
  );
}

const main = async () => {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  await run(dryRun);
  await db.write.$disconnect();
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
