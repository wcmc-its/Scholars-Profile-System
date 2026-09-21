/**
 * `etl/orcid-push` — the nightly that copies `scholar.orcid` into the WCM Identity record
 * through the ReCiter engine API, compare-then-write. The pure `decide` is the whole rule;
 * `runActions` is exercised with the client module mocked (no network), and the failure
 * threshold is what keeps a dead API from grading green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReciterIdentity } from "@/lib/reciter/client";

const { getIdentityByUid, saveIdentity } = vi.hoisted(() => ({
  getIdentityByUid: vi.fn(),
  saveIdentity: vi.fn(),
}));
vi.mock("@/lib/reciter/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reciter/client")>();
  return { ...actual, getIdentityByUid, saveIdentity };
});
// The module imports `db` for main(); never touched by the pure paths under test.
vi.mock("../../lib/db", () => ({ db: { write: {} } }));

import { decide, exceedsFailureThreshold, runActions, type PushAction } from "@/etl/orcid-push/index";

const ID = "0000-0002-1825-0097";
const OTHER = "0000-0001-5109-3700";
const CONFIG = { baseUrl: "http://reciter.invalid", apiKey: "x" };

/** An Identity record as the engine serves it: top-level orcid, other fields opaque. */
const identity = (orcid: string | null | undefined, extra: Record<string, unknown> = {}): ReciterIdentity => ({
  uid: "abc1234",
  primaryName: { firstName: "A", lastName: "B" },
  personTypes: ["academic-faculty"],
  ...extra,
  ...(orcid === undefined ? {} : { orcid }),
});

const target = (orcid = ID): PushAction => ({ kind: "target", cwid: "abc1234", orcid });
const dismissal = (orcid = ID): PushAction => ({ kind: "dismissal", cwid: "abc1234", orcid });

describe("orcid-push decide (pure)", () => {
  it("target: Identity already holds the iD → equal, nothing to save", () => {
    expect(decide(target(), identity(ID))).toEqual({ outcome: "equal" });
    // Whitespace on the record side does not trigger a rewrite.
    expect(decide(target(), identity(` ${ID} `))).toEqual({ outcome: "equal" });
  });

  it("target: Identity holds null / nothing / a different iD → pushed, with ONLY orcid changed", () => {
    for (const held of [null, undefined, OTHER]) {
      const rec = identity(held, { knownRelationships: [{ uid: "x" }], grants: ["G1"] });
      const d = decide(target(), rec);
      expect(d.outcome).toBe("pushed");
      // The POST body is the fetched record with orcid replaced — every other field round-trips.
      expect(d.save).toEqual({ ...rec, orcid: ID });
      expect(d.save?.knownRelationships).toEqual([{ uid: "x" }]);
      // The fetched object is not mutated.
      expect(rec.orcid).toBe(held);
    }
  });

  it("target: no Identity record (404) → no_identity, never a create", () => {
    expect(decide(target(), null)).toEqual({ outcome: "no_identity" });
  });

  it("dismissal: Identity still holds exactly the dismissed iD → cleared (orcid: null)", () => {
    const rec = identity(ID, { title: "Professor" });
    const d = decide(dismissal(), rec);
    expect(d.outcome).toBe("cleared");
    expect(d.save).toEqual({ ...rec, orcid: null });
  });

  it("dismissal: Identity holds a different iD, none, or no record → skip (someone else's write is not ours to undo)", () => {
    expect(decide(dismissal(), identity(OTHER))).toEqual({ outcome: "skip" });
    expect(decide(dismissal(), identity(null))).toEqual({ outcome: "skip" });
    expect(decide(dismissal(), identity(undefined))).toEqual({ outcome: "skip" });
    expect(decide(dismissal(), null)).toEqual({ outcome: "skip" });
  });
});

describe("orcid-push failure threshold", () => {
  it("zero checked always fails — a dead API and an empty set are indistinguishable from here", () => {
    expect(exceedsFailureThreshold(0, 0)).toBe(true);
    expect(exceedsFailureThreshold(0, 7)).toBe(true);
  });

  it("tolerates up to max(2, 10%) failures and fails past it", () => {
    // Small sets: the floor of 2 applies.
    expect(exceedsFailureThreshold(5, 2)).toBe(false);
    expect(exceedsFailureThreshold(5, 3)).toBe(true);
    // Large sets: 10% applies (100 checked → 10 allowed, 11 not).
    expect(exceedsFailureThreshold(100, 10)).toBe(false);
    expect(exceedsFailureThreshold(100, 11)).toBe(true);
    // Healthy.
    expect(exceedsFailureThreshold(1, 0)).toBe(false);
  });
});

describe("orcid-push runActions (client mocked)", () => {
  beforeEach(() => {
    getIdentityByUid.mockReset();
    saveIdentity.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("GET → decide → POST per action, and the counters add up", async () => {
    const recs: Record<string, ReciterIdentity | null> = {
      aaa1111: identity(ID, { uid: "aaa1111" }), // equal
      bbb2222: identity(null, { uid: "bbb2222" }), // pushed
      ccc3333: null, // no_identity
      ddd4444: identity(ID, { uid: "ddd4444" }), // dismissal → cleared
      eee5555: identity(OTHER, { uid: "eee5555" }), // dismissal → skip
    };
    getIdentityByUid.mockImplementation(async (_c: unknown, uid: string) => recs[uid] ?? null);
    saveIdentity.mockResolvedValue(undefined);

    const actions: PushAction[] = [
      { kind: "target", cwid: "aaa1111", orcid: ID },
      { kind: "target", cwid: "bbb2222", orcid: ID },
      { kind: "target", cwid: "ccc3333", orcid: ID },
      { kind: "dismissal", cwid: "ddd4444", orcid: ID },
      { kind: "dismissal", cwid: "eee5555", orcid: ID },
    ];
    const { counts, changed } = await runActions(actions, CONFIG, { dryRun: false, gapMs: 0 });
    expect(counts).toEqual({
      checked: 5,
      equal: 1,
      pushed: 1,
      cleared: 1,
      skip: 1,
      no_identity: 1,
      failed: 0,
    });
    expect(changed).toEqual(["bbb2222", "ddd4444"]);
    expect(saveIdentity).toHaveBeenCalledTimes(2);
    expect(saveIdentity.mock.calls[0][1]).toEqual({ ...recs.bbb2222, orcid: ID });
    expect(saveIdentity.mock.calls[1][1]).toEqual({ ...recs.ddd4444, orcid: null });
    // The key never leaves the config object: no call is made with it in the uid slot.
    for (const call of getIdentityByUid.mock.calls) expect(call[1]).not.toBe("x");
  });

  it("dry run: same decisions, same counters, zero POSTs", async () => {
    getIdentityByUid.mockResolvedValue(identity(null));
    const { counts, changed } = await runActions([target()], CONFIG, { dryRun: true, gapMs: 0 });
    expect(counts.pushed).toBe(1);
    expect(changed).toEqual(["abc1234"]);
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it("a GET failure is counted, not checked, and the loop continues; a POST failure is counted after the check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getIdentityByUid
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(identity(null))
      .mockResolvedValueOnce(identity(null));
    saveIdentity.mockRejectedValueOnce(new Error("500 Internal Server Error")).mockResolvedValueOnce(undefined);
    const actions: PushAction[] = [
      { kind: "target", cwid: "aaa1111", orcid: ID },
      { kind: "target", cwid: "bbb2222", orcid: ID },
      { kind: "target", cwid: "ccc3333", orcid: ID },
    ];
    const { counts, changed } = await runActions(actions, CONFIG, { dryRun: false, gapMs: 0 });
    expect(counts.failed).toBe(2);
    expect(counts.checked).toBe(2);
    expect(counts.pushed).toBe(1);
    expect(changed).toEqual(["ccc3333"]);
    warn.mockRestore();
  });

  it("a dead API (every GET throws) leaves checked at 0, which the threshold turns into a failed run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getIdentityByUid.mockRejectedValue(new Error("fetch failed"));
    const { counts } = await runActions([target(), dismissal()], CONFIG, { dryRun: true, gapMs: 0 });
    expect(counts).toMatchObject({ checked: 0, failed: 2 });
    expect(exceedsFailureThreshold(counts.checked, counts.failed)).toBe(true);
    warn.mockRestore();
  });

  it("waits the gap between consecutive calls (sequential, never a burst)", async () => {
    vi.useFakeTimers();
    getIdentityByUid.mockResolvedValue(identity(ID));
    const p = runActions([target(), target(), target()], CONFIG, { dryRun: true, gapMs: 100 });
    // First GET fires immediately; each further one waits for the gap.
    await vi.advanceTimersByTimeAsync(0);
    expect(getIdentityByUid).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(getIdentityByUid).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(getIdentityByUid).toHaveBeenCalledTimes(3);
    const { counts } = await p;
    expect(counts.equal).toBe(3);
  });
});
