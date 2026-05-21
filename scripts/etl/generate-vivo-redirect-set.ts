/**
 * Generate the legacy-URL redirect set for B14.
 *
 * Pulls academic-faculty CWIDs from WCM Enterprise Directory and writes them
 * to `data/vivo-redirects.json` as a sorted, deduped array. The B14 middleware
 * uses this set to decide whether a path like `/display/cwid-{cwid}`,
 * `/individual/cwid-{cwid}`, or `/profile/cwid-{cwid}` should 301 to the
 * canonical `/scholars/by-cwid/{cwid}` (which then chains to the current slug
 * via `lib/url-resolver.ts`).
 *
 * Why a CWID-only JSON, not a CWID -> slug map: slugs drift (rename, alias),
 * and re-running this script weekly would churn the diff. CWIDs are stable
 * identifiers; the slug currency lookup lives in `resolveByCwidOrAlias`
 * (DB-backed) and the chained redirect keeps the legacy host's URL contract
 * with a single point of truth.
 *
 * Minimal-attribute LDAP query (per the memory rule): the attribute list is
 * exactly ["uid", "labeledURI;vivo"]. We never request DOB or other PII.
 *
 * Run locally before each prod deploy:
 *   npx tsx scripts/etl/generate-vivo-redirect-set.ts
 *
 * CI builds consume the committed JSON file. The script never runs in CI.
 *
 * Environment: requires SCHOLARS_LDAP_URL, SCHOLARS_LDAP_BIND_DN (optional;
 * defaults applied in lib/sources/ldap.ts), and SCHOLARS_LDAP_BIND_PASSWORD
 * in the shell environment. The same env vars the nightly ED ETL uses.
 *
 * Defensive notes:
 *  - `labeledURI;vivo` is an RFC 4525 attribute subtype. Some ldapts versions
 *    surface it as the base attribute `labeledURI` when subtypes are not
 *    requested explicitly; we request the subtype and read both names.
 *  - If zero values come back, the script exits non-zero with a loud message
 *    rather than writing an empty redirect set.
 *  - Filter is the documented `academic-faculty` person-type code. If the
 *    output count is suspiciously low, broaden via `--filter-loose` (which
 *    matches `academic-faculty*`) per the plan's "broaden filter" risk row.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { openLdap } from "@/lib/sources/ldap";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "vivo-redirects.json",
);

const SEARCH_BASE =
  process.env.SCHOLARS_LDAP_SEARCH_BASE ?? "ou=people,dc=weill,dc=cornell,dc=edu";

const FILTER_STRICT =
  "(&(objectClass=weillCornellEduPerson)(weillCornellEduPersonTypeCode=academic-faculty))";
const FILTER_LOOSE =
  "(&(objectClass=weillCornellEduPerson)(weillCornellEduPersonTypeCode=academic-faculty*))";

// Minimal attribute list. NEVER widen this without explicit review --
// `weillCornellEduDOB` and similar PII fields are out of scope for B14.
const ATTRIBUTES = ["uid", "labeledURI;vivo"] as const;

const VIVO_PATH_RE = /\/display\/cwid-([A-Za-z0-9._\-]+)\/?$/;

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function* iterStringValues(value: unknown): Generator<string> {
  if (isString(value)) {
    yield value;
  } else if (Array.isArray(value)) {
    for (const v of value) {
      if (isString(v)) yield v;
    }
  }
}

function extractCwidFromVivoUri(uri: string): string | null {
  // Path-form parse: tolerate trailing slashes; accept any host (the legacy
  // VIVO host has had several DNS aliases over the years).
  try {
    const url = new URL(uri);
    const m = VIVO_PATH_RE.exec(url.pathname);
    if (m && m[1]) return m[1];
  } catch {
    // Fall through: some entries may be path-only, not full URLs.
  }
  const m = VIVO_PATH_RE.exec(uri);
  return m && m[1] ? m[1] : null;
}

async function main(): Promise<void> {
  const loose = process.argv.includes("--filter-loose");
  const filter = loose ? FILTER_LOOSE : FILTER_STRICT;

  const client = await openLdap();
  const cwids = new Set<string>();
  let entriesScanned = 0;
  let entriesWithVivoUri = 0;

  try {
    const { searchEntries } = await client.search(SEARCH_BASE, {
      scope: "sub",
      filter,
      attributes: [...ATTRIBUTES],
      paged: { pageSize: 500 },
    });
    entriesScanned = searchEntries.length;

    for (const entry of searchEntries) {
      const record = entry as unknown as Record<string, unknown>;
      // Read both the subtype name and the bare base attribute -- ldapts
      // versions vary on which key the value lands under.
      const candidates: unknown[] = [
        record["labeledURI;vivo"],
        record.labeledURI,
        record["labeledURI"],
      ];
      let matchedThisEntry = false;
      for (const candidate of candidates) {
        for (const value of iterStringValues(candidate)) {
          const cwid = extractCwidFromVivoUri(value);
          if (cwid) {
            cwids.add(cwid);
            matchedThisEntry = true;
          }
        }
      }
      if (matchedThisEntry) entriesWithVivoUri += 1;
    }
  } finally {
    await client.unbind();
  }

  if (cwids.size === 0) {
    console.error(
      `No CWIDs extracted from ${entriesScanned} ED entries (filter=${filter}). Refusing to write an empty redirect set.`,
    );
    console.error(
      "If this is expected (e.g. ED no longer carries labeledURI;vivo), delete data/vivo-redirects.json manually.",
    );
    process.exit(1);
  }

  const sorted = [...cwids].sort();
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  await fs.writeFile(OUTPUT_PATH, json, "utf8");

  console.log(
    `Scanned ${entriesScanned} ED entries; ${entriesWithVivoUri} carried labeledURI;vivo; wrote ${sorted.length} unique CWIDs to ${path.relative(process.cwd(), OUTPUT_PATH)}.`,
  );
  if (entriesWithVivoUri < entriesScanned / 2) {
    console.warn(
      `Note: only ${entriesWithVivoUri}/${entriesScanned} entries had a labeledURI;vivo value. If you expected more, re-run with --filter-loose.`,
    );
  }
}

main().catch((err) => {
  console.error("generate-vivo-redirect-set failed:", err);
  process.exit(1);
});
