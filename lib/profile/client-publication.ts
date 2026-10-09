import type { ProfilePublication } from "@/lib/api/profile";

/**
 * #2213 — the profile publication list as the client sees it.
 *
 * The full list is serialized into the RSC payload (3.1 MB on the largest
 * profile before this change), so the server hands the client components a
 * compact WIRE form (`ClientPublicationWire`, built by `toClientPublicationWire`)
 * and they rebuild the row objects with `hydrateClientPublications`.
 *
 * `ProfileClientPublication` is the hydrated shape. It carries ONLY the fields
 * a client component reads; typing the client props with it keeps a future
 * client-side read of a dropped field a compile error. Relative to
 * `ProfilePublication`, the client does not get:
 *   - the ranking inputs and score (`dateAddedToEntrez`, `reciteraiImpact`,
 *     `isConfirmed`, `score`) — server-only;
 *   - `pubmedUrl` — the row links by pmid; the modal fetches its own record;
 *   - `authorship.isPenultimate` — no client consumer;
 *   - MeSH labels — the Topics filter and facet counts key on descriptor UI
 *     only (labels come from the `keywords` prop), so `meshTerms` becomes
 *     `meshUis` (non-null, de-duplicated — both consumers already skipped null
 *     UIs and de-duplicated within a publication);
 *   - `wcmAuthors[].position` — the server already ordered the chips.
 */
export type ProfileClientWcmAuthor = {
  name: string;
  cwid: string;
  slug: string;
  identityImageEndpoint: string;
  isFirst: boolean;
  isLast: boolean;
  /** #536 — co-author chip link suppression for hidden roles. */
  roleCategory: string | null;
};

export type ProfileClientPublication = {
  pmid: string;
  title: string;
  /** Full PubMed-style author list; the in-profile search matches on it. */
  authorsString: string | null;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  citationCount: number;
  doi: string | null;
  pmcid: string | null;
  ecommonsLink: string | null;
  authorship: { isFirst: boolean; isLast: boolean };
  /** MeSH descriptor UIs on this publication (Topics filter + facet counts). */
  meshUis: string[];
  hasAbstract: boolean;
  wcmAuthors: ProfileClientWcmAuthor[];
};

/** The fields `<PublicationRow>` reads. The profile's Selected highlights pass a
 *  full `ProfilePublication`, which satisfies this. */
export type ProfileRowPublication = Pick<
  ProfileClientPublication,
  | "pmid"
  | "title"
  | "journal"
  | "year"
  | "citationCount"
  | "doi"
  | "pmcid"
  | "ecommonsLink"
  | "authorship"
  | "hasAbstract"
  | "wcmAuthors"
>;

/** One WCM author identity, interned: the profile owner sits on every row and
 *  frequent co-authors on hundreds, so each identity is serialized once. */
type WirePerson = {
  name: string;
  cwid: string;
  slug: string;
  identityImageEndpoint: string;
  roleCategory: string | null;
};

/** One publication on the wire. Keys are short because they repeat once per
 *  publication; optional keys are OMITTED (never `undefined`, which the RSC
 *  serializer would spell out) when they hold the default noted. */
type WirePub = {
  /** pmid */
  i: string;
  /** title */
  t: string;
  /** authorsString — omitted when null */
  s?: string;
  /** journal, as an index into `strings` — omitted when null */
  j?: number;
  /** year — omitted when null (0 is kept: it is a real "undated" value) */
  y?: number;
  /** publicationType, as an index into `strings` — omitted when null */
  pt?: number;
  /** citationCount — omitted when 0 */
  c?: number;
  /** doi / pmcid / ecommonsLink — omitted when null */
  d?: string;
  pm?: string;
  e?: string;
  /** bit flags: 1 authorship.isFirst, 2 authorship.isLast, 4 hasAbstract —
   *  omitted when 0 */
  f?: number;
  /** MeSH UIs, as indexes into `strings` — omitted when empty */
  m?: number[];
  /** WCM authors in chip order: (personIndex << 2) | (isLast << 1) | isFirst —
   *  omitted when empty */
  w?: number[];
};

export type ClientPublicationWire = {
  /** Interned strings: journals, publication types, MeSH descriptor UIs. */
  strings: string[];
  /** Interned WCM author identities. */
  people: WirePerson[];
  /** Publications, in the server's display order. */
  pubs: WirePub[];
};

const F_FIRST = 1;
const F_LAST = 2;
const F_ABSTRACT = 4;

/** Build the wire form. Server-side; pure. */
export function toClientPublicationWire(
  publications: readonly ProfilePublication[],
): ClientPublicationWire {
  const strings: string[] = [];
  const stringIdx = new Map<string, number>();
  const intern = (v: string): number => {
    let i = stringIdx.get(v);
    if (i === undefined) {
      i = strings.length;
      strings.push(v);
      stringIdx.set(v, i);
    }
    return i;
  };

  const people: WirePerson[] = [];
  const personIdx = new Map<string, number>();
  // Keyed on the full identity tuple, not the cwid alone, so interning can never
  // merge two chips that differ in any rendered field.
  const internPerson = (p: WirePerson): number => {
    const key = JSON.stringify([p.cwid, p.name, p.slug, p.identityImageEndpoint, p.roleCategory]);
    let i = personIdx.get(key);
    if (i === undefined) {
      i = people.length;
      people.push(p);
      personIdx.set(key, i);
    }
    return i;
  };

  const pubs = publications.map((p): WirePub => {
    const w: WirePub = { i: p.pmid, t: p.title };
    if (p.authorsString !== null) w.s = p.authorsString;
    if (p.journal !== null) w.j = intern(p.journal);
    if (p.year !== null) w.y = p.year;
    if (p.publicationType !== null) w.pt = intern(p.publicationType);
    if (p.citationCount !== 0) w.c = p.citationCount;
    if (p.doi !== null) w.d = p.doi;
    if (p.pmcid !== null) w.pm = p.pmcid;
    if (p.ecommonsLink !== null) w.e = p.ecommonsLink;
    const f =
      (p.authorship.isFirst ? F_FIRST : 0) |
      (p.authorship.isLast ? F_LAST : 0) |
      (p.hasAbstract ? F_ABSTRACT : 0);
    if (f !== 0) w.f = f;
    const seen = new Set<string>();
    const m: number[] = [];
    for (const t of p.meshTerms) {
      if (t.ui === null || seen.has(t.ui)) continue;
      seen.add(t.ui);
      m.push(intern(t.ui));
    }
    if (m.length > 0) w.m = m;
    if (p.wcmAuthors.length > 0) {
      w.w = p.wcmAuthors.map(
        (a) =>
          (internPerson({
            name: a.name,
            cwid: a.cwid,
            slug: a.slug,
            identityImageEndpoint: a.identityImageEndpoint,
            roleCategory: a.roleCategory,
          }) <<
            2) |
          (a.isLast ? F_LAST : 0) |
          (a.isFirst ? F_FIRST : 0),
      );
    }
    return w;
  });

  return { strings, people, pubs };
}

/** Rebuild the row objects from the wire form. Client-side; pure. */
export function hydrateClientPublications(
  wire: ClientPublicationWire,
): ProfileClientPublication[] {
  const { strings, people, pubs } = wire;
  return pubs.map((w) => {
    const f = w.f ?? 0;
    return {
      pmid: w.i,
      title: w.t,
      authorsString: w.s ?? null,
      journal: w.j !== undefined ? strings[w.j] : null,
      year: w.y ?? null,
      publicationType: w.pt !== undefined ? strings[w.pt] : null,
      citationCount: w.c ?? 0,
      doi: w.d ?? null,
      pmcid: w.pm ?? null,
      ecommonsLink: w.e ?? null,
      authorship: { isFirst: (f & F_FIRST) !== 0, isLast: (f & F_LAST) !== 0 },
      meshUis: (w.m ?? []).map((i) => strings[i]),
      hasAbstract: (f & F_ABSTRACT) !== 0,
      wcmAuthors: (w.w ?? []).map((packed) => {
        const person = people[packed >> 2];
        return {
          name: person.name,
          cwid: person.cwid,
          slug: person.slug,
          identityImageEndpoint: person.identityImageEndpoint,
          isFirst: (packed & F_FIRST) !== 0,
          isLast: (packed & F_LAST) !== 0,
          roleCategory: person.roleCategory,
        };
      }),
    };
  });
}
