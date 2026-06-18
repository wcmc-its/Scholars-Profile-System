/**
 * `lib/edit/reciter-pending-hint.ts` — the `SELF_EDIT_RECITER_PENDING_HINT` flag
 * reader for the dormant ReCiter pending-suggestions nudge. Follows the strict
 * `=== "on"` convention, so every other value (unset, "off", casing variants,
 * "true") keeps the feature dark.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReciterPendingHintEnabled } from "@/lib/edit/reciter-pending-hint";

describe("isReciterPendingHintEnabled (SELF_EDIT_RECITER_PENDING_HINT)", () => {
  const original = process.env.SELF_EDIT_RECITER_PENDING_HINT;
  beforeEach(() => {
    delete process.env.SELF_EDIT_RECITER_PENDING_HINT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SELF_EDIT_RECITER_PENDING_HINT;
    else process.env.SELF_EDIT_RECITER_PENDING_HINT = original;
  });

  it("defaults to false when the env is unset (ships dark)", () => {
    expect(isReciterPendingHintEnabled()).toBe(false);
  });

  it("is true only for exactly 'on'", () => {
    process.env.SELF_EDIT_RECITER_PENDING_HINT = "on";
    expect(isReciterPendingHintEnabled()).toBe(true);
  });

  it("is false for any value that is not 'on' (incl. casing variants and 'true')", () => {
    process.env.SELF_EDIT_RECITER_PENDING_HINT = "ON";
    expect(isReciterPendingHintEnabled()).toBe(false);
    process.env.SELF_EDIT_RECITER_PENDING_HINT = "off";
    expect(isReciterPendingHintEnabled()).toBe(false);
    process.env.SELF_EDIT_RECITER_PENDING_HINT = "true";
    expect(isReciterPendingHintEnabled()).toBe(false);
    process.env.SELF_EDIT_RECITER_PENDING_HINT = "";
    expect(isReciterPendingHintEnabled()).toBe(false);
  });
});
