/**
 * Faculty Review Tool mentees arrive as free-text names with no CWID. The
 * match key is "first|last": lowercased, accents and honorifics/degrees
 * stripped, "Last, First" flipped. Middle names and initials are ignored.
 *
 * The key is PERSISTED (`frt_mentee.name_key`, unique per mentor) and mentor
 * decisions (dismissals, hand-assigned CWIDs) are keyed on it, so its output
 * must never change. A nickname ("Bob" vs "Robert") is therefore NOT folded into
 * the key; `frtNicknameCandidate` looks it up separately. A married-name change
 * still misses.
 */
import { nicknameVariants } from "@/lib/names/nicknames";

const NOISE = /\b(dr|mr|mrs|ms|prof|md|phd|mph|msc|mba|do|rn|np|pa|jr|sr|ii|iii|iv)\b\.?/g;

export function frtNameKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(NOISE, " ")
    .replace(/[^a-z ,'-]/g, " ");
  if (s.includes(",")) {
    const [last, first] = s.split(",", 2);
    if (first.trim()) s = `${first} ${last}`;
  }
  const tokens = s
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length < 2) return null;
  return `${tokens[0]}|${tokens[tokens.length - 1]}`;
}

/**
 * The one person a name key reaches ONLY through a nickname ("bob|doe" ->
 * "robert|doe"), or null. Fires only when the exact key finds nobody, and only
 * when the nickname keys together reach exactly one CWID.
 *
 * Never used to set `frt_mentee.mentee_cwid`: a name-matched CWID there is
 * treated as confirmed by the Mentored publications report, and a nickname
 * match is weaker than that. The ETL counts these as candidates instead.
 */
export function frtNicknameCandidate(
  idx: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
): string | null {
  if ((idx.get(key)?.size ?? 0) > 0) return null;
  const [first, last] = key.split("|");
  const hits = new Set<string>();
  for (const v of nicknameVariants(first)) for (const c of idx.get(`${v}|${last}`) ?? []) hits.add(c);
  return hits.size === 1 ? [...hits][0] : null;
}
