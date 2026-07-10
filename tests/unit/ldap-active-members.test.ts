/**
 * Active-member guard helper (`fetchActiveMembersByCwid`) — the shared lookup
 * every ED-sourced org-unit role import consults so a person whose ED entry is
 * `weillCornellEduActiveMember=FALSE` is not (re-)granted unit-edit access.
 *
 * Exercises the projection (TRUE → true, FALSE / missing-attr / not-found →
 * false), lowercasing, RFC-4515 escaping, and 100-per-query chunking against a
 * fake ldapts client. No live LDAP.
 */
import { describe, expect, it } from "vitest";

import { fetchActiveMembersByCwid } from "@/lib/sources/ldap";
import type { Client } from "ldapts";

/**
 * Fake ldapts client. `found` maps a lowercased CWID to the value its
 * `weillCornellEduActiveMember` attribute carries (or `undefined` to model a
 * person entry that exists but omits the attribute). A CWID absent from `found`
 * models a person NOT present in ou=people.
 */
function makeClient(found: Record<string, string | undefined>) {
  const calls: Array<{ base: string; filter: string }> = [];
  const client = {
    async search(base: string, options: { filter: string }) {
      calls.push({ base, filter: options.filter });
      const requested = [
        ...String(options.filter).matchAll(/weillCornellEduCWID=([^)]+)\)/g),
      ].map((m) => m[1]);
      const searchEntries = requested
        .filter((c) => Object.prototype.hasOwnProperty.call(found, c))
        .map((c) => ({
          weillCornellEduCWID: c,
          ...(found[c] !== undefined ? { weillCornellEduActiveMember: found[c] } : {}),
        }));
      return { searchEntries };
    },
    calls,
  };
  return client as unknown as Client & { calls: typeof calls };
}

describe("fetchActiveMembersByCwid", () => {
  it("returns an entry for every input CWID; only TRUE maps to active", async () => {
    const client = makeClient({
      alice: "TRUE",
      bob: "FALSE",
      carol: undefined, // person exists but no active attr
      // dave: absent → not found in ou=people
    });
    const map = await fetchActiveMembersByCwid(client, ["alice", "bob", "carol", "dave"]);

    expect(map.get("alice")).toBe(true);
    expect(map.get("bob")).toBe(false); // explicit FALSE
    expect(map.get("carol")).toBe(false); // missing attr → fail-closed
    expect(map.get("dave")).toBe(false); // not found → fail-closed
    expect(map.size).toBe(4);
  });

  it("empty input performs no search and returns an empty map", async () => {
    const client = makeClient({});
    const map = await fetchActiveMembersByCwid(client, []);
    expect(map.size).toBe(0);
    expect(client.calls.length).toBe(0);
  });

  it("lowercases input CWIDs before querying and keying", async () => {
    const client = makeClient({ alice: "TRUE" });
    const map = await fetchActiveMembersByCwid(client, ["ALICE"]);
    expect(map.get("alice")).toBe(true);
    // filter carries the lowercased CWID
    expect(client.calls[0].filter).toContain("weillCornellEduCWID=alice)");
  });

  it("uses the ou=people eduPerson OR-filter and RFC-4515-escapes CWIDs", async () => {
    const client = makeClient({});
    await fetchActiveMembersByCwid(client, ["a*b"]);
    expect(client.calls[0].filter.startsWith("(&(objectClass=eduPerson)(|")).toBe(true);
    // "*" must be escaped so a user-injected wildcard is literal, not a match-all.
    expect(client.calls[0].filter).toContain("weillCornellEduCWID=a\\2ab)");
  });

  it("chunks the OR filter at 100 CWIDs per query", async () => {
    const found: Record<string, string> = {};
    const cwids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const c = `c${String(i).padStart(3, "0")}`;
      cwids.push(c);
      found[c] = "TRUE";
    }
    const client = makeClient(found);
    const map = await fetchActiveMembersByCwid(client, cwids);

    expect(client.calls.length).toBe(2); // 100 + 50
    expect(map.size).toBe(150);
    expect([...map.values()].every((v) => v === true)).toBe(true);
  });

  it("de-duplicates repeated CWIDs into a single map entry", async () => {
    const client = makeClient({ alice: "TRUE" });
    const map = await fetchActiveMembersByCwid(client, ["alice", "Alice", "ALICE"]);
    expect(map.size).toBe(1);
    expect(map.get("alice")).toBe(true);
  });
});
