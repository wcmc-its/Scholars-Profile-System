/**
 * CTSC roster ETL — mirror the CTSC investigators-and-trainees feed (the same
 * LibraryFeed the ReCiter Institutional Client reads) into the `ctsc` center.
 *
 *   feed record ──ED check──▶ profiled scholar  → center_membership source "ctsc-feed"
 *                          └▶ anyone else      → external_member (source "ctsc-feed")
 *                                                 + center_membership source "ctsc-feed-external"
 *                          └▶ fixable CWID     → ctsc_feed_issue (full replace)
 *
 * CTSC is NOT a publication source: the feed's PubMedIDs are never read.
 * Emails are used only for the ED lookup (+ the matched address on an issue).
 *
 * Mirror safety: only rows carrying this step's own sources are ever deleted,
 * and createMany(skipDuplicates) never overwrites a curator's manual row for the
 * same person. A failed / short feed read aborts before any delete.
 *
 * Needs CTSC_FEED_URL + CTSC_FEED_TOKEN (secret scholars/<env>/etl/ctsc) and
 * SCHOLARS_LDAP_* (scholars/<env>/etl/ed). The `ctsc` center must exist
 * (created in /edit) — its absence is a failure, not a silent no-op.
 *
 * Usage: `npm run etl:ctsc-roster`
 */
import type { Client } from "ldapts";
import { db } from "@/lib/db";
import { assertPruneVolume, assertSourceVolume } from "@/lib/etl-guard";
import { withEtlRun } from "@/lib/etl-run";
import { escapeLdapFilter, openLdap } from "@/lib/sources/ldap";
import { MEMBER_ROLE_KEY } from "@/lib/org-unit-roles";
import {
  CTSC_CENTER_SLUG,
  CTSC_EXTERNAL_SOURCE,
  CTSC_FEED_SOURCES,
  CTSC_LINKED_SOURCE as LINKED_SOURCE,
} from "@/lib/edit/external-member-sources";
import { feedEmails, parseCtscFeed, resolveCtscFeed, type CtscFeedRecord, type EdPerson } from "./resolve";

const SEARCH_BASE = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? "ou=people,dc=weill,dc=cornell,dc=edu";
const BATCH = 100;

async function fetchFeed(): Promise<CtscFeedRecord[]> {
  const url = process.env.CTSC_FEED_URL;
  const token = process.env.CTSC_FEED_TOKEN;
  if (!url || !token) throw new Error("CTSC_FEED_URL / CTSC_FEED_TOKEN not set");
  const u = new URL(url);
  u.searchParams.set("token", token);
  const res = await fetch(u, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok) throw new Error(`CTSC feed HTTP ${res.status}`);
  return parseCtscFeed(await res.json());
}

const first = (v: unknown): string | null =>
  Array.isArray(v) ? (v[0] == null ? null : String(v[0])) : v == null ? null : String(v);
const all = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

async function searchBatched(
  client: Client,
  values: string[],
  clause: (v: string) => string,
  onEntry: (e: Record<string, unknown>) => void,
): Promise<void> {
  for (let i = 0; i < values.length; i += BATCH) {
    const filter = "(|" + values.slice(i, i + BATCH).map((v) => clause(escapeLdapFilter(v))).join("") + ")";
    const { searchEntries } = await client.search(SEARCH_BASE, {
      scope: "one",
      filter,
      attributes: ["uid", "sn", "displayName", "weillCornellEduStatus", "mail", "mailAlternateAddress"],
      paged: { pageSize: 500 },
    });
    searchEntries.forEach((e) => onEntry(e as Record<string, unknown>));
  }
}

async function lookupEd(records: CtscFeedRecord[]) {
  const edByUid = new Map<string, EdPerson>();
  const edUidsByEmail = new Map<string, string[]>();
  const take = (e: Record<string, unknown>) => {
    const uid = first(e.uid)?.toLowerCase();
    if (!uid) return;
    edByUid.set(uid, {
      uid,
      sn: first(e.sn),
      displayName: first(e.displayName),
      retired: all(e.weillCornellEduStatus).includes("retired-cwid"),
    });
    return uid;
  };
  const emails = [...new Set(records.flatMap(feedEmails))];
  const emailSet = new Set(emails);
  const cwids = [...new Set(records.map((r) => (r.CWID ?? "").trim().toLowerCase()).filter(Boolean))];

  const client = await openLdap();
  try {
    await searchBatched(client, cwids, (c) => `(uid=${c})`, take);
    await searchBatched(client, emails, (m) => `(mail=${m})(mailAlternateAddress=${m})`, (e) => {
      const uid = take(e);
      if (!uid) return;
      for (const m of [...all(e.mail), ...all(e.mailAlternateAddress)].map((s) => s.toLowerCase())) {
        if (!emailSet.has(m)) continue;
        const list = edUidsByEmail.get(m) ?? [];
        if (!list.includes(uid)) list.push(uid);
        edUidsByEmail.set(m, list);
      }
    });
  } finally {
    await client.unbind().catch(() => {});
  }
  return { edByUid, edUidsByEmail };
}

async function main(): Promise<number> {
  const center = await db.write.center.findUnique({ where: { slug: CTSC_CENTER_SLUG }, select: { code: true } });
  if (!center) throw new Error(`no center with slug "${CTSC_CENTER_SLUG}" — create it in /edit with that slug`);
  const centerCode = center.code;

  const records = await fetchFeed();
  const existing = await db.write.centerMembership.findMany({
    where: { centerCode: centerCode, source: { in: [...CTSC_FEED_SOURCES] } },
    select: { cwid: true, source: true },
  });
  // Feed volume vs what we mirrored last night (bootstrap: existing = 0 → skipped).
  assertSourceVolume("ctsc:feed", { incoming: records.length, existing: existing.length, floor: 1, maxDropPct: 20 });
  console.log(`CTSC feed: ${records.length} records; ${existing.length} feed memberships held.`);

  const { edByUid, edUidsByEmail } = await lookupEd(records);
  const allScholars = await db.write.scholar.findMany({
    select: { cwid: true, status: true, deletedAt: true },
  });
  const scholars = allScholars.filter((s) => s.deletedAt === null && s.status === "active");
  const active = new Set(scholars.map((s) => s.cwid.toLowerCase()));
  // Suppressed / soft-deleted: never republished under the feed as a plain name.
  const hidden = new Set(allScholars.filter((s) => !active.has(s.cwid.toLowerCase())).map((s) => s.cwid.toLowerCase()));
  const { linkedCwids, externals, issues } = resolveCtscFeed(records, edByUid, edUidsByEmail, active, hidden);
  console.log(
    `Resolved: ${linkedCwids.length} profiled scholars, ${externals.length} plain names, ${issues.length} issues.`,
  );
  // A degraded ED read (empty/partial result, no error) would demote profiled
  // members to plain names; compare against last night's linked rows.
  assertSourceVolume("ctsc:linked", {
    incoming: linkedCwids.length,
    existing: existing.filter((m) => m.source === LINKED_SOURCE).length,
    maxDropPct: 20,
  });

  // Scholar CWIDs may be stored mixed-case; write the stored form.
  const storedCwid = new Map(scholars.map((s) => [s.cwid.toLowerCase(), s.cwid]));
  const want = new Map<string, string>([
    ...linkedCwids.map((c): [string, string] => [storedCwid.get(c) ?? c, LINKED_SOURCE]),
    ...externals.map((e): [string, string] => [e.cuid, CTSC_EXTERNAL_SOURCE]),
  ]);
  const stale = existing.filter((m) => want.get(m.cwid) !== m.source).map((m) => m.cwid);
  assertPruneVolume("ctsc:prune", { pruning: stale.length, of: existing.length, maxPct: 20 });

  for (let i = 0; i < stale.length; i += 500) {
    await db.write.centerMembership.deleteMany({
      where: {
        centerCode: centerCode,
        source: { in: [...CTSC_FEED_SOURCES] },
        cwid: { in: stale.slice(i, i + 500) },
      },
    });
  }

  // external_member: upsert-by-replace for this source only.
  const keep = new Set(externals.map((e) => e.cuid));
  const heldExternal = await db.write.externalMember.findMany({
    where: { source: LINKED_SOURCE },
    select: { cuid: true, displayName: true, affiliation: true },
  });
  const held = new Map(heldExternal.map((e) => [e.cuid, e]));
  const goneExternal = heldExternal.filter((e) => !keep.has(e.cuid)).map((e) => e.cuid);
  for (let i = 0; i < goneExternal.length; i += 500) {
    await db.write.externalMember.deleteMany({ where: { source: LINKED_SOURCE, cuid: { in: goneExternal.slice(i, i + 500) } } });
  }
  const fresh = externals.filter((e) => !held.has(e.cuid));
  for (let i = 0; i < fresh.length; i += 500) {
    await db.write.externalMember.createMany({
      data: fresh.slice(i, i + 500).map((e) => ({ ...e, source: LINKED_SOURCE })),
      skipDuplicates: true,
    });
  }
  for (const e of externals) {
    const h = held.get(e.cuid);
    if (h && (h.displayName !== e.displayName || h.affiliation !== e.affiliation)) {
      await db.write.externalMember.update({ where: { cuid: e.cuid }, data: e });
    }
  }

  const rows = [...want].map(([cwid, source]) => ({
    centerCode: centerCode,
    cwid,
    source,
    membershipRoleKey: MEMBER_ROLE_KEY,
    membershipType: null,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.write.centerMembership.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
  }

  await db.write.$transaction([
    db.write.ctscFeedIssue.deleteMany({}),
    db.write.ctscFeedIssue.createMany({ data: issues, skipDuplicates: true }),
  ]);

  console.log(`Wrote ${rows.length} memberships (pruned ${stale.length}), ${issues.length} issues.`);
  return rows.length;
}

if (!process.env.VITEST) {
  withEtlRun("CTSC-Roster", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => db.write.$disconnect());
}
