/**
 * The stage and article-type SQL report 8, report 26 and its nightly table
 * (etl:translational-portfolio) share. Its own module, with no `server-only`
 * import chain, so the ETL can load it.
 */
import { Prisma } from "@/lib/generated/prisma/client";
import { TRANSLATIONAL_STAGES } from "@/lib/translational-stage";

/** The SQL form of `displayStage` (`lib/api/topic-activity.ts`): low confidence
 *  hidden, NULL confidence shown. */
export const STAGE_NOT_LOW = Prisma.sql`(p.translational_stage_confidence IS NULL OR p.translational_stage_confidence <> 'low')`;

/** The SQL form of `displayStage`: the stage, else NULL (= No stage). */
export const stageCase = () =>
  Prisma.sql`CASE WHEN p.translational_stage IN (${Prisma.join([...TRANSLATIONAL_STAGES])}) AND ${STAGE_NOT_LOW} THEN p.translational_stage END`;

/** Report 26 counts research articles only (report 8's `atype`; ReCiter's
 *  "Academic Article", shown as Research Article). Reviews, editorials,
 *  letters, book chapters and errata almost never get a stage (165 of them
 *  staged across 2020-2025), so counting them only inflated No stage (#3610). */
export const PORTFOLIO_ARTICLE_TYPES: readonly string[] = ["Academic Article"];
