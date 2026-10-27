import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { write: {} } }));

import { classifyLink, promotionAfterDelete } from "@/etl/nih-profile/cleanup-misattributed";

describe("classifyLink", () => {
  it("is ok when RePORTER's name matches the full name", () => {
    expect(classifyLink(["John A Smith"], ["John A. Smith", null])).toBe("ok");
  });

  it("is ok when only the preferred name matches", () => {
    expect(classifyLink(["Jack Smith"], ["John Smith", "Jack Smith"])).toBe("ok");
  });

  it("is surname_only when the surname agrees and the given name does not", () => {
    expect(classifyLink(["Robert Smith"], ["John Smith", null])).toBe("surname_only");
  });

  it("is wrong when no RePORTER name shares the scholar's surname", () => {
    expect(classifyLink(["Mary Jones", "JONES, MARY"], ["John Smith", "Jack Smith"])).toBe("wrong");
  });

  it("is ok when any one of several RePORTER names matches", () => {
    expect(classifyLink(["Mary Jones", "John Smith"], ["John Smith", null])).toBe("ok");
  });

  it('keeps a "LAST, FIRST" name that namesMatch can\'t read as surname_only, never wrong', () => {
    expect(classifyLink(["SMITH, JOHN"], ["John Smith", null])).toBe("surname_only");
  });

  it("is no_name when RePORTER returned nothing", () => {
    expect(classifyLink([], ["John Smith", null])).toBe("no_name");
  });
});

describe("promotionAfterDelete", () => {
  const at = (iso: string) => new Date(iso);

  it("promotes the most recently verified row left when the preferred row goes", () => {
    const rows = [
      { nihProfileId: 1, isPreferred: true, lastVerified: at("2026-10-01") },
      { nihProfileId: 2, isPreferred: false, lastVerified: at("2026-09-01") },
      { nihProfileId: 3, isPreferred: false, lastVerified: at("2026-10-20") },
    ];
    expect(promotionAfterDelete(rows, new Set([1]))).toBe(3);
  });

  it("breaks a tie on the lowest id", () => {
    const rows = [
      { nihProfileId: 9, isPreferred: true, lastVerified: at("2026-10-01") },
      { nihProfileId: 5, isPreferred: false, lastVerified: at("2026-09-01") },
      { nihProfileId: 4, isPreferred: false, lastVerified: at("2026-09-01") },
    ];
    expect(promotionAfterDelete(rows, new Set([9]))).toBe(4);
  });

  it("promotes nothing when only non-preferred rows go", () => {
    const rows = [
      { nihProfileId: 1, isPreferred: true, lastVerified: at("2026-10-01") },
      { nihProfileId: 2, isPreferred: false, lastVerified: at("2026-10-20") },
    ];
    expect(promotionAfterDelete(rows, new Set([2]))).toBeNull();
  });

  it("promotes nothing when no row is left", () => {
    const rows = [{ nihProfileId: 1, isPreferred: true, lastVerified: at("2026-10-01") }];
    expect(promotionAfterDelete(rows, new Set([1]))).toBeNull();
  });

  it("never promotes a row that is itself being deleted", () => {
    const rows = [
      { nihProfileId: 1, isPreferred: true, lastVerified: at("2026-10-01") },
      { nihProfileId: 2, isPreferred: false, lastVerified: at("2026-10-20") },
      { nihProfileId: 3, isPreferred: false, lastVerified: at("2026-09-01") },
    ];
    expect(promotionAfterDelete(rows, new Set([1, 2]))).toBe(3);
  });
});
