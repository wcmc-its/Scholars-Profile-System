/**
 * LDAP connection helper for the ED ETL.
 *
 * Connection params mirror the existing ReCiter-Institutional-Client conventions:
 *   - Bind DN:    cn=reciter,ou=binds,dc=weill,dc=cornell,dc=edu
 *   - Search base: ou=people,dc=weill,dc=cornell,dc=edu
 *   - Active-faculty filter: (&(objectClass=eduPerson)(weillCornellEduPersonTypeCode=academic))
 *
 * Env: LDAP_URL (full ldaps://host:port), LDAP_BIND_PASSWORD.
 */
import { Client } from "ldapts";

export const ED_BIND_DN = "cn=reciter,ou=binds,dc=weill,dc=cornell,dc=edu";
export const ED_SEARCH_BASE = "ou=people,dc=weill,dc=cornell,dc=edu";
export const ED_ACTIVE_ACADEMIC_FILTER =
  "(&(objectClass=eduPerson)(weillCornellEduPersonTypeCode=academic))";

/** Attributes we pull on the active-faculty search. */
export const ED_FACULTY_ATTRIBUTES = [
  "weillCornellEduCWID",
  "weillCornellEduPrimaryTitle",
  "weillCornellEduMiddleName",
  "weillCornellEduPersonTypeCode",
  "weillCornellEduDepartment",
  "givenName",
  "sn",
  "cn",
  "mail",
  "ou",
  "title",
  "departmentNumber",
] as const;

export type EdFacultyEntry = {
  cwid: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
};

/**
 * Open a bound LDAP connection. Caller is responsible for `await client.unbind()`.
 */
export async function openLdap(): Promise<Client> {
  const url = process.env.LDAP_URL;
  const password = process.env.LDAP_BIND_PASSWORD;
  if (!url) throw new Error("LDAP_URL is not set");
  if (!password) throw new Error("LDAP_BIND_PASSWORD is not set");

  const client = new Client({ url, timeout: 30_000, connectTimeout: 10_000 });
  await client.bind(ED_BIND_DN, password);
  return client;
}

/**
 * Search active academic-type entries and project to the EdFacultyEntry shape.
 * Returns one entry per CWID; skips records without a CWID.
 */
export async function fetchActiveFaculty(client: Client): Promise<EdFacultyEntry[]> {
  const { searchEntries } = await client.search(ED_SEARCH_BASE, {
    scope: "sub",
    filter: ED_ACTIVE_ACADEMIC_FILTER,
    attributes: [...ED_FACULTY_ATTRIBUTES],
    paged: { pageSize: 500 },
  });

  const out: EdFacultyEntry[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    if (!cwid) continue;

    const givenName = firstString(e.givenName) ?? "";
    const middleName = firstString(e.weillCornellEduMiddleName) ?? "";
    const sn = stripSurnameNoise(firstString(e.sn) ?? "");
    const preferredName = [givenName, sn].filter(Boolean).join(" ").trim();
    const fullName = [givenName, middleName, sn].filter(Boolean).join(" ").trim();

    out.push({
      cwid,
      preferredName: preferredName || cwid,
      fullName: fullName || preferredName || cwid,
      primaryTitle: firstString(e.weillCornellEduPrimaryTitle) ?? firstString(e.title) ?? null,
      primaryDepartment: firstString(e.weillCornellEduDepartment) ?? firstString(e.ou) ?? null,
      email: firstString(e.mail) ?? null,
    });
  }
  return out;
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : null;
  }
  return typeof v === "string" ? v : null;
}

/**
 * Surnames in ED occasionally have suffixes like "- M.D." baked in. Match the
 * institutional client's de-noising before slug derivation.
 */
function stripSurnameNoise(sn: string): string {
  return sn.replace(/-\s*M\.?D\.?$/i, "").trim();
}
