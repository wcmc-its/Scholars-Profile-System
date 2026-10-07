import { describe, expect, it } from "vitest";
import { frtNameKey, frtNicknameCandidate, resolveFrtMentee } from "@/lib/frt/mentee-name";

describe("frtNameKey", () => {
  it("keys on first + last token, ignoring middles, case and accents", () => {
    expect(frtNameKey("Jane Q. Doe")).toBe("jane|doe");
    expect(frtNameKey("  JOSÉ  García ")).toBe("jose|garcia");
  });
  it("flips 'Last, First' and drops honorifics and degrees", () => {
    expect(frtNameKey("Doe, Jane")).toBe("jane|doe");
    expect(frtNameKey("Dr. Jane Doe, MD, PhD")).toBe("jane|doe");
  });
  it("returns null when there is no first + last pair", () => {
    expect(frtNameKey("Jane")).toBeNull();
    expect(frtNameKey("")).toBeNull();
    expect(frtNameKey(null)).toBeNull();
  });
});

describe("frtNicknameCandidate", () => {
  const idx = new Map<string, Set<string>>([
    ["robert|wexley", new Set(["zzf0001"])],
    ["gerald|harrowby", new Set(["zzf0002"])],
    ["jerome|harrowby", new Set(["zzf0003"])],
    ["bob|quorn", new Set(["zzf0004"])],
    ["robert|quorn", new Set(["zzf0005"])],
  ]);

  it("keeps the persisted key unchanged — a nickname is not folded into it", () => {
    expect(frtNameKey("Bob Wexley")).toBe("bob|wexley");
  });
  it("finds the one person a nickname reaches when the exact key misses", () => {
    expect(frtNicknameCandidate(idx, "bob|wexley")).toBe("zzf0001");
  });
  it("never fires when the exact key already finds someone", () => {
    expect(frtNicknameCandidate(idx, "bob|quorn")).toBeNull();
  });
  it("returns null when the nickname reaches more than one person, or none", () => {
    expect(frtNicknameCandidate(idx, "jerry|harrowby")).toBeNull();
    expect(frtNicknameCandidate(idx, "effie|wexley")).toBeNull();
    expect(frtNicknameCandidate(idx, "rob|nowhere")).toBeNull();
  });
});

describe("resolveFrtMentee", () => {
  const idx = new Map<string, Set<string>>([
    ["robert|wexley", new Set(["zzf0001"])],
    ["ana|ruizmont", new Set(["zzf0006"])],
    ["mentor|selfsame", new Set(["zzf0009"])],
  ]);

  it("an exact key links, as before, with no suggestion", () => {
    expect(resolveFrtMentee(idx, "ana|ruizmont", "zzm0001", false)).toEqual({
      menteeCwid: "zzf0006",
      suggestedCwid: null,
    });
  });
  it("a nickname-only match is a SUGGESTION, never the link", () => {
    expect(resolveFrtMentee(idx, "bob|wexley", "zzm0001", false)).toEqual({
      menteeCwid: null,
      suggestedCwid: "zzf0001",
    });
  });
  it("external mentees get neither", () => {
    expect(resolveFrtMentee(idx, "bob|wexley", "zzm0001", true)).toEqual({
      menteeCwid: null,
      suggestedCwid: null,
    });
  });
  it("never links or suggests the mentor themself", () => {
    expect(resolveFrtMentee(idx, "bob|wexley", "zzf0001", false)).toEqual({
      menteeCwid: null,
      suggestedCwid: null,
    });
    expect(resolveFrtMentee(idx, "mentor|selfsame", "zzf0009", false).menteeCwid).toBeNull();
  });
});
