/**
 * "How this queue works" copy for each /edit review queue, and each queue's
 * read-only notice. One file so the wording can be reviewed in one place.
 *
 * Every rule stated here is a rule in code; the source is named beside each
 * block. If a rule changes, change the copy with it.
 *
 * No hooks and no server imports: server pages render these as the
 * `QueueIntro` panel, and `components/edit/orcid-queue.tsx` (client) does not
 * import this file.
 */
import { QueueHelpPanel, QueueHelpSection, QueueTerm } from "@/components/edit/queue-help";
import { HIDE_AT, SHOW_AT } from "@/lib/edit/grant-attribution-decided";

const BULK_NOTE =
  "An administrator may approve strong matches in bulk, so some leave this queue without a separate review here.";

/** Honors. Levels: `lib/edit/honor-match.ts` (`matchSignals`); pills:
 *  `components/edit/honors-review.tsx`; who decides: `isHonorsQueueReadOnly`. */
export function HonorsQueueGuide() {
  return (
    <QueueHelpPanel>
      <QueueHelpSection title="Match strength">
        <QueueTerm term="How a match is checked">
          The name on the award list must match the profile name, and the source must tie the
          scholar to Weill Cornell. For an honor found in a news story, the quote must also name the
          scholar and the award. A nickname match counts as a failed check.
        </QueueTerm>
        <QueueTerm term="Strong" swatch="bg-apollo-slate">
          Every check passed.
        </QueueTerm>
        <QueueTerm term="Likely" swatch="bg-apollo-amber">
          One check failed.
        </QueueTerm>
        <QueueTerm term="Weak" swatch="bg-destructive">
          Two or more checks failed.
        </QueueTerm>
        <QueueTerm term="Pick 1 of N">
          The name matches more than one scholar. Pick the right person, or choose None of these.
        </QueueTerm>
      </QueueHelpSection>
      <QueueHelpSection title="What each action does">
        <QueueTerm term="Approve">
          The honor moves to Known and shows on the scholar&rsquo;s profile.
        </QueueTerm>
        <QueueTerm term="Reject or None of these">
          Pick a reason. The match moves to Rejected and won&rsquo;t be suggested again.
        </QueueTerm>
        <QueueTerm term="Skip">Moves on to the next match without deciding.</QueueTerm>
        <QueueTerm term="Undo">
          Reverses a decision you just made. Later, Move to Possible on Known or Restore on Rejected
          sends an honor back for review.
        </QueueTerm>
        <QueueTerm term="Bulk approval">{BULK_NOTE}</QueueTerm>
        <QueueTerm term="Who can decide">
          Administrators and honors curators. Other viewers can browse and download the CSV.
        </QueueTerm>
      </QueueHelpSection>
    </QueueHelpPanel>
  );
}

export function HonorsReadOnlyText() {
  return (
    <>
      You can view this queue and download the CSV, but you can&rsquo;t approve or reject honors.
      Only administrators and honors curators can decide. If you should be able to, ask an
      administrator to check your access.
    </>
  );
}

/** ORCID. Levels: `bandOf` in `etl/orcid-evidence/index.ts` (MIN_SHARED = 3,
 *  ORCID_HISTORY_BAND on in both envs); auto-confirm: `planAutoConfirm` there;
 *  labels: `ORCID_QUEUE_BAND_LABEL`; who decides: `isOrcidQueueTabVisible`. */
export function OrcidQueueGuide() {
  return (
    <QueueHelpPanel>
      <QueueHelpSection title="Match strength, strongest first">
        <QueueTerm term="Email verified">
          The ORCID record shows the scholar&rsquo;s own email, verified by ORCID. When nothing
          conflicts, the iD is confirmed automatically overnight and shows here with an Undo.
        </QueueTerm>
        <QueueTerm term="Strong">
          At least 3 shared papers, names that agree, and an affiliation with Cornell or with an
          institution in the scholar&rsquo;s own history.
        </QueueTerm>
        <QueueTerm term="Shared papers">
          At least 3 shared papers and names that agree, but no matching affiliation.
        </QueueTerm>
        <QueueTerm term="Moderate">
          Two of these three: a matching affiliation, at least 3 shared papers, no competing scholar
          or iD.
        </QueueTerm>
        <QueueTerm term="Weak">Less evidence than Moderate.</QueueTerm>
        <QueueTerm term="Competing scholar or iD">
          When another scholar, or another iD, has 3 or more of the same papers, the match stays at
          Moderate or below.
        </QueueTerm>
      </QueueHelpSection>
      <QueueHelpSection title="What each action does">
        <QueueTerm term="Confirm">
          Puts the iD on file for this scholar. It reaches WCM Identity overnight. If a different iD
          is already on file, the button reads Replace with this iD.
        </QueueTerm>
        <QueueTerm term="Not this person">
          Rules out this iD for this scholar. It won&rsquo;t be suggested for them again.
        </QueueTerm>
        <QueueTerm term="Undo">
          On an iD confirmed automatically, takes it off file and marks it Not this person.
        </QueueTerm>
        <QueueTerm term="Bulk approval">{BULK_NOTE}</QueueTerm>
        <QueueTerm term="Who can decide">Administrators only.</QueueTerm>
      </QueueHelpSection>
    </QueueHelpPanel>
  );
}

/** Grant attribution. Levels: `EVIDENCE_LEVELS` / `evidenceLevel` in
 *  `lib/edit/grant-attribution-board.ts` (SHOW_AT / HIDE_AT); actions:
 *  `components/edit/grant-attribution-board.tsx`; who decides:
 *  `canDecideGrantAttribution`. */
export function GrantAttributionQueueGuide() {
  return (
    <QueueHelpPanel>
      <QueueHelpSection title="Evidence, from the weekly check">
        <QueueTerm term="Supports">
          Enough evidence to show the award (a score of +{SHOW_AT} or more).
        </QueueTerm>
        <QueueTerm term="Leans for">Some evidence for, but not enough to show it.</QueueTerm>
        <QueueTerm term="Mixed">Evidence points both ways.</QueueTerm>
        <QueueTerm term="None found">Nothing found for or against.</QueueTerm>
        <QueueTerm term="Leans against">
          Some evidence against, but not enough to hide it.
        </QueueTerm>
        <QueueTerm term="Against">
          Enough evidence against to hide the award (a score of &minus;{Math.abs(HIDE_AT)} or less).
        </QueueTerm>
      </QueueHelpSection>
      <QueueHelpSection title="What each action does">
        <QueueTerm term="Confirm">
          The award shows on the profile. Profiles and search update within minutes.
        </QueueTerm>
        <QueueTerm term="Not this person">
          The award stays off the profile. A reason is required.
        </QueueTerm>
        <QueueTerm term="Skip">Moves on to the next award without deciding.</QueueTerm>
        <QueueTerm term="Move to review">Sends a decided award back to To review.</QueueTerm>
        <QueueTerm term="Undo">
          The message after a decision offers Undo, which reverses it.
        </QueueTerm>
        <QueueTerm term="Bulk approval">{BULK_NOTE}</QueueTerm>
        <QueueTerm term="Who can decide">
          Administrators and communications stewards. Observers and content editors can view.
        </QueueTerm>
      </QueueHelpSection>
    </QueueHelpPanel>
  );
}

export function GrantAttributionReadOnlyText() {
  return (
    <>
      You can see every decision and its evidence, but you can&rsquo;t change them. Only
      administrators and communications stewards can decide. If you should be able to, ask an
      administrator to check your access.
    </>
  );
}

/** News and Media highlights share the matcher (`etl/news/names.ts`: TAG is
 *  High; prose is scored on position, repeats, headline and a department tag;
 *  caption-only and endowed-title-only are Low; a shared name is capped at
 *  Medium), the review state (`etl/news/index.ts` never resurrects a rejected
 *  row), and the decision route (superuser, comms steward or content editor). */
const NEWS_WHO = "Administrators, communications stewards and content editors. Observers can view.";

export function NewsQueueGuide() {
  return (
    <QueueHelpPanel>
      <QueueHelpSection title="Match strength">
        <QueueTerm term="HIGH">
          The newsroom tagged this scholar on the story, or the text names them prominently: early
          in the story, more than once, in the headline, or with their department tagged.
        </QueueTerm>
        <QueueTerm term="MEDIUM">
          Named with less prominence, or tagged by a middle name or nickname. A name shared by more
          than one scholar is never higher than Medium.
        </QueueTerm>
        <QueueTerm term="LOW">
          Named only in a photo caption, only inside an endowed chair&rsquo;s name, or only in
          passing. The story is often about someone else.
        </QueueTerm>
        <QueueTerm term="Where the name was found">
          The second pill: Newsroom tag, Name in text, Photo caption, or Endowed title only.
        </QueueTerm>
        <QueueTerm term="Same name">
          A name matches more than one scholar. Pick the right person before approving, or choose
          None of these.
        </QueueTerm>
      </QueueHelpSection>
      <QueueHelpSection title="What each action does">
        <QueueTerm term="Approve">The story shows in the scholar&rsquo;s News section.</QueueTerm>
        <QueueTerm term="Hide">
          Approves the match but keeps it off the profile. You can show it later from the Approved
          tab.
        </QueueTerm>
        <QueueTerm term="Reject or None of these">
          Rules out the match. It won&rsquo;t be suggested again.
        </QueueTerm>
        <QueueTerm term="Approve all">Approves every waiting mention on a story at once.</QueueTerm>
        <QueueTerm term="Undo">The bar after a decision offers Undo, which reverses it.</QueueTerm>
        <QueueTerm term="Bulk approval">{BULK_NOTE}</QueueTerm>
        <QueueTerm term="Who can decide">{NEWS_WHO}</QueueTerm>
      </QueueHelpSection>
    </QueueHelpPanel>
  );
}

export function MediaHighlightsQueueGuide() {
  return (
    <QueueHelpPanel>
      <QueueHelpSection title="Match strength">
        <QueueTerm term="High match">
          The clip names the scholar prominently, for example early in the story or more than once.
        </QueueTerm>
        <QueueTerm term="Medium match">
          Named with less prominence. A name shared by more than one scholar is never higher than
          Medium.
        </QueueTerm>
        <QueueTerm term="Low match">
          Named only in a photo caption, only inside an endowed chair&rsquo;s name, or only in
          passing. The clip is often about someone else.
        </QueueTerm>
        <QueueTerm term="via">Where in the clip the name was found.</QueueTerm>
      </QueueHelpSection>
      <QueueHelpSection title="What each action does">
        <QueueTerm term="Approve">
          The clip shows in the profile&rsquo;s Media highlights section.
        </QueueTerm>
        <QueueTerm term="Approve but hide">Confirms the match without showing it.</QueueTerm>
        <QueueTerm term="Reject">Rules out the match. It won&rsquo;t be suggested again.</QueueTerm>
        <QueueTerm term="Undo">The bar after a decision offers Undo, which reverses it.</QueueTerm>
        <QueueTerm term="Bulk approval">{BULK_NOTE}</QueueTerm>
        <QueueTerm term="Who can decide">{NEWS_WHO}</QueueTerm>
      </QueueHelpSection>
    </QueueHelpPanel>
  );
}

export function NewsReadOnlyText({ noun }: { noun: "stories" | "clips" }) {
  return (
    <>
      You can view this queue, but you can&rsquo;t approve or reject {noun}. Only administrators,
      communications stewards and content editors can decide. If you should be able to, ask an
      administrator to check your access.
    </>
  );
}

/** Titles. Who pins: `canPinTitles` in `lib/edit/titles-queue.ts`. */
export function TitlesReadOnlyText() {
  return (
    <>
      You can view this queue, but you can&rsquo;t pin titles. Only administrators and
      communications stewards can. If you should be able to, ask an administrator to check your
      access.
    </>
  );
}
