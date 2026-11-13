/**
 * Cross-campus duplicates (Ithaca ORCID plan, step 1a) → `scholar_identity_link`,
 * read by report 22. Weekly, full replace.
 *
 *   Aurora    scholar (every row, soft-deleted included: people leave WCM for Ithaca)
 *   reciterdb identity_cornell_current (the whole Cornell roster, staff included)
 *             pubsource_orcid_person   (ORCID iDs by CWID and by NetID)
 *   pub.orcid.org  names for Cornell people the roster has none for
 *        └──▶ match.ts ──▶ scholar_identity_link
 *
 * Reads reciterdb, so it runs on the sources family (SOURCES_SCRIPTS). The "known"
 * band needs `scholar.netid`, which etl/ed fills nightly.
 *
 * Usage: `npm run etl:identity-links`
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { assertSourceVolume } from "@/lib/etl-guard";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { fetchRecord } from "../orcid-registry/orcid-api";
import { matchIdentities, type CornellPerson, type WcmPerson } from "./match";

type RosterRow = {
  netid: string;
  name: string | null;
  name_first: string | null;
  name_last: string | null;
  email: string | null;
  email_alt_cu: string | null;
  primary_department: string | null;
  primary_job_title: string | null;
};
type OrcidRow = { personIdentifier: string; personIdentifierType: string; orcid: string };

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

async function main(): Promise<number> {
  const { roster, orcidRows } = await withReciterConnection(async (conn) => ({
    roster: (await conn.query(
      `SELECT netid, name, name_first, name_last, email, email_alt_cu, primary_department, primary_job_title
         FROM identity_cornell_current WHERE netid REGEXP '^[A-Za-z]+[0-9]+$'`,
    )) as RosterRow[],
    orcidRows: (await conn.query(
      `SELECT personIdentifier, personIdentifierType, orcid FROM pubsource_orcid_person
        WHERE orcid IS NOT NULL AND orcid <> ''`,
    )) as OrcidRow[],
  }));
  // NetID-shaped keys only: the 2025 Ithaca spreadsheet keyed ~500 people by an
  // email address (often their WCM one, some cut off at 20 characters), which
  // paired WCM scholars with their own address. 33,711 people on 2026-11-12;
  // a short read would silently drop pairs.
  assertSourceVolume("identity-links-roster", { incoming: roster.length, floor: 25_000 });

  const orcidsBy = (type: string) => {
    const m = new Map<string, Set<string>>();
    for (const r of orcidRows) {
      if (r.personIdentifierType !== type) continue;
      const id = lc(r.personIdentifier);
      m.set(id, (m.get(id) ?? new Set()).add(r.orcid.trim().toUpperCase()));
    }
    return m;
  };
  const cwidOrcids = orcidsBy("CWID");
  const netidOrcids = orcidsBy("NetID");

  const cornell: CornellPerson[] = roster.map((r) => {
    const netid = lc(r.netid);
    return {
      netid,
      firstName: r.name_first ?? "",
      lastName: r.name_last ?? "",
      emails: [r.email, r.email_alt_cu].map(lc).filter((e) => e.endsWith("@med.cornell.edu")),
      orcids: [...(netidOrcids.get(netid) ?? [])],
      name: r.name,
      department: r.primary_department,
      title: r.primary_job_title,
    };
  });

  const scholars = await db.write.scholar.findMany({
    select: { cwid: true, netid: true, fullName: true, email: true, orcid: true },
  });
  const wcm: WcmPerson[] = scholars.map((s) => {
    const cwid = lc(s.cwid);
    const orcids = new Set(cwidOrcids.get(cwid) ?? []);
    if (s.orcid) orcids.add(s.orcid.toUpperCase());
    return {
      cwid: s.cwid,
      netid: s.netid,
      fullName: s.fullName,
      email: s.email,
      orcids: [...orcids],
    };
  });

  const links = matchIdentities(wcm, cornell);
  const byNetid = new Map(cornell.map((c) => [c.netid, c]));
  const existing = await db.write.scholarIdentityLink.count();
  // The ED pairs alone are hundreds; a collapse means a broken input, not fewer people.
  assertSourceVolume("identity-links-pairs", { incoming: links.length, existing, maxDropPct: 50 });

  // ~10% of the roster (NetIDs imported with an ORCID iD only) has no name. Show
  // the public ORCID record's name instead. Display only: the first failed lookup
  // stops further ones and leaves the name blank.
  let orcidReachable = true;
  const orcidName = async (orcid: string | undefined): Promise<string | null> => {
    if (!orcid || !orcidReachable) return null;
    try {
      const n = (await fetchRecord(orcid)).person?.name;
      return [n?.["given-names"]?.value, n?.["family-name"]?.value].filter(Boolean).join(" ") || null;
    } catch (err) {
      console.warn(`identity-links: ORCID name lookup failed, skipping the rest: ${err}`);
      orcidReachable = false;
      return null;
    }
  };

  const data: Prisma.ScholarIdentityLinkCreateManyInput[] = [];
  for (const l of links) {
    const c = byNetid.get(l.netid);
    const name =
      c?.name ||
      [c?.firstName, c?.lastName].filter(Boolean).join(" ") ||
      (await orcidName(l.signals.orcid ?? c?.orcids[0]));
    data.push({
      cwid: l.cwid,
      netid: l.netid,
      band: l.band,
      signals: l.signals,
      cornellName: name?.slice(0, 255) || null,
      cornellDepartment: c?.department?.slice(0, 255) ?? null,
      cornellTitle: c?.title?.slice(0, 255) ?? null,
    });
  }
  await db.write.$transaction(
    async (tx) => {
      await tx.scholarIdentityLink.deleteMany({});
      for (let i = 0; i < data.length; i += 500) {
        await tx.scholarIdentityLink.createMany({ data: data.slice(i, i + 500) });
      }
    },
    { timeout: 60_000 },
  );

  const count = (b: string) => links.filter((l) => l.band === b).length;
  console.log(
    `identity-links: ${links.length} pairs (known ${count("known")}, strong ${count("strong")}, ` +
      `possible ${count("possible")}) from ${wcm.length} scholars x ${cornell.length} Cornell people`,
  );
  return links.length;
}

if (!process.env.VITEST) {
  withEtlRun("Identity-Links", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await closeReciterPool();
      await db.write.$disconnect();
    });
}
