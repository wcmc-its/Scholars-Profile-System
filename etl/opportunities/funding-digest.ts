/**
 * Research Dean "Major Funding Digest" email → opportunity URL submissions.
 *
 * Run via `npm run etl:funding-digest`; wired weekly as FundingDigestWeekly in
 * cdk/lib/etl-stack.ts. The Office of the Research Dean mails a weekly digest
 * of ~60 funding opportunities; `funding@scholars-mail.weill.cornell.edu` is
 * subscribed, and SES (cdk/lib/inbound-mail-stack.ts) drops each message into
 * S3 under `funding/`. This step parses each digest item (title, link, section,
 * sponsor, deadline, nomination limit) and submits every NEW link to the same
 * `SUBMISSION` queue the /edit/grant-matcha intake panel writes
 * (lib/edit/opportunity-submission.ts). ReciterAI's daily
 * `ingest_submissions` drain fetches, judges, scores and persists them; the
 * nightly `etl:dynamodb` projection brings them back as `manual_url` rows.
 *
 * Dedup is STRICTER than the panel's findDuplicate: a URL already in the
 * corpus, or carrying ANY queue item (rejected and suppressed included), is
 * skipped. The panel lets a person resubmit a rejected URL on purpose; a weekly
 * re-read must not resubmit it every week, or undo a steward's suppression.
 *
 * The queue lives in the ONE `reciterai` table both envs share, so only prod
 * submits. Any other SCHOLARS_ENV (staging, local) parses and logs a dry run.
 *
 * Usage:
 *   npm run etl:funding-digest                   read INBOUND_MAIL_BUCKET/funding/
 *   npm run etl:funding-digest -- a.eml b.eml    parse hand-given emails
 */
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import {
  listSubmissions,
  normalizeOpportunityUrl,
  putSubmission,
  type OpportunitySubmission,
} from "@/lib/edit/opportunity-submission";
import {
  htmlToLines,
  readBucketEmails,
  readEmail,
  REPLY_RE,
  unwrapLink,
  WCM_FROM_RE,
  type RawEmail,
} from "../news/clips";

export const FUNDING_PREFIX = "funding/";
const SUBJECT_RE = /\bmajor funding digest\b/i;
/** Same stray-email tolerance as the clips step (see etl/news/clips.ts). */
const UNPARSED_FAIL_MS = 36 * 3_600_000;
/** The panel caps a note at 500 chars; so does the digest. */
const NOTE_MAX = 500;

export type DigestItem = {
  url: string;
  /** normalizeOpportunityUrl's key — https only, tracking params stripped. */
  normalizedUrl: string;
  title: string;
  section: string | null;
  sponsor: string | null;
  deadline: string | null;
  nominationLimit: string | null;
};

/** Opportunity listings start at the first of these headers ... */
const START_RE = /^(federal limited submission|nih funding opportunities|department of (war|defense))/i;
/** ... and end where the events section or the footer begins. */
const STOP_RE = /^(webinars\b|look out for our correspondence)/i;
/** A section header ("Industry Open Submission Programs"). */
const SECTION_RE = /(opportunities|programs)$/i;
const LINK_RE = /<([^\s<>]+)>/g;
/** Link text that points at a list, a booking page or a mailbox, not an opportunity. */
const NOISE_TEXT_RE = /\b(here|book now|click|rsvp)\b/i;
const NOISE_HOST_RE = /(^|\.)sharepoint\.com$/i;
const FIELD_RE = /^(?:(external|internal)\s+)?(deadline|nomination limit|loi deadline)\s*:\s*(.+)$/i;
const BULLET_RE = /^[•·▪*-]\s*/;

function opportunityLink(line: string): string | null {
  for (const m of line.matchAll(LINK_RE)) {
    const url = unwrapLink(m[1]);
    if (url && !NOISE_HOST_RE.test(new URL(url).hostname)) return url;
  }
  return null;
}

/** Parse one digest body (already in `Title<link>` line shape). */
export function parseDigestLines(text: string): DigestItem[] {
  const items: DigestItem[] = [];
  const seen = new Set<string>();
  let started = false;
  let section: string | null = null;
  let sponsor: string | null = null;
  let cur: DigestItem | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim().replace(BULLET_RE, "");
    if (!line) continue;
    if (!started) {
      if (!START_RE.test(line)) continue;
      started = true;
    }
    if (STOP_RE.test(line)) break;

    const text = line.replace(LINK_RE, "").replace(/\s+/g, " ").trim();
    const url = opportunityLink(line);
    if (url) {
      // "Bone Marrow Failure Research Program<url> - Deadline: October 7, 2026"
      const [title, inlineDeadline] = text.split(/\s+-\s+deadline\s*:\s*/i);
      if (NOISE_TEXT_RE.test(title) || /^please\b/i.test(title)) continue;
      const norm = normalizeOpportunityUrl(url);
      if (!norm.ok || seen.has(norm.normalized)) {
        cur = null;
        continue;
      }
      seen.add(norm.normalized);
      cur = {
        url,
        normalizedUrl: norm.normalized,
        title: title.replace(/[.\s]+$/, "").slice(0, 300),
        section,
        sponsor,
        deadline: inlineDeadline?.trim() ?? null,
        nominationLimit: null,
      };
      items.push(cur);
      continue;
    }
    if (line.includes("<")) continue; // only noise links (mailto, "here", SharePoint)

    const f = text.match(FIELD_RE);
    if (f) {
      if (!cur) continue;
      const [, qualifier, field, value] = f;
      if (/nomination/i.test(field)) cur.nominationLimit = value;
      // The EXTERNAL deadline is the sponsor's; the internal one is WCM routing.
      else if (!qualifier || /external/i.test(qualifier)) cur.deadline = value;
      continue;
    }
    if (SECTION_RE.test(text) && text.length <= 80) {
      section = text;
      sponsor = null;
      cur = null;
      continue;
    }
    // A plain line is a topic or sponsor heading; the one nearest the item wins.
    // ponytail: topic headings ("Cancer Research") also land here, and the
    // sponsor line that follows overwrites them. Good enough for a note.
    // Instructions ("Please click on the program link …") are sentences, not headings.
    if (text.length <= 120 && !/^please\b/i.test(text) && !/[.:]$/.test(text)) sponsor = text;
  }
  return items;
}

/** Parse a raw digest email: HTML part when it yields items, else plain. */
export function parseFundingDigest(raw: string): DigestItem[] {
  const e = readEmail(raw);
  const fromHtml = e.html ? parseDigestLines(htmlToLines(e.html)) : [];
  return fromHtml.length ? fromHtml : e.plain ? parseDigestLines(e.plain) : [];
}

export function digestNote(item: DigestItem, digestDate: string): string {
  return [
    `Research Dean funding digest ${digestDate}`,
    item.section,
    item.sponsor,
    item.deadline ? `Deadline: ${item.deadline}` : null,
    item.nominationLimit ? `Nomination limit: ${item.nominationLimit}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, NOTE_MAX);
}

/**
 * The items to submit: not already in the corpus, and not carrying ANY queue
 * item, whatever its status (see the module doc for why this is stricter than
 * the panel's findDuplicate).
 */
export function newSubmissions(
  items: DigestItem[],
  corpusUrls: Iterable<string>,
  submissions: ReadonlyArray<Pick<OpportunitySubmission, "normalizedUrl">>,
): DigestItem[] {
  const known = new Set(submissions.map((s) => s.normalizedUrl));
  for (const u of corpusUrls) {
    const n = normalizeOpportunityUrl(u);
    if (n.ok) known.add(n.normalized);
  }
  const out: DigestItem[] = [];
  for (const it of items) {
    if (known.has(it.normalizedUrl)) continue;
    known.add(it.normalizedUrl); // the same link in two digests submits once
    out.push(it);
  }
  return out;
}

function isoDate(header: string | null, fallbackMs: number): string {
  const t = header ? Date.parse(header) : NaN;
  return new Date(Number.isNaN(t) ? fallbackMs : t).toISOString().slice(0, 10);
}

async function main(): Promise<number> {
  const files = process.argv.slice(2);
  const fromBucket = files.length === 0;
  const raws: RawEmail[] = fromBucket
    ? await readBucketEmails(FUNDING_PREFIX)
    : files.map((f) => ({ raw: readFileSync(f).toString("latin1"), receivedAt: Date.now() }));

  const found: { item: DigestItem; date: string }[] = [];
  const unparsed: string[] = [];
  let skipped = 0;
  for (const { raw, receivedAt } of raws) {
    const e = readEmail(raw);
    // Noise filter, not a trust boundary: the drain's judge decides what
    // becomes an opportunity, and a steward can suppress any submission.
    const trusted =
      SUBJECT_RE.test(e.subject) &&
      (!fromBucket ||
        (!REPLY_RE.test(e.subject) &&
          WCM_FROM_RE.test(e.from) &&
          e.virusVerdict !== "FAIL" &&
          e.spamVerdict !== "FAIL"));
    if (!trusted) {
      skipped++;
      continue;
    }
    const items = parseFundingDigest(raw);
    if (items.length === 0 && Date.now() - receivedAt <= UNPARSED_FAIL_MS) unparsed.push(e.subject);
    const date = isoDate(e.date, receivedAt);
    for (const item of items) found.push({ item, date });
  }

  const corpus = await db.write.opportunity.findMany({ select: { sourceUrl: true } });
  const queue = await listSubmissions();
  const fresh = newSubmissions(
    found.map((f) => f.item),
    corpus.map((c) => c.sourceUrl),
    queue,
  );
  const dateOf = new Map(found.map((f) => [f.item.normalizedUrl, f.date]));

  const submit = process.env.SCHOLARS_ENV === "prod";
  let submitted = 0;
  if (submit) {
    for (const it of fresh) {
      const date = dateOf.get(it.normalizedUrl)!;
      await putSubmission({
        url: it.url,
        normalizedUrl: it.normalizedUrl,
        note: digestNote(it, date),
        submittedBy: `digest:${date}`,
      });
      submitted++;
    }
  }
  console.log(
    `[FundingDigest] ${JSON.stringify({ event: "funding_digest_complete", dryRun: !submit, emails: raws.length, skipped, items: found.length, new: fresh.length, submitted })}`,
  );
  if (!submit) for (const it of fresh) console.log(`[FundingDigest] would submit ${it.url} — ${it.title}`);
  if (unparsed.length) {
    throw new Error(`[FundingDigest] ${unparsed.length} digest(s) parsed to zero items: ${unparsed.join(" | ")}`);
  }
  return submitted;
}

if (process.env.NODE_ENV !== "test" && process.argv[1] && /etl[\\/]opportunities[\\/]funding-digest/.test(process.argv[1])) {
  withEtlRun("FundingDigest", main)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.write.$disconnect());
}
