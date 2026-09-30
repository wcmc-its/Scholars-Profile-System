/**
 * Faculty Review Tool mentees arrive as free-text names with no CWID. The
 * match key is "first|last": lowercased, accents and honorifics/degrees
 * stripped, "Last, First" flipped. Middle names and initials are ignored.
 *
 * ponytail: exact first+last key only; a nickname ("Bob" vs "Robert") or a
 * married-name change misses and falls back to a name-only mentee.
 */
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
