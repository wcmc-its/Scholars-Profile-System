/**
 * `etl:area-signal-inputs` — send eligible grant and trial TEXTS to ReciterAI
 * for research-area scoring, and stamp each SPS row with the key of its text.
 *
 *   SPS nightly (this step)        ReciterAI daily              SPS next nightly
 *   eligible grants + trials  ->   drain AREAINPUT pending  ->  etl:dynamodb projects
 *   text_key on each row           synopsis + area scores       AREASIGNAL# into
 *   PutItem AREAINPUT (new keys)   PutItem AREASIGNAL#          area_signal_text/_topic
 *
 * Runs in the nightly chain after Infoed and before Dynamodb, and in the weekly
 * chain after ClinicalTrialsWeekly (that step full-replaces `clinical_trial`,
 * which nulls every trial's key until this re-derives it).
 *
 * Eligibility is lib/area-signals.ts, shared with the ranking. Only scholars the
 * ranking can reach are read (the top-scholars carve: active, not deleted,
 * full-time faculty), so nothing is scored that could never move a card.
 * Suppressed grants are not sent; `hideFunding` / `hideClinicalTrials` are
 * applied at read time instead, since a scholar can flip them back any day.
 *
 * `--dry-run` reads and reports, writes nothing (neither SPS nor DynamoDB, nor
 * an etl_run row: a green dry run would read as a real pass on the freshness
 * board, the same rule as etl/orcid-registry).
 *
 * rowsProcessed is the VOLUME of eligible texts this run planned, not the count
 * of new AREAINPUT items put. The put count is a change count (thousands on the
 * backfill, a handful on an ordinary night), which the integrity volume guard
 * would read as a collapse. The planned-text volume is stable night to night, so
 * the guard stays meaningful: a >50% drop is a truncated grant or trial read.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { withEtlRun } from "@/lib/etl-run";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { loadAllGrantSuppressions } from "@/lib/api/manual-layer";
import {
  AREA_GRANT_ROLES,
  AREA_GRANT_SOURCE,
  AREA_SIGNAL_START_DATE,
  AREA_TRIAL_PI_ROLE,
  isEligibleAreaGrant,
  isEligibleAreaTrial,
} from "@/lib/area-signals";
import { listQueuedInputKeys, putNewInputs, type AreaInputDdbClient } from "./dynamo";
import { buildInputPlan, planKeyColumn, type TrialInputRow } from "./plan";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const UPDATE_BATCH = 500;

const scholarCarve: Prisma.ScholarWhereInput = {
  deletedAt: null,
  status: "active",
  roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
};

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Group `id -> key` by key so each distinct key is one updateMany per chunk. */
function byKey(set: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, key] of set) out.set(key, [...(out.get(key) ?? []), id]);
  return out;
}

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<number> {
  const now = new Date();

  // ----- grants -----------------------------------------------------------
  const [grantRows, suppressed] = await Promise.all([
    db.write.grant.findMany({
      where: {
        source: AREA_GRANT_SOURCE,
        role: { in: [...AREA_GRANT_ROLES] },
        startDate: { gte: new Date(`${AREA_SIGNAL_START_DATE}T00:00:00Z`) },
        scholar: scholarCarve,
      },
      select: {
        id: true,
        externalId: true,
        source: true,
        role: true,
        title: true,
        abstract: true,
        startDate: true,
        primeSponsor: true,
        directSponsor: true,
        nihIc: true,
        mechanism: true,
        programType: true,
      },
    }),
    loadAllGrantSuppressions(db.write),
  ]);
  const grants = grantRows.filter((g) => isEligibleAreaGrant(g) && !suppressed.has(g.externalId));

  // ----- trials -----------------------------------------------------------
  const piRows = await db.write.personClinicalTrial.findMany({
    where: {
      role: AREA_TRIAL_PI_ROLE,
      scholar: scholarCarve,
      trial: { nctNumber: { not: null }, startDate: { gte: AREA_SIGNAL_START_DATE.slice(0, 4) } },
    },
    select: {
      trial: {
        select: {
          protocolNumber: true,
          nctNumber: true,
          status: true,
          title: true,
          briefSummary: true,
          startDate: true,
          principalSponsor: true,
          phase: true,
          studyType: true,
          conditions: true,
          interventions: true,
        },
      },
    },
  });
  const trialsById = new Map<string, TrialInputRow>();
  for (const { trial } of piRows) {
    if (isEligibleAreaTrial(trial)) trialsById.set(trial.protocolNumber, trial);
  }
  const trials = [...trialsById.values()];

  const plan = buildInputPlan(grants, trials, now);

  // ----- key columns ------------------------------------------------------
  const [keyedGrants, keyedTrials] = await Promise.all([
    db.write.grant.findMany({
      where: { areaTextKey: { not: null } },
      select: { id: true, areaTextKey: true },
    }),
    db.write.clinicalTrial.findMany({
      where: { areaTextKey: { not: null } },
      select: { protocolNumber: true, areaTextKey: true },
    }),
  ]);
  const grantCols = planKeyColumn(
    plan.grantKeys,
    new Map(keyedGrants.map((g) => [g.id, g.areaTextKey as string])),
  );
  const trialCols = planKeyColumn(
    plan.trialKeys,
    new Map(keyedTrials.map((t) => [t.protocolNumber, t.areaTextKey as string])),
  );
  for (const [table, p] of [["grant", grantCols], ["clinical_trial", trialCols]] as const) {
    if (p.clearSkipped) {
      console.warn(`[AreaSignalInputs] ${table} key clear SKIPPED — ${p.clearSkipped}; likely a partial read.`);
    }
  }

  const grantItems = [...plan.items.values()].filter((i) => i.kind === "grant");
  console.log(
    `[AreaSignalInputs] ${JSON.stringify({
      event: "area_signal_inputs_plan",
      dryRun,
      grantRowsRead: grantRows.length,
      grantRowsEligible: grants.length,
      grantTexts: grantItems.length,
      grantTextsFull: grantItems.filter((i) => i.mode === "full").length,
      trialsEligible: trials.length,
      trialTexts: plan.items.size - grantItems.length,
      grantKeysToSet: grantCols.set.size,
      grantKeysToClear: grantCols.clear.length,
      trialKeysToSet: trialCols.set.size,
      trialKeysToClear: trialCols.clear.length,
    })}`,
  );
  if (dryRun) return plan.items.size;

  for (const [key, ids] of byKey(grantCols.set)) {
    for (const c of chunks(ids, UPDATE_BATCH)) {
      await db.write.grant.updateMany({ where: { id: { in: c } }, data: { areaTextKey: key } });
    }
  }
  for (const c of chunks(grantCols.clear, UPDATE_BATCH)) {
    await db.write.grant.updateMany({ where: { id: { in: c } }, data: { areaTextKey: null } });
  }
  for (const [key, ids] of byKey(trialCols.set)) {
    for (const c of chunks(ids, UPDATE_BATCH)) {
      await db.write.clinicalTrial.updateMany({
        where: { protocolNumber: { in: c } },
        data: { areaTextKey: key },
      });
    }
  }
  for (const c of chunks(trialCols.clear, UPDATE_BATCH)) {
    await db.write.clinicalTrial.updateMany({
      where: { protocolNumber: { in: c } },
      data: { areaTextKey: null },
    });
  }

  // ----- queue ------------------------------------------------------------
  // After the key columns on purpose: a key with no score yet is inert (the
  // ranking finds no area_signal_topic rows for it), while a queue write that
  // failed is retried by tomorrow's run, which re-reads the queue.
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  }) as unknown as AreaInputDdbClient;
  const cmd = { Put: PutCommand, Query: QueryCommand };
  const queued = await listQueuedInputKeys(ddb, TABLE, cmd);
  const res = await putNewInputs(ddb, TABLE, cmd, plan.items.values(), queued);
  console.log(
    `[AreaSignalInputs] ${JSON.stringify({ event: "area_signal_inputs_complete", queuedBefore: queued.size, ...res })}`,
  );
  return plan.items.size;
}

if (
  process.env.NODE_ENV !== "test" &&
  process.argv[1] &&
  /etl[\\/]area-signal-inputs/.test(process.argv[1])
) {
  // A dry run must not leave a green etl_run row behind (see the header).
  (dryRun ? main().then(() => undefined) : withEtlRun("AreaSignal-inputs", main))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.write.$disconnect());
}
