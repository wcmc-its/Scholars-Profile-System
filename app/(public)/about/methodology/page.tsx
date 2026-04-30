import { METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";

export const dynamic = "force-static";
export const revalidate = false;

export const metadata = {
  title: "How algorithmic surfaces work — Scholars at WCM",
  description:
    "Plain-English explanation of how Scholars ranks publications and surfaces faculty work, with formula, eligibility carves, and recency curves.",
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

      <section id={METHODOLOGY_ANCHORS.selectedResearch} className="mt-12">
        <h2 className="text-lg font-semibold">Selected research</h2>
        <p className="mt-3 text-base">
          The Selected research carousel shows eight subtopics with the
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
          The Recent highlights surface on a topic page shows three
          publications with the strongest recent impact in that area. The pool
          is publication-centric: papers are ranked individually without an
          authorship-position filter, so middle-author contributions to
          high-impact work can surface here. Letters, editorials, and errata
          are excluded entirely. Citation counts are not displayed.
        </p>
        <p className="mt-3 text-base">
          The recency curve favors papers 6–18 months old (peak), with smaller
          weights for newer (0–6 months) and older (18 months+) work, capped
          at 0.4 beyond three years.
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
          recent scholar-attributed views. The Selected research curve was
          considered and rejected — the profile recent feed is year-grouped
          and recency-sorted, so emphasizing the 6–18 month band matches the
          surface&apos;s intent.
        </p>
      </section>
    </main>
  );
}
