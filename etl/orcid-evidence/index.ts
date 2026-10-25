/**
 * ORCID candidate evidence → `orcid_candidate_evidence`, for the librarian queue
 * (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md). Weekly, right after
 * `etl:orcid-registry`.
 *
 * Population: every distinct (cwid, orcid) in `orcid_candidate` (all sources)
 * for an active scholar, minus pairs in `orcid_dismissal`, minus pairs already
 * on file — `scholar.orcid`, or an undismissed `rpm_admin` iD (WCM leaves
 * `scholar.orcid` NULL; /edit reads the RPM mirror, `heldFor`). Each iD's public `/record` is fetched
 * ONCE and shared by every scholar it is a candidate for. Per pair:
 *
 *   - `email_verified` — a public email on the record with `verified: true`
 *                        equals the scholar's `email` (case-insensitive).
 *   - `inst_match`     — an employment or education organization names
 *                        "Cornell" (which covers the WCM `orgPhrase`), or carries
 *                        the WCM ROR id, or any public email is on cornell.edu.
 *   - `history_match`  — (v2) an employment or education organization matches an
 *                        institution in the scholar's own history: ASMS degrees
 *                        (`education`), external positions (`profile_appointment`,
 *                        category EXTERNAL), ReCiter Identity `institutions`
 *                        (DynamoDB, one Scan per run). `institution-match.ts`.
 *   - `name_agrees`    — `givenNamesAgree` (the registry's full-given-name
 *                        guard) AND `surnamesAgree` (see below).
 *   - `shared`         — distinct scholar papers the record's works also carry,
 *                        by PMID or DOI, a paper with both counted once
 *                        (`sharedPapers`, the registry's own count).
 *   - `competitor`     — another active scholar with the same surname key holds
 *                        ≥3 of the record's papers this scholar does not; or
 *                        another candidate iD of this scholar shares ≥3; or the
 *                        same iD is a candidate for another scholar who shares ≥3.
 *   - `band`           — `bandOf`, first match wins: email_verified, strong,
 *                        shared_only, moderate, weak. The institutional condition
 *                        is `inst_match OR history_match` (v2, decision C) only
 *                        when `ORCID_HISTORY_BAND` is exactly "on"; otherwise
 *                        `inst_match` alone, and the run logs how many rows the
 *                        history term would move (spec Phasing step 2: persist
 *                        history_match, compare band counts, then switch).
 *
 * Works (v2 item 3): every record's works go through `filterPublicationWorks`
 * (`work-filter.ts`) first — figures, data sets, posters and the like are
 * dropped and preprint versions collapsed — so `works_total`, `new_works`, the
 * sample and `shared` all count publications only. Each row also carries
 * `evidence_detail` (v2 item 2): the matched institution pairs, the verified
 * email, the shared papers (title, year, journal from our publications), the
 * competitor detail, both names and the surname rule, and the pair's sources.
 *
 * Then the email auto-confirm: each `email_verified` row whose scholar has no
 * iD on file gets `scholar.orcid` + `orcid_confirmed_at` + method
 * `email_verified` + `orcid_confirmed_by = "ETL"` and an
 * `orcid_email_autoconfirm` audit row, one transaction each. Behind
 * `ORCID_EMAIL_AUTOCONFIRM` (exactly "on" writes; anything else logs the
 * would-confirm count and cwids). Never overwrites a non-null `scholar.orcid`
 * (the write is `WHERE orcid IS NULL`), never confirms a dismissed pair, and
 * skips a scholar with two verified-email iDs or an iD another scholar holds.
 * `etl:orcid-push` then carries it to Identity like any other `scholar.orcid`.
 *
 * Same mirror contract as `etl/orcid-registry`: full replace per run (upsert,
 * then delete rows this run did not compute), refuse to write an empty set,
 * fail loud on a 401/403 from ORCID or more than RECORD_FAIL_SHARE of the
 * `/record` calls failing (a single dead iD just has no row until a re-run).
 * WCM only: nothing here reads a cwid's shape.
 *
 * Usage: `npm run etl:orcid-evidence [-- --dry-run]` (weekly; base task family —
 * HTTPS to ORCID + Aurora, plus the Identity table Scan on the shared task role).
 * Env: `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET` (optional, anonymous otherwise),
 * `ORCID_EMAIL_AUTOCONFIRM`, `ORCID_HISTORY_BAND`, `SCHOLARS_IDENTITY_TABLE` + AWS region (the Identity
 * Scan, as etl/identity; a failed Scan logs and the run goes on without that
 * source — a missing source can only lower a band, never raise one),
 * `ORCID_EVIDENCE_DRY_RUN=1`, `ORCID_EVIDENCE_MAX_RECORDS=<n>` (local smoke:
 * truncates the iD list and FORCES a dry run — the delete pass would otherwise
 * remove every row the sample did not cover).
 */
import { db } from "../../lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { withEtlRun } from "@/lib/etl-run";
import { nameTokens } from "@/etl/nih-profile/resolver";
import {
  buildNameIndex,
  candidateNames,
  extractWorkIds,
  fold,
  givenNamesAgree,
  INSTITUTIONS,
  loadScholarWorkIds,
  sharedPapers,
  type ScholarWorkIndex,
} from "@/etl/orcid-registry/index";
import {
  fetchRecord,
  initOrcidAuth,
  OrcidDeprecatedError,
  OrcidHttpError,
  type RecordResponse,
} from "@/etl/orcid-registry/orcid-api";
import {
  heldFor,
  type OrcidEvidenceDetail,
  type OrcidInstitutionPair,
  type OrcidSharedPaper,
  type OrcidSurnameRule,
} from "@/lib/edit/orcid-queue";
import { lastNameKey } from "@/lib/last-name-key";

import { loadIdentityInstitutions } from "./identity-institutions";
import {
  historyMatches,
  type HistoryInstitution,
  type OrcidAffiliation,
} from "./institution-match";
import { filterPublicationWorks } from "./work-filter";

const BATCH = 500;
export const MIN_SHARED = 3;
const NEW_WORKS_SAMPLE = 5;
/** Shared papers kept in `evidence_detail` (the `shared` column has the full count). */
export const SHARED_DETAIL_CAP = 100;
/** Same outage rule as the registry's `/works` step. */
const RECORD_FAIL_SHARE = 0.02;
const RECORD_FAIL_FLOOR = 2;
/** The parent university's name and mail domain. The WCM values come from
 *  `INSTITUTIONS`; "Cornell" also covers its `orgPhrase` ("Weill Cornell"). */
const CORNELL_ORG_PHRASE = "Cornell";
const CORNELL_EMAIL_DOMAIN = "cornell.edu";
/** `orcid_confirmed_by` for an email auto-confirm, and its audit actor. */
export const ETL_ACTOR = "ETL";

export const BANDS = ["email_verified", "strong", "shared_only", "moderate", "weak"] as const;
export type Band = (typeof BANDS)[number];

export type BandInput = {
  emailVerified: boolean;
  instMatch: boolean;
  /** v2: an ORCID affiliation matches the scholar's own history. Absent = false. */
  historyMatch?: boolean;
  shared: number;
  competitor: boolean;
  nameAgrees: boolean;
};

/** The queue band, first match wins. The institutional condition is
 *  `instMatch OR historyMatch` (v2, decided 2026-10-25), in Strong and in
 *  Moderate's two-of-three alike. Pure. */
export function bandOf(e: BandInput): Band {
  const papers = e.shared >= MIN_SHARED;
  const inst = e.instMatch || e.historyMatch === true;
  if (e.emailVerified && !e.competitor) return "email_verified";
  if (inst && papers && !e.competitor && e.nameAgrees) return "strong";
  if (papers && !e.competitor && e.nameAgrees) return "shared_only";
  if ([inst, papers, !e.competitor].filter(Boolean).length >= 2) return "moderate";
  return "weak";
}

export type NewWork = {
  title: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  source: string | null;
  /** The ORCID work's own link (the depositing source's `url`), for the preview's
   *  link when the work has neither PMID nor DOI. */
  url: string | null;
};

type WorkFact = NewWork & { ids: Set<string>; type: string | null };

/** What one `/record` says, normalized once per iD. */
export type RecordFacts = {
  /** credit-name, "given family", other names — `candidateNames`, folded. */
  names: string[];
  given: string | null;
  family: string | null;
  /** v2: the record's own spelling, for the names-side-by-side display. */
  credit?: string | null;
  otherNames?: string[];
  emails: Array<{ email: string; verified: boolean }>;
  orgs: OrcidAffiliation[];
  /** Every PUBLICATION's doi:/pmid: keys (`extractWorkIds`, after the filter). */
  workIds: Set<string>;
  /** One per work group, publications only (`filterPublicationWorks`). */
  works: WorkFact[];
  /** Works the filter dropped or collapsed. */
  worksDropped?: number;
  modifiedAt: Date | null;
};

const text = (v: { value: string } | null | undefined): string | null => v?.value?.trim() || null;

/** The `/record` response → `RecordFacts`. Pure. */
export function recordFacts(orcid: string, rec: RecordResponse): RecordFacts {
  const name = rec.person?.name ?? null;
  const given = text(name?.["given-names"]);
  const family = text(name?.["family-name"]);
  const names = candidateNames({
    "orcid-id": orcid,
    "given-names": given,
    "family-names": family,
    "credit-name": text(name?.["credit-name"]),
    "other-name": (rec.person?.["other-names"]?.["other-name"] ?? [])
      .map((o) => o.content?.trim() ?? "")
      .filter(Boolean),
    email: null,
    "institution-name": null,
  });
  const emails = (rec.person?.emails?.email ?? [])
    .filter((e) => !!e.email?.trim())
    .map((e) => ({ email: e.email!.trim().toLowerCase(), verified: e.verified === true }));
  const acts = rec["activities-summary"];
  const orgs: RecordFacts["orgs"] = [];
  const yearOf = (d: { year: { value: string } | null } | null | undefined) => {
    const y = Number(text(d?.year));
    return Number.isInteger(y) && y > 0 ? y : null;
  };
  for (const [kind, block] of [
    ["employment", acts?.employments],
    ["education", acts?.educations],
  ] as const) {
    for (const g of block?.["affiliation-group"] ?? []) {
      for (const summary of g.summaries ?? []) {
        // Each summary is `{ "employment-summary": {...} }` or `{ "education-summary": {...} }`.
        for (const s of Object.values(summary)) {
          const org = s?.organization;
          if (!org) continue;
          const d = org["disambiguated-organization"];
          orgs.push({
            name: org.name ?? null,
            ror:
              d?.["disambiguation-source"]?.toUpperCase() === "ROR"
                ? (d["disambiguated-organization-identifier"] ?? null)
                : null,
            kind,
            start: yearOf(s["start-date"]),
            end: yearOf(s["end-date"]),
          });
        }
      }
    }
  }
  const worksResp = acts?.works ?? { "last-modified-date": null, group: null };
  const all: WorkFact[] = (worksResp.group ?? []).map((g) => {
    const ids = extractWorkIds({ "last-modified-date": null, group: [g] });
    const summaries = g["work-summary"] ?? [];
    const first = summaries.find((w) => text(w.title?.title)) ?? summaries[0];
    const year = Number(text(first?.["publication-date"]?.year));
    const doi = [...ids].find((k) => k.startsWith("doi:"))?.slice(4) ?? null;
    const pmid = [...ids].find((k) => k.startsWith("pmid:"))?.slice(5) ?? null;
    // A group's copies can disagree on type; a journal-article copy wins, so a
    // paper one source typed `other` is not mistaken for a figure.
    const types = summaries.map((w) => w.type?.trim().toLowerCase()).filter(Boolean) as string[];
    return {
      ids,
      title: text(first?.title?.title),
      year: Number.isInteger(year) && year > 0 ? year : null,
      doi,
      pmid,
      source: text(first?.source?.["source-name"]),
      url: summaries.map((w) => text(w.url)).find(Boolean) ?? null,
      type: types.includes("journal-article") ? "journal-article" : (types[0] ?? null),
    };
  });
  const { kept: works } = filterPublicationWorks(all);
  const workIds = new Set<string>();
  for (const w of works) for (const k of w.ids) workIds.add(k);
  const modified =
    rec.history?.["last-modified-date"]?.value ?? acts?.["last-modified-date"]?.value ?? null;
  return {
    names,
    given,
    family,
    credit: text(name?.["credit-name"]),
    otherNames: (rec.person?.["other-names"]?.["other-name"] ?? [])
      .map((o) => o.content?.trim() ?? "")
      .filter(Boolean),
    emails,
    orgs,
    workIds,
    works,
    worksDropped: all.length - works.length,
    modifiedAt: modified ? new Date(modified) : null,
  };
}

/** The scholar's email when a VERIFIED public email on the record equals it,
 *  else null. Pure. */
export function verifiedEmailOf(
  facts: Pick<RecordFacts, "emails">,
  scholarEmail: string | null,
): string | null {
  const mine = scholarEmail?.trim().toLowerCase();
  if (!mine) return null;
  return facts.emails.some((e) => e.verified && e.email === mine) ? mine : null;
}

/** A VERIFIED public email on the record equals the scholar's email. Pure. */
export function isEmailVerified(
  facts: Pick<RecordFacts, "emails">,
  scholarEmail: string | null,
): boolean {
  return verifiedEmailOf(facts, scholarEmail) !== null;
}

type OrgFact = Pick<OrcidAffiliation, "name" | "ror"> & Partial<OrcidAffiliation>;

/** What made `inst_match`: each org that names Cornell or carries the WCM ROR
 *  id (paired with what it matched), and the first cornell.edu email. Pure. */
export function instMatchFacts(facts: { emails: RecordFacts["emails"]; orgs: OrgFact[] }): {
  pairs: OrcidInstitutionPair[];
  email: string | null;
} {
  const phrases = [CORNELL_ORG_PHRASE, ...INSTITUTIONS.map((i) => i.orgPhrase)].map((p) =>
    p.toLowerCase(),
  );
  const wcmPhrases = INSTITUTIONS.map((i) => i.orgPhrase.toLowerCase());
  const rors = new Set(INSTITUTIONS.map((i) => i.ror.toLowerCase()));
  const domains = [CORNELL_EMAIL_DOMAIN, ...INSTITUTIONS.map((i) => i.emailDomain)];
  const pairs: OrcidInstitutionPair[] = [];
  for (const o of facts.orgs) {
    const name = o.name?.toLowerCase() ?? "";
    const byRor = !!o.ror && rors.has(o.ror.trim().toLowerCase());
    if (!byRor && !phrases.some((p) => name.includes(p))) continue;
    pairs.push({
      orcid: {
        name: o.name?.trim() || o.ror || "",
        kind: o.kind ?? "employment",
        start: o.start ?? null,
        end: o.end ?? null,
      },
      ours: {
        name:
          byRor || wcmPhrases.some((p) => name.includes(p))
            ? `Weill Cornell Medicine${byRor ? " (ROR)" : ""}`
            : "Cornell University",
        source: "wcm",
      },
    });
  }
  const email =
    facts.emails.find((e) =>
      domains.some((d) => e.email.endsWith(`@${d}`) || e.email.endsWith(`.${d}`)),
    )?.email ?? null;
  return { pairs, email };
}

/** An employment/education org names Cornell or carries the WCM ROR id, or a
 *  public email is on cornell.edu (verified or not). Pure. */
export function isInstMatch(facts: { emails: RecordFacts["emails"]; orgs: OrgFact[] }): boolean {
  const f = instMatchFacts(facts);
  return f.pairs.length > 0 || f.email !== null;
}

/** A name's surname tokens: everything after the first (given) token, folded,
 *  each hyphenated token also split ("garcia-vao" → garcia-vao, garcia, vao). Pure. */
export function surnameTokens(name: string, { skipGiven }: { skipGiven: boolean }): string[] {
  const tokens = [...nameTokens(fold(name))];
  const rest = skipGiven && tokens.length > 1 ? tokens.slice(1) : tokens;
  return rest.flatMap((t) => (t.includes("-") ? [t, ...t.split("-").filter(Boolean)] : [t]));
}

/** The record's family name; when `family-name` is empty and `given-names` holds
 *  the whole name ("Ana Prieto Fernandez"), everything after the first given
 *  token — the registry's `candidateNames` case, split and retried. Pure. */
export function recordFamilyName(facts: Pick<RecordFacts, "given" | "family">): string | null {
  if (facts.family) return facts.family;
  const parts = facts.given?.split(/\s+/) ?? [];
  return parts.length >= 2 ? parts.slice(1).join(" ") : null;
}

type NamedScholar = { cwid: string; fullName: string; preferredName: string };

/** Each tail of a token list glued with spaces and hyphens removed:
 *  ["k", "al", "hariri"] → kalhariri, alhariri, hariri. A one-letter tail is an
 *  initial, not a surname, and is dropped; two letters stay ("Li", "Wu", "Ng"). */
const gluedTails = (tokens: string[]) =>
  tokens.map((_, i) => tokens.slice(i).join("").replace(/-/g, "")).filter((t) => t.length >= 2);

/** The record's family name and the scholar's surname agree after folding: they
 *  share a token of ≥3 letters, or are equal with spaces and hyphens removed
 *  ("Al Hariri" = "Alhariri", compared tail by tail so a middle name on either
 *  side does not get in the way). The equality rule has no ≥3 minimum, so a
 *  two-letter surname agrees with itself ("Li" = "Wei Li") but a short token
 *  inside a longer surname does not ("Li" ≠ "Wei Li Wang"). The scholar's
 *  surname is everything after the first token of fullName or preferredName —
 *  there is no surname column. Pure. */
export function surnamesAgree(recordFamily: string | null, scholar: NamedScholar): boolean {
  return surnameRule(recordFamily, scholar) !== null;
}

/** WHICH surname rule agreed, for the evidence detail (v2 item 4), or null:
 *  `same` (the whole surname, as spelled), `folded` (the whole surname once
 *  accents are folded: Jaffré/Jaffre), `compound_token` (a ≥3-letter part of a
 *  compound surname: Sanchez / Sanchez Garcia-Vao), `joined` (equal once spaces
 *  and hyphens are removed: Al Hariri / Alhariri). Same agreement as
 *  `surnamesAgree`, which reads this. Pure. */
export function surnameRule(
  recordFamily: string | null,
  scholar: NamedScholar,
): OrcidSurnameRule | null {
  if (!recordFamily) return null;
  const theirs = surnameTokens(recordFamily, { skipGiven: false });
  const theirTails = new Set(gluedTails([...nameTokens(fold(recordFamily))]));
  const words = (v: string) => v.toLowerCase().split(/\s+/).filter(Boolean);
  const endsWith = (xs: string[], ys: string[]) =>
    ys.length > 0 &&
    ys.length <= xs.length &&
    ys.every((y, k) => xs[xs.length - ys.length + k] === y);
  for (const n of [scholar.fullName, scholar.preferredName]) {
    const mine = surnameTokens(n, { skipGiven: true });
    if (theirs.some((t) => t.length >= 3 && mine.includes(t))) {
      // The whole record surname is the end of the scholar's name: as spelled, or folded.
      if (endsWith(words(n).slice(1), words(recordFamily))) return "same";
      if (endsWith(words(fold(n)).slice(1), words(fold(recordFamily)))) return "folded";
      return "compound_token";
    }
    if (gluedTails([...nameTokens(fold(n))].slice(1)).some((t) => theirTails.has(t)))
      return "joined";
  }
  return null;
}

/** Given name (`givenNamesAgree`) AND surname (`surnamesAgree`). Pure. */
export function nameAgrees(
  facts: Pick<RecordFacts, "names" | "given" | "family">,
  scholar: NamedScholar,
): boolean {
  return givenNamesAgree(facts.names, scholar) && surnamesAgree(recordFamilyName(facts), scholar);
}

/** Works on the record that are not in the scholar's publications (by any of
 *  their ids): the count and a sample, newest first. Pure. */
export function newWorksOf(
  facts: Pick<RecordFacts, "works">,
  mine: Map<string, string> | undefined,
): { total: number; count: number; sample: NewWork[] } {
  const fresh = facts.works.filter((w) => ![...w.ids].some((k) => mine?.has(k)));
  const sample = [...fresh]
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, NEW_WORKS_SAMPLE)
    .map(({ title, year, doi, pmid, source, url }) => ({ title, year, doi, pmid, source, url }));
  return { total: facts.works.length, count: fresh.length, sample };
}

/** The three competitor rules for one (cwid, orcid) pair. Pure.
 *   1. another scholar with the same surname key holds ≥3 of the record's
 *      papers that are NOT in this scholar's publications;
 *   2. another candidate iD of this scholar has `shared` ≥3 — or could not be
 *      scored (`shared: null`, its `/record` fetch failed), which counts as a
 *      competitor so a degraded run never lifts a pair into a confirmable band;
 *   3. the same iD is a candidate for another scholar whose `shared` is ≥3. */
export function findCompetitors(args: {
  cwid: string;
  workIds: Set<string>;
  mine: Map<string, string> | undefined;
  sameSurname: Array<{ cwid: string; works: Map<string, string> | undefined }>;
  otherIds: Array<{ orcid: string; shared: number | null }>;
  otherHolders: Array<{ cwid: string; shared: number }>;
}): {
  competitor: boolean;
  cwids: string[];
  orcids: string[];
  /** v2: who and why, for the evidence detail. `shared` is K: the record's
   *  papers the other scholar holds (rule 1: that this scholar lacks), or the
   *  other iD's shared count (null = its fetch failed). */
  detail: OrcidEvidenceDetail["competitors"];
} {
  const minePmids = new Set(args.mine?.values() ?? []);
  const cwids = new Map<string, { shared: number; reason: "same_surname" | "same_id" }>();
  for (const s of args.sameSurname) {
    if (s.cwid === args.cwid) continue;
    const theirs = [...sharedPapers(args.workIds, s.works)].filter((p) => !minePmids.has(p));
    if (theirs.length >= MIN_SHARED)
      cwids.set(s.cwid, { shared: theirs.length, reason: "same_surname" });
  }
  for (const h of args.otherHolders)
    if (h.cwid !== args.cwid && h.shared >= MIN_SHARED && !cwids.has(h.cwid))
      cwids.set(h.cwid, { shared: h.shared, reason: "same_id" });
  const orcids = new Map<string, number | null>();
  for (const o of args.otherIds)
    if ((o.shared === null || o.shared >= MIN_SHARED) && !orcids.has(o.orcid))
      orcids.set(o.orcid, o.shared);
  const cwidList = [...cwids.keys()].sort();
  const orcidList = [...orcids.keys()].sort();
  return {
    competitor: cwids.size > 0 || orcids.size > 0,
    cwids: cwidList,
    orcids: orcidList,
    detail: {
      cwids: cwidList.map((c) => ({ cwid: c, ...cwids.get(c)! })),
      orcids: orcidList.map((o) => ({ orcid: o, shared: orcids.get(o)! })),
    },
  };
}

export type EvidenceRow = {
  cwid: string;
  orcid: string;
  band: Band;
  instMatch: boolean;
  historyMatch: boolean;
  emailVerified: boolean;
  nameAgrees: boolean;
  shared: number;
  competitor: boolean;
  competitorCwids: string[];
  competitorOrcids: string[];
  worksTotal: number;
  newWorks: number;
  newWorksSample: NewWork[];
  /** The facts behind the chips. `shared` holds bare PMIDs until
   *  `withSharedPaperDetail` fills in title, year and journal. */
  evidenceDetail: OrcidEvidenceDetail;
  recordModifiedAt: Date | null;
};

type EvidenceScholar = NamedScholar & { email: string | null };

/** Every evidence row for a population, from the fetched facts and the scholars'
 *  work indexes. `pairs` is every non-dismissed (cwid, orcid) of an active scholar
 *  (on-file ones included: they still compete); `onFile` the pairs left out of
 *  the output. A pair whose record could not be fetched gets no row, and makes
 *  the scholar's other pairs competitors (rule 2 cannot be ruled out). Rule 3
 *  needs no such guard: every holder of an iD is scored from the same record.
 *  Pure. */
export function assembleEvidence(args: {
  pairs: Array<{ cwid: string; orcid: string }>;
  onFile: Set<string>;
  facts: Map<string, RecordFacts>;
  scholars: Map<string, EvidenceScholar>;
  works: ScholarWorkIndex;
  /** Active scholars, for the same-surname rule. */
  active: EvidenceScholar[];
  /** v2: cwid → the scholar's own institution history (education, external
   *  appointments, ReCiter Identity). Absent = none known. */
  history?: Map<string, HistoryInstitution[]>;
  /** v2: `cwid|orcid` → its `orcid_candidate` sources. */
  sources?: Map<string, string[]>;
  /** v2: let `history_match` count toward the band (`ORCID_HISTORY_BAND`).
   *  Absent = false: history_match is persisted but the band is inst_match's. */
  historyBand?: boolean;
}): EvidenceRow[] {
  const key = (cwid: string, orcid: string) => `${cwid}|${orcid}`;
  const shared = new Map<string, number>();
  for (const p of args.pairs) {
    const f = args.facts.get(p.orcid);
    if (f) shared.set(key(p.cwid, p.orcid), sharedPapers(f.workIds, args.works.get(p.cwid)).size);
  }
  const byCwid = new Map<string, string[]>();
  const byOrcid = new Map<string, string[]>();
  for (const p of args.pairs) {
    byCwid.set(p.cwid, [...(byCwid.get(p.cwid) ?? []), p.orcid]);
    byOrcid.set(p.orcid, [...(byOrcid.get(p.orcid) ?? []), p.cwid]);
  }
  const index = buildNameIndex(args.active);

  const rows: EvidenceRow[] = [];
  for (const p of args.pairs) {
    if (args.onFile.has(key(p.cwid, p.orcid))) continue;
    const f = args.facts.get(p.orcid);
    const s = args.scholars.get(p.cwid);
    if (!f || !s) continue;
    const mine = args.works.get(p.cwid);
    const sameSurname = new Map<string, EvidenceScholar>();
    for (const k of new Set([lastNameKey(fold(s.fullName)), lastNameKey(fold(s.preferredName))])) {
      for (const o of index.get(k) ?? []) sameSurname.set(o.cwid, o as EvidenceScholar);
    }
    const comp = findCompetitors({
      cwid: p.cwid,
      workIds: f.workIds,
      mine,
      sameSurname: [...sameSurname.values()].map((o) => ({
        cwid: o.cwid,
        works: args.works.get(o.cwid),
      })),
      otherIds: (byCwid.get(p.cwid) ?? [])
        .filter((o) => o !== p.orcid)
        // No facts = the fetch failed: unknown, which rule 2 reads as a competitor.
        .map((o) => ({
          orcid: o,
          shared: args.facts.has(o) ? (shared.get(key(p.cwid, o)) ?? 0) : null,
        })),
      otherHolders: (byOrcid.get(p.orcid) ?? [])
        .filter((c) => c !== p.cwid)
        .map((c) => ({ cwid: c, shared: shared.get(key(c, p.orcid)) ?? 0 })),
    });
    const email = verifiedEmailOf(f, s.email);
    const inst = instMatchFacts(f);
    const history = historyMatches(f.orgs, args.history?.get(p.cwid.toLowerCase()) ?? []);
    const rule = surnameRule(recordFamilyName(f), s);
    const givenAgrees = givenNamesAgree(f.names, s);
    const e = {
      emailVerified: email !== null,
      instMatch: inst.pairs.length > 0 || inst.email !== null,
      historyMatch: history.length > 0,
      shared: shared.get(key(p.cwid, p.orcid)) ?? 0,
      competitor: comp.competitor,
      nameAgrees: givenAgrees && rule !== null,
    };
    const nw = newWorksOf(f, mine);
    const sharedPmids = [...sharedPapers(f.workIds, mine)].sort((a, b) => Number(b) - Number(a));
    rows.push({
      cwid: p.cwid,
      orcid: p.orcid,
      band: bandOf({ ...e, historyMatch: args.historyBand === true && e.historyMatch }),
      ...e,
      competitorCwids: comp.cwids,
      competitorOrcids: comp.orcids,
      worksTotal: nw.total,
      newWorks: nw.count,
      newWorksSample: nw.sample,
      evidenceDetail: {
        names: {
          orcid: {
            credit: f.credit ?? null,
            given: f.given,
            family: f.family,
            other: f.otherNames ?? [],
          },
          givenAgrees,
          surnameRule: rule,
        },
        institutions: [...inst.pairs, ...history],
        institutionEmail: inst.email,
        email,
        shared: sharedPmids
          .slice(0, SHARED_DETAIL_CAP)
          .map((pmid) => ({ pmid, doi: null, title: null, year: null, journal: null })),
        competitors: comp.detail,
        sources: [...(args.sources?.get(key(p.cwid, p.orcid)) ?? [])].sort(),
        worksDropped: f.worksDropped ?? 0,
      },
      recordModifiedAt: f.modifiedAt,
    });
  }
  return rows;
}

/** Fills each row's shared papers with title, year, journal and DOI from our
 *  publications (`papers`: pmid → its row). A PMID with no row keeps its id. Pure. */
export function withSharedPaperDetail(
  rows: EvidenceRow[],
  papers: Map<string, Omit<OrcidSharedPaper, "pmid">>,
): EvidenceRow[] {
  return rows.map((r) => ({
    ...r,
    evidenceDetail: {
      ...r.evidenceDetail,
      shared: r.evidenceDetail.shared.map((p) => ({ ...p, ...(papers.get(p.pmid) ?? {}) })),
    },
  }));
}

/** The scholars' own institution history from our tables plus ReCiter Identity,
 *  keyed by LOWERCASE cwid (Identity's uid is lowercase). Pure. */
export function buildHistory(args: {
  education: Array<{ cwid: string; institution: string }>;
  appointments: Array<{ cwid: string; organization: string }>;
  identity: Map<string, string[]>;
}): Map<string, HistoryInstitution[]> {
  const out = new Map<string, HistoryInstitution[]>();
  const add = (cwid: string, h: HistoryInstitution) => {
    const k = cwid.toLowerCase();
    const xs = out.get(k) ?? [];
    if (!xs.some((x) => x.name === h.name && x.source === h.source)) xs.push(h);
    out.set(k, xs);
  };
  for (const e of args.education)
    if (e.institution?.trim()) add(e.cwid, { name: e.institution.trim(), source: "education" });
  for (const a of args.appointments)
    if (a.organization?.trim()) add(a.cwid, { name: a.organization.trim(), source: "appointment" });
  for (const [cwid, names] of args.identity)
    for (const n of names) add(cwid, { name: n, source: "identity" });
  return out;
}

/** Replace each pair whose iD ORCID reports as deprecated with the same scholar
 *  paired to the primary iD, unless that pair is dismissed or already present. A
 *  deprecated iD with no named primary is dropped. The deprecated iD itself never
 *  reaches the evidence table: confirming it would put a dead iD on file. Pure. */
export function substituteDeprecated(
  pairs: ReadonlyArray<{ cwid: string; orcid: string }>,
  deprecated: ReadonlyMap<string, string | null>,
  dismissed: ReadonlySet<string>,
): { pairs: Array<{ cwid: string; orcid: string }>; replaced: number; dropped: number } {
  const out: Array<{ cwid: string; orcid: string }> = [];
  const have = new Set<string>();
  let replaced = 0;
  let dropped = 0;
  const push = (cwid: string, orcid: string) => {
    const k = `${cwid}|${orcid}`;
    if (have.has(k)) return;
    have.add(k);
    out.push({ cwid, orcid });
  };
  for (const p of pairs) if (!deprecated.has(p.orcid)) push(p.cwid, p.orcid);
  for (const p of pairs) {
    if (!deprecated.has(p.orcid)) continue;
    const primary = deprecated.get(p.orcid) ?? null;
    if (!primary || deprecated.has(primary) || dismissed.has(`${p.cwid}|${primary}`)) {
      dropped++;
      continue;
    }
    replaced++;
    push(p.cwid, primary);
  }
  return { pairs: out, replaced, dropped };
}

/** The `email_verified` rows the auto-confirm may write: the scholar has no iD
 *  on file (`held`: `scholar.orcid` or an undismissed `rpm_admin` iD), the pair
 *  is not dismissed, the scholar has exactly one such row, and no other scholar
 *  holds or is email-verified for the iD. The last two are stricter than the
 *  spec on purpose (see its Deviations). Pure. */
export function planAutoConfirm(
  rows: Array<Pick<EvidenceRow, "cwid" | "orcid" | "band">>,
  held: Map<string, string | null>,
  dismissed: Set<string>,
): Array<{ cwid: string; orcid: string }> {
  const verified = rows.filter((r) => r.band === "email_verified");
  const perCwid = new Map<string, number>();
  const perOrcid = new Map<string, number>();
  for (const r of verified) {
    perCwid.set(r.cwid, (perCwid.get(r.cwid) ?? 0) + 1);
    perOrcid.set(r.orcid, (perOrcid.get(r.orcid) ?? 0) + 1);
  }
  const heldIds = new Set([...held.values()].filter((v): v is string => !!v));
  return verified
    .filter(
      (r) =>
        !held.get(r.cwid) &&
        !dismissed.has(`${r.cwid}|${r.orcid}`) &&
        perCwid.get(r.cwid) === 1 &&
        perOrcid.get(r.orcid) === 1 &&
        !heldIds.has(r.orcid),
    )
    .map((r) => ({ cwid: r.cwid, orcid: r.orcid }));
}

/** `ORCID_HISTORY_BAND`: exactly "on" lets history_match count toward the band. */
export function isHistoryBandEnabled(): boolean {
  return process.env.ORCID_HISTORY_BAND === "on";
}

/** Rows whose band the history term would change, by band after → count.
 *  For the before/after comparison the spec asks for ahead of the switch. Pure. */
export function historyBandShift(rows: readonly EvidenceRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const off = bandOf({ ...r, historyMatch: false });
    const on = bandOf({ ...r, historyMatch: r.historyMatch });
    if (off !== on) out[`${off}->${on}`] = (out[`${off}->${on}`] ?? 0) + 1;
  }
  return out;
}

/** `ORCID_EMAIL_AUTOCONFIRM`: exactly "on" writes. */
export function isEmailAutoconfirmEnabled(): boolean {
  return process.env.ORCID_EMAIL_AUTOCONFIRM === "on";
}

type WriteClient = Pick<typeof db.write, "$transaction">;

/** Writes the planned confirms, one transaction each with its audit row. The
 *  scholar write is `WHERE orcid IS NULL`, and a dismissal found inside the
 *  transaction skips the pair, so a run can never overwrite an iD or confirm a
 *  pair dismissed since it was read. Returns the cwids confirmed. */
export async function applyAutoConfirm(
  client: WriteClient,
  plan: Array<{ cwid: string; orcid: string }>,
  now: Date = new Date(),
): Promise<string[]> {
  const done: string[] = [];
  for (const p of plan) {
    const wrote = await client.$transaction(async (tx) => {
      const dismissal = await tx.orcidDismissal.findUnique({
        where: { cwid_orcid: { cwid: p.cwid, orcid: p.orcid } },
      });
      if (dismissal) return false;
      const { count } = await tx.scholar.updateMany({
        where: { cwid: p.cwid, orcid: null },
        data: {
          orcid: p.orcid,
          orcidConfirmedAt: now,
          orcidConfirmMethod: "email_verified",
          orcidConfirmedBy: ETL_ACTOR,
        },
      });
      if (count !== 1) return false;
      await appendAuditRow(tx, {
        actorCwid: ETL_ACTOR,
        impersonatedCwid: null,
        targetEntityType: "scholar",
        targetEntityId: p.cwid,
        action: "orcid_email_autoconfirm",
        fieldsChanged: ["orcid"],
        beforeValues: { orcid: null },
        afterValues: { orcid: p.orcid, method: "email_verified" },
        ts: now,
        requestId: null,
      });
      return true;
    });
    if (wrote) done.push(p.cwid);
  }
  return done;
}

/** The auto-confirm step as main() runs it: with the flag off (or on a dry
 *  run) it only logs the would-confirm count and cwids and writes nothing. */
export async function autoConfirmStep(
  client: WriteClient,
  plan: Array<{ cwid: string; orcid: string }>,
  opts: { enabled: boolean; dryRun: boolean; now?: Date },
): Promise<string[]> {
  if (opts.dryRun || !opts.enabled) {
    console.log(
      `email auto-confirm ${opts.dryRun ? "(dry run)" : "(ORCID_EMAIL_AUTOCONFIRM off)"}: would confirm ${plan.length}: ${plan.map((p) => p.cwid).join(", ")}`,
    );
    return [];
  }
  const done = await applyAutoConfirm(client, plan, opts.now);
  console.log(`email auto-confirm: ${done.length} of ${plan.length} confirmed: ${done.join(", ")}`);
  return done;
}

const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const maxRecords = Number(process.env.ORCID_EVIDENCE_MAX_RECORDS);
// A truncated iD list is a local smoke only: the delete pass would remove every
// evidence row the sample did not cover, so the knob forces a dry run.
const dryRun =
  process.argv.includes("--dry-run") ||
  process.env.ORCID_EVIDENCE_DRY_RUN === "1" ||
  maxRecords > 0;

async function main(): Promise<number> {
  await initOrcidAuth();

  const scholars = await db.write.scholar.findMany({
    select: {
      cwid: true,
      email: true,
      fullName: true,
      preferredName: true,
      orcid: true,
      status: true,
      deletedAt: true,
    },
  });
  const active = scholars.filter((s) => s.status === "active" && !s.deletedAt);
  const byCwid = new Map(active.map((s) => [s.cwid, s]));
  const dismissed = new Set(
    (await db.write.orcidDismissal.findMany({ select: { cwid: true, orcid: true } })).map(
      (d) => `${d.cwid}|${d.orcid}`,
    ),
  );

  // 1. Population: distinct non-dismissed candidate pairs of active scholars.
  //    "On file" is `scholar.orcid` or an undismissed `rpm_admin` iD (`heldFor`).
  const seen = new Set<string>();
  const pairs: Array<{ cwid: string; orcid: string }> = [];
  const admins = new Map<string, string[]>();
  const sources = new Map<string, string[]>();
  for (const c of await db.write.orcidCandidate.findMany({
    select: { cwid: true, orcid: true, source: true },
  })) {
    const k = `${c.cwid}|${c.orcid}`;
    if (dismissed.has(k) || !byCwid.has(c.cwid)) continue;
    if (!(sources.get(k) ?? []).includes(c.source))
      sources.set(k, [...(sources.get(k) ?? []), c.source]);
    if (c.source === "rpm_admin" && !(admins.get(c.cwid) ?? []).includes(c.orcid))
      admins.set(c.cwid, [...(admins.get(c.cwid) ?? []), c.orcid]);
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push({ cwid: c.cwid, orcid: c.orcid });
  }
  let ids = [...new Set(pairs.map((p) => p.orcid))];
  if (maxRecords > 0 && ids.length > maxRecords) {
    console.log(
      `ORCID_EVIDENCE_MAX_RECORDS=${maxRecords}: truncating ${ids.length} iDs (dry run forced)`,
    );
    ids = ids.slice(0, maxRecords);
  }
  console.log(`${pairs.length} candidate pairs, ${ids.length} distinct iDs`);
  if (ids.length === 0)
    throw new Error("0 candidate iDs — orcid_candidate is empty; refusing to mirror");

  // 2. One /record per iD.
  const facts = new Map<string, ReturnType<typeof recordFacts>>();
  const deprecated = new Map<string, string | null>();
  let failed = 0;
  const fetchAll = async (list: string[]) => {
    for (const orcid of list) {
      if (facts.has(orcid) || deprecated.has(orcid)) continue;
      try {
        facts.set(orcid, recordFacts(orcid, await fetchRecord(orcid)));
      } catch (err) {
        // A merged record: not a failure, and never scored as itself.
        if (err instanceof OrcidDeprecatedError) {
          deprecated.set(orcid, err.primary);
          continue;
        }
        // Auth/blocking: every further call fails the same way — stop before the write.
        if (err instanceof OrcidHttpError && (err.status === 401 || err.status === 403)) {
          throw new Error(
            `ORCID refused /record (HTTP ${err.status}) — aborting before the write`,
            {
              cause: err,
            },
          );
        }
        failed++;
        if (failed <= 3)
          console.warn(`record fetch failed for ${orcid}: ${(err as Error).message}`);
      }
    }
  };
  await fetchAll(ids);
  if (deprecated.size > 0) {
    const sub = substituteDeprecated(pairs, deprecated, dismissed);
    pairs.splice(0, pairs.length, ...sub.pairs);
    // Primaries this run has not fetched yet (they were not candidates themselves).
    await fetchAll([...new Set(pairs.map((p) => p.orcid))]);
    console.log(
      `${deprecated.size} deprecated iDs: ${sub.replaced} pairs moved to the primary iD, ${sub.dropped} dropped (${[...deprecated].map(([d, p]) => `${d}->${p ?? "none"}`).join(", ")})`,
    );
  }
  const onFile = new Set(
    pairs
      .filter(
        (p) => heldFor(p.orcid, byCwid.get(p.cwid)!.orcid, admins.get(p.cwid) ?? []) === p.orcid,
      )
      .map((p) => `${p.cwid}|${p.orcid}`),
  );
  console.log(`${onFile.size} pairs already on file`);
  const maxFailed = Math.max(RECORD_FAIL_FLOOR, Math.ceil(RECORD_FAIL_SHARE * ids.length));
  if (failed > maxFailed) {
    throw new Error(
      `${failed} of ${ids.length} /record fetches failed after retries (> ${maxFailed}) — an ORCID outage, refusing to mirror`,
    );
  }

  // 3. Works for every scholar a rule reads: the pairs' scholars and their same-surname peers.
  const index = buildNameIndex(active);
  const needed = new Set(pairs.map((p) => p.cwid));
  for (const cwid of [...needed]) {
    const s = byCwid.get(cwid)!;
    for (const k of new Set([lastNameKey(fold(s.fullName)), lastNameKey(fold(s.preferredName))])) {
      for (const o of index.get(k) ?? []) needed.add(o.cwid);
    }
  }
  const works = await loadScholarWorkIds([...needed]);

  // 4. The scholars' own institution history (history_match), for the pairs' scholars.
  const pairCwids = [...new Set(pairs.map((p) => p.cwid))];
  const education: Array<{ cwid: string; institution: string }> = [];
  const appointments: Array<{ cwid: string; organization: string }> = [];
  for (const part of chunk(pairCwids, BATCH)) {
    education.push(
      ...(await db.write.education.findMany({
        where: { cwid: { in: part } },
        select: { cwid: true, institution: true },
      })),
    );
    appointments.push(
      ...(await db.write.profileAppointment.findMany({
        where: { cwid: { in: part }, category: "EXTERNAL" },
        select: { cwid: true, organization: true },
      })),
    );
  }
  let identity = new Map<string, string[]>();
  try {
    identity = await loadIdentityInstitutions(new Set(pairCwids));
  } catch (err) {
    // Conservative on failure: without this source a pair can only score lower.
    console.warn(
      `ReCiter Identity institutions unavailable (${(err as Error).message}); history_match uses education + appointments only`,
    );
  }
  const history = buildHistory({ education, appointments, identity });
  console.log(
    `history: ${education.length} degrees, ${appointments.length} external appointments, ${identity.size} Identity records with institutions`,
  );

  const scored = assembleEvidence({
    pairs,
    onFile,
    facts,
    scholars: byCwid,
    works,
    active,
    history,
    sources,
    historyBand: isHistoryBandEnabled(),
  });

  // 5. Shared papers' title, year, journal and DOI from our publications.
  const sharedPmids = [
    ...new Set(scored.flatMap((r) => r.evidenceDetail.shared.map((p) => p.pmid))),
  ];
  const papers = new Map<
    string,
    { doi: string | null; title: string | null; year: number | null; journal: string | null }
  >();
  for (const part of chunk(sharedPmids, BATCH)) {
    for (const p of await db.write.publication.findMany({
      where: { pmid: { in: part } },
      select: { pmid: true, doi: true, title: true, year: true, journal: true },
    }))
      papers.set(p.pmid, { doi: p.doi, title: p.title, year: p.year, journal: p.journal });
  }
  const rows = withSharedPaperDetail(scored, papers);
  const byBand = rows.reduce<Record<string, number>>(
    (m, r) => ((m[r.band] = (m[r.band] ?? 0) + 1), m),
    {},
  );
  console.log(
    `${rows.length} evidence rows ${JSON.stringify(byBand)}; ${rows.filter((r) => r.historyMatch).length} with history_match (${rows.filter((r) => r.historyMatch && !r.instMatch).length} without inst_match); ${failed} record-fetch failures`,
  );
  console.log(
    `history band term ${isHistoryBandEnabled() ? "ON" : "off (ORCID_HISTORY_BAND)"}; band moves it makes: ${JSON.stringify(historyBandShift(rows))}`,
  );
  if (rows.length === 0) throw new Error("0 evidence rows — refusing to mirror an empty set");

  const plan = planAutoConfirm(
    rows,
    new Map(active.map((s) => [s.cwid, s.orcid ?? admins.get(s.cwid)?.[0] ?? null])),
    dismissed,
  );
  if (dryRun) {
    await autoConfirmStep(db.write, plan, { enabled: isEmailAutoconfirmEnabled(), dryRun });
    console.log("--dry-run: nothing written.");
    return rows.length;
  }

  // 6. Mirror: upsert everything, then delete what this run did not compute.
  const now = new Date();
  for (const batch of chunk(rows, BATCH)) {
    await db.write.$transaction(
      batch.map((r) => {
        const data = { ...r, computedAt: now };
        return db.write.orcidCandidateEvidence.upsert({
          where: { cwid_orcid: { cwid: r.cwid, orcid: r.orcid } },
          create: data,
          update: data,
        });
      }),
    );
  }
  const { count: removed } = await db.write.orcidCandidateEvidence.deleteMany({
    where: { computedAt: { lt: now } },
  });
  console.log(
    `orcid_candidate_evidence mirrored: ${rows.length} rows, ${removed} stale rows removed.`,
  );

  // 7. Email auto-confirm, after the evidence write.
  await autoConfirmStep(db.write, plan, { enabled: isEmailAutoconfirmEnabled(), dryRun, now });
  return rows.length;
}

// Run only when invoked directly (`npm run etl:orcid-evidence` / the weekly task) — the
// module is also imported by its unit test for the pure transforms.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  // A dry run must not leave a green EtlRun row behind (freshness would read it as a real pass).
  (dryRun ? main().then(() => undefined) : withEtlRun("ORCID-evidence", main))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
