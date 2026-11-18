/**
 * Pure matcher for etl/identity-links: which WCM scholars are probably also a
 * Cornell (Ithaca) person under a different identifier. No IO; index.ts feeds it.
 *
 * Signals, strongest first:
 *   ed      — ED lists the NetID on the scholar (`scholar.netid`). An assertion.
 *   cornell — Cornell's directory lists the scholar's CWID on the NetID
 *             (cornellEduCWID, via reciterdb identity_cornell_directory). Also one.
 *   orcid  — the same ORCID iD on the CWID and the NetID (reciterdb
 *            pubsource_orcid_person, plus the scholar's confirmed iD).
 *   email  — the Cornell record carries the scholar's @med.cornell.edu address,
 *            or one whose local part is the CWID.
 *   name   — the same first + last name, and that name is held by exactly one
 *            person on each campus.
 * Band: ed or cornell → known; orcid or email → strong; name alone → possible.
 *
 * ponytail: no shared-publication signal. The Cornell Scopus link table
 * (cornell_pub_researcher_publication) points at an emptied researcher table and
 * its publications carry no authors (checked 2026-11-12); add it when Cornell
 * publications have a usable source.
 */

export type WcmPerson = {
  cwid: string;
  netid: string | null;
  fullName: string;
  email: string | null;
  orcids: string[];
};

export type CornellPerson = {
  netid: string;
  firstName: string;
  lastName: string;
  emails: string[];
  orcids: string[];
  /** The WCM CWID Cornell's directory records for this NetID, lowercased. */
  cwid: string | null;
  name: string | null;
  department: string | null;
  title: string | null;
};

export type LinkSignals = {
  ed?: true;
  cornell?: true;
  orcid?: string;
  email?: string;
  name?: true;
};
export type LinkBand = "known" | "strong" | "possible";
export type IdentityLink = { cwid: string; netid: string; band: LinkBand; signals: LinkSignals };

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "md", "phd"]);

/** Lowercase ASCII letters only, diacritics folded ("Núñez-Ruiz" → "nunezruiz"). */
export function normToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** "first|last" from free-text name parts, or null when either is empty. */
export function nameKey(first: string, last: string): string | null {
  const f = first.split(/\s+/).map(normToken).find(Boolean);
  const lastTokens = last
    .split(/[\s,]+/)
    .map(normToken)
    .filter((t) => t && !SUFFIXES.has(t));
  const l = lastTokens[lastTokens.length - 1];
  return f && l ? `${f}|${l}` : null;
}

/** A WCM full name ("Jane Q. Doe Jr.") split into first token and the rest. */
export function wcmNameKey(fullName: string): string | null {
  const tokens = fullName.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  return nameKey(tokens[0], tokens.slice(1).join(" "));
}

const BAND_RANK: Record<LinkBand, number> = { known: 0, strong: 1, possible: 2 };

export function bandOf(s: LinkSignals): LinkBand {
  if (s.ed || s.cornell) return "known";
  if (s.orcid || s.email) return "strong";
  return "possible";
}

export function matchIdentities(wcm: WcmPerson[], cornell: CornellPerson[]): IdentityLink[] {
  const cornellByNetid = new Map(cornell.map((c) => [c.netid, c]));
  const pairs = new Map<string, LinkSignals>();
  const add = (cwid: string, netid: string, s: LinkSignals) => {
    if (cwid === netid) return; // one identifier on both campuses: nothing to link
    const k = `${cwid}\t${netid}`;
    pairs.set(k, { ...pairs.get(k), ...s });
  };

  // ed
  for (const w of wcm) {
    if (w.netid && cornellByNetid.has(w.netid)) add(w.cwid, w.netid, { ed: true });
  }

  // cornell
  const wcmCwid = new Map(wcm.map((w) => [w.cwid.toLowerCase(), w.cwid]));
  for (const c of cornell) {
    const cwid = c.cwid && wcmCwid.get(c.cwid);
    if (cwid) add(cwid, c.netid, { cornell: true });
  }

  // orcid
  const netidsByOrcid = new Map<string, string[]>();
  for (const c of cornell)
    for (const o of c.orcids) netidsByOrcid.set(o, [...(netidsByOrcid.get(o) ?? []), c.netid]);
  for (const w of wcm) {
    for (const o of w.orcids)
      for (const n of netidsByOrcid.get(o) ?? []) add(w.cwid, n, { orcid: o });
  }

  // email
  const wcmByEmail = new Map<string, string>();
  for (const w of wcm) {
    wcmByEmail.set(`${w.cwid}@med.cornell.edu`, w.cwid);
    if (w.email) wcmByEmail.set(w.email.toLowerCase(), w.cwid);
  }
  for (const c of cornell) {
    for (const e of c.emails) {
      const cwid = wcmByEmail.get(e.toLowerCase());
      if (cwid) add(cwid, c.netid, { email: e.toLowerCase() });
    }
  }

  // name — unique on both sides only
  const group = <T>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const x of xs) {
      const k = key(x);
      if (k) m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const wcmByName = group(wcm, (w) => wcmNameKey(w.fullName));
  const cornellByName = group(cornell, (c) => nameKey(c.firstName, c.lastName));
  for (const [k, ws] of wcmByName) {
    const cs = cornellByName.get(k);
    if (ws.length === 1 && cs?.length === 1) add(ws[0].cwid, cs[0].netid, { name: true });
  }

  const links: IdentityLink[] = [...pairs].map(([k, signals]) => {
    const [cwid, netid] = k.split("\t");
    return { cwid, netid, band: bandOf(signals), signals };
  });

  // A known pair settles both identifiers: drop weaker guesses that pair either
  // side with someone else.
  const knownCwid = new Set(links.filter((l) => l.band === "known").map((l) => l.cwid));
  const knownNetid = new Set(links.filter((l) => l.band === "known").map((l) => l.netid));
  return links
    .filter((l) => l.band === "known" || (!knownCwid.has(l.cwid) && !knownNetid.has(l.netid)))
    .sort((a, b) => BAND_RANK[a.band] - BAND_RANK[b.band] || a.cwid.localeCompare(b.cwid));
}
