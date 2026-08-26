/**
 * #2519 PR 1 — Cornell (Ithaca) external-member add resolution
 * (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §5). Pure resolver
 * moved out of `app/api/edit/roster/route.ts` (a `route.ts` may only export
 * Next.js route fields — GET/POST/etc. — so a plain value export like this
 * fails `next build`'s route-export validation) into its own module.
 */
import type { CornellDirectoryPerson } from "@/lib/sources/cornell-ldap";

/** Injected dependencies for {@link resolveCornellRosterAdd} — lets the
 *  bridge-resolution + disjointness-check logic be unit-tested with fakes,
 *  no live LDAP or DB (§14). */
export type CornellAddDeps = {
  fetchByNetid: (netid: string) => Promise<CornellDirectoryPerson | null>;
  /** Resolves an ACTIVE Scholar by cwid, or `null`. */
  findActiveScholarByCwid: (cwid: string) => Promise<{ cwid: string } | null>;
};

/** A snapshot of the Cornell entry's display attributes — the `ExternalMember`
 *  row shape minus `cuid`/`source`/timestamps (schema §3). */
export type ExternalMemberSnapshot = {
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  title: string | null;
  dept: string | null;
  email: string | null;
  affiliation: string | null;
};

export type CornellAddResolution =
  /** The netid is asserted-disjoint but already IS an active Scholar.cwid —
   *  the invariant is violated; fail closed rather than ever overwrite a WCM
   *  person (§5 step 4, `ponytail:` insurance). */
  | { kind: "disjoint_violation" }
  /** No Cornell entry matches this netid (or it's excluded by the population
   *  filter — e.g. alumni). */
  | { kind: "not_found" }
  /** The entry's `cornellEduCWID` bridges to an active Scholar — add the
   *  ordinary WCM membership row instead (§5 step 2). */
  | { kind: "wcm"; cwid: string }
  /** No bridge — upsert `ExternalMember` and add a `cwid = <netid>`,
   *  `source = "cornell-ithaca"` membership row (§5 step 3). */
  | { kind: "external"; cuid: string; snapshot: ExternalMemberSnapshot };

/**
 * Resolve a Cornell-add request to one of the outcomes above. Pure
 * orchestration over injected deps — no LDAP client or Prisma import here, so
 * this is directly unit-testable with fakes (§14: bridge test + defensive
 * cuid-check test).
 */
export async function resolveCornellRosterAdd(
  netid: string,
  deps: CornellAddDeps,
): Promise<CornellAddResolution> {
  // Defensive cuid check FIRST: the WCM-CWID / Cornell-NetID namespaces are
  // asserted disjoint (§1), so this can only fire on bad data — and it must
  // run before any write path that would use `netid` as a membership cwid.
  const collision = await deps.findActiveScholarByCwid(netid);
  if (collision) return { kind: "disjoint_violation" };

  const person = await deps.fetchByNetid(netid);
  if (!person) return { kind: "not_found" };

  if (person.cornellEduCWID) {
    const bridged = await deps.findActiveScholarByCwid(person.cornellEduCWID);
    if (bridged) return { kind: "wcm", cwid: bridged.cwid };
  }

  return {
    kind: "external",
    cuid: person.netid,
    snapshot: {
      displayName: person.name,
      givenName: person.givenName,
      familyName: person.familyName,
      title: person.title,
      dept: person.dept,
      email: person.email,
      affiliation: person.affiliation,
    },
  };
}
