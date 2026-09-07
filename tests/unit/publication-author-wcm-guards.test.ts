/**
 * The three `publication_author` WCM-row guards, shape-asserted.
 *
 * Each of the three readers carved in `fix: scope the three unguarded
 * publication_author readers to WCM rows` carries a long comment arguing that
 * its filter must not be silently widened or dropped — and nothing enforced
 * that. Deleting all three guard lines left every nearby suite green, so the
 * comments were the only thing holding the line.
 *
 * These are deliberately shape assertions, not behavior tests: two of the
 * three guards are provable no-ops against deployed data (the profile and
 * search-index readers both drop null-cwid rows again downstream), so there is
 * no output to assert on. What must not change is the QUERY, which is exactly
 * what is checked here. No database, no fixtures, no snapshot.
 *
 * The third — `fetchAuthorshipOnPub` — is the one whose output does move:
 * `firstCount` / `lastCount` count every returned row and pick "First" vs
 * "Co-first" and "Senior" vs "Co-senior". Its filter lives in raw SQL, so the
 * assertion reads the tagged-template text the way
 * tests/unit/scholar-count-link-parity.test.ts does.
 *
 * The profile.ts guard is asserted in tests/unit/profile-api.test.ts, next to
 * the honors-gate test, because it needs that file's Prisma mock surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection: vi.fn() }));

import { fetchAuthorshipOnPub } from "@/lib/api/popover-context";
import { PUBLICATION_INDEX_INCLUDE } from "@/lib/search-index-docs";

beforeEach(() => {
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
});

describe("publication_author WCM-row guards", () => {
  // lib/search-index-docs.ts — `authorNames` is a ^2-boosted BM25 field, so
  // widening this `where` changes the field length of every publication doc
  // and with it every relevance score, silently. That is an A/B against
  // scripts/search-eval/, never an incidental edit.
  it("search index: PUBLICATION_INDEX_INCLUDE scopes authors to non-null cwid", () => {
    expect(PUBLICATION_INDEX_INCLUDE.authors.where).toEqual({ cwid: { not: null } });
  });

  // lib/api/popover-context.ts — the one guard whose OUTPUT changes if a
  // null-cwid row exists: an external byline carrying its own is_first would
  // turn "First author" into "Co-first author" site-wide with nothing failing.
  it("popover role pill: the authorship-count SQL ANDs `cwid IS NOT NULL`", async () => {
    await fetchAuthorshipOnPub("abc1001", "12345678");

    const [strings] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    // The tagged template arrives as (strings, ...values); `?` stands in for
    // each interpolated bind so the joined text reads like the real query.
    const sql = strings.join("?");
    // A conjunct, not a disjunct — `OR cwid IS NOT NULL` would widen the count
    // back to the full byline while still containing the substring.
    expect(sql).toMatch(/AND\s+cwid IS NOT NULL/);
  });
});
