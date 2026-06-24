import type { Metadata } from "next";
import Link from "next/link";
import { DocsMobileNav, DocsToc, type NavGroup } from "@/components/docs/docs-toc";

/**
 * /docs (v0): single comprehensive documentation page, stakeholder-first +
 * shared reference, ported from the approved `scholars-documentation4.html`
 * mockup. Force-static, rendered inside the shared public header/footer; the
 * DocsToc sidebar is the only client piece (scroll-spy). The hybrid SPEC's
 * multi-page split (per-question URLs, per-methodology pages) is the
 * post-launch build; the old sub-routes 301 into the anchors here.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "About — Scholars at WCM",
  description:
    "How your Scholars profile is built, how to read it, and how to change the things that are yours to change: provenance, corrections, the Impact score, research areas, search, and the showcase surfaces.",
  alternates: { canonical: "/about" },
};

const NAV: NavGroup[] = [
  {
    group: "Start",
    items: [
      { id: "start", label: "The one thing first" },
      { id: "who", label: "Which of these are you?" },
    ],
  },
  {
    group: "Stakeholders",
    items: [
      { id: "scholar", label: "Scholar (faculty)" },
      { id: "postdoc", label: "Postdoc or fellow" },
      { id: "dept-admin", label: "Dept / division admin" },
      { id: "center-admin", label: "Center administrator" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "provenance", label: "Where your data comes from" },
      { id: "correct", label: "How to correct something" },
      { id: "control", label: "What you control" },
      { id: "roles", label: "Roles & who can edit" },
      { id: "research-areas", label: "Research areas" },
      { id: "methods", label: "Methods & tools" },
      { id: "impact", label: "The Impact score" },
      { id: "search", label: "Search" },
      { id: "showcase", label: "Spotlight & Selected research" },
      { id: "profile-url", label: "Your profile URL" },
      { id: "requests", label: "Requesting changes" },
    ],
  },
  { group: "", items: [{ id: "glossary", label: "Glossary" }] },
];

const LINK = "text-[#7d1c1c] underline underline-offset-4 hover:no-underline";
const PM = "https://reciter.weill.cornell.edu";
const WEB_DIR = "https://directory.weill.cornell.edu";

function Callout({
  variant = "note",
  heading,
  children,
}: {
  variant?: "note" | "key" | "warn";
  heading: string;
  children: React.ReactNode;
}) {
  const box =
    variant === "key"
      ? "border-[#d3d8de] bg-[#f6f7f9]"
      : variant === "warn"
        ? "border-[#eedcb6] bg-[#fdf6ec]"
        : "border-[#c9d8ee] bg-[#f3f6fb]";
  const head = variant === "warn" ? "text-[#8a5a00]" : "text-[#7d1c1c]";
  return (
    <div className={`mt-5 max-w-[820px] rounded-[10px] border p-4 ${box}`}>
      <div className={`mb-1 text-[13px] font-bold uppercase tracking-wide ${head}`}>{heading}</div>
      {children}
    </div>
  );
}

const MAIN_CLASS = [
  "min-w-0 pb-24 pt-8",
  // Hybrid width: cap running prose to a comfortable reading measure (~820px)
  // while the data-table wrappers below stay uncapped and fill the wider
  // content column. Headings/lists/callouts/cards are capped directly; the
  // `overflow-x-auto` table wrappers are intentionally not.
  "[&_h1]:max-w-[820px] [&_h2]:max-w-[820px] [&_h3]:max-w-[820px] [&_p]:max-w-[820px] [&_ul]:max-w-[820px] [&_ol]:max-w-[820px] [&_dl]:max-w-[820px]",
  "[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:ml-5 [&_ul]:list-disc [&_li]:mt-1 [&_ol]:mt-3 [&_ol]:ml-5 [&_ol]:list-decimal",
  // Anchor offset: below lg a sticky "On this page" bar (DocsMobileNav) sits
  // under the 60px header, so headings need extra scroll-margin to clear it;
  // at lg the bar is gone and the original 80px (matching the sidebar's
  // lg:top-20) applies.
  "[&_h2]:mt-14 [&_h2]:scroll-mt-28 lg:[&_h2]:scroll-mt-20 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-7 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[15px]",
  "[&_th]:border-b-2 [&_th]:border-[#d3d8de] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:align-top [&_th]:text-xs [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground",
  "[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  // Emphasize each row's subject (the first column reads as a row label).
  "[&_tbody_td:first-child]:font-medium [&_tbody_td:first-child]:text-foreground",
].join(" ");

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-6 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-12">
      <DocsMobileNav nav={NAV} />
      <DocsToc nav={NAV} />

      <main className={MAIN_CLASS}>
        <p className="text-xs font-bold uppercase tracking-widest text-[#7d1c1c]">About</p>
        <h1
          id="start"
          className="mt-1 scroll-mt-28 font-serif text-4xl font-semibold leading-tight tracking-tight lg:scroll-mt-20"
        >
          Scholars at Weill Cornell Medicine
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          How your profile is built, how to read it, and how to change the things that are yours to
          change.
        </p>

        <Callout variant="key" heading="The one thing to understand first">
          <p>
            Scholars does not store a profile you fill out. It assembles your profile from systems
            that already hold your information, and shows a copy. That single fact answers most
            questions:
          </p>
          <ul>
            <li>
              <em>Where your data comes from</em>: authoritative source systems (PubMed, the WCM Web
              Directory, the Enterprise Directory, ASMS, InfoEd, NIH RePORTER, NYP, the Graduate
              School, and the COI system) plus two in-house layers: ReCiter, which decides which publications are yours, and
              ReciterAI, which derives research areas, the Impact score, and synopses.
            </li>
            <li>
              <em>How you correct it</em>: almost always at the source, not in Scholars.
              Fixing the copy would not hold; the next refresh overwrites it. Your self-edit
              interface is where you submit those corrections, and it routes each one to the office
              that owns the field.
            </li>
            <li>
              <em>What you control here</em> is a small, deliberate set: your overview text and
              which of your publications are shown.
            </li>
          </ul>
        </Callout>

        <p>
          Scholars replaces VIVO, WCM&apos;s previous research-profile site. Like VIVO, it is mostly
          read-only: it assembles your profile from systems that already hold your information rather
          than asking you to fill one out, and it is not a submission system. You do not enter
          publications, and there is no &ldquo;claim your profile&rdquo; step; profiles are built
          automatically. Two names recur and are easy to confuse: <em>ReCiter</em> decides which
          publications are yours (author disambiguation), while <em>ReciterAI</em> derives what a
          publication is about and how notable it is (research areas, the Impact score, the one-line
          synopsis). Different systems, different jobs.
        </p>

        <p>
          <strong>Where Scholars goes beyond VIVO.</strong> Two things changed. First, you have
          more control over your own profile. Publication attribution through{" "}
          <a href={PM} className={LINK}>
            ReCiter Publication Manager
          </a>{" "}
          &mdash; confirming the papers that are yours and rejecting the ones that aren&apos;t
          &mdash; carried over from the VIVO era and works as it did before; what&apos;s new with
          Scholars is profile-level self-service: you write your own overview, hide or restore
          individual papers, choose which of your papers appear as Selected highlights, and can
          request a name-based custom web address. Second, there are more ways for your work and
          expertise to surface: representative papers in the home Spotlight, the research areas you
          publish in, the specific methods and tools your published work draws on, and expert
          listings that place you among the most active faculty in an area.
        </p>

        {/* Top-level section directly under the page h1, semantically an h2
            (clears the heading-order skip). Pinned to the smaller 18px/spacing
            of the page's h3 scale so the visual teaser hierarchy is unchanged;
            MAIN_CLASS sizes bare `h2` via a `[&_h2]` descendant variant whose
            class+element specificity beats plain utilities, hence the `!`. */}
        <h2 className="!mt-7 !text-lg !font-semibold !tracking-normal">
          Common questions
        </h2>
        <div className="mt-3 max-w-[820px] overflow-hidden rounded-[10px] border border-border bg-[#fafbfc]">
          {[
            {
              href: "#scholar",
              q: "Why is this paper on (or missing from) my profile?",
              a: "ReCiter matched it, or has not yet. You can hide a wrong match as a near-term fix; the proper fix is to reject it in Publication Manager.",
            },
            {
              href: "#provenance",
              q: "Where does the information on my profile come from?",
              a: "From authoritative source systems plus the ReCiter and ReciterAI computed layers. Most fields are corrected at the source.",
            },
            {
              href: "#showcase",
              q: "Why isn’t my best paper a “Selected highlight”?",
              a: "Those surfaces are chosen by a model, not by you, and filtered by author position, recency, and publication type.",
            },
            {
              href: "#search",
              q: "Why isn’t my publication showing up in search?",
              a: "Usually the index has not rebuilt yet, your terms do not match, or the paper is hidden. Search is separate from your profile.",
            },
            {
              href: "#center-admin",
              q: "How do I add or remove a member of my center?",
              a: "A center Owner or Curator edits the roster in-app; center membership is the only shared institutional field Scholars itself owns.",
            },
            {
              href: "#profile-url",
              q: "Can I change my profile’s web address?",
              a: "A custom address can be arranged through the Scholars team; your existing address keeps working and redirects to the new one.",
            },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-[#f6f7f9]"
            >
              <span className="font-medium text-[#7d1c1c]">{item.q}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">{item.a}</span>
            </Link>
          ))}
        </div>

        <hr className="mt-12 border-border" />
        <p className="mt-8 text-xs font-bold uppercase tracking-widest text-[#7d1c1c]">
          Part 1: by stakeholder
        </p>
        <h2 id="who">Which of these are you?</h2>
        <p>
          Jump to your section. Each is short and links into the shared reference below for the
          mechanics.
        </p>
        <div className="mt-5 grid max-w-[820px] gap-3.5 sm:grid-cols-2">
          {[
            { href: "#scholar", t: "A scholar (faculty)", d: "You have a profile and want it to be right." },
            { href: "#postdoc", t: "A postdoc or fellow", d: "An academic appointee who can appear as a scholar." },
            { href: "#dept-admin", t: "A department / division administrator", d: "You report on a unit’s output and field its faculty’s questions." },
            { href: "#center-admin", t: "A center administrator", d: "You manage a center — the only shared institutional data Scholars itself owns." },
          ].map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="rounded-[10px] border border-border p-4 no-underline hover:border-[#7d1c1c]"
            >
              <span className="block font-bold text-[#7d1c1c]">{c.t}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{c.d}</span>
            </Link>
          ))}
        </div>

        <h2 id="scholar">Scholar (faculty)</h2>
        <p>
          Your profile is assembled for you automatically. Your name comes from the WCM Web
          Directory; your title from the Enterprise Directory (ED), usually following your primary
          ASMS appointment, though a &ldquo;working title&rdquo; set in ED can override it; and your
          primary department from ASMS, the system of record for your primary appointment. Your
          publications are matched to you by ReCiter from PubMed. Your funding comes from InfoEd, WCM&apos;s grants system of record for all
          sponsors; for federally funded work, NIH RePORTER supplies the abstract text and the
          NIH-portfolio link. Disclosures come from the COI system, and a NewYork-Presbyterian
          position from NYP. Your research areas, the Impact numbers, and the synopses are computed by
          ReciterAI.
        </p>
        <p>
          <strong>What you can change yourself</strong>, in your self-edit interface at{" "}
          <code>/edit/scholar/[your CWID]</code>: your overview text; which publications appear
          (hide one that isn&apos;t yours, or restore one you hid, reversible and recorded);
          and a data correction for anything else (Request a change, routed to the office that owns
          the field). Your profile also has a stable web address you don&apos;t normally need to
          touch; a custom one can be arranged through the Scholars team (see{" "}
          <Link href="#profile-url" className={LINK}>
            Your profile URL
          </Link>
          ).
        </p>
        <p>
          <strong>What you cannot change directly</strong>: source-of-record fields. For a{" "}
          <em>misattributed publication</em>, hide it as a quick near-term fix, then reject it in{" "}
          <a href={PM} className={LINK}>
            ReCiter Publication Manager
          </a>{" "}
          to correct the attribution at the source so it does not come back; a <em>missing</em>{" "}
          publication is added there too, by you or the library curation team, whoever gets
          to it first. Your name, department, title, funding, disclosures, and
          appointments are corrected at their source. Use Request a change in your self-edit
          interface, and it routes to the right office. Research areas, Impact, and synopsis are computed by
          ReciterAI and cannot be hand-edited. The full map is in{" "}
          <Link href="#provenance" className={LINK}>
            Where your data comes from
          </Link>{" "}
          and{" "}
          <Link href="#correct" className={LINK}>
            How to correct something
          </Link>
          .
        </p>

        <h2 id="postdoc">Postdoc or fellow</h2>
        <p>
          Postdocs and fellows are <em>academic appointees</em>. Your appointment is an academic
          appointment, so your role and appointment data come through the Enterprise Directory as an
          academic-appointee person-type, not from the Graduate School. That is the main
          thing that distinguishes you from a student here.
        </p>
        <p>
          You can appear as a scholar, and your publications appear through attribution. One rule
          worth knowing: the scoring scope is full-time WCM faculty only (see{" "}
          <Link href="#impact" className={LINK}>
            the Impact score
          </Link>
          ). A paper you co-authored with a full-time WCM faculty member is scored and appears with
          its Impact; a paper with no full-time WCM faculty author is outside the scope and is not
          scored. That is scope, a deliberate cost-and-scale choice, not a quality judgment (see{" "}
          <Link href="#impact" className={LINK}>
            why the scope stops there
          </Link>
          ).
        </p>
        <p>
          To correct your academic appointment, use Request a change in your self-edit interface.
          Academic appointments are owned by the Office of Faculty Affairs (not HR); the request is
          routed to ITS support, who fix a data-sync (ETL) issue in the pipeline or escalate a
          genuine source-record correction to Faculty Affairs. Either way it flows back through
          Enterprise Directory on the next refresh. Your self-serve controls (overview,
          hide/restore, submit a correction) are the same as a faculty member&apos;s.
        </p>

        <h2 id="dept-admin">Department or division administrator</h2>
        <p>
          You mostly read and report, but if you hold a curation role on a unit, you also
          have a real in-app editor (see{" "}
          <Link href="#roles" className={LINK}>
            Roles
          </Link>
          ).
        </p>
        <p>
          Anyone can browse a unit&apos;s output (its faculty, research areas, and publications) on the
          department and division surfaces. An Owner or Curator of a unit can edit
          unit-level data in-app at <code>/edit/department/[code]</code> or{" "}
          <code>/edit/division/[code]</code>: unit metadata (leadership, slug, browse category) and
          the roster of a manually-created division. LDAP-sourced division membership stays with ED
          and is not editable here. A Superuser can do all of this across every unit and grant
          roles.
        </p>
        <p>
          No role lets you move someone between departments or edit a faculty member&apos;s personal
          profile. Primary department is derived from a person&apos;s primary appointment (Faculty
          Affairs, by way of ASMS and Enterprise Directory) and isn&apos;t directly editable; it
          changes only when the appointment does. The two personal controls (overview, publication
          visibility) belong to the scholar.
          For recurring reports by research area, date, or funding, ask the Scholars team through{" "}
          <Link href="#requests" className={LINK}>
            Request a change
          </Link>
          .
        </p>
        <p>
          Set expectations with your faculty: Impact is publication-level, not a ranking of your
          people (
          <Link href="#impact" className={LINK}>
            the Impact score
          </Link>
          ); research areas are model-derived (
          <Link href="#research-areas" className={LINK}>
            Research areas
          </Link>
          ); and the showcase surfaces are algorithmic (
          <Link href="#showcase" className={LINK}>
            Spotlight
          </Link>
          ).
        </p>

        <h2 id="center-admin">Center administrator</h2>
        <p>
          You are the one stakeholder with a Scholars-native data responsibility.{" "}
          <strong>
            Center membership is the only <em>institutional</em> field whose system of record is
            Scholars itself
          </strong>{" "}
          &mdash; your overview, publication-visibility choices, and Selected highlights are stored
          here too, but those are an individual&apos;s own profile rather than shared data about the
          institution. Center rosters are not held anywhere upstream, so they are maintained in this application,
          and they are self-serve for the right roles.
        </p>
        <p>
          A center Owner or Curator manages the roster at <code>/edit/center/[code]</code>: add,
          remove, or update a member, with membership type, program, and start/end dates. Every
          change is one transaction and is audit-logged. If you do not have a role yet, a Superuser
          grants you one (an Owner can also grant Curators on their own center), or request access
          through{" "}
          <Link href="#requests" className={LINK}>
            Request a change
          </Link>
          .
        </p>
        <p>
          Everything else about your center&apos;s people (names, titles, departments, publications,
          funding, research areas, scores) comes from the same sources and follows the same correction paths
          as any scholar. You route those; you do not own them.
        </p>

        <hr className="mt-12 border-border" />
        <p className="mt-8 text-xs font-bold uppercase tracking-widest text-[#7d1c1c]">
          Part 2: shared reference
        </p>

        <h2 id="provenance">Where your data comes from</h2>
        <p>
          Every part of a profile traces to a system of record. Scholars shows a copy and cannot
          override the source; corrections made upstream appear here after the next refresh.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[640px]">
            <thead>
              <tr>
                <th>What you see</th>
                <th>System of record</th>
                <th>Refresh</th>
                <th>How it&apos;s corrected</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Name (preferred name)</td>
                <td>WCM Web Directory</td>
                <td>Nightly</td>
                <td>
                  Update the Preferred Name field yourself in the{" "}
                  <a href={WEB_DIR} className={LINK}>
                    Web Directory
                  </a>
                </td>
              </tr>
              <tr>
                <td>Headshot</td>
                <td>WCM Web Directory</td>
                <td>Nightly</td>
                <td>
                  Add, update, or remove it yourself in the{" "}
                  <a href={WEB_DIR} className={LINK}>
                    Web Directory
                  </a>{" "}
                  (Profile Picture)
                </td>
              </tr>
              <tr>
                <td>Primary department</td>
                <td>ASMS (your primary appointment)</td>
                <td>Nightly</td>
                <td>Inferred from your primary appointment, not directly changeable</td>
              </tr>
              <tr>
                <td>Title</td>
                <td>Enterprise Directory (usually from your ASMS appointment)</td>
                <td>Nightly</td>
                <td>
                  Usually follows your primary appointment; a department admin can set a
                  &ldquo;working title&rdquo; override in the Enterprise Directory, which then takes
                  precedence
                </td>
              </tr>
              <tr>
                <td>Affiliation</td>
                <td>ASMS (your primary affiliation)</td>
                <td>Nightly</td>
                <td>Changed only by the Office of Faculty Affairs</td>
              </tr>
              <tr>
                <td>Person type (full-time faculty, postdoc, etc.)</td>
                <td>Enterprise Directory (imported from Faculty Affairs)</td>
                <td>Nightly</td>
                <td>Request a change (routed to ITS support; owned by Faculty Affairs)</td>
              </tr>
              <tr>
                <td>Which publications are yours (attribution)</td>
                <td>ReCiter, reading PubMed</td>
                <td>Nightly</td>
                <td>
                  Hide as a near-term fix; reject in{" "}
                  <a href={PM} className={LINK}>
                    Publication Manager
                  </a>{" "}
                  to fix attribution
                </td>
              </tr>
              <tr>
                <td>Publication metadata (title, author order, journal, DOI, MeSH)</td>
                <td>PubMed (NIH/NLM)</td>
                <td>Nightly</td>
                <td>At the publisher / NLM; flows in on next refresh</td>
              </tr>
              <tr>
                <td>Citation counts and cites/cited-by</td>
                <td>iCite (NIH)</td>
                <td>Nightly</td>
                <td>NIH / iCite source</td>
              </tr>
              <tr>
                <td>Research areas, subareas, Impact score, synopsis</td>
                <td>ReciterAI (in-house)</td>
                <td>Impact &amp; synopsis nightly; areas &amp; subareas weekly; taxonomy periodic</td>
                <td>Not hand-editable; report a systematic error</td>
              </tr>
              <tr>
                <td>Funding / grants</td>
                <td>InfoEd, all sponsors (NIH RePORTER supplies federal abstract text)</td>
                <td>Nightly</td>
                <td>Request a change (routes to Sponsored Research); applied in InfoEd</td>
              </tr>
              <tr>
                <td>Clinical trials</td>
                <td>OnCore (clinical trial management system)</td>
                <td>Nightly</td>
                <td>
                  Corrected at the OnCore source; attribution comes directly from OnCore, not
                  ReCiter
                </td>
              </tr>
              <tr>
                <td>Graduate School appointment; student mentor/mentee</td>
                <td>Jenzabar (Graduate School)</td>
                <td>Nightly</td>
                <td>Request a change (routes to the Graduate School)</td>
              </tr>
              <tr>
                <td>Education record</td>
                <td>ASMS</td>
                <td>Nightly</td>
                <td>Request a change (routes to Faculty Affairs)</td>
              </tr>
              <tr>
                <td>Hospital position</td>
                <td>NYP IdentityIQ (NewYork-Presbyterian)</td>
                <td>Per NYP sync</td>
                <td>Request a change (routes to the NYP-side office)</td>
              </tr>
              <tr>
                <td>Disclosures</td>
                <td>Conflicts-of-Interest system (WCM COI)</td>
                <td>Nightly</td>
                <td>Request a change (routes to the COI office)</td>
              </tr>
              <tr className="[&>td]:bg-[#f7f1f1]">
                <td>Center membership</td>
                <td>Scholars (this app) &mdash; the only institutional field Scholars owns</td>
                <td>On edit</td>
                <td>Edited in-app by a center Owner/Curator</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Callout variant="warn" heading="Citation source">
          <p>Scholars uses iCite as its only citation source. It does not use Scopus.</p>
        </Callout>
        <p>
          A few non-obvious behaviors this map explains. MeSH &ldquo;check tags&rdquo; (Humans, Male,
          Female, Adult, and so on) are filtered out upstream by ReciterDB before Scholars sees
          them, so they correctly never appear as topics, which is intended, not a gap. A copy can lag
          the source: a correction you make today appears only after the next refresh. And a
          correction to directory or appointment data (department, title, affiliation, person type,
          or an appointment) is submitted through Request a change and routed to ITS
          support, because a wrong value can be either a source-record error (which they escalate to
          the owning office, such as Faculty Affairs) or a data-sync (ETL) problem in the pipeline
          (which they fix directly). That trade-off is the cost of showing an authoritative copy
          rather than a hand-kept duplicate.
        </p>

        <h3 id="disclosures" className="scroll-mt-28 lg:scroll-mt-20">
          Disclosures
        </h3>
        <p>
          Disclosures are the financial interests and conflicts a scholar reports to WCM. Their
          system of record is the WCM Conflicts-of-Interest (COI) system, they refresh nightly, and
          on a profile they are shown grouped by category. As with every sourced field, Scholars
          shows a copy and cannot edit it. To correct or update a disclosure, use Request a change
          in your self-edit interface and it routes to the COI office, where the fix is
          applied and flows back on the next refresh.
        </p>

        <h2 id="correct">How to correct something</h2>
        <p>
          Your self-edit interface is the front door: it lets you edit your overview, hide or
          restore publications, and submit a data correction via Request a change, which routes to
          the office that owns the field (you never have to figure out where to send it). The rule
          of thumb: if Scholars owns it, it is fixed here; otherwise the fix happens at
          the source and appears after the next refresh.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[640px]">
            <thead>
              <tr>
                <th>What&apos;s wrong</th>
                <th>Where it&apos;s fixed</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>A publication that isn&apos;t yours is on your profile</td>
                <td>Publication Manager (you can hide)</td>
                <td>
                  Hide it now as a near-term fix (reversible, recorded); reject it in{" "}
                  <a href={PM} className={LINK}>
                    Publication Manager
                  </a>{" "}
                  to fix attribution at the source
                </td>
              </tr>
              <tr>
                <td>A publication that is yours is missing</td>
                <td>ReCiter Publication Manager</td>
                <td>
                  Add or confirm it at{" "}
                  <a href={PM} className={LINK}>
                    reciter.weill.cornell.edu
                  </a>, you or the library curation team, whoever gets there first
                </td>
              </tr>
              <tr>
                <td>A wrong field on a publication (title, author order, DOI)</td>
                <td>PubMed (NIH/NLM)</td>
                <td>Bibliographic metadata flows from the publisher/NLM</td>
              </tr>
              <tr>
                <td>Your preferred name or headshot</td>
                <td>WCM Web Directory</td>
                <td>
                  Update it yourself in the{" "}
                  <a href={WEB_DIR} className={LINK}>
                    Web Directory
                  </a>
                </td>
              </tr>
              <tr>
                <td>Your department, title, or affiliation</td>
                <td>ASMS (your primary appointment); title is carried by the Enterprise Directory</td>
                <td>
                  Tied to your primary appointment; Request a change routes to the Office of
                  Faculty Affairs (a department admin can set a &ldquo;working title&rdquo; override
                  in the Enterprise Directory)
                </td>
              </tr>
              <tr>
                <td>A postdoc or fellow academic appointment</td>
                <td>Faculty Affairs (by way of ASMS / Enterprise Directory)</td>
                <td>
                  Request a change, routed to ITS support, who fix a data-sync issue or
                  escalate a source correction to Faculty Affairs
                </td>
              </tr>
              <tr>
                <td>A Graduate School appointment or mentor/mentee</td>
                <td>Jenzabar</td>
                <td>Request a change (routes to the Graduate School)</td>
              </tr>
              <tr>
                <td>Your hospital position</td>
                <td>NYP IdentityIQ</td>
                <td>Request a change (routes to the NYP-side office)</td>
              </tr>
              <tr>
                <td>Your funding / grants</td>
                <td>InfoEd</td>
                <td>Request a change (routes to Sponsored Research)</td>
              </tr>
              <tr>
                <td>A disclosure</td>
                <td>COI system</td>
                <td>Request a change (routes to the COI office)</td>
              </tr>
              <tr>
                <td>A wrong research area, Impact score, or synopsis</td>
                <td>ReciterAI (computed)</td>
                <td>Report a systematic error via Request a change (routes to the Scholars team)</td>
              </tr>
              <tr className="[&>td]:bg-[#f7f1f1]">
                <td>Center membership</td>
                <td>Scholars</td>
                <td>
                  A center Owner/Curator edits it at <code>/edit/center/[code]</code>, or request it
                  through{" "}
                  <Link href="#requests" className={LINK}>
                    Request a change
                  </Link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 id="control">What you control</h2>
        <p>Four things are yours to do directly, in your self-edit interface:</p>
        <ul>
          <li>
            <strong>Your overview text</strong>: the free-text statement about your work. You
            write it; it is not derived from anything.
          </li>
          <li>
            <strong>Hide or restore a publication</strong>: if ReCiter attributed a paper that
            isn&apos;t yours, you can hide it as a quick near-term fix. Hiding is reversible and
            recorded, and is about your profile rather than search: it removes a paper from your
            profile, separate from whether it appears in search (
            <Link href="#search" className={LINK}>
              more on that below
            </Link>
            ). The proper fix is to reject the paper in{" "}
            <a href={PM} className={LINK}>
              Publication Manager
            </a>
            , which corrects the attribution at the source so it does not return on the next refresh.
          </li>
          <li>
            <strong>Submit a data correction</strong>: for a field you cannot edit directly,
            Request a change and it is routed to the office that owns the field.
          </li>
          <li>
            <strong>Choose your Selected highlights</strong>: the small set of papers featured on
            your profile. By default these are chosen by Impact and recency; you can instead pick
            them yourself.
          </li>
        </ul>
        <Callout variant="note" heading="Not a control, but worth knowing">
          <p>
            You cannot edit Impact scores, research areas, or synopses; those are computed. You also
            cannot pick what appears on the home-page showcase surfaces, which are algorithmic (see{" "}
            <Link href="#showcase" className={LINK}>
              Spotlight
            </Link>
            ). What you can choose is your profile&apos;s Selected highlights, described above.
          </p>
        </Callout>

        <h2 id="roles">Roles &amp; who can edit</h2>
        <p>
          Most editing in Scholars is source-system editing. The exception is unit curation
          (centers, divisions, and departments), governed by three roles.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[560px]">
            <thead>
              <tr>
                <th>Role</th>
                <th>Scope</th>
                <th>Can do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Superuser</td>
                <td>Global</td>
                <td>Edit any unit; grant Owner and Curator roles; full curation surface</td>
              </tr>
              <tr>
                <td>Owner</td>
                <td>One unit</td>
                <td>Edit that unit&apos;s curated data; grant Curators on it</td>
              </tr>
              <tr>
                <td>Curator</td>
                <td>One unit</td>
                <td>Edit that unit&apos;s curated data, for example a center&apos;s roster</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Roles are unit-scoped (a role on one center does not grant access to another), and every
          edit is audit-logged. Curatable: center rosters and metadata, manually-created
          division rosters, and unit metadata (leadership, slug, browse category). Not curatable: a
          scholar&apos;s source-of-record fields, or a scholar&apos;s personal overview and
          publication controls.
        </p>
        <p>
          These curation roles are granted inside Scholars by a Superuser. They are separate from the
          ED person-type (faculty / appointee) that categorizes people on their profiles.
        </p>

        <h2 id="research-areas">Research areas</h2>
        <Callout variant="key" heading="Two axes: what, and how">
          <p>
            A scholar&apos;s work is described along two complementary axes. <em>Research areas</em>{" "}
            capture <strong>what</strong> you study; <em>methods and tools</em> capture{" "}
            <strong>how</strong> you study it. They are derived independently, shown as separate
            sections, and together give a fuller picture than either alone.
          </p>
        </Callout>
        <p>
          Research areas are not self-selected, and they are not the same as the MeSH keywords that
          power search. Rather than borrowing a standard subject classification, ReciterAI reads
          across plain-language summaries of every Weill Cornell publication and lets the major
          domains emerge from what is actually there: areas like Cardiovascular Disease, Immunology,
          and Cancer Biology. The model consolidates overlapping areas and validates the result
          against a set of representative queries, so the areas hold together without being
          hand-built. Within each area, the same approach surfaces finer subareas, organized as a
          research-area to subarea hierarchy.
        </p>
        <p>
          As an independent check, that map was benchmarked against authoritative institutional
          reference points: Weill Cornell&apos;s divisions and departments, its strategic research
          roadmap, and NIH research designations. It aligned cleanly with all three, confirming that
          what the model surfaced from the literature mirrors how the institution and the wider field
          already organize science.
        </p>
        <p>
          Each publication is then placed on that map. ReciterAI scores each paper against every
          research area, using a plain-language synopsis of the paper together with its abstract, then
          associates the paper with all the research areas it relates to (and, within each, zero or
          more subareas), each carrying its own relevance score. Because real research often spans
          several areas, a single paper is commonly associated with more than one. The areas shown on
          a scholar&apos;s profile reflect the balance of their published work.
        </p>
        <p>
          <strong>A worked example.</strong> Take a 2024 paper, &ldquo;Single-cell profiling of aging
          T cells in the tumor microenvironment.&rdquo; We&apos;ll follow it through{" "}
          <Link href="#methods" className={LINK}>
            methods
          </Link>{" "}
          and{" "}
          <Link href="#impact" className={LINK}>
            the Impact score
          </Link>{" "}
          below as well. It is read against every research area at once and clears the bar for three:{" "}
          <em>Aging &amp; Geroscience</em> most strongly, then <em>Immunology</em>, and{" "}
          <em>Cancer Biology</em> more loosely. All three are kept; there is no single
          &ldquo;primary&rdquo; area, because the work genuinely sits across them. Within Aging &amp;
          Geroscience it is then placed into finer subareas (here <em>Immune Aging</em> as the
          best fit, with <em>Cellular Senescence</em> secondary), and a paper that fits no
          subarea cleanly is left unassigned rather than forced into one.
        </p>
        <Callout variant="warn" heading="A second score, a click deeper">
          <p>
            Each publication-to-area pairing carries a <em>relevance</em> score from 0 to 1: in
            the example, roughly 0.85 for Aging &amp; Geroscience, 0.78 for Immunology, and 0.42 for
            Cancer Biology. It measures how central the paper is to <em>that</em> area, a different
            question from the Impact score&apos;s &ldquo;how notable is this paper overall.&rdquo; A
            paper can be highly relevant to an area yet modest in Impact, or the reverse. Relevance is
            used mainly to order publications within a research area (combined with Impact, so a
            paper ranks high on an area page when it is both central to the area and notable). Unlike
            Impact, it does not appear on publication cards or listings; it surfaces only when you
            open a publication&apos;s detail view. So in everyday browsing the one score you see is
            Impact (&ldquo;Impact: NN&rdquo;), with relevance available a click deeper.
          </p>
        </Callout>
        <p>
          <strong>Freshness.</strong> The taxonomy (the set of research areas itself) is stable
          between rebuilds and is recomputed only periodically, when the field has shifted
          enough to warrant it, not on a fixed clock. Your publications, though, are classified into
          the current taxonomy on a weekly run as new work is ingested, so an individual paper does
          not wait for a taxonomy rebuild to receive its areas, and your profile keeps up as you
          publish. An area can shift when the taxonomy is next rebuilt; that is expected.
          Research-area scoring reads the paper&apos;s plain-language synopsis together with its
          abstract; a paper without an abstract is still scored from its synopsis. Subarea assignment
          instead reads the title together with the synopsis, not the abstract. A genuinely wrong area
          is a ReciterAI matter; report a systematic error.
        </p>

        <h2 id="methods">Methods &amp; tools</h2>
        <p>
          Methods and tools describe <em>how</em> a scholar does their research: the techniques,
          instruments, datasets, models, and software behind the work. They are read directly from
          the publications themselves. ReciterAI scans the abstracts of each Weill Cornell
          scholar&apos;s papers and grants and identifies the specific methods and resources actually
          used, deliberately skipping the commodity lab staples that don&apos;t distinguish one group
          from another.
        </p>
        <p>
          Closely related mentions are merged, so that &ldquo;MRI,&rdquo; &ldquo;magnetic resonance
          imaging,&rdquo; and &ldquo;MRI scanner&rdquo; become a single entry, and they are grouped
          into broader capability families, so a profile reads at the right level rather than as a
          list of synonyms. Each method is weighted by how distinctive it is across the institution:
          a technique only a handful of labs use ranks higher than one everyone shares.
        </p>
        <p>
          <strong>How methods are organized.</strong> Behind each entry sits a four-level
          structure, from most specific to most general:
        </p>
        <ul>
          <li>
            <strong>Raw mention</strong>: the exact phrase as it appeared in a paper, such as
            &ldquo;scRNA-seq&rdquo; or &ldquo;single-cell RNA sequencing.&rdquo;
          </li>
          <li>
            <strong>Canonical method</strong>: the single standard name those mentions resolve to
            (&ldquo;single-cell RNA sequencing&rdquo;).
          </li>
          <li>
            <strong>Family</strong>: the capability group of related techniques it belongs to
            (&ldquo;single-cell genomics&rdquo;).
          </li>
          <li>
            <strong>Supercategory</strong>: the broad domain above the family.
          </li>
        </ul>
        <p>
          A profile shows methods at the family level, expandable to the member tools, and search
          and the methods pages use the same structure.
        </p>
        <p>
          <strong>The same paper, once more.</strong> From our example&apos;s abstract, ReciterAI
          picks out <em>single-cell RNA sequencing</em>, the <em>10x Genomics</em> platform, and{" "}
          <em>CITE-seq</em>, and ignores the routine qPCR validation step, a commodity staple
          that doesn&apos;t distinguish one lab from another. &ldquo;scRNA-seq&rdquo; and
          &ldquo;single-cell RNA sequencing&rdquo; collapse into one entry, filed under a broader{" "}
          <em>single-cell genomics</em> capability family. Each method then carries a distinctiveness
          weight set by how many WCM labs use it: single-cell RNA-seq is now common enough to sit
          mid-pack, whereas a technique only three or four labs use would rank near the top. On the
          scholar&apos;s own profile, their methods are ordered by how much they themselves use each
          one.
        </p>
        <p>
          Because this is drawn from a scholar&apos;s own publications, it reflects demonstrated,
          hands-on use rather than self-reported interests, and it is refreshed as new work is
          published.
        </p>
        <p>
          From a scholar&apos;s publications, a method is attributed to them only when they were
          first or senior (last) author on the paper it was drawn from (grants are a separate
          source). That is a deliberate choice to err toward under-attribution: it keeps the list to
          methods the scholar themselves led, at the cost of occasionally omitting one they used as a
          middle author on a large collaboration. We would rather show fewer, surer methods than
          over-claim.
        </p>

        <h2 id="impact">The Impact score</h2>
        <p>
          The Impact score is a 0&ndash;100 number ReciterAI assigns to a publication, shown as
          &ldquo;Impact: NN&rdquo;. It weighs three things about the paper: its citation
          signal (the iCite citation count, plus the paper&apos;s NIH percentile and Relative
          Citation Ratio once those exist), the standing of the journal it appeared in, and how
          recent it is. A calibrated model combines them into a single number by comparing
          the paper against a fixed ladder of reference points (described below). It is not a
          hand-tuned arithmetic formula but a judgment the model makes against that ladder, which is
          why two papers with comparable evidence land at comparable scores.
        </p>
        <h3>What the score is for, and what it isn&apos;t</h3>
        <p>
          The Impact score has a deliberately limited job. Inside Scholars it is used mainly to help
          the application decide <em>which of your own publications to surface</em>: on the
          home-page showcase, in your profile&apos;s highlights, on a research-area page. It is an
          input to that choice, not a verdict on you, and the aim of surfacing is egalitarian: to
          make sure every researcher&apos;s strongest work gets its day in the sun, rather than
          letting a few famous papers crowd everyone else out. It is <strong>not</strong> a ranking
          of scholars, and it is not used to evaluate people for promotion, funding, or effort.
        </p>
        <p>
          It is also a <em>leading</em> indicator. Field-normalized citation metrics like the NIH
          percentile and the Relative Citation Ratio (RCR) need two to three years of accumulated
          citations to settle, so for a paper published this month they do not yet exist. The Impact
          score reads what is already available (the venue, the abstract, and the earliest
          citation signal) to estimate within the same week where the paper is likely to land,
          and it folds the percentile and RCR in later, as they mature. That lets you and your
          department act on new work without waiting years for the citation record to catch up.
        </p>
        <p>
          What it does <em>not</em> claim is to measure quality, rigor, or importance. It tracks
          attention and standing: how much the wider literature is engaging with a paper, in
          what venue, how recently. A careful negative result, a foundational methods paper, or a
          study in a small field can matter enormously and still carry a modest score, and a heavily
          cited but incremental paper can carry a high one. Read it as &ldquo;how visible and
          well-placed is this paper,&rdquo; not &ldquo;how good is this science.&rdquo;
        </p>
        <h3>How to read the number</h3>
        <p>
          The model scores against a fixed ladder of about two hundred reference points spanning all
          of biomedicine, so the same number means the same thing in any field. The bands are
          demanding: preliminary or underpowered work sits in the low tier (a letter to the editor
          anchors at 8, a single-patient case report near 12); solid but incremental studies fall in
          the 30s and 40s; the 50s and 60s already denote strong contributions with clear influence;
          and the 70s and 80s are major, practice- or field-shaping work. So a score that looks modest
          is not a poor grade: a paper in the 60s is, by this rubric, a strong and influential
          one.
        </p>
        <Callout variant="note" heading="High scores are rare by design">
          <p>
            The top of the ladder is held for paradigm-shifting, field-defining work (the
            discovery of the DNA double helix anchors at 99, penicillin at 97, CRISPR&ndash;Cas9
            genome editing at 93), so the scale is demanding and the model is sparing with high
            numbers. There is no fixed ceiling for a real paper, but very high scores are uncommon by
            design. The practical effect is that a number which looks middling can still mark one of a
            researcher&apos;s strongest papers, so read it against a scholar&apos;s own body of work
            rather than against a notional 100.
          </p>
        </Callout>
        <p>
          That restraint is also what makes the score useful for choosing what to feature. A
          field-normalized percentile can label many of a prolific researcher&apos;s papers as
          top-percentile at once, which is gratifying but little help when the task is to pick the few
          that best represent them. Because the Impact score spreads work out instead of crowding the
          top, it can separate a researcher&apos;s most impactful papers from their merely solid ones,
          which is exactly what the surfaces it feeds need.
        </p>
        <p>
          <strong>It does not favor basic over clinical research, or the reverse.</strong> The model
          is explicitly calibrated for parity: the ladder rates clinical trials, health-services
          research, and implementation work on the same terms as bench science, and the scorer runs a
          counterfactual check (would this same evidence score higher attached to a
          basic-science paper?) and corrects itself when the answer is yes. Clinical,
          implementation, and health-services work can reach the same heights as bench discovery.
        </p>
        <p>
          <strong>Which publications are scored.</strong> The scoring scope is full-time WCM faculty
          only: ReciterAI scores the substantive research articles (from 2020 onward) that have at
          least one full-time WCM faculty author, and the Impact then appears on that publication
          wherever it shows, including on a co-author&apos;s or trainee&apos;s view. A publication
          with no full-time WCM faculty author is outside the scope and is not scored. Publication{" "}
          <em>type</em> matters separately, when the showcase surfaces decide what to feature
          (Reviews and Case Reports are down-weighted there and Letters and Editorials excluded),
          but that is a surfacing rule, not part of the Impact score itself (see{" "}
          <Link href="#showcase" className={LINK}>
            Spotlight
          </Link>
          ).
        </p>
        <p>
          <strong>Why the scope stops there.</strong> Enriching a publication is not free: ReciterAI
          derives its plain-language synopsis, classifies it into research areas, extracts its
          methods, and scores it, each step a chain of language-model passes, so the compute and the
          pipeline overhead grow with every paper in the corpus. To keep that cost manageable for
          now, ReciterAI runs this full enrichment only on publications with at least one full-time
          WCM faculty author. It is purely a cost-and-scale measure, not a statement about whose work
          counts: voluntary and affiliated faculty, postdocs, and other appointees are fully part of
          Scholars, with their own profiles and a place in search and the Browse directory.
          Depending on feedback, we may later widen the set of publications that receive the full
          treatment.
        </p>
        <p>
          <strong>The same worked example.</strong> Take the 2024 single-cell paper we traced under{" "}
          <Link href="#research-areas" className={LINK}>
            research areas
          </Link>{" "}
          and{" "}
          <Link href="#methods" className={LINK}>
            methods
          </Link>{" "}
          above, first-authored by a WCM faculty member in a leading journal. Because it is only
          months old it has no NIH percentile or RCR yet, so the model works from the venue, the
          abstract, and its first handful of citations and assigns <strong>Impact: 84</strong>,
          a high score, which the model assigns sparingly. That same 84 appears on the paper everywhere
          (on the first author&apos;s profile, on a middle co-author&apos;s, on a
          trainee&apos;s) because it describes the paper, not any one author.
        </p>
        <p>
          <strong>How often it updates.</strong> Impact scores and synopses refresh nightly, on the
          same cadence as the source mirrors like ED and PubMed. A newly matched publication is
          usually scored within a day or two, and an updated citation count reaches the score within
          about a day.
        </p>
        <p>
          <strong>Why a publication can show no Impact (a dash).</strong> Not a quality judgment.
          Usually the paper is very recent and not yet scored in a batch, is a preprint or in-press,
          or is in a venue the citation source does not index.
        </p>
        <h3>The three scores in the system</h3>
        <p>Three scores run in Scholars, and they differ in how visible they are to you:</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[640px]">
            <thead>
              <tr>
                <th>Score</th>
                <th>What it measures</th>
                <th>Granularity</th>
                <th>Shown to you?</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ReCiter score</td>
                <td>Confidence that a publication is yours (attribution)</td>
                <td>per (person, publication)</td>
                <td>No (drives attribution behind the scenes)</td>
              </tr>
              <tr>
                <td>Impact score</td>
                <td>A publication&apos;s overall standing</td>
                <td>per publication</td>
                <td>Yes (&ldquo;Impact: NN&rdquo;)</td>
              </tr>
              <tr>
                <td>Research-area relevance score</td>
                <td>How central a paper is to a research area</td>
                <td>per (publication, research area)</td>
                <td>Only in a publication&apos;s detail view</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 id="search">Search</h2>
        <p>
          Search in Scholars is MeSH-aware, not plain keyword matching. MeSH (Medical Subject
          Headings) is the NLM&apos;s controlled vocabulary for indexing biomedical literature, and
          Scholars uses it to understand what a query is about. A query that resolves to a MeSH
          concept matches publications and scholars indexed under that concept, even when they do not
          use your exact wording, and exact MeSH-descriptor matches rank above free-text matches.
          When your query maps to a concept, the publications tab shows a resolver chip naming it,
          and you can escape into a literal-text search from that chip to match your words exactly.
        </p>
        <p>
          Search has had considerable tuning, and it does more than match words. Some results are
          entities rather than documents: when your query lands on a research area or on a method or
          tool, Scholars surfaces that as its own result, so you can step straight onto its dedicated
          page instead of paging through publications. The ranking is calibrated to favor exact
          concept matches over loose stemmed ones, and to show the snippet of text that explains why
          each result matched.
        </p>
        <p>
          If a publication of yours isn&apos;t turning up, the search index rebuilds nightly, so a
          paper added today usually appears the next day; searching its exact title is the quickest
          way to confirm it is indexed.
        </p>
        <Callout variant="note" heading="Search is separate from your profile">
          <p>
            Whether a publication appears in search is governed by the search index, which rebuilds
            nightly. Whether it appears on your profile is governed by attribution and
            your hide/restore choices. Hiding a paper from your profile does not remove it from
            search, and the reverse holds too.
          </p>
        </Callout>

        <h2 id="showcase">Spotlight &amp; Selected research</h2>
        <p>
          Most showcase surfaces are chosen by a model, not by you, and the home-page surfaces have
          no &ldquo;feature this paper&rdquo; control. The exception is your profile&apos;s Selected
          highlights, which you can curate yourself (see{" "}
          <Link href="#control" className={LINK}>
            What you control
          </Link>
          ). They share one formula
          (the ReciterAI Impact score multiplied by author position, publication type, and recency)
          plus surface-specific filters. The publication-type factor is where Reviews and Case
          Reports are down-weighted and Letters, Editorials, and Errata are excluded entirely, so a
          paper&apos;s type can keep it off these surfaces even when its Impact is high.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[680px]">
            <thead>
              <tr>
                <th>Surface</th>
                <th>Where</th>
                <th>What it shows</th>
                <th>How it is selected</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Selected research / Spotlight</td>
                <td>Home page</td>
                <td>Representative publications per subarea, in a small rotating set</td>
                <td>Ranked by Impact within the subarea; refreshed weekly</td>
              </tr>
              <tr id="selected-highlights" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Selected highlights</td>
                <td>A scholar&apos;s profile</td>
                <td>That scholar&apos;s most notable papers</td>
                <td>Impact and recency, restricted to first- or senior-author papers; lighter recency weight. A scholar may instead curate these manually.</td>
              </tr>
              <tr id="recent-contributions" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Recent contributions</td>
                <td>Home page</td>
                <td>Recent notable work across WCM</td>
                <td>Impact and heavy recency; eligible roles only; one per research area</td>
              </tr>
              <tr id="recent-highlights" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Recent highlights</td>
                <td>Research area page</td>
                <td>Recent notable work in a research area</td>
                <td>Impact and heavy recency; all attributed authors</td>
              </tr>
              <tr id="top-scholars" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Top scholars</td>
                <td>Research area page</td>
                <td>Full-time faculty most active in a research area</td>
                <td>Summed Impact of their first- or senior-author papers in the research area; refreshed weekly</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          So the honest answer to &ldquo;why isn&apos;t my Cell paper a Selected highlight&rdquo; is
          usually that it is not a first- or senior-author paper, it is older and lost to more recent
          work, or its type is down-weighted. The same paper can be featured on one surface and not
          another, because the filters differ.
        </p>
        <Callout variant="note" heading="A representative selection, not a complete list">
          <p>
            Read these surfaces as a <em>representative selection</em> of a scholar&apos;s work, a
            curated highlight, not a complete or proportional inventory. Most feature only
            research articles from 2020 onward on which the scholar is <em>first or senior (last)
            author</em>; co-first and co-senior authors count too, since equal-contribution
            authorship is tracked upstream. That is a deliberate signal-to-noise choice: a faculty
            member&apos;s first-
            and senior-author papers are the ones they led or supervised, so restricting to them
            gives a truer picture of what a scholar drives than a feed that also pulled in every
            large-consortium paper they were a middle author on. The cost is real: it leaves
            out some work that genuinely reflects expertise, such as key collaborations where the
            scholar contributed without leading, but it keeps the highlighted set focused
            rather than crowded. The selection is curated by design and is not meant to be
            exhaustive: every paper attributed to a scholar, in any author position, still appears in
            full on their profile and in search.
          </p>
        </Callout>
        <h3>Who appears on these surfaces</h3>
        <p>
          Because these surfaces highlight ongoing research, they draw from people in active research
          roles: full-time faculty, postdocs, and fellows. Affiliated and voluntary appointees,
          instructors, lecturers, and emeritus faculty are not featured here, though they still appear
          in full on their own profiles, in search, and on the Browse directory. <strong>Top
          scholars</strong> narrows further to full-time faculty only, because it is a
          principal-investigator surface. Doctoral students are not shown on any public surface at
          all (a deliberate privacy choice), and appear only as plain-text names where a mentor or
          co-author relationship refers to them.
        </p>

        <h2 id="profile-url">Your profile URL</h2>
        <p>
          Every profile has a short, stable web address:{" "}
          <code>scholars.weill.cornell.edu/&lt;your-name&gt;</code>, for example{" "}
          <code>/jane-smith</code>. The longer form{" "}
          <code>/scholars/&lt;your-name&gt;</code> works too and leads to the same profile, so any
          link to you keeps working.
        </p>
        <p>
          The address is <strong>derived automatically from your preferred name</strong> in the Web
          Directory: lowercased, accents removed, spaces turned into hyphens. So{" "}
          <em>María José García-López</em> becomes <code>maria-jose-garcia-lopez</code> and{" "}
          <em>Mary-Anne O&rsquo;Brien</em> becomes{" "}
          <code>mary-anne-obrien</code>. You don&apos;t set it, and you don&apos;t normally need to
          think about it.
        </p>
        <p>
          <strong>Your address is stable.</strong> If your preferred name later changes, or an
          administrator sets a custom address for you, the old address keeps working; it
          permanently redirects to the new one, so existing links, citations, and bookmarks
          don&apos;t break.
        </p>
        <p>
          <strong>Want a different address?</strong> Custom addresses aren&apos;t self-serve;
          email the Scholars team (or open a Service Desk ticket) and say what you&apos;d like.
          Addresses stay name-based, so ask for a variation of your first and last name; you
          can add a middle initial or a fuller form (for example <code>jane-q-smith</code>) when a
          namesake already has the plain form. They aren&apos;t free-choice handles; you can&apos;t claim a word
          like a research area or a department. An administrator reviews the request, sets your new
          address, and replies to your ticket when it&apos;s done, usually within a few business days;
          your old address keeps working and permanently redirects.
        </p>
        <Callout variant="note" heading="A number in your address isn’t a ranking">
          <p>
            If your address ends in a number (<code>jane-smith-2</code>), it only means someone
            already had the name-based address when yours was created. The first profile keeps the
            plain <code>jane-smith</code>; each later namesake gets the next number, in the order
            profiles were created. It says nothing about you.
          </p>
        </Callout>

        <h2 id="requests">Requesting a correction, bug, or enhancement</h2>
        <p>
          Three different requests go to different places. A <em>correction</em> means something is
          wrong: a misattributed paper, a stale department, or a bad research area. Use{" "}
          <Link href="#correct" className={LINK}>
            How to correct something
          </Link>
          , starting in your self-edit interface, which routes the request to the owning office for
          you. A <em>bug</em> means something is broken; report it through{" "}
          <Link href="#correct" className={LINK}>
            Request a change
          </Link>
          , and a systematic model error, such as wrong scores or research areas across many items, routes to
          a ReciterAI review. An <em>enhancement</em> is a feature request: include your stakeholder
          role, the surface or behavior, what you want, and the underlying need, and submit it the
          same way. Every request is logged as a support ticket and routed for you.
        </p>

        <hr className="mt-12 border-border" />

        <h2 id="glossary">Glossary</h2>
        <dl className="mt-4 space-y-5">
          {[
            { term: "Impact score", def: "A 0–100 score ReciterAI assigns to a publication: a calibrated model weighs its citation signal (iCite count, plus NIH percentile and RCR once they exist), journal standing, and recency against a fixed ladder of ~200 reference points. Publication-level and not author-relative: the same number for every co-author. Field-aware but not a literal cross-field ranking. Used mainly to help decide which of a scholar’s papers to surface; not a ranking of people. High scores are rare by design (the scale is demanding and the 90–100 band is reserved for historic landmarks), so a mid-range score can still mark a top paper. Shown as “Impact: NN”." },
            { term: "Author Position", def: "Your place in a publication’s author list (first / middle / senior). This, not Impact, conveys your role on a paper." },
            { term: "ReCiter", def: "WCM’s author-disambiguation engine. Decides which publications are yours, from PubMed. Runs nightly." },
            { term: "ReCiter Publication Manager", def: "The curation interface at reciter.weill.cornell.edu where a publication’s attribution is corrected. A misattributed paper is rejected here; a missing one is added here." },
            { term: "ReciterAI", def: "WCM’s pipeline that derives a publication’s research areas, Impact score, and one-line synopsis. Impact and synopsis refresh nightly; research areas and subareas are assigned weekly; the research-area taxonomy is rebuilt periodically." },
            { term: "Research areas (and subareas)", def: "WCM’s AI-derived map of what scholars work on: broad research areas such as Cancer Biology, each with finer subareas. ReciterAI derives them from publications, not from MeSH or a fixed list, and scores how strongly each paper relates to each area. Distinct from the MeSH keywords that power search." },
            { term: "Self-edit interface", def: "Where a scholar edits their overview, hides or restores publications, and submits data corrections (Request a change), which route to the owning office." },
            { term: "Profile URL (slug)", def: "A profile’s web address: the short scholars.weill.cornell.edu/<slug> and the longer /scholars/<slug> both work and lead to the same page. The slug is derived automatically from the scholar’s preferred name (e.g. jane-smith); a later namesake gets a number (jane-smith-2) and the earlier profile keeps the plain form; it is not a ranking. The address is stable: if it changes, the old one permanently redirects, so existing links keep working. A custom address (still based on the scholar’s name) can be set by a Scholars administrator." },
            { term: "iCite", def: "The NIH tool Scholars uses as its only citation source. Scholars does not use Scopus." },
            { term: "InfoEd", def: "WCM’s grants system of record, for all sponsors. NIH RePORTER supplies federal abstract text and the portfolio link." },
            { term: "MeSH", def: "Medical Subject Headings, the NLM’s controlled vocabulary for indexing biomedical literature. Scholars search is MeSH-aware." },
            { term: "System of record (SOR)", def: "The authoritative system that owns a field. Scholars shows a copy and cannot override it; corrections happen at the SOR. Center membership is the only institutional field whose SOR is Scholars itself; a scholar’s own overview and visibility choices are stored in Scholars too, but those are personal profile data, not shared institutional records." },
            { term: "Roles (Superuser / Owner / Curator)", def: "Unit-scoped permissions for curating centers, divisions, and departments. Superuser is global and grants roles; Owner and Curator act on one unit. Every edit is audit-logged." },
            { term: "Spotlight / Selected research", def: "The home-page showcase of representative publications per subarea, selected by ReciterAI Impact within the subarea and refreshed weekly. Not scholar-curated." },
            { term: "Suppression", def: "Hiding a misattributed publication from a profile. A reversible, recorded near-term measure; the source-level fix is rejecting the paper in Publication Manager." },
          ].map(({ term, def }) => (
            <div key={term} id={`g-${term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`} className="scroll-mt-28 lg:scroll-mt-20">
              <dt className="font-semibold">{term}</dt>
              <dd className="mt-0.5 text-muted-foreground">{def}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
