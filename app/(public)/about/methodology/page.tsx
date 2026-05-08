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
      <h1 className="font-serif text-4xl font-semibold leading-tight">
        How algorithmic surfaces work
      </h1>
      <p className="mt-6 text-base text-muted-foreground">
        Scholars at Weill Cornell Medicine ranks publications using a
        multiplicative formula: research impact (from ReCiterAI) × authorship
        weight × publication type weight × recency weight. Each surface uses a
        different recency curve tuned to its purpose, and some surfaces apply
        additional filters described below.
      </p>

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
          The recency curve favors papers 6–18 months old (peak weight 1.0),
          with modest weights for newer (0–6 months) and older (18 months–3
          years) work. Voluntary, Adjunct, Courtesy, Instructor, Lecturer, and
          Emeritus appointees do not appear here — they continue to appear in
          scholar profiles and search results.
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.spotlight} className="mt-12">
        {/* Stable redirect anchor for the previous "Selected research" URL. Drop after one release. */}
        <span id={METHODOLOGY_ANCHORS.selectedResearch} aria-hidden className="sr-only" />
        <h2 className="text-lg font-semibold">Spotlight</h2>
        <p className="mt-3 text-base">
          The Spotlight section surfaces a rotating set of subtopics with the
          strongest recent activity at WCM, one per parent area. The score for
          each subtopic sums per-publication scores using the Recent highlights
          recency curve. Refreshes weekly with the ReCiterAI cadence.
        </p>
        <p className="mt-3 text-sm italic text-muted-foreground">
          ReCiterAI publication scoring extends back to 2020 only. Selected
          highlights on profile pages rank scholars&apos; WCM-attributed work
          scored by ReCiterAI from 2020 onward. Older landmark publications
          are visible in the most-recent-papers feed but not algorithmically
          scored. Phase 5+ ReCiterAI backfill is out of scope. (D-15)
        </p>
        <p className="mt-2 text-sm italic text-muted-foreground">
          Within a single profile-page render, papers that appear in Selected
          highlights are filtered out of the most-recent-papers feed to avoid
          showing the same paper twice. (D-16)
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.topScholars} className="mt-12">
        <h2 className="text-lg font-semibold">Top scholars</h2>
        <p className="mt-3 text-base">
          The Top scholars chip row on a topic page shows the seven full-time
          faculty members with the strongest recent publication record in that
          area. Each scholar&apos;s score is the sum of per-publication scores
          for their first-or-senior-author papers in the topic. Second,
          penultimate, and middle authorship contribute 0 — these papers do
          not count toward the chip-row score.
        </p>
        <p className="mt-3 text-base">
          This surface uses a compressed recency curve distinct from Recent
          highlights:
        </p>
        <ul className="mt-3 ml-6 list-disc text-base">
          <li>0–3 months: 0.7</li>
          <li>3 months–3 years: 1.0 (peak)</li>
          <li>3–6 years: 0.85</li>
          <li>6+ years: 0.7</li>
        </ul>
        <p className="mt-3 text-base">
          The narrowed eligibility (full-time faculty only) and compressed
          curve reflect that this surface highlights principal investigators
          specifically. Postdocs, Fellows, and Doctoral students continue to
          appear on Recent contributions and on individual scholar profiles.
          (D-14)
        </p>
      </section>

      <section id={METHODOLOGY_ANCHORS.recentHighlights} className="mt-12">
        <h2 className="text-lg font-semibold">Recent highlights</h2>
        <p className="mt-3 text-base">
          The Recent highlights surface on a topic page shows up to three of
          the most recent academic articles in that area where a WCM
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
        <h2 className="text-lg font-semibold">
          A note on authorship weight (co-corresponding author limitation)
        </h2>
        <p className="mt-3 text-base">
          Authorship weight 1.0 applies to first and last (senior) authors
          only. The data feed does not currently mark co-corresponding
          authors, so a co-corresponding middle-author position will appear
          with weight 0 even though the spec assigns 1.0. This is tracked for
          follow-up — the <code>is_corresponding</code> flag is not yet
          projected from the upstream source. (D-09)
        </p>
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
          recency curve (6–18 month sweet spot) because both surfaces are
          recent scholar-attributed views. The Spotlight curve was
          considered and rejected — the profile recent feed is year-grouped
          and recency-sorted, so emphasizing the 6–18 month band matches the
          surface&apos;s intent.
        </p>
      </section>
    </main>
  );
}
