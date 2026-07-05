/**
 * Department URL promotion backfill (2026-07-04, one-shot per DB).
 *
 * Promotes the 26 department homepage-URL edits made on STAGING via the /edit
 * self-editor (actor `dwd2001`, 2026-06-16) to any environment where they are
 * not yet present — created to move those staging curator edits to prod, which
 * has no cross-env edit-promotion path (ADR-005 non-goal). Each edit is a
 * `field_override(entityType=department, entityId=<code>, fieldName=url)` row:
 * the manual-layer curator value the read path merges over the ED-owned
 * `department.url` column. Source of truth for this list is the staging
 * `scholars_audit.manual_edit_audit` log (action=field_override,
 * target_entity_type=department, after_values.url).
 *
 * SCOPE — this covers ONLY the 26 department URLs, which are cleanly promotable:
 * every target department exists in every env (ED ETL), the value is additive
 * (verified prod baseline: department.url = null, zero existing overrides), and
 * `field_override` has no FK. Three related staging edits are DEFERRED and NOT
 * handled here, each pending a decision:
 *   - Center `weill_metabolic_health` URL — the center is staging-only (absent
 *     from prod, which has 8 centers, none metabolic); promoting the URL first
 *     requires creating the center on prod.
 *   - Meyer Cancer Center roster dates (aas9008 end 2026-06-03; achadbur start
 *     2026-06-02 / end 2026-06-09) — the prod center_membership rows exist but
 *     are empty (null membership_type/program_code/dates), and program_code='CT'
 *     needs a matching CenterProgram FK on prod. See the prior meyer backfills
 *     (2026-06-10-meyer-center-membership-extended, 2026-06-18-meyer-program-
 *     leaders) — likely run on staging but not prod. Needs a dates-only-vs-full
 *     decision + FK prereq check.
 *
 * Idempotent: upsert keyed on (entityType, entityId, fieldName); re-running
 * re-asserts the same value. Safe to repeat.
 *
 *   --dry-run   report intended changes; write nothing.
 *
 * Run (operator-driven, per scripts/backfills/README.md): after this ships and
 * the target image is rebuilt, invoke as a one-shot ECS task — dry-run first,
 * then live:
 *   npx tsx scripts/backfills/2026-07-04-dept-url-promotion.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";

/** field_override.actor_cwid sentinel attributing these rows to this backfill.
 *  The original curator (dwd2001) is preserved in the staging audit log. */
const ACTOR = "dept-url-promo";

/** { department code -> homepage URL }, verbatim from the staging edits
 *  (trailing slashes preserved exactly as entered). */
const DEPT_URLS: ReadonlyArray<{ code: string; url: string }> = [
  { code: "N1140", url: "https://anesthesiology.weill.cornell.edu" },
  { code: "N1700", url: "https://biochem.weill.cornell.edu" },
  { code: "N1160", url: "https://ctsurgery.weillcornell.org" },
  { code: "N1710", url: "https://celldevbiology.weill.cornell.edu" },
  { code: "N1240", url: "https://emed.weill.cornell.edu/" },
  { code: "N1360", url: "https://eye.weillcornell.org/" },
  { code: "N1760", url: "https://brainandmind.weill.cornell.edu/" },
  { code: "N1720", url: "https://geneticmedicine.weill.cornell.edu/" },
  { code: "N1730", url: "https://microbiology.weill.cornell.edu/" },
  { code: "N1320", url: "https://neurosurgery.weill.cornell.edu/" },
  { code: "N1300", url: "https://neurology.weill.cornell.edu/" },
  { code: "N1340", url: "https://obgyn.weillcornell.org/" },
  { code: "N1400", url: "https://ent.weill.cornell.edu" },
  { code: "N1420", url: "https://pathology.weill.cornell.edu/" },
  { code: "N1440", url: "https://pediatrics.weill.cornell.edu/" },
  { code: "N1750", url: "https://pharmacology.weill.cornell.edu/" },
  { code: "N1480", url: "https://phs.weill.cornell.edu/" },
  { code: "N1500", url: "https://psychiatry.weill.cornell.edu/" },
  { code: "N1530", url: "https://radiationoncology.weillcornell.org" },
  { code: "N1520", url: "https://radiology.weill.cornell.edu/" },
  { code: "N1540", url: "https://rehabmed.weill.cornell.edu/" },
  { code: "N1180", url: "https://ivf.org/" },
  { code: "N1932", url: "https://library.weill.cornell.edu/" },
  { code: "N1560", url: "https://surgery.weill.cornell.edu/" },
  { code: "N1580", url: "https://urology.weill.cornell.edu/" },
  { code: "N1280", url: "https://medicine.weill.cornell.edu/" },
];

const log = (m: string) => console.log(m);

async function run(dryRun: boolean) {
  log(`Department URL promotion — ${DEPT_URLS.length} field_override(url) rows${dryRun ? " (dry run)" : ""}`);

  for (const d of DEPT_URLS) {
    log(`  ${d.code} -> ${d.url}`);
    if (!dryRun) {
      await db.write.fieldOverride.upsert({
        where: {
          entityType_entityId_fieldName: {
            entityType: "department",
            entityId: d.code,
            fieldName: "url",
          },
        },
        create: {
          entityType: "department",
          entityId: d.code,
          fieldName: "url",
          value: d.url,
          actorCwid: ACTOR,
        },
        update: { value: d.url, actorCwid: ACTOR },
      });
    }
  }

  // Verification read-back: how many of the target overrides are present now.
  const present = await db.write.fieldOverride.count({
    where: {
      entityType: "department",
      fieldName: "url",
      entityId: { in: DEPT_URLS.map((d) => d.code) },
    },
  });
  log(
    `\nDone${dryRun ? " (dry run — nothing written)" : ""}: ` +
      `${present}/${DEPT_URLS.length} department url overrides present.`,
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
