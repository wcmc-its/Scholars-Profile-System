import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, disconnect: vi.fn(), prisma: {} }));
vi.mock("@/lib/edit/search-suppression", () => ({ reflectGrantSuppressions: vi.fn() }));

import { toFinAccountPairs } from "@/etl/infoed";

// Synthetic accounts only.
describe("toFinAccountPairs", () => {
  it("keeps distinct 8-digit fin accounts, many-to-many with InfoEd accounts", () => {
    expect(
      toFinAccountPairs([
        { fin_account: "11112222", Account_Number: "0000000101" },
        { fin_account: " 11112222 ", Account_Number: "0000000101" },
        { fin_account: "11112222", Account_Number: "0000000102" },
        { fin_account: "33334444", Account_Number: "0000000101" },
      ]),
    ).toEqual([
      { finAccount: "11112222", accountNumber: "0000000101" },
      { finAccount: "11112222", accountNumber: "0000000102" },
      { finAccount: "33334444", accountNumber: "0000000101" },
    ]);
  });

  it("drops non-8-digit accts and missing account numbers", () => {
    expect(
      toFinAccountPairs([
        { fin_account: "1111222", Account_Number: "0000000101" },
        { fin_account: "111122223", Account_Number: "0000000101" },
        { fin_account: null, Account_Number: "0000000101" },
        { fin_account: "11112222", Account_Number: null },
        { fin_account: "11112222", Account_Number: " " },
      ]),
    ).toEqual([]);
  });
});
