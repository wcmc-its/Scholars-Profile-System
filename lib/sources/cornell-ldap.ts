/**
 * Cornell (Ithaca) LDAP client — #2519 PR 1
 * (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §4).
 *
 * A second, independent LDAP source from `lib/sources/ldap.ts` (the WCM
 * Enterprise Directory client, which this module does not modify or import
 * from): a different directory, a different bind, a different attribute
 * schema. Mirrors that module's connection idiom (bounded timeouts, `unbind`
 * in a `finally`) so the two sources read the same to a future maintainer.
 *
 *   SCHOLARS_CORNELL_LDAP_URL              (required) — full ldaps://host:port
 *   SCHOLARS_CORNELL_LDAP_BIND_DN          (required) — Cornell-issued bind DN
 *   SCHOLARS_CORNELL_LDAP_BIND_PASSWORD    (required) — password for the bind DN
 *
 * Population filter (centralized here so no caller can bypass it, per §4):
 * excludes alumni. Whatever else the eventual data-use agreement requires
 * (students/FERPA posture, §11) narrows this filter further, in one place.
 */
import { Client } from "ldapts";

export const CORNELL_SEARCH_BASE = "ou=People,o=Cornell University,c=us";

/** One Cornell directory person, `DirectoryPerson`-shaped plus the Cornell
 *  extras this feature needs (netid as the cuid, and the WCM bridge). */
export type CornellDirectoryPerson = {
  /** `uid` — the Cornell NetID, which is also the cuid (§1). */
  netid: string;
  name: string;
  givenName: string | null;
  familyName: string | null;
  /** `cornelleduwrkngtitle1`, falling back to `cornelleduunivtitle1`. */
  title: string | null;
  /** `cornelledudeptname1`. */
  dept: string | null;
  email: string | null;
  /** `cornelleduprimaryaffiliation` — also drives the alumni population filter. */
  affiliation: string | null;
  /** `cornellEduCWID` — present only when this person also holds a WCM
   *  identity. This is the disjoint-union bridge the API layer resolves
   *  against `Scholar` (§5). Null for a Cornell-only person. */
  cornellEduCWID: string | null;
};

const CORNELL_PERSON_ATTRS = [
  "uid",
  "displayName",
  "givenName",
  "sn",
  "cornelleduwrkngtitle1",
  "cornelleduunivtitle1",
  "cornelledudeptname1",
  "mail",
  "cornelleduprimaryaffiliation",
  "cornellEduCWID",
] as const;

/** RFC 4515 LDAP filter escaping (mirrors `lib/sources/ldap.ts`'s private
 *  helper of the same name — not exported there, so duplicated narrowly here
 *  rather than modifying that module). */
function escapeLdapFilter(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      case "\0":
        return "\\00";
      default:
        return c;
    }
  });
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : null;
  }
  return typeof v === "string" ? v : null;
}

/** Excludes alumni (§4). Centralized here so it can't be bypassed by a
 *  caller — every search/fetch in this module routes through it. */
function withPopulationFilter(inner: string): string {
  return `(&(!(cornelleduprimaryaffiliation=alumni))${inner})`;
}

/**
 * Project a raw LDAP search entry to a {@link CornellDirectoryPerson}.
 * Exported (unlike the WCM client's equivalent) so the attribute map has a
 * direct unit test independent of the LDAP transport.
 */
export function projectCornellPerson(entry: Record<string, unknown>): CornellDirectoryPerson | null {
  const netid = firstString(entry.uid);
  if (!netid) return null;
  const displayName = firstString(entry.displayName);
  const given = firstString(entry.givenName);
  const sn = firstString(entry.sn);
  const constructed = [given, sn].filter(Boolean).join(" ").trim();
  const name = displayName ?? (constructed.length > 0 ? constructed : netid);
  return {
    netid,
    name,
    givenName: given,
    familyName: sn,
    title: firstString(entry.cornelleduwrkngtitle1) ?? firstString(entry.cornelleduunivtitle1),
    dept: firstString(entry.cornelledudeptname1),
    email: firstString(entry.mail),
    affiliation: firstString(entry.cornelleduprimaryaffiliation),
    cornellEduCWID: firstString(entry.cornellEduCWID),
  };
}

/**
 * Build the name-search filter for a typed query (§4: "typeahead is a
 * name-prefix query"). Tokens are AND-ed and matched as PREFIXES (`token*`,
 * never `*token*`) against givenName/sn/displayName, plus an exact match
 * against uid — prefix-safe, no leading wildcard, so the query stays a cheap
 * indexed scan against Cornell's directory. Each token is escaped first, so a
 * literal `*` a user types is not a wildcard.
 */
export function buildCornellNameFilter(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean).map(escapeLdapFilter);
  const perToken = (t: string) =>
    `(|(givenName=${t}*)(sn=${t}*)(displayName=${t}*)(uid=${t}))`;
  return withPopulationFilter(`(objectClass=person)${tokens.map(perToken).join("")}`);
}

/**
 * Open a bound connection to the Cornell directory. Caller is responsible for
 * `await client.unbind()`.
 */
async function openCornellLdap(): Promise<Client> {
  const url = process.env.SCHOLARS_CORNELL_LDAP_URL;
  const bindDn = process.env.SCHOLARS_CORNELL_LDAP_BIND_DN;
  const password = process.env.SCHOLARS_CORNELL_LDAP_BIND_PASSWORD;
  if (!url) throw new Error("SCHOLARS_CORNELL_LDAP_URL is not set");
  if (!bindDn) throw new Error("SCHOLARS_CORNELL_LDAP_BIND_DN is not set");
  if (!password) throw new Error("SCHOLARS_CORNELL_LDAP_BIND_PASSWORD is not set");

  const client = new Client({ url, timeout: 30_000, connectTimeout: 10_000 });
  await client.bind(bindDn, password);
  return client;
}

/**
 * Search the Cornell directory by name. Caps the result at `limit` (default
 * ~25, per §4 — never rely on a full listing).
 */
export async function searchCornellPeopleByName(
  q: string,
  limit = 25,
): Promise<CornellDirectoryPerson[]> {
  const filter = buildCornellNameFilter(q);
  const client = await openCornellLdap();
  try {
    const { searchEntries } = await client.search(CORNELL_SEARCH_BASE, {
      scope: "sub",
      filter,
      attributes: [...CORNELL_PERSON_ATTRS],
      sizeLimit: limit,
      paged: { pageSize: limit },
    });
    const out: CornellDirectoryPerson[] = [];
    for (const entry of searchEntries) {
      const person = projectCornellPerson(entry);
      if (person) out.push(person);
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    try {
      await client.unbind();
    } catch {
      // non-fatal — mirrors lib/sources/ldap.ts's unbind-in-finally posture.
    }
  }
}

/**
 * Fetch a single Cornell person by NetID (exact `uid` match). Used by the
 * roster-add write path (§5) to re-fetch server-side rather than trust
 * client-supplied display data. Returns `null` when no entry matches (or the
 * matching entry is excluded by the population filter).
 */
export async function fetchCornellPersonByNetid(
  netid: string,
): Promise<CornellDirectoryPerson | null> {
  const filter = withPopulationFilter(`(uid=${escapeLdapFilter(netid)})`);
  const client = await openCornellLdap();
  try {
    const { searchEntries } = await client.search(CORNELL_SEARCH_BASE, {
      scope: "sub",
      filter,
      attributes: [...CORNELL_PERSON_ATTRS],
      sizeLimit: 1,
    });
    const [entry] = searchEntries;
    return entry ? projectCornellPerson(entry) : null;
  } finally {
    try {
      await client.unbind();
    } catch {
      // non-fatal — see searchCornellPeopleByName.
    }
  }
}
