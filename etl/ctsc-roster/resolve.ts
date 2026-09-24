/**
 * Pure resolution for `etl/ctsc-roster`: feed record → linked scholar, plain
 * external name, and (when CTSC should fix its record) an issue row.
 *
 * The feed's CWIDs are unreliable (confirmed with the feed owner, IC #144), so
 * a CWID is trusted only after an ED check — never by its shape: many valid
 * WCM CWIDs are letters-only legacy ids (e.g. `varmus`), which is why they also
 * equal the person's email local-part. Blank / bad CWIDs fall back to an ED
 * email lookup, accepted only when it names ONE person whose ED surname agrees
 * with the feed's (a shared or stale mailbox must not link the wrong person).
 */

export type CtscFeedRecord = {
  PrimaryKey: number;
  CWID?: string | null;
  FirstName?: string | null;
  MiddleName?: string | null;
  LastName?: string | null;
  EMails?: string[] | null;
  Institutions?: string[] | null;
};

export type EdPerson = { uid: string; sn: string | null; displayName: string | null; retired: boolean };

export type CtscIssueReason =
  /** Blank CWID; ED resolved one from the record's email. */
  | "blank-resolved"
  /** CWID not in ED; see suggestedCwid if an email resolved. */
  | "not-in-ed"
  /** CWID is a retired ED record; see suggestedCwid if an email resolved. */
  | "retired-cwid"
  /** Valid CWID, but the record's emails belong to a DIFFERENT person. Not auto-fixed. */
  | "cwid-email-conflict"
  /** An email resolved, but ED's surname disagrees with the feed's. Not linked. */
  | "email-match-name-differs"
  /** Emails resolve to more than one ED person. */
  | "email-ambiguous"
  /** Same person as an earlier feed record. */
  | "duplicate-record";

export type CtscIssue = {
  primaryKey: number;
  name: string;
  institution: string | null;
  feedCwid: string | null;
  reason: CtscIssueReason;
  suggestedCwid: string | null;
  suggestedName: string | null;
  matchedEmail: string | null;
};

export type CtscExternal = {
  cuid: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  affiliation: string | null;
};

export type CtscResolution = {
  /** Profiled scholars (lowercase CWIDs) → `ctsc-feed` memberships. */
  linkedCwids: string[];
  /** Everyone else → `ExternalMember` + `ctsc-feed-external` membership. */
  externals: CtscExternal[];
  issues: CtscIssue[];
};

/**
 * Parse the feed body. The feed sends `PrimaryKey` as a digit STRING ("12345"),
 * not a number — normalize it, and drop any record without a usable key.
 */
export function parseCtscFeed(body: unknown): CtscFeedRecord[] {
  const records = (body as { CTSCInvestigatorsAndTrainees?: unknown })?.CTSCInvestigatorsAndTrainees;
  if (!Array.isArray(records)) throw new Error("CTSC feed: missing CTSCInvestigatorsAndTrainees array");
  const out: CtscFeedRecord[] = [];
  for (const r of records as Array<Record<string, unknown>>) {
    const raw = r?.PrimaryKey;
    const pk = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isSafeInteger(pk)) continue;
    out.push({ ...(r as CtscFeedRecord), PrimaryKey: pk });
  }
  return out;
}

export function ctscExternalKey(primaryKey: number): string {
  return `ctsc:${primaryKey}`;
}

const fold = (s: string | null | undefined): string =>
  (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** Accent-folded; either containing the other tolerates compound surnames. */
export function surnamesAgree(feed: string | null | undefined, ed: string | null | undefined): boolean {
  const a = fold(feed);
  const b = fold(ed);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

export function feedDisplayName(r: CtscFeedRecord): string {
  return [r.FirstName, r.MiddleName, r.LastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function feedEmails(r: CtscFeedRecord): string[] {
  return [...new Set((r.EMails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

export function resolveCtscFeed(
  records: CtscFeedRecord[],
  edByUid: Map<string, EdPerson>,
  edUidsByEmail: Map<string, string[]>,
  activeScholarCwids: Set<string>,
): CtscResolution {
  const linked = new Set<string>();
  const externalCwids = new Set<string>();
  const externals: CtscExternal[] = [];
  const issues: CtscIssue[] = [];

  for (const r of records) {
    const name = feedDisplayName(r);
    if (!name) continue;
    const feedCwid = (r.CWID ?? "").trim().toLowerCase() || null;
    const institution = (r.Institutions ?? []).find((s) => s?.trim())?.trim() ?? null;

    // Email → the one non-retired ED person every matching address names.
    let emailUid: string | null = null;
    let matchedEmail: string | null = null;
    let emailAmbiguous = false;
    const uids = new Set<string>();
    for (const e of feedEmails(r)) {
      for (const u of edUidsByEmail.get(e) ?? []) {
        if (edByUid.get(u)?.retired) continue;
        if (!uids.has(u)) matchedEmail ??= e;
        uids.add(u);
      }
    }
    if (uids.size === 1) emailUid = [...uids][0];
    else if (uids.size > 1) emailAmbiguous = true;
    const emailPerson = emailUid ? edByUid.get(emailUid) : undefined;
    const emailNameOk = emailPerson ? surnamesAgree(r.LastName, emailPerson.sn) : false;

    const issue = (
      reason: CtscIssueReason,
      suggested: EdPerson | undefined = undefined,
    ): CtscIssue => ({
      primaryKey: r.PrimaryKey,
      name,
      institution,
      feedCwid,
      reason,
      suggestedCwid: suggested?.uid ?? null,
      suggestedName: suggested?.displayName ?? null,
      matchedEmail: suggested ? matchedEmail : null,
    });

    let cwid: string | null = null;
    let recordIssue: CtscIssue | null = null;
    const feedPerson = feedCwid ? edByUid.get(feedCwid) : undefined;

    if (feedPerson && !feedPerson.retired) {
      cwid = feedCwid;
      if (emailPerson && emailUid !== feedCwid && emailNameOk) {
        recordIssue = issue("cwid-email-conflict", emailPerson);
      }
    } else if (emailPerson && emailNameOk) {
      cwid = emailUid;
      recordIssue = issue(feedCwid ? (feedPerson ? "retired-cwid" : "not-in-ed") : "blank-resolved", emailPerson);
    } else if (emailPerson) {
      recordIssue = issue("email-match-name-differs", emailPerson);
    } else if (emailAmbiguous) {
      recordIssue = issue("email-ambiguous");
    } else if (feedCwid) {
      recordIssue = issue(feedPerson ? "retired-cwid" : "not-in-ed");
    }

    const dup = cwid !== null && (linked.has(cwid) || externalCwids.has(cwid));
    if (dup && !recordIssue) recordIssue = issue("duplicate-record");
    if (recordIssue) issues.push(recordIssue);
    if (dup) continue;

    if (cwid && activeScholarCwids.has(cwid)) {
      linked.add(cwid);
      continue;
    }
    if (cwid) externalCwids.add(cwid);
    externals.push({
      cuid: ctscExternalKey(r.PrimaryKey),
      displayName: name.slice(0, 255),
      givenName: r.FirstName?.trim().slice(0, 128) || null,
      familyName: r.LastName?.trim().slice(0, 128) || null,
      affiliation: institution?.slice(0, 64) ?? null,
    });
  }

  return { linkedCwids: [...linked], externals, issues };
}
