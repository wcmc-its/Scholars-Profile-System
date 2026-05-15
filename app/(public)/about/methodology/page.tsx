import type { Metadata } from "next";
import { METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";

export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "How algorithmic surfaces work — Scholars at WCM",
  description:
    "Plain-English explanation of how Scholars ranks publications and surfaces faculty work, with formula, eligibility carves, and recency curves.",
  alternates: { canonical: "/about/methodology" },
};

export default function MethodologyPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">
        How algorithmic surfaces work
      </h1>
      <p className="mt-6 text-base text-muted-foreground">
        Scholars at Weill Cornell Medicine uses algorithmic ranking and topic
        assignment to help readers find the work most relevant to a research
        area. This page explains what that ranking does, what it does not
        do, and how to read it.
      </p>

      <section id={METHODOLOGY_ANCHORS.whyAi} className="mt-12">
        <h2 className="text-lg font-semibold">Why we use ReCiterAI at all</h2>
        <p className="mt-3 text-base">
          Weill Cornell publishes thousands of papers a year across hundreds
          of research areas. A static, hand-curated list of &ldquo;featured
          work&rdquo; ages quickly, reflects whoever last edited the page,
          and tends to miss work outside the curator&apos;s own subfield.
          ReCiterAI lets the site keep up with the actual research output of
          the institution &mdash; without asking a person to read every new
          PubMed record.
        </p>
        <p className="mt-3 text-base">
          Concretely, ReCiterAI does three things:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>
            <strong>Attributes publications to WCM scholars.</strong> Author
            name disambiguation against PubMed metadata, ORCID, and WCM HR
            data.
          </li>
          <li>
            <strong>Scores publications</strong> on a research-impact scale
            derived from journal, citation pattern, and authorship signals.
          </li>
          <li>
            <strong>Assigns publications to research areas</strong> so a
            paper can show up in the topic pages it belongs to.
          </li>
        </ul>
        <p className="mt-3 text-base">
          Every surface that uses ReCiterAI shows a small{" "}
          <span aria-hidden>(i)</span> icon next to its heading; click it to
          read what the ranking does on that surface and jump straight to the
          detailed write-up below.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">What this site does not do with AI</h2>
        <p className="mt-3 text-base">
          We are deliberately narrow about where AI shows up. In particular,
          Scholars does <em>not</em>:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>
            Generate or rewrite publication titles, abstracts, author lists,
            journals, or citations. Every bibliographic field comes from
            PubMed.
          </li>
          <li>
            Write biographical claims about scholars. Profile overviews are
            authored or approved by the scholar; ReCiterAI does not
            paraphrase them.
          </li>
          <li>
            Predict who &ldquo;should&rdquo; be considered a top scholar
            beyond their published record. Rankings reflect publication
            activity that already happened.
          </li>
          <li>
            Surface a paper that does not exist in PubMed. If the underlying
            record is wrong, the surface will reflect that &mdash; it will
            not invent a correction.
          </li>
        </ul>
        <p className="mt-3 text-base">
          When a ranking is wrong, the fix is upstream (PubMed metadata,
          author disambiguation, or the scoring model) rather than a
          one-off display patch. That trade-off keeps the system honest at
          the cost of slower response to individual edge cases.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">Where the data comes from</h2>
        <p className="mt-3 text-base">
          ReCiterAI is not a language model running on the page. It is a
          publication-attribution and scoring pipeline that runs on the
          following inputs:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>
            <strong>PubMed</strong> &mdash; the source of truth for
            publication records, authors, journals, and publication types.
          </li>
          <li>
            <strong>ORCID and Scopus</strong> &mdash; supporting signals for
            author disambiguation.
          </li>
          <li>
            <strong>Weill Cornell HR data</strong> &mdash; current
            appointments, departments, divisions, and centers, so we know
            which scholars to attribute publications to and which to display
            on algorithmic surfaces.
          </li>
        </ul>
        <p className="mt-3 text-base">
          Self-edits to a scholar profile (overview text and similar fields)
          are stored separately and write through immediately; they bypass
          the daily ETL cadence described below.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.impact} className="mt-12">
        <h2 className="text-lg font-semibold">What the impact score means</h2>
        <p className="mt-3 text-base">
          The number labelled <strong>Impact</strong> on a publication is an
          integer between 0 and 100, where higher means greater research
          impact. It is the <em>research impact</em> term in the ranking
          formula described below &mdash; the same number that drives the
          &ldquo;By impact (ReCiterAI)&rdquo; sort option on publication
          lists.
        </p>
        <p className="mt-3 text-base">
          To produce it, a large language model reads the publication&apos;s
          title, abstract, journal, year, authorship, citation count, and
          (when available) the NIH iCite percentile, and scores the paper
          against a calibrated rubric. The rubric weighs novelty,
          methodological rigor, evidence of influence or uptake by other
          researchers, translational relevance, citation potential, and
          venue prestige. Scores refresh daily as new publications enter the
          corpus and as citation and iCite signals update.
        </p>
        <p className="mt-3 text-base">
          A few things the impact score is <em>not</em>:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>
            Not a citation count. A 2024 paper with no citations yet can
            score high on rubric criteria; an older paper with many
            citations can score lower if the underlying work is judged
            incremental.
          </li>
          <li>
            Not a journal impact factor. The score is per-paper, not
            per-venue. A high-impact paper in a low-prestige journal will
            score on its own merits.
          </li>
          <li>
            Not a field-normalized percentile. There is no &ldquo;top 10%
            of cardiology&rdquo; calculation; the rubric is applied
            uniformly across fields.
          </li>
        </ul>
        <p className="mt-3 text-base">
          When a search resolves to a specific research area &mdash; for
          example, typing a MeSH term like &ldquo;diabetes&rdquo; that maps
          to a curated topic &mdash; result rows may show a second number
          labelled <strong>Concept</strong>. That value is the
          publication&apos;s strongest score within the searched topic&apos;s
          curated subtopics. Comparing <em>Impact</em> against{" "}
          <em>Concept</em> shows whether a paper is judged more or less
          impactful <em>within the searched topic</em> than across its
          overall record. A paper might score 65 globally but 82 within a
          narrow subfield it helped establish, or 65 globally and 41 within
          a topic it only tangentially touches.
        </p>
        <p className="mt-3 text-base">
          A practical caveat: language-model scoring is not fully
          deterministic. Re-scoring the same paper at a different time can
          produce a score a few points higher or lower without any
          underlying change. Treat the number as a coarse signal, not a
          precise rank &mdash; the gap between a 72 and a 74 is noise; the
          gap between a 45 and a 75 is meaningful.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">How the ranking works at a high level</h2>
        <p className="mt-3 text-base">
          Every surface that ranks publications uses the same multiplicative
          formula:
        </p>
        <p className="mt-3 text-base">
          <code>
            research impact (from ReCiterAI) &times; authorship weight
            &times; publication-type weight &times; recency weight
          </code>
        </p>
        <p className="mt-3 text-base">
          Different surfaces tune the <em>recency</em> curve differently and
          some apply eligibility filters on top &mdash; the specifics are in
          the sections below. Calibration is reviewed against ~20 real WCM
          profiles spanning seniority, and weights are revisited six months
          post-launch.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.recentContributions} className="mt-12">
        <h2 className="text-lg font-semibold">Recent contributions</h2>
        <p className="mt-3 text-base">
          The Recent contributions surface on the home page shows six recent
          first- or senior-author papers by WCM researchers in eligible roles
          (Full-time faculty, Postdocs, Fellows, and Doctoral students), one
          per parent research area. Letters, editorials, and errata are
          excluded entirely (weight 0). Citation counts are not displayed.
        </p>
        <p className="mt-3 text-base">
          The recency curve favors papers 6&ndash;18 months old (peak weight
          1.0), with modest weights for newer (0&ndash;6 months) and older
          (18 months&ndash;3 years) work. Voluntary, Adjunct, Courtesy,
          Instructor, Lecturer, and Emeritus appointees do not appear here
          &mdash; they continue to appear in scholar profiles and search
          results.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.spotlight} className="mt-12">
        {/* Stable redirect anchor for the previous "Selected research" URL. Drop after one release. */}
        <span id={METHODOLOGY_ANCHORS.selectedResearch} aria-hidden className="sr-only" />
        <h2 className="text-lg font-semibold">Spotlight</h2>
        <p className="mt-3 text-base">
          The Spotlight section surfaces a rotating set of subtopics with the
          strongest recent activity at WCM, one per parent area. The score
          for each subtopic sums per-publication scores using the Recent
          highlights recency curve. Refreshes weekly with the ReCiterAI
          cadence.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          ReCiterAI publication scoring extends back to 2020 only. Selected
          highlights on profile pages rank scholars&apos; WCM-attributed work
          scored by ReCiterAI from 2020 onward. Older landmark publications
          are visible in the most-recent-papers feed but not algorithmically
          scored.
        </p>
        <p className="mt-2 text-sm italic text-muted-foreground">
          Within a single profile-page render, papers that appear in Selected
          highlights are filtered out of the most-recent-papers feed to avoid
          showing the same paper twice.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.topScholars} className="mt-12">
        <h2 className="text-lg font-semibold">Top scholars</h2>
        <p className="mt-3 text-base">
          The Top scholars chip row on a topic page shows the seven full-time
          faculty members with the strongest recent publication record in
          that area. Each scholar&apos;s score is the sum of per-publication
          scores for their first-or-senior-author papers in the topic.
          Second, penultimate, and middle authorship contribute 0 &mdash;
          those papers do not count toward the chip-row score.
        </p>
        <p className="mt-3 text-base">
          This surface uses a compressed recency curve distinct from Recent
          highlights:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>0&ndash;3 months: 0.7</li>
          <li>3 months&ndash;3 years: 1.0 (peak)</li>
          <li>3&ndash;6 years: 0.85</li>
          <li>6+ years: 0.7</li>
        </ul>
        <p className="mt-3 text-base">
          The narrowed eligibility (full-time faculty only) and compressed
          curve reflect that this surface highlights principal investigators
          specifically. Postdocs, Fellows, and Doctoral students continue to
          appear on Recent contributions and on individual scholar profiles.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.recentHighlights} className="mt-12">
        <h2 className="text-lg font-semibold">Recent highlights</h2>
        <p className="mt-3 text-base">
          The Recent highlights surface on a topic page shows up to three of
          the most recent research articles in that area where a WCM
          full-time faculty member is the first or senior author and the
          paper&apos;s ReCiterAI impact score is at least 40.
        </p>
        <p className="mt-3 text-base">
          Letters, editorials, errata, and other non-research publication
          types are excluded. Citation counts are not displayed. Cards link
          to the paper on PubMed; author names link to the contributing WCM
          scholar&apos;s profile.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          Papers must fall within the 2020+ ReCiterAI scoring window. Older
          landmark publications are not eligible for this surface.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.selectedHighlights} className="mt-12">
        <h2 className="text-lg font-semibold">Selected highlights on profiles</h2>
        <p className="mt-3 text-base">
          The Selected highlights surface at the top of every scholar profile
          picks the three most-impactful publications from a scholar&apos;s
          first- or senior-author work, scored by the same multiplicative
          formula used elsewhere on the site (research impact &times;
          authorship weight &times; publication-type weight &times; recency
          weight).
        </p>
        <p className="mt-3 text-base">
          Selected highlights and the most-recent-papers feed below them are
          deduplicated within a single profile render: a paper that appears
          as a Selected highlight is removed from the most-recent feed for
          that page view, so the same paper is never shown twice on the same
          profile.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          ReCiterAI scoring covers publications from 2020 onward only. Older
          landmark publications still appear in the most-recent-papers feed
          when they fall in the date window, but they cannot surface as a
          Selected highlight because they sit before the scoring data floor.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          Citation export on profile pages currently supports Vancouver and
          BibTeX. AMA, APA, and RIS are planned for a later phase.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.topResearchAreas} className="mt-12">
        <h2 className="text-lg font-semibold">Top research areas (department, division, center)</h2>
        <p className="mt-3 text-base">
          Department, division, and center pages show a row of &ldquo;Top
          research areas&rdquo; chips. These are aggregated from ReCiterAI
          publication scores: for every scholar attached to the unit, the
          publications they appear on contribute to the score of the topics
          those publications are assigned to. The chips are sorted by total
          publication score within the unit and capped to the strongest few.
        </p>
        <p className="mt-3 text-base">
          The aggregation reflects recent publication activity by the
          unit&apos;s members. It is not editorial &mdash; chairs and center
          directors do not curate the order, and the order can move as new
          work appears or as appointments change.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          A topic appearing here is evidence of recent activity, not a
          declaration of strategic focus. Use the chip to browse the
          underlying papers and scholars; do not read it as the unit&apos;s
          official priority list.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.eligibilityCarves} className="mt-12">
        <h2 className="text-lg font-semibold">Who appears on algorithmic surfaces</h2>
        <p className="mt-3 text-base">
          Recent contributions on the home page and Top scholars on topic
          pages are researcher-attributed surfaces. They show work by
          scholars in active appointments at WCM in these roles:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>Full-time faculty</li>
          <li>Postdoctoral associates and fellows</li>
          <li>Clinical fellows</li>
          <li>Doctoral students with active program enrollment</li>
        </ul>
        <p className="mt-3 text-base">
          Voluntary, Adjunct, Courtesy, Instructor, Lecturer, and Emeritus
          appointees do not appear on these two surfaces. They continue to
          appear in all search results, profile pages, the A&ndash;Z
          Directory on Browse, and department detail pages &mdash; the carve
          only affects the algorithmic surfaces that highlight ongoing
          research activity.
        </p>
        <p className="mt-3 text-base">
          Top scholars on topic pages narrows further to Full-time faculty
          only. It is a principal-investigator surface, intended to surface
          the WCM faculty most actively driving work in a given research
          area.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.exclusions} className="mt-12">
        <h2 className="text-lg font-semibold">Letters, editorials, and errata</h2>
        <p className="mt-3 text-base">
          Letters to the editor, editorials, commentaries, and errata are
          hard-excluded from every algorithmic surface (weight = 0). They
          still appear in the full publications list on a scholar&apos;s
          profile and in publication search, but they cannot surface as
          Recent contributions, Selected highlights, Recent highlights, or
          count toward Top scholars rankings.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          The exclusion is applied at the publication-type level: any record
          tagged as a letter, editorial, comment, news item, or erratum by
          the upstream PubMed metadata is dropped before scoring.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.dataCadence} className="mt-12">
        <h2 className="text-lg font-semibold">Data refresh cadence</h2>
        <p className="mt-3 text-base">
          Source-system data refreshes daily. The ETL chain runs in a fixed
          order &mdash; Employee Directory, ASMS, InfoEd, ReCiter publication
          records, and Conflict-of-Interest disclosures &mdash; with an
          ED-first abort cascade so a downstream failure never replaces good
          data with stale data.
        </p>
        <p className="mt-3 text-base">
          ReCiterAI publication scores and topic assignments refresh weekly.
          The algorithmic surfaces on the home page and topic pages use the
          latest weekly score snapshot; rankings can shift week-over-week as
          new publications enter the corpus and recency weights advance.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          Self-edit overrides on a scholar&apos;s overview write through
          immediately and bypass the daily cadence: the public profile
          reflects the change within seconds of save.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">Known limits and how we mitigate them</h2>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>
            <strong>Co-corresponding authors</strong> are not marked in our
            upstream feed, so a co-corresponding middle-author position
            currently receives weight 0 even though the spec assigns 1.0.
            Tracked for follow-up.
          </li>
          <li>
            <strong>Pre-2020 publications</strong> are not scored by
            ReCiterAI. Older landmark work appears in profile publication
            lists but does not compete on the algorithmic surfaces.
          </li>
          <li>
            <strong>Name disambiguation errors</strong> &mdash; an
            occasional paper may be attributed to the wrong WCM author or
            missed entirely. Scholars can flag these through the contact
            link on their profile; corrections feed back into the
            disambiguation model rather than being patched in display.
          </li>
          <li>
            <strong>Topic assignment</strong> is automatic and can put a
            paper into a research area it only tangentially fits. The
            aggregate-level surfaces (Recent highlights, Top scholars) are
            relatively robust to this; chip rows on department/center pages
            are more sensitive.
          </li>
        </ul>
      </section>

      <section className="mt-16 border-t pt-8">
        <p className="text-sm italic text-muted-foreground">
          Weights and recency curves are reviewed six months post-launch by
          the ReCiter lead and the methodology page owner. Calibration draws
          on actual outputs against ~20 real WCM profiles spanning seniority.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          Note: the profile most-recent-papers feed reuses the
          <code> recent_contributions </code>
          recency curve (6&ndash;18 month sweet spot) because both surfaces
          are recent scholar-attributed views. The Spotlight curve was
          considered and rejected &mdash; the profile recent feed is
          year-grouped and recency-sorted, so emphasizing the 6&ndash;18
          month band matches the surface&apos;s intent.
        </p>
      </section>
    </main>
  );
}
