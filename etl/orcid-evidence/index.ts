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
 *                        shared_only, moderate, weak.
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
 * HTTPS to ORCID + Aurora only). Env: `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET`
 * (optional, anonymous otherwise), `ORCID_EMAIL_AUTOCONFIRM`,
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
import { heldFor } from "@/lib/edit/orcid-queue";
import { lastNameKey } from "@/lib/last-name-key";

const BATCH = 500;
export const MIN_SHARED = 3;
const NEW_WORKS_SAMPLE = 5;
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
  shared: number;
  competitor: boolean;
  nameAgrees: boolean;
};

/** The queue band, first match wins. Pure. */
export function bandOf(e: BandInput): Band {
  const papers = e.shared >= MIN_SHARED;
  if (e.emailVerified && !e.competitor) return "email_verified";
  if (e.instMatch && papers && !e.competitor && e.nameAgrees) return "strong";
  if (papers && !e.competitor && e.nameAgrees) return "shared_only";
  if ([e.instMatch, papers, !e.competitor].filter(Boolean).length >= 2) return "moderate";
  return "weak";
}

export type NewWork = {
  title: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  source: string | null;
};

type WorkFact = NewWork & { ids: Set<string> };

/** What one `/record` says, normalized once per iD. */
export type RecordFacts = {
  /** credit-name, "given family", other names — `candidateNames`, folded. */
  names: string[];
  given: string | null;
  family: string | null;
  emails: Array<{ email: string; verified: boolean }>;
  orgs: Array<{ name: string | null; ror: string | null }>;
  /** Every work's doi:/pmid: keys (`extractWorkIds`). */
  workIds: Set<string>;
  /** One per work group. */
  works: WorkFact[];
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
  for (const block of [acts?.employments, acts?.educations]) {
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
          });
        }
      }
    }
  }
  const worksResp = acts?.works ?? { "last-modified-date": null, group: null };
  const works: WorkFact[] = (worksResp.group ?? []).map((g) => {
    const ids = extractWorkIds({ "last-modified-date": null, group: [g] });
    const first =
      (g["work-summary"] ?? []).find((w) => text(w.title?.title)) ?? g["work-summary"]?.[0];
    const year = Number(text(first?.["publication-date"]?.year));
    const doi = [...ids].find((k) => k.startsWith("doi:"))?.slice(4) ?? null;
    const pmid = [...ids].find((k) => k.startsWith("pmid:"))?.slice(5) ?? null;
    return {
      ids,
      title: text(first?.title?.title),
      year: Number.isInteger(year) && year > 0 ? year : null,
      doi,
      pmid,
      source: text(first?.source?.["source-name"]),
    };
  });
  const modified =
    rec.history?.["last-modified-date"]?.value ?? acts?.["last-modified-date"]?.value ?? null;
  return {
    names,
    given,
    family,
    emails,
    orgs,
    workIds: extractWorkIds(worksResp),
    works,
    modifiedAt: modified ? new Date(modified) : null,
  };
}

/** A VERIFIED public email on the record equals the scholar's email. Pure. */
export function isEmailVerified(
  facts: Pick<RecordFacts, "emails">,
  scholarEmail: string | null,
): boolean {
  const mine = scholarEmail?.trim().toLowerCase();
  if (!mine) return false;
  return facts.emails.some((e) => e.verified && e.email === mine);
}

/** An employment/education org names Cornell or carries the WCM ROR id, or a
 *  public email is on cornell.edu (verified or not). Pure. */
export function isInstMatch(facts: Pick<RecordFacts, "emails" | "orgs">): boolean {
  const phrases = [CORNELL_ORG_PHRASE, ...INSTITUTIONS.map((i) => i.orgPhrase)].map((p) =>
    p.toLowerCase(),
  );
  const rors = new Set(INSTITUTIONS.map((i) => i.ror.toLowerCase()));
  const domains = [CORNELL_EMAIL_DOMAIN, ...INSTITUTIONS.map((i) => i.emailDomain)];
  return (
    facts.orgs.some(
      (o) =>
        (o.name && phrases.some((p) => o.name!.toLowerCase().includes(p))) ||
        (o.ror && rors.has(o.ror.trim().toLowerCase())),
    ) ||
    facts.emails.some((e) =>
      domains.some((d) => e.email.endsWith(`@${d}`) || e.email.endsWith(`.${d}`)),
    )
  );
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
  if (!recordFamily) return false;
  const theirs = surnameTokens(recordFamily, { skipGiven: false });
  const theirTails = new Set(gluedTails([...nameTokens(fold(recordFamily))]));
  for (const n of [scholar.fullName, scholar.preferredName]) {
    const mine = surnameTokens(n, { skipGiven: true });
    if (theirs.some((t) => t.length >= 3 && mine.includes(t))) return true;
    if (gluedTails([...nameTokens(fold(n))].slice(1)).some((t) => theirTails.has(t))) return true;
  }
  return false;
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
    .map(({ title, year, doi, pmid, source }) => ({ title, year, doi, pmid, source }));
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
}): { competitor: boolean; cwids: string[]; orcids: string[] } {
  const minePmids = new Set(args.mine?.values() ?? []);
  const cwids = new Set<string>();
  for (const s of args.sameSurname) {
    if (s.cwid === args.cwid) continue;
    const theirs = [...sharedPapers(args.workIds, s.works)].filter((p) => !minePmids.has(p));
    if (theirs.length >= MIN_SHARED) cwids.add(s.cwid);
  }
  for (const h of args.otherHolders)
    if (h.cwid !== args.cwid && h.shared >= MIN_SHARED) cwids.add(h.cwid);
  const orcids = [
    ...new Set(
      args.otherIds.filter((o) => o.shared === null || o.shared >= MIN_SHARED).map((o) => o.orcid),
    ),
  ];
  return {
    competitor: cwids.size > 0 || orcids.length > 0,
    cwids: [...cwids].sort(),
    orcids: orcids.sort(),
  };
}

export type EvidenceRow = {
  cwid: string;
  orcid: string;
  band: Band;
  instMatch: boolean;
  emailVerified: boolean;
  nameAgrees: boolean;
  shared: number;
  competitor: boolean;
  competitorCwids: string[];
  competitorOrcids: string[];
  worksTotal: number;
  newWorks: number;
  newWorksSample: NewWork[];
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
    const e = {
      emailVerified: isEmailVerified(f, s.email),
      instMatch: isInstMatch(f),
      shared: shared.get(key(p.cwid, p.orcid)) ?? 0,
      competitor: comp.competitor,
      nameAgrees: nameAgrees(f, s),
    };
    const nw = newWorksOf(f, mine);
    rows.push({
      cwid: p.cwid,
      orcid: p.orcid,
      band: bandOf(e),
      ...e,
      competitorCwids: comp.cwids,
      competitorOrcids: comp.orcids,
      worksTotal: nw.total,
      newWorks: nw.count,
      newWorksSample: nw.sample,
      recordModifiedAt: f.modifiedAt,
    });
  }
  return rows;
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
  for (const c of await db.write.orcidCandidate.findMany({
    select: { cwid: true, orcid: true, source: true },
  })) {
    const k = `${c.cwid}|${c.orcid}`;
    if (dismissed.has(k) || !byCwid.has(c.cwid)) continue;
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

  const rows = assembleEvidence({ pairs, onFile, facts, scholars: byCwid, works, active });
  const byBand = rows.reduce<Record<string, number>>(
    (m, r) => ((m[r.band] = (m[r.band] ?? 0) + 1), m),
    {},
  );
  console.log(
    `${rows.length} evidence rows ${JSON.stringify(byBand)}; ${failed} record-fetch failures`,
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

  // 4. Mirror: upsert everything, then delete what this run did not compute.
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

  // 5. Email auto-confirm, after the evidence write.
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
