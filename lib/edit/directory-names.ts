/**
 * Display names from the Enterprise Directory for CWIDs with no Scholar row.
 *
 * Admin-page lists (functional roles, report access) resolve a person's name
 * from `Scholar.preferredName`, then a stored `granteeName`, then the bare
 * CWID. Staff who hold these roles (report-access holders, comms and
 * development staff) often have no Scholar row and no stored name, so they
 * rendered as a CWID. This fills those gaps from ED with the same batched
 * lookup the directory typeahead uses (`fetchDirectoryPeopleByCwid`: one bind,
 * one OR-of-CWIDs search per 100).
 *
 * Fail-soft by construction: any ED error or a slow directory returns what
 * the cache already knows (often nothing), so callers keep the CWID and the
 * page never breaks. A failure also backs off ED for a minute, so a directory
 * outage costs one timeout per minute, not one per page load. Results (hits
 * and misses) are cached per process for a few minutes.
 *
 * Server-only (reaches LDAP). Never import this from a client component.
 */
import { fetchDirectoryPeopleByCwid, type DirectoryPerson } from "@/lib/sources/ldap";

/** How long a looked-up name (or a confirmed miss) is reused. */
export const DIRECTORY_NAME_TTL_MS = 10 * 60_000;
/** After an ED failure, skip ED entirely for this long. */
export const DIRECTORY_FAILURE_BACKOFF_MS = 60_000;
/** A page render waits at most this long for ED. */
export const DIRECTORY_LOOKUP_TIMEOUT_MS = 4_000;
/** Upper bound on CWIDs sent to ED in one call (the rest wait for a later render). */
export const DIRECTORY_MAX_LOOKUP = 500;
/** Cache entries kept before the cache is dropped wholesale. */
const MAX_CACHE_ENTRIES = 5_000;

const CWID_PATTERN = /^[a-z0-9]{3,16}$/;

type CacheEntry = { name: string | null; expires: number };
const cache = new Map<string, CacheEntry>();
let backoffUntil = 0;

export type DirectoryNameDeps = {
  fetch?: (cwids: string[]) => Promise<DirectoryPerson[]>;
  now?: () => number;
  timeoutMs?: number;
};

/** Test hook: forget every cached name and any failure backoff. */
export function resetDirectoryNameCache(): void {
  cache.clear();
  backoffUntil = 0;
}

/** "First Last" when ED has the parts, else ED's display name; null when ED
 *  only knows the CWID. Matches the Administrators roster's client-side rule. */
export function directoryDisplayName(p: DirectoryPerson): string | null {
  const parts = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  if (parts) return parts;
  const name = p.name?.trim();
  return name && name.toLowerCase() !== p.cwid.toLowerCase() ? name : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // The abandoned lookup may still reject later; swallow that here.
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`directory lookup timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * ED display names for `cwids`, keyed by lowercased CWID. A CWID ED does not
 * know, or any failure, is simply absent from the map. Never throws.
 */
export async function resolveDirectoryNames(
  cwids: Iterable<string>,
  deps: DirectoryNameDeps = {},
): Promise<Map<string, string>> {
  const now = deps.now?.() ?? Date.now();
  const out = new Map<string, string>();
  const missing = new Set<string>();
  for (const raw of cwids) {
    const lc = raw.trim().toLowerCase();
    if (!CWID_PATTERN.test(lc)) continue;
    const hit = cache.get(lc);
    if (hit && hit.expires > now) {
      if (hit.name) out.set(lc, hit.name);
    } else {
      missing.add(lc);
    }
  }
  if (missing.size === 0 || now < backoffUntil) return out;

  const batch = [...missing].slice(0, DIRECTORY_MAX_LOOKUP);
  try {
    const people = await withTimeout(
      (deps.fetch ?? fetchDirectoryPeopleByCwid)(batch),
      deps.timeoutMs ?? DIRECTORY_LOOKUP_TIMEOUT_MS,
    );
    const found = new Map<string, string | null>();
    for (const p of people) found.set(p.cwid.toLowerCase(), directoryDisplayName(p));
    if (cache.size + batch.length > MAX_CACHE_ENTRIES) cache.clear();
    for (const lc of batch) {
      const name = found.get(lc) ?? null;
      cache.set(lc, { name, expires: now + DIRECTORY_NAME_TTL_MS });
      if (name) out.set(lc, name);
    }
  } catch (err) {
    backoffUntil = now + DIRECTORY_FAILURE_BACKOFF_MS;
    console.warn(
      JSON.stringify({
        event: "directory_name_lookup_failed",
        cwids: batch.length,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return out;
}

/** True when `name` is absent or is just the CWID again. */
export function isBareName(name: string | null | undefined, cwid: string): boolean {
  return !name || name.trim().toLowerCase() === cwid.trim().toLowerCase();
}

/**
 * Fill each item whose name is missing (null, or equal to its CWID) with its
 * ED name, in ONE batched lookup. Items with a name, and items ED cannot
 * name, come back unchanged. Never throws.
 */
export async function fillDirectoryNames<T extends { cwid: string }>(
  items: readonly T[],
  getName: (item: T) => string | null | undefined,
  setName: (item: T, name: string) => T,
  deps?: DirectoryNameDeps,
): Promise<T[]> {
  const need = items.filter((i) => isBareName(getName(i), i.cwid)).map((i) => i.cwid);
  if (need.length === 0) return [...items];
  const names = await resolveDirectoryNames(need, deps);
  if (names.size === 0) return [...items];
  return items.map((i) => {
    if (!isBareName(getName(i), i.cwid)) return i;
    const name = names.get(i.cwid.trim().toLowerCase());
    return name ? setName(i, name) : i;
  });
}
