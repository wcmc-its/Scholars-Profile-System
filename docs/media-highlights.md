# Media highlights — press clips on profiles

**Status:** Live in both environments as of 2026-09-23/24. Built in #2740 (mail intake, clip parser,
profile section) and #2756 (separate review queue). `MEDIA_HIGHLIGHTS_SECTION` is `on` in both envs
(prod since #2757 and a manual `cdk deploy Sps-App-prod`). `Sps-Etl-prod` was deployed on
2026-09-23 with the `ClipsNightly` and `FundingDigestWeekly` steps. Clips only appear on a profile
after review, so a profile's section stays empty until comms approves clips for that scholar.

This doc answers **where a profile's "Media highlights" come from, who approves them, and what to
check when they stop arriving.** Newsroom stories (the separate "News mentions" section) are covered
in [`2026-07-18-news-mentions-plan.md`](./2026-07-18-news-mentions-plan.md).

## End to end

1. **Email.** External Affairs sends a curated daily "WCM in the News" digest to its clips mailing
   list. A receive-only SPS address on the `scholars-mail` subdomain is subscribed to that list.
   The list address is kept out of this public repo.
2. **SES inbound.** The `Sps-InboundMail` stack (`cdk/lib/inbound-mail-stack.ts`) receives the mail
   and writes each raw message to the S3 bucket `sps-inbound-mail-<account>`, under `clips/` for the
   clips address and `funding/` for the funding digest (below). The stack is an account-wide
   singleton, declared from the prod app only, because SES allows one active receipt rule set per
   account and region and staging and prod share the account. **Both environments' ETL read the same
   bucket**, read-only.
3. **Nightly parse.** The `ClipsNightly` step of `scholars-nightly-<env>` (`cdk/lib/etl-stack.ts`) runs
   `npm run etl:news-clips` (`etl/news/clips.ts`). It lists recent messages (default look-back 30 days,
   `CLIPS_LOOKBACK_DAYS`), keeps only digests from a WCM sender whose subject reads "in the news"
   (replies are skipped, forwards are kept), parses each clip (headline, outlet, link, the summary
   line) and runs the newsroom name matcher over it. Re-reading a message is harmless: the upsert is
   idempotent.
4. **Rows.** Each clip becomes a `news_mention` row with **`outlet` set**. That column is the whole
   difference between a press clip and a newsroom story. Every clip lands `pending`.
5. **Review.** Comms approves or rejects clips at **`/edit/media-highlights-queue`**, separate from the
   newsroom queue at `/edit/news-queue`. Same reviewers (superusers and comms stewards), same component
   and decision API, filtered to rows with an `outlet`.
6. **Profile.** Approved clips render in the profile's **Media highlights** section
   (`lib/api/profile.ts` `mediaHighlights`, `components/profile/profile-view.tsx`), with the outlet
   shown. Clips never appear in the News mentions section. The scholar's existing "hide News" section
   switch hides both.

## Flags

| Flag | Gates | State |
|---|---|---|
| `MEDIA_HIGHLIGHTS_SECTION` | The profile section, and (with the one below) the review queue | `on` in staging and prod |
| `NEWS_APPROVAL_QUEUE` | The news queue; the clips queue requires it too (`isMediaHighlightsQueueEnabled` in `lib/edit/news-queue.ts`) | `on` in both envs |

Task-env flags go live only on a manual `cdk deploy Sps-App-<env>`; see
[`flag-inventory.md`](./flag-inventory.md).

## The funding digest shares the mailbox

The same stack receives the Office of the Research Dean's weekly "Major Funding Digest" under
`funding/`. The `FundingDigestWeekly` step of `scholars-weekly-<env>` runs `npm run etl:funding-digest`
(`etl/opportunities/funding-digest.ts`, #2745). It parses each opportunity and submits every **new**
link to ReciterAI's `SUBMISSION` queue, the same queue the Grant Matcha intake panel writes. That queue
lives in the one `reciterai` DynamoDB table both environments share, so **only prod submits**; any other
environment parses and logs a dry run. It is inert until the funding address is subscribed to the
Research Dean's funding-announcements list.

## Operating it

**Did a clip run happen?** Look at the newest `scholars-nightly-<env>` execution in Step Functions and
its `ClipsNightly` step, or the `etl_run` rows for source `NewsClips`. `/edit/etl-status` grades
`NewsClips` on a nightly cadence and `FundingDigest` weekly (`lib/etl/freshness-policy.ts`). A night
with no new digest is still a successful run, so staleness means the step itself stopped running.

**Did mail arrive?** `aws s3 ls s3://sps-inbound-mail-<account>/clips/` (or `funding/`).

**Failures.** Both steps are continue-tier: a bad digest fails its own step and alerts, but the rest of
the chain runs. Step failures publish to the `etl-failures-<env>` SNS topic, like every ETL step (see
[`etl-monitoring.md`](./etl-monitoring.md)). A digest that parses to zero clips fails the step only
while it is less than 36 hours old, so one stray email reds at most a night or two, while real format
drift keeps the step red.

**Re-run by hand.** Start the nightly from the step:
`aws stepfunctions start-execution --state-machine-arn <scholars-nightly-<env>> --input '{"startFrom":"ClipsNightly"}'`,
or run `npm run etl:news-clips` as a one-off task on the `sps-etl-<env>` family (resolve subnets and
security group live, per [`data-population-runbook.md`](./data-population-runbook.md)). To load a
forwarded digest by hand: `npm run etl:news-clips -- <file.eml>`.

**One-time setup** of the inbound mail stack (DNS delegation, activating the rule set, list
subscriptions) is in [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), section "Media highlights inbound mail".

## Known issues and open items

- **Sender-verdict logging reads the wrong headers.** `etl/news/clips.ts` logs `authVerdict` from
  `X-SES-SPF-Verdict` / `X-SES-DKIM-Verdict`, which SES does not write for this setup, so it always logs
  `none`. The real SPF / DKIM / DMARC results are in the `Authentication-Results: amazonses.com` header.
  The virus and spam checks are unaffected. The sender check is currently the From domain only; tighten
  it once real deliveries' verdicts are read from the right header.
- **List subscriptions owed.** The clips address must be on External Affairs' list, and the funding
  address on the Research Dean's funding-announcements list, before mail flows in production.
- **Editor sidebar.** The profile editor has no "Media highlights" item yet, and today it lists
  published clips under "News mentions" (`lib/api/edit-context.ts` does not filter on `outlet`). A
  separate change adds a Media highlights item and removes clips from News mentions.
