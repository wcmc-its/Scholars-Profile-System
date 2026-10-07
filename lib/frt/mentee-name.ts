/**
 * Faculty Review Tool mentees arrive as free-text names with no CWID. The
 * match key is "first|last": lowercased, accents and honorifics/degrees
 * stripped, "Last, First" flipped. Middle names and initials are ignored.
 *
 * The key is PERSISTED (`frt_mentee.name_key`, unique per mentor) and mentor
 * decisions (dismissals, hand-assigned CWIDs) are keyed on it, so its output
 * must never change. A nickname ("Bob" vs "Robert") is therefore NOT folded into
 * the key; `frtNicknameCandidate` looks it up separately, as a suggestion only.
 * A married-name change still misses.
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
 * match is weaker than that. It goes to `frt_mentee.suggested_cwid` instead,
 * which /edit offers the mentor as a one-click link (see resolveFrtMentee).
 */
export function frtNicknameCandidate(
  idx: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
): string | null {
  if ((idx.get(key)?.size ?? 0) > 0) return null;
  const [first, last] = key.split("|");
  const hits = new Set<string>();
  for (const v of nicknameVariants(first))
    for (const c of idx.get(`${v}|${last}`) ?? []) hits.add(c);
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * The CWID fields the FRT ETL writes for one (mentor, name key) row whose CWID
 * the mentor has NOT assigned. `menteeCwid` is the exact-key match (one person,
 * not the mentor), unchanged from before nicknames; `suggestedCwid` is the
 * nickname-only candidate, set only when there is no exact match. External
 * mentees get neither.
 */
export function resolveFrtMentee(
  idx: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  mentorCwid: string,
  external: boolean,
): { menteeCwid: string | null; suggestedCwid: string | null } {
  if (external) return { menteeCwid: null, suggestedCwid: null };
  const hits = idx.get(key);
  const cwid = hits?.size === 1 ? [...hits][0] : null;
  if (cwid && cwid !== mentorCwid) return { menteeCwid: cwid, suggestedCwid: null };
  const nick = frtNicknameCandidate(idx, key);
  return { menteeCwid: null, suggestedCwid: nick && nick !== mentorCwid ? nick : null };
}
