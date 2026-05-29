import type { Metadata } from "next";
import Link from "next/link";
import { DOCS_PROSE_CLASS } from "@/lib/docs/prose";

/**
 * /docs/data/sources — the provenance "keystone" page. Per-section source ->
 * refresh -> how-to-fix map for an assembled-profile system. Content drafted in
 * `.planning/drafts/docs-mvp/data-sources-provenance.mdx`; rendered here as
 * typed JSX for the v0 (pre-MDX) substrate.
 *
 * Two cells are gated on open decisions (flagged in the draft): the correction
 * destination (OQ-5, ties to #519/#520 ServiceNow) and the office that fixes
 * Education/ASMS (OQ-6). Copy here uses the cautious "Request a change" routing
 * until those are set.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Where your profile data comes from — Scholars docs",
  description:
    "Scholars assembles each profile from authoritative WCM, hospital, and external systems. This page maps every part of your profile to its source system and how to correct it.",
  alternates: { canonical: "/docs/data/sources" },
};

const LINK = "text-[var(--color-accent-slate)] underline underline-offset-4 hover:no-underline";

export default function DataSourcesPage() {
  return (
    <main className="mx-auto max-w-[820px] px-6 py-10">
      <h1 className="page-title text-4xl font-semibold leading-tight">
        Where the information on your profile comes from
      </h1>
      <p className="mt-6 text-base text-muted-foreground">
        Your Scholars profile is <strong>assembled from authoritative systems &mdash; it is not
        typed in by hand.</strong> Scholars reads from WCM, hospital, and external systems of
        record, adds a few computed layers, and displays the result. Because each field originates
        somewhere specific, <strong>most corrections happen at the source system, not in
        Scholars</strong> &mdash; and once corrected there, the change flows back on the next
        refresh.
      </p>

      <div className={DOCS_PROSE_CLASS}>
        <h2>The four kinds of data behind your profile</h2>
        <ul>
          <li>
            <strong>External sources</strong> &mdash; PubMed, NIH RePORTER, and iCite (all NIH/NLM).
          </li>
          <li>
            <strong>WCM &amp; hospital systems of record</strong> &mdash; Enterprise Directory,
            ASMS, InfoEd, Jenzabar, NYP IdentityIQ, and the Conflicts-of-Interest system.
          </li>
          <li>
            <strong>Computed by WCM</strong> &mdash; ReCiter (which publications are yours) and
            ReciterAI (topics, Impact scores, synopses).
          </li>
          <li>
            <strong>Maintained in Scholars itself</strong> &mdash; center/institute membership is
            the one set of fields whose system of record <em>is</em> this application.
          </li>
        </ul>

        <h2>Where each part of your profile comes from</h2>
        <table>
          <thead>
            <tr>
              <th>What&apos;s on your profile</th>
              <th>Where it comes from</th>
              <th>Refresh</th>
              <th>How to correct it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Name, CWID, primary department, institutional affiliation</td>
              <td>Enterprise Directory (WCM HR/IT)</td>
              <td>nightly</td>
              <td>Corrected in WCM&apos;s directory/HR systems; flows back on the next refresh.</td>
            </tr>
            <tr>
              <td>Titles &amp; appointments</td>
              <td>Enterprise Directory</td>
              <td>nightly</td>
              <td>Corrected in WCM HR.</td>
            </tr>
            <tr>
              <td>Education &amp; training (degrees)</td>
              <td>ASMS (WCM academic system)</td>
              <td>nightly</td>
              <td>Corrected at the academic system of record; use Request a change until the office is confirmed.</td>
            </tr>
            <tr>
              <td>Graduate School appointment; PhD program &amp; status</td>
              <td>Jenzabar (Graduate School)</td>
              <td>scheduled</td>
              <td>Corrected at the Graduate School.</td>
            </tr>
            <tr>
              <td>PhD mentor / advisee (thesis advisor)</td>
              <td>Jenzabar</td>
              <td>scheduled</td>
              <td>Corrected at the Graduate School.</td>
            </tr>
            <tr>
              <td>Postdoc mentee relationship</td>
              <td>Enterprise Directory (HR role records)</td>
              <td>nightly</td>
              <td>Corrected in WCM HR.</td>
            </tr>
            <tr>
              <td>Hospital position</td>
              <td>NYP IdentityIQ (NewYork-Presbyterian)</td>
              <td>nightly</td>
              <td>Corrected in the NYP system.</td>
            </tr>
            <tr>
              <td>Funding / grants (all sponsors)</td>
              <td>InfoEd</td>
              <td>nightly</td>
              <td>Corrected in InfoEd, the funding system of record.</td>
            </tr>
            <tr>
              <td>Federal-grant abstracts; NIH portfolio link</td>
              <td>NIH RePORTER</td>
              <td>nightly/weekly</td>
              <td>Data corrected at NIH RePORTER.</td>
            </tr>
            <tr>
              <td>Which publications are attributed to you</td>
              <td>ReCiter (computed, from PubMed)</td>
              <td>weekly</td>
              <td>
                Hide a misattributed one yourself in the editor (reversible, recorded). A{" "}
                <em>missing</em> publication is reviewed by our curation team &mdash; use Request a
                change.
              </td>
            </tr>
            <tr>
              <td>Publication details (title, authors, DOI, MeSH tags)</td>
              <td>PubMed (NIH/NLM)</td>
              <td>&mdash;</td>
              <td>Metadata corrections flow from the publisher/NLM.</td>
            </tr>
            <tr>
              <td>Citation counts; cites / cited-by</td>
              <td>iCite (NIH)</td>
              <td>per ETL</td>
              <td>Corrections flow from iCite. (Scholars does not use Scopus.)</td>
            </tr>
            <tr>
              <td>Topics &amp; subtopics, Impact score, synopsis</td>
              <td>ReciterAI (computed)</td>
              <td>weekly / annual</td>
              <td>Model-generated &mdash; can&apos;t be hand-edited. Report a systematic error via Request a change.</td>
            </tr>
            <tr>
              <td>Conflict-of-interest disclosures</td>
              <td>WCM Conflicts-of-Interest system</td>
              <td>nightly</td>
              <td>Corrected in WCM&apos;s COI system.</td>
            </tr>
            <tr>
              <td>Center / institute membership</td>
              <td>
                <strong>Scholars (this application)</strong>
              </td>
              <td>on edit</td>
              <td>Maintained here &mdash; contact the Scholars team or your unit&apos;s owner/curator.</td>
            </tr>
          </tbody>
        </table>

        <p>
          Scholars displays a <em>copy</em> of every source-of-record field, so it can&apos;t
          override the source. A correction made upstream appears here after the next data refresh
          &mdash; not instantly.
        </p>

        <h2>What you manage yourself</h2>
        <p>Two things don&apos;t need a request &mdash; you control them directly in the editor:</p>
        <ul>
          <li>
            <strong>Your overview text</strong> &mdash; the narrative bio at the top of your
            profile.
          </li>
          <li>
            <strong>Which of your publications appear</strong> &mdash; hide a misattributed paper,
            or restore one you previously hid (reversible, recorded).
          </li>
        </ul>
        <p>
          You can also <strong>request a personalized profile URL</strong> (a vanity slug); a
          Scholars administrator reviews and approves it.
        </p>

        <h2>A note on the computed layers</h2>
        <ul>
          <li>
            <strong>ReCiter</strong> decides which publications are yours (author disambiguation
            from PubMed). It&apos;s highly accurate but not perfect &mdash; common names, or papers
            written at other institutions, are the usual sources of error. See{" "}
            <Link href="/docs/q/why-is-this-publication-on-my-profile">
              Why is this publication on (or not on) my profile?
            </Link>
          </li>
          <li>
            <strong>ReciterAI</strong> derives the topics, the <strong>Impact score</strong> (a
            property of the <em>publication</em>, not of your role on it), and the one-line
            synopsis. See{" "}
            <Link href="/docs/q/what-does-impact-mean">What does Impact mean?</Link>
          </li>
        </ul>
      </div>

      <p className="mt-10 text-base">
        Still stuck?{" "}
        <Link href="/docs/q/request-a-correction" className={LINK}>
          Request a correction &#x2192;
        </Link>
      </p>
    </main>
  );
}
