import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CADENCE_STEP_TIMEOUT_SECONDS,
  HONORS_TASK_TIMEOUT_SECONDS,
  INFOED_REQUEST_TIMEOUT_SECONDS,
  MARGIN_WARN_FRACTION,
  PROJECTION_TASK_TIMEOUT_SECONDS,
  RECONCILER_TASK_TIMEOUT_SECONDS,
  type MarginRow,
  gradeDurationMargin,
  marginWindowStart,
  stepTimeoutSeconds,
} from "@/lib/etl/duration-margin";
import { HOUR_MS, TRACKED } from "@/lib/etl/freshness-policy";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const TIMEOUT = 2400;

/** A run that started `agoS` seconds before NOW and ran `durS` seconds (null = never closed). */
function row(agoS: number, durS: number | null, status = "success"): MarginRow {
  const startedAt = new Date(NOW - agoS * 1000);
  return {
    startedAt,
    completedAt: durS === null ? null : new Date(startedAt.getTime() + durS * 1000),
    status,
  };
}

describe("gradeDurationMargin", () => {
  it("is ok when every run is well under its timeout", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [row(80_000, 500), row(3_600, 520)], NOW);
    expect(r.level).toBe("ok");
    expect(r.worst?.durationSeconds).toBe(520);
  });

  it("is near at 80% of the timeout — the creep #2190 is about", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [row(3_600, 2000)], NOW);
    expect(r.level).toBe("near");
    expect(r.fraction).toBeCloseTo(2000 / 2400);
    // Exactly at the threshold counts.
    expect(gradeDurationMargin("InfoEd", TIMEOUT, [row(3_600, 1920)], NOW).level).toBe("near");
    expect(gradeDurationMargin("InfoEd", TIMEOUT, [row(3_600, 1919)], NOW).level).toBe("ok");
  });

  it("is over when a retry row ran past the timeout, even if a later retry was short", () => {
    // The 08-05 shape: attempts die at ~2427s, each a separate etl_run row.
    const rows = [row(20_000, 2427, "failed"), row(15_000, 2427, "failed"), row(10_000, 300)];
    const r = gradeDurationMargin("InfoEd", TIMEOUT, rows, NOW);
    expect(r.level).toBe("over");
    expect(r.worst?.status).toBe("failed");
  });

  it("treats a missing completedAt as in flight while under the timeout", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [row(600, null, "running")], NOW);
    expect(r.level).toBe("ok");
    expect(r.worst?.open).toBe(true);
    expect(r.worst?.durationSeconds).toBe(600);
  });

  it("treats a missing completedAt past the timeout as over — the task was killed", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [row(9_000, null, "running")], NOW);
    expect(r.level).toBe("over");
    expect(r.worst?.open).toBe(true);
  });

  it("is ok with no rows at all — absence is freshness's job, not margin's", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [], NOW);
    expect(r).toMatchObject({ level: "ok", worst: null, fraction: null });
  });

  it("never reports a negative duration when the DB clock led Node's", () => {
    const r = gradeDurationMargin("InfoEd", TIMEOUT, [row(100, -5)], NOW);
    expect(r.worst?.durationSeconds).toBe(0);
  });
});

describe("stepTimeoutSeconds", () => {
  it("grades cadence steps against the buildStep cap and overrides where a tighter ceiling kills first", () => {
    expect(stepTimeoutSeconds("ED")).toBe(CADENCE_STEP_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("SearchIndex")).toBe(CADENCE_STEP_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("InfoEd")).toBe(INFOED_REQUEST_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("SearchReconcile")).toBe(RECONCILER_TASK_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("CdnReconcile")).toBe(RECONCILER_TASK_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("HonorsLists")).toBe(HONORS_TASK_TIMEOUT_SECONDS);
    expect(stepTimeoutSeconds("ReCiterAI-projection")).toBe(PROJECTION_TASK_TIMEOUT_SECONDS);
  });

  it("skips producer-mirrored ReciterAI rows — their timestamps are not our task's", () => {
    const mirrored = Object.keys(TRACKED).filter((s) => s.startsWith("ReciterAI-"));
    expect(mirrored.length).toBeGreaterThan(0);
    for (const s of mirrored) expect(stepTimeoutSeconds(s), s).toBeNull();
  });

  it("warns at 80%", () => {
    expect(MARGIN_WARN_FRACTION).toBe(0.8);
  });
});

describe("marginWindowStart", () => {
  it("looks back one cadence SLA window", () => {
    expect(marginWindowStart("nightly", NOW).getTime()).toBe(NOW - 30 * HOUR_MS);
  });
});

/**
 * The timeouts are MIRRORED from files lib/ and etl/ may not import (cdk/ is
 * out of the Docker build context). Read them as text and fail on drift, so a
 * timeout change in the stack cannot leave the margin check grading against a
 * ceiling that no longer exists.
 */
describe("mirrored timeouts match their source of truth", () => {
  const root = join(__dirname, "..", "..");
  const stack = readFileSync(join(root, "cdk/lib/etl-stack.ts"), "utf8");

  const UNIT_SECONDS: Record<string, number> = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400,
  };
  /** The first `taskTimeout: sfn.Timeout.duration(Duration.<unit>(n))` after `anchor`. */
  function taskTimeoutAfter(anchor: string): number {
    const at = stack.indexOf(anchor);
    expect(at, `anchor not found in etl-stack.ts: ${anchor}`).toBeGreaterThanOrEqual(0);
    const m = /taskTimeout: sfn\.Timeout\.duration\(Duration\.(\w+)\((\d+)\)\)/.exec(
      stack.slice(at),
    );
    expect(m, `no taskTimeout after ${anchor}`).not.toBeNull();
    return Number(m![2]) * UNIT_SECONDS[m![1]];
  }

  it("buildStep cadence steps", () => {
    expect(taskTimeoutAfter("const buildStep = (")).toBe(CADENCE_STEP_TIMEOUT_SECONDS);
  });
  it("search:reconcile and cdn:reconcile", () => {
    expect(taskTimeoutAfter('command: ["npm", "run", "search:reconcile"]')).toBe(
      RECONCILER_TASK_TIMEOUT_SECONDS,
    );
    expect(taskTimeoutAfter('command: ["npm", "run", "cdn:reconcile"]')).toBe(
      RECONCILER_TASK_TIMEOUT_SECONDS,
    );
  });
  it("etl:honors", () => {
    expect(taskTimeoutAfter('command: ["npm", "run", "etl:honors"]')).toBe(
      HONORS_TASK_TIMEOUT_SECONDS,
    );
  });
  it("etl:dynamodb projection machine", () => {
    expect(taskTimeoutAfter('command: ["npm", "run", "etl:dynamodb"]')).toBe(
      PROJECTION_TASK_TIMEOUT_SECONDS,
    );
  });
  it("InfoEd requestTimeout", () => {
    const src = readFileSync(join(root, "lib/sources/mssql-infoed.ts"), "utf8");
    const m = /requestTimeout:\s*([\d_]+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, "")) / 1000).toBe(INFOED_REQUEST_TIMEOUT_SECONDS);
  });
});
