/**
 * Method services: an author's name as PubMed lists it ("family name then
 * initials", for example "Rivera Stone BK"), and how a name a superuser enters
 * for a unit is compared with one. Pure, with no imports: the validation the
 * client bundle uses and the server-side match share it.
 *
 * Two names are the same person for this purpose when the family names have
 * the same letters and the first initials agree. Case, diacritics, punctuation
 * and spacing are all ignored in the family name, so "Rivera-Stone",
 * "rivera stone" and "RIVERA STONE" are one name, as are "O'Neil" and "ONeil".
 */

/** Letters Unicode does not decompose into a base letter and a mark. */
const UNDECOMPOSED: Record<string, string> = {
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  ı: "i",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
};

/** Lowercased, without diacritics. */
function plain(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[øłđðıßæœþ]/g, (c) => UNDECOMPOSED[c] ?? c);
}

/** A family name reduced to its letters and digits. */
export function familyNameKey(familyName: string): string {
  return plain(familyName).replace(/[^\p{L}\p{N}]/gu, "");
}

/** The first letter of an initials string ("BK", "B.K.", "b"), or "". */
function firstInitial(initials: string): string {
  return plain(initials).replace(/[^\p{L}]/gu, "").charAt(0);
}

const SINGLE_LETTER = /^\p{L}\.?$/u;
const RUN_OF_CAPITALS = /^(?:\p{Lu}\.?){2,3}$/u;
/** A generational suffix, which PubMed prints after the initials ("Stone B
 *  Jr", "Stone B III", "Stone B 3rd") and holds apart from both. */
const SUFFIX = /^(?:jr|sr|ii|iii|iv|vi|\d(?:st|nd|rd|th))\.?$/iu;

/** Where the initials start in `words[0..end)`: `end` when there are none. */
function initialsStart(words: ReadonlyArray<string>, end: number): number {
  let cut = end;
  while (cut > 0 && SINGLE_LETTER.test(words[cut - 1])) cut -= 1;
  if (cut === end && cut > 0 && RUN_OF_CAPITALS.test(words[cut - 1])) cut -= 1;
  return cut;
}

/**
 * What an entered name is compared by: its family-name letters, a space and
 * the first initial. `null` when the entry does not end in an initial.
 *
 * The initials are the trailing single letters ("Rivera Stone B", "Rivera
 * Stone B K", "Rivera Stone B."), or else a last word of two or three capitals
 * ("Rivera Stone BK"). So "Rivera Stone", with no initial, is refused and is
 * never read as family name "Rivera", initial "S".
 *
 * A generational suffix after the initials is left out, since a PubMed author
 * is keyed without one: "Stone B III" and "Stone BK Jr" are both "stone b".
 * It is only a suffix when a family name and initials come before it, so
 * "Stone II" is still family name "Stone", initials "II".
 */
export function authorNameKey(entry: string): string | null {
  const words = entry.trim().split(/\s+/).filter((w) => w.length > 0);
  let end = words.length;
  if (end > 2 && SUFFIX.test(words[end - 1])) {
    const before = initialsStart(words, end - 1);
    if (before > 0 && before < end - 1) end -= 1;
  }
  const cut = initialsStart(words, end);
  if (cut === end) return null;
  const family = familyNameKey(words.slice(0, cut).join(" "));
  const initial = firstInitial(words.slice(cut, end).join(""));
  return family.length > 0 && initial.length > 0 ? `${family} ${initial}` : null;
}

/** One author of a PubMed record: `LastName` and `Initials` as printed. */
export type PubMedAuthorName = { lastName: string; initials: string };

/** A PubMed author in the form {@link authorNameKey} gives an entry, or `null`
 *  for an author with no family name or no initial (a collective name, say). */
export function pubmedAuthorKey(author: PubMedAuthorName): string | null {
  const family = familyNameKey(author.lastName);
  const initial = firstInitial(author.initials);
  return family.length > 0 && initial.length > 0 ? `${family} ${initial}` : null;
}
