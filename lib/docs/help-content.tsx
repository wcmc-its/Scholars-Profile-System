import Link from "next/link";

/**
 * Launch-MVP help corpus (#515 / #508 §2).
 *
 * Data-driven, no MDX pipeline and no new dependencies: the eight launch
 * drafts are ported to typed entries here, rendered by the `/about/help`
 * hub and the `/about/help/[slug]` static template. All consuming pages are
 * `force-static` (public, no DB, no auth), so this module must stay free of
 * server-only imports.
 *
 * Body JSX is intentionally semantic (bare <p>/<ul>/<table>, <Link> for
 * internal cross-links). Typographic styling is applied once by the template
 * wrapper, not inline here, so prose and presentation stay decoupled.
 *
 * Post-launch these 301 to `/docs/q/<slug>` (questions) and
 * `/docs/how-to/<slug>` (how-to) when the full v2 docs site lands; the draft
 * `methodology_anchor` frontmatter (dropped here) is already aimed at the
 * future methodology pages.
 */

export type HelpAudience = "visitor" | "faculty";

export type HelpGroupId = "impact" | "publications" | "search" | "data";

export interface HelpEntry {
  /** URL slug, e.g. "what-does-impact-mean". */
  slug: string;
  type: "question" | "how-to";
  /** H1 + <title>. */
  title: string;
  /** <meta name="description">. */
  description: string;
  /** Lead paragraph rendered above the body (questions). */
  shortAnswer?: string;
  /** Hub grouping. */
  group: HelpGroupId;
  audience: HelpAudience[];
  tags: string[];
  /** Slugs -> static "Related" links (unresolved slugs are skipped). */
  related: string[];
  /** Body prose as semantic JSX. */
  body: React.ReactNode;
}

/** Hub section order + labels. */
export const HELP_GROUPS: { id: HelpGroupId; label: string }[] = [
  { id: "impact", label: "Impact" },
  { id: "publications", label: "Publications & profile" },
  { id: "search", label: "Search" },
  { id: "data", label: "Data & corrections" },
];

/** Internal cross-link to another help page. */
function HelpLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return <Link href={`/about/help/${slug}`}>{children}</Link>;
}

export const HELP_ENTRIES: HelpEntry[] = [
  {
    slug: "what-does-impact-mean",
    type: "question",
    title: "What does Impact mean on my profile?",
    description:
      "Impact is a publication-level score (0–100) from ReciterAI, surfaced as 'Impact: NN' on each publication.",
    shortAnswer:
      "Impact is a 0–100 score for each publication, computed by ReciterAI from citations, journal signals, and recency. The same publication has the same Impact for every co-author.",
    group: "impact",
    audience: ["visitor", "faculty"],
    tags: ["impact", "scoring"],
    related: ["why-isnt-my-impact-score-author-relative", "when-does-my-impact-score-update"],
    body: (
      <>
        <p>
          You see <code>Impact: NN</code> (or <code>Impact: &mdash;</code>) on each of your
          publications. That number is the <strong>Impact score</strong> that ReciterAI assigns to
          the publication. It reflects how much citation, journal-level, and recency signal a paper
          has accumulated &mdash; at a publication level, not at an author level.
        </p>
        <p>Two practical consequences:</p>
        <ul>
          <li>
            <strong>It&apos;s a property of the paper, not of you.</strong> Your first-author paper
            and your 12th-author paper get the same Impact number, because the score describes the
            paper. Your role on a paper is conveyed separately by <strong>Author Position</strong>{" "}
            (first, middle, senior), shown next to each publication.
          </li>
          <li>
            <strong>It does not normalise across fields or journals.</strong> A neuroscience Impact
            of 80 and a biostatistics Impact of 60 are not directly comparable &mdash; they are
            absolute scores on one scale, applied to papers with very different baseline citation
            behaviour.
          </li>
        </ul>
        <p>
          A missing score (<code>Impact: &mdash;</code>, an em-dash) is not a quality judgement
          &mdash; it means ReciterAI has not computed a score yet, usually because the publication
          is recent, a preprint, or in a journal its citation sources don&apos;t index.
        </p>
      </>
    ),
  },
  {
    slug: "why-isnt-my-impact-score-author-relative",
    type: "question",
    title: "Why isn't my Impact score author-relative?",
    description: "Impact is a property of the publication, not of your contribution to it.",
    shortAnswer:
      "Impact is a publication-level score. A paper you led and a paper you contributed to as the 12th author show the same Impact number, because the score describes the paper, not your role on it.",
    group: "impact",
    audience: ["faculty"],
    tags: ["impact", "scoring"],
    related: ["what-does-impact-mean", "when-does-my-impact-score-update"],
    body: (
      <>
        <p>
          This is the most common Impact-score question we hear, so it deserves a direct answer: the
          Impact score on your profile describes the publication, not your contribution to it. The
          same publication shows the same Impact value on every co-author&apos;s profile.
        </p>
        <p>
          That can feel wrong if you&apos;ve spent years thinking about citation impact in
          author-attributed terms (h-index, first-author counts, last-author signals). Scholars
          deliberately doesn&apos;t do author-relative scoring at the Impact-score level, for three
          reasons:
        </p>
        <ol>
          <li>
            <strong>Author-relative signals are a different metric.</strong> Your role on a paper is
            conveyed by <strong>Author Position</strong> (first, middle, senior), shown next to each
            publication. The Impact score isn&apos;t trying to replicate Author Position; it&apos;s
            an orthogonal measure of how much attention the <em>paper</em> has received.
          </li>
          <li>
            <strong>Reliable author-relative scoring is hard.</strong> Splitting a paper&apos;s
            citation signal across co-authors requires assumptions about contribution that vary by
            field and by paper. Scholars does not make those assumptions.
          </li>
          <li>
            <strong>Field and journal effects compound.</strong> Even if author-relative scoring
            worked at the paper level, comparing across fields and journals would still require
            normalisation Scholars does not perform.
          </li>
        </ol>
        <p>
          If you want author-attributed signals, look at Author Position, publication count by year,
          and (for senior authors) papers where you&apos;re the last-listed author. Those tell you
          about your role; the Impact score tells you about the paper.
        </p>
      </>
    ),
  },
  {
    slug: "when-does-my-impact-score-update",
    type: "question",
    title: "When does my Impact score update?",
    description:
      "Impact scores refresh on ReciterAI's cadence; updates land in Scholars on the nightly ETL.",
    shortAnswer:
      "ReciterAI recomputes Impact scores on a regular batch cadence, and updates land in Scholars on the next nightly ETL. A brand-new publication usually shows a score within a few weeks of being indexed in PubMed.",
    group: "impact",
    audience: ["faculty"],
    tags: ["impact", "scoring", "getting-started"],
    related: ["why-is-impact-missing", "what-does-impact-mean"],
    body: (
      <>
        <p>Impact-score updates are driven by two steps:</p>
        <ul>
          <li>
            <strong>ReciterAI</strong> recomputes Impact scores on a regular batch cadence and
            publishes the new values.
          </li>
          <li>
            <strong>ReciterDB</strong> lands new and updated scores in Scholars on its{" "}
            <strong>nightly</strong> ETL.
          </li>
        </ul>
        <p>
          So for an existing publication, a score change you&apos;d expect (because, say, a new
          citation just landed) propagates after the next ReciterAI batch, then appears in Scholars
          on the following nightly ETL.
        </p>
        <p>
          For a brand-new publication the timeline is longer, because ReciterAI needs the paper to
          be indexed in PubMed first. A realistic expectation is a few weeks after PubMed shows your
          paper. If it has been longer and your publication still shows <code>&mdash;</code>, see{" "}
          <HelpLink slug="why-is-impact-missing">
            Why is Impact missing on some of my publications?
          </HelpLink>
        </p>
      </>
    ),
  },
  {
    slug: "why-is-impact-missing",
    type: "question",
    title: "Why is Impact missing on some of my publications?",
    description:
      "ReciterAI needs citation, journal, and recency signal; some publications don't have enough yet to score.",
    shortAnswer:
      "Impact is missing (shown as '—') when ReciterAI can't assign a score yet. Common reasons: the publication is recent, it's a preprint, or it's in a journal the citation source doesn't index. A missing score is not a quality judgement.",
    group: "impact",
    audience: ["faculty"],
    tags: ["impact", "scoring"],
    related: ["when-does-my-impact-score-update", "what-does-impact-mean"],
    body: (
      <>
        <p>
          A publication displays <code>Impact: &mdash;</code> (an em-dash, not a zero) when
          ReciterAI has not yet assigned it an Impact score. Three common causes:
        </p>
        <ol>
          <li>
            <strong>The publication is too recent.</strong> Citation signal takes time to
            accumulate. Very new publications typically have too little signal to score reliably.
          </li>
          <li>
            <strong>The publication is a preprint.</strong> Preprints are recorded but not scored
            &mdash; the model is designed for peer-reviewed publication metadata.
          </li>
          <li>
            <strong>The journal isn&apos;t well covered by the citation source.</strong> When
            citation data isn&apos;t available for a publication, ReciterAI may not be able to
            assign a score.
          </li>
        </ol>
        <p>
          A missing score is <strong>not</strong> a quality judgement of the publication &mdash; it
          only means the score hasn&apos;t been computed yet. Most publications eventually receive an
          Impact score on a later ReciterAI run as signal accumulates; some long-tail publications
          (e.g. very old papers in journals with no citation coverage) may never score.
        </p>
        <p>
          If a publication has been on your profile for a while and still shows <code>&mdash;</code>,
          you can flag it via{" "}
          <HelpLink slug="request-a-correction">Request a correction</HelpLink> &mdash; though in
          most cases the answer will be &ldquo;the source data doesn&apos;t have the citation signal
          we need.&rdquo;
        </p>
      </>
    ),
  },
  {
    slug: "why-is-this-publication-on-my-profile",
    type: "question",
    title: "Why is this publication on (or not on) my profile?",
    description:
      "Publications are matched to you automatically by ReCiter, WCM's author-disambiguation engine. You can hide ones that aren't yours.",
    shortAnswer:
      "Publications are matched to you automatically by ReCiter, WCM's author-disambiguation engine, from PubMed records. If one isn't yours, you can hide it from your profile in the editor; if one is missing, it may not have been matched yet.",
    group: "publications",
    audience: ["faculty"],
    tags: ["disambiguation", "editing", "suppression"],
    // Draft listed `how-do-i-hide-a-publication` first; that page isn't in the
    // launch-MVP corpus, so the template drops it and only `request-a-correction`
    // renders. Restore it if that page ships post-launch.
    related: ["how-do-i-hide-a-publication", "request-a-correction"],
    body: (
      <>
        <p>
          The publications on your profile are matched to you <strong>automatically</strong>, not
          entered by hand. <strong>ReCiter</strong> &mdash; WCM&apos;s author-disambiguation engine
          &mdash; reads new records from PubMed and decides which ones are yours, using signals like
          your name variants, your departmental and institutional affiliations, your co-authors, the
          topics (MeSH terms) you publish in, and your citation history. It runs nightly, so newly
          indexed papers appear on your profile over the following days.
        </p>
        <p>Because the matching is automatic, two things can happen:</p>
        <ul>
          <li>
            <strong>A publication is here that isn&apos;t yours.</strong> Disambiguation is highly
            accurate but not perfect &mdash; authors with similar names can be confused. If a
            publication isn&apos;t yours, you can <strong>hide it from your profile</strong> yourself
            in the editor. Hiding is reversible and is recorded, so it can always be undone.
          </li>
          <li>
            <strong>A publication that is yours is missing.</strong> Most often it simply
            hasn&apos;t been matched yet (it&apos;s very recent, or ReCiter wasn&apos;t confident
            enough to attribute it). Missing publications are currently corrected through our
            curation team rather than self-service &mdash; use{" "}
            <HelpLink slug="request-a-correction">Request a correction</HelpLink> and we&apos;ll
            review the attribution.
          </li>
        </ul>
        <p>
          Note this is about <em>authorship attribution</em> &mdash; which papers are yours. It is
          separate from why a paper does or doesn&apos;t appear in <strong>search</strong> (that&apos;s
          about the search index, not your profile).
        </p>
      </>
    ),
  },
  {
    slug: "why-isnt-my-publication-showing-up-in-search",
    type: "question",
    title: "Why isn't my publication showing up in search?",
    description:
      "Most often: not yet indexed, or the query doesn't match the publication's title, abstract, or topics.",
    shortAnswer:
      "Usually one of three things: the search index hasn't rebuilt since the publication was added (it rebuilds nightly), your query terms don't match the publication's title/abstract/topics, or the publication has been hidden. Hiding is rare and deliberate.",
    group: "search",
    audience: ["faculty"],
    tags: ["search", "indexing"],
    related: ["why-is-this-publication-on-my-profile", "request-a-correction"],
    body: (
      <>
        <p>
          If you go to Scholars search and can&apos;t find one of your publications, three causes
          account for the overwhelming majority of cases.
        </p>
        <p>
          <strong>The search index hasn&apos;t yet incorporated the publication.</strong> Scholars
          rebuilds the search index nightly. If your publication was added earlier today, it likely
          won&apos;t appear in search until tomorrow. Wait 24 hours and search again.
        </p>
        <p>
          <strong>Your query terms don&apos;t match the publication&apos;s indexed text.</strong>{" "}
          Search matches the publication&apos;s title, abstract, and MeSH topic tags. If your query
          uses different terminology than the publication does, an exact-text match won&apos;t fire
          &mdash; though on the Publications tab, MeSH expansion may still surface it if your query
          resolves to a known medical descriptor. Try searching by the publication&apos;s title (or
          a distinctive phrase from the abstract) to confirm it&apos;s indexed.
        </p>
        <p>
          <strong>The publication is hidden.</strong> Hiding is rare &mdash; it&apos;s a deliberate
          manual action by you or a superuser, usually because the publication was misattributed. If
          you hid it and want it back, you can restore it in the editor. If you didn&apos;t and
          don&apos;t know who did, see{" "}
          <HelpLink slug="request-a-correction">Request a correction</HelpLink>.
        </p>
        <p>
          Note this is about <strong>search</strong> &mdash; whether a paper appears in results.
          It&apos;s separate from whether a paper is attributed to <strong>your profile</strong> (see{" "}
          <HelpLink slug="why-is-this-publication-on-my-profile">
            Why is this publication on my profile?
          </HelpLink>
          ).
        </p>
      </>
    ),
  },
  {
    slug: "where-does-the-data-come-from",
    type: "question",
    title: "Where does the information on my profile come from?",
    description:
      "Scholars pulls from authoritative WCM, hospital, and external systems and adds computed layers; most fields are systems-of-record you edit at the source, not here.",
    shortAnswer:
      "Scholars doesn't store hand-entered profiles. It pulls from authoritative systems — publications from PubMed, funding from InfoEd, identity and appointments from WCM and NYP systems of record — and adds computed layers (ReCiter, ReciterAI). Most fields are corrected at their source system, not here.",
    group: "data",
    audience: ["visitor", "faculty"],
    tags: ["data-source", "governance", "correction"],
    related: ["request-a-correction", "why-is-this-publication-on-my-profile"],
    body: (
      <>
        <p>
          Your profile is <strong>assembled from authoritative systems</strong>, not typed in. Four
          kinds of data sit behind it.
        </p>
        <p>
          <strong>External sources</strong>
        </p>
        <ul>
          <li>
            <strong>PubMed</strong> (NIH/NLM) &mdash; your publications and their MeSH topic tags.
          </li>
          <li>
            <strong>NIH RePORTER</strong> &mdash; the abstracts of your federally funded grants.
          </li>
          <li>
            <strong>iCite</strong> (NIH) &mdash; citation counts, and the cites/cited-by records
            shown when you open a publication.
          </li>
        </ul>
        <p>
          <strong>WCM and hospital systems of record</strong>
        </p>
        <ul>
          <li>
            <strong>InfoEd</strong> &mdash; your funding from all sponsors.
          </li>
          <li>
            <strong>Enterprise Directory</strong> &mdash; your CWID, name, department, institutional
            affiliation, and postdoc-mentee relationships (via HR).
          </li>
          <li>
            <strong>Jenzabar</strong> &mdash; your Graduate School appointments and your student
            mentor/mentee relationships.
          </li>
          <li>
            <strong>NYP IdentityIQ</strong> &mdash; your NewYork-Presbyterian hospital position.
          </li>
          <li>
            <strong>Conflicts-of-Interest system</strong> &mdash; your disclosures.
          </li>
        </ul>
        <p>
          <strong>Computed by WCM</strong> from the sources above
        </p>
        <ul>
          <li>
            <strong>ReCiter</strong> decides which publications are yours (author disambiguation).
          </li>
          <li>
            <strong>ReciterAI</strong> derives the topics, Impact scores, and synopses on your
            publications.
          </li>
        </ul>
        <p>
          <strong>Maintained in Scholars itself</strong>
        </p>
        <ul>
          <li>
            <strong>Center membership</strong> is curated in this application &mdash; it&apos;s the
            one set of affiliations whose system of record is Scholars.
          </li>
        </ul>
        <p>
          Because most fields originate elsewhere, you don&apos;t edit them in Scholars &mdash; the
          editor names each field&apos;s source and points you to the right place to request a change
          (and the change flows back on the next refresh). What you manage directly here is your
          overview text and which publications appear on your profile.
        </p>
      </>
    ),
  },
  {
    slug: "request-a-correction",
    type: "how-to",
    title: "Request a correction",
    description:
      "How to fix something wrong on a Scholars profile — most fields are corrected at their source system, not in Scholars.",
    group: "data",
    audience: ["visitor", "faculty"],
    tags: ["correction", "governance", "data-source"],
    related: ["where-does-the-data-come-from", "why-is-this-publication-on-my-profile"],
    body: (
      <>
        <h2>Goal</h2>
        <p>
          Fix something that&apos;s wrong on a profile. Because Scholars assembles profiles from
          authoritative systems (see{" "}
          <HelpLink slug="where-does-the-data-come-from">
            Where does the information on my profile come from?
          </HelpLink>
          ), <strong>most corrections happen at the source system, not in Scholars.</strong> Find
          your situation below.
        </p>

        <h2>Find your situation</h2>
        <table>
          <thead>
            <tr>
              <th>What&apos;s wrong</th>
              <th>Where it&apos;s fixed</th>
              <th>How</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                A publication that <strong>isn&apos;t yours</strong> is on your profile
              </td>
              <td>Scholars</td>
              <td>Hide it yourself in the editor (reversible, recorded).</td>
            </tr>
            <tr>
              <td>
                A publication <strong>that is yours is missing</strong>
              </td>
              <td>Scholars (curation)</td>
              <td>Request review &mdash; our curation team checks the attribution.</td>
            </tr>
            <tr>
              <td>
                A wrong field <strong>on a publication</strong> (title, author order, DOI)
              </td>
              <td>PubMed (NIH/NLM)</td>
              <td>
                Publication metadata comes from PubMed; corrections flow from the publisher/NLM.
              </td>
            </tr>
            <tr>
              <td>
                Your <strong>name, department, or institutional affiliation</strong>
              </td>
              <td>Enterprise Directory</td>
              <td>Corrected in WCM&apos;s directory/HR systems; flows back on the next refresh.</td>
            </tr>
            <tr>
              <td>
                Your <strong>Graduate School appointment</strong> or{" "}
                <strong>student mentor/mentee</strong>
              </td>
              <td>Jenzabar</td>
              <td>Corrected at the Graduate School.</td>
            </tr>
            <tr>
              <td>
                Your <strong>hospital position</strong>
              </td>
              <td>NYP IdentityIQ</td>
              <td>Corrected in the NewYork-Presbyterian system.</td>
            </tr>
            <tr>
              <td>
                Your <strong>funding / grants</strong>
              </td>
              <td>InfoEd (federal abstracts: NIH RePORTER)</td>
              <td>Corrected in the funding system of record.</td>
            </tr>
            <tr>
              <td>
                A <strong>disclosure</strong>
              </td>
              <td>Conflicts-of-Interest system</td>
              <td>Corrected in WCM&apos;s COI system.</td>
            </tr>
            <tr>
              <td>
                A wrong <strong>topic, Impact score, or synopsis</strong>
              </td>
              <td>ReciterAI (computed)</td>
              <td>
                These are generated by a model and can&apos;t be hand-edited; report it as a
                systematic error.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Center membership</strong>
              </td>
              <td>Scholars</td>
              <td>Maintained in this application &mdash; contact the Scholars team.</td>
            </tr>
          </tbody>
        </table>

        <h2>What you can do yourself, right now</h2>
        <p>
          Two things don&apos;t need a request &mdash; you manage them directly in the editor: your{" "}
          <strong>overview text</strong>, and <strong>which of your publications appear</strong> on
          your profile (hide/restore).
        </p>

        <h2>What happens to everything else</h2>
        <p>
          For source-of-record fields, the fix happens in the upstream system and appears in Scholars
          after the next data refresh &mdash; Scholars displays a copy, so it can&apos;t override the
          source.
        </p>
        <p>
          A guided correction form for routing these requests is coming. Until then, the table above
          shows where each field is maintained.
        </p>
      </>
    ),
  },
];

export function getHelpEntry(slug: string): HelpEntry | undefined {
  return HELP_ENTRIES.find((e) => e.slug === slug);
}
