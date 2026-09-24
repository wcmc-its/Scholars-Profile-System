import type { Metadata } from "next";
import Link from "next/link";
import { DocsMobileNav, DocsToc, type NavGroup } from "@/components/docs/docs-toc";
import { ProvenanceFlow } from "@/components/docs/provenance-flow";

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
      { id: "mentees", label: "Mentees" },
      { id: "profile-url", label: "Your profile URL" },
      { id: "requests", label: "Requesting changes" },
    ],
  },
  { group: "", items: [{ id: "glossary", label: "Glossary" }] },
];

const LINK = "text-[#7d1c1c] underline underline-offset-4 hover:no-underline";
const PM = "https://reciter.weill.cornell.edu";
const WEB_DIR = "https://directory.weill.cornell.edu";
const NIH_MPI =
  "https://grants.nih.gov/grants-process/plan-to-apply/consider-your-idea-resources-and-collaborators/multiple-principal-investigators";

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
      <div className={`mb-1 text-[13px] font-semibold ${head}`}>{heading}</div>
      {children}
    </div>
  );
}

const WRG = "https://wrg.weill.cornell.edu";

const WebDirLink = (
  <a href={WEB_DIR} className={LINK}>
    Web Directory
  </a>
);
const PmLink = (
  <a href={PM} className={LINK}>
    Publication Manager
  </a>
);

/**
 * The field-by-field map for #provenance: [what you see, system of record,
 * refresh, how it's corrected]. Every row was traced to the ETL, schedule
 * (cdk/lib/etl-stack.ts), flag and Request-a-change routing code on master,
 * 2026-09-24. "Occasional" = a hand-run export or import with no schedule.
 * Update a row when its ETL step, cadence or route changes.
 */
const PROVENANCE: {
  group: string;
  rows: [string, string, string, React.ReactNode][];
}[] = [
  {
    group: "Name, photo & contact",
    rows: [
      ["Name", "Enterprise Directory", "Nightly", <>Change your preferred name yourself in the {WebDirLink}</>],
      ["Degrees after your name", "Enterprise Directory, from ASMS", "Nightly", "Request a change (routes to the Office of Faculty Affairs)"],
      ["Photo", "Web Directory, shown live rather than copied", "Live", <>Add, change, or remove it yourself in the {WebDirLink}. It shows right away</>],
      ["Email, and who can see it", "Enterprise Directory", "Nightly", <>Change the address or its &ldquo;Publish to&rdquo; setting yourself in the {WebDirLink}</>],
      ["ORCID iD", "Scholars, kept in sync with WCM Identity", "On save", "Confirm or enter it yourself on Identifiers & profiles in Edit my profile"],
      ["Profile links (LinkedIn, X, Bluesky, Google Scholar, ResearchGate)", "Scholars", "On save", "Add or remove them yourself on Identifiers & profiles"],
    ],
  },
  {
    group: "Appointments & positions",
    rows: [
      ["Titles and appointments", "Enterprise Directory (faculty record)", "Nightly", "Request a change (routes to ITS Support, who fix a sync problem or escalate to Faculty Affairs). You can hide an appointment meanwhile"],
      ["Displayed title (the one under your name)", "Chosen by Scholars from your titles: a working title or leadership role can outrank your primary title", "Nightly", "Request a change and name the title you want (routes to ITS Support)"],
      ["Department and division", "Enterprise Directory, from your primary appointment", "Nightly", "Request a change (routes to ITS Support)"],
      ["Chair and chief titles", "Enterprise Directory", "Nightly", "Request a change if a chair role has ended (routes to ITS Support). A unit Owner or Curator can set a unit's leader"],
      ["Past appointments (earlier ranks)", "Enterprise Directory", "Nightly", "Hide or show each one yourself. Report a wrong one with Request a change"],
      ["Graduate School appointment", "Jenzabar (Graduate School)", "Occasional", "Request a change (routes to ITS Support)"],
      ["Institution (shown only when it isn't WCM)", "Enterprise Directory", "Nightly", "No in-app route; it follows your faculty record"],
      ["Whether you have a public profile (your person type)", "Enterprise Directory", "Nightly", "Follows your HR or faculty record"],
      ["Positions the directory omits (leadership roles, positions elsewhere)", "Scholars", "On save", "Add, edit, or remove them yourself. Shown on your profile only"],
    ],
  },
  {
    group: "Center roles",
    rows: [
      ["Center membership", "Scholars", "On save", "The center's Owner or Curator edits the roster. You can hide the Centers card"],
      ["Center director and program leader", "Scholars", "On save", "Set by the center's Owner or Curator"],
    ],
  },
  {
    group: "Clinical",
    rows: [
      ["Clinical trials (which trials, your role, status, sponsor)", "OnCore, the clinical trial management system", "Weekly, from an occasional export", "Corrected in OnCore; appears after the next export. You can hide the section"],
      ["Trial details (phase, summary, conditions, enrollment)", "ClinicalTrials.gov", "Weekly", "The study team updates the registration"],
      ["Board certifications, specialties, clinical expertise (used in search and CV export)", "weillcornell.org physician directory (POPS)", "Weekly", "Corrected in your weillcornell.org physician profile"],
      ["Clinical profile link", "Enterprise Directory (a weillcornell.org address)", "Nightly", "Follows your directory entry and NYP clinical affiliation"],
      ["Hospital position", "Enterprise Directory, NewYork-Presbyterian record", "Nightly", "Request a change (routes to ITS Support). You can hide it meanwhile"],
    ],
  },
  {
    group: "Education & honors",
    rows: [
      ["Education and training", "ASMS", "Nightly", "Request a change (routes to the Office of Faculty Affairs). You can hide an entry or the graduation years"],
      ["Honors and distinctions", "Scholars", "On save", "Add, edit, or remove them yourself. Not endowed chairs, which come through your title. Shown on your profile only"],
    ],
  },
  {
    group: "Mentoring",
    rows: [
      ["PhD thesis advisees", "Jenzabar (Graduate School)", "Nightly", "Request a change (routes to ITS Support). You can hide one meanwhile"],
      ["MD scholarly-project mentees (AOC, MD-PhD program, early-career)", "Medical Education rosters", "Occasional", "Request a change (routes to ITS Support). You can hide one meanwhile"],
      ["Postdocs you supervise", "Enterprise Directory, from HR reporting lines", "Nightly", "Request a change (routes to ITS Support, who escalate to HR). You can hide one meanwhile"],
      ["Mentees you add", "Scholars", "On save", "Add or remove them yourself under Mentees"],
      ["Suggestions from your co-authors (full-time faculty only)", "ReCiter", "Nightly", "Private until you accept one. Accept or dismiss each yourself"],
      ["Your postdoctoral mentor (on a postdoc's own profile)", "Enterprise Directory, from HR reporting lines", "Nightly", "Follows the HR reporting line. You can hide the card"],
      ["Papers with each mentee", "ReCiter", "Occasional", "Follows your publication list"],
    ],
  },
  {
    group: "Publications",
    rows: [
      ["Which publications are yours", "ReCiter, reading PubMed", "Nightly", <>Use Not mine in Edit my profile: it leaves your profile and search at once, and the rejection goes to ReCiter so it does not come back. Or reject it in {PmLink}</>],
      ["Publications not in PubMed", "Scopus, OpenAlex, or Web of Science, added by a library curator in ReCiter", "Nightly", "Ask the library curation team to add or remove one"],
      ["Publication details (title, authors, journal, DOI)", "PubMed, or the outside source for a curator-added paper", "Nightly", "Request a change (routes to ITS Support); the fix is made at PubMed"],
      ["MeSH topics (the Topics list)", "PubMed indexing, by way of ReCiter", "Nightly", "Set by NLM indexers. Hiding a paper drops its tags"],
      ["Citation count", "Scopus, by way of ReCiter", "Nightly", "Follows Scopus"],
      ["Citing papers", "NIH iCite", "Occasional", "Follows iCite"],
      ["Retractions", "PubMed", "Nightly", "Retracted papers are hidden everywhere automatically"],
      ["Selected highlights", "Scholars, from Impact scores", "Nightly", "Pick your own, or keep the automatic set"],
      ["Datasets (off unless you turn the section on)", "ReCiter database", "Weekly", "Turn the section on, then hide a dataset or mark it Not mine"],
    ],
  },
  {
    group: "Research areas & Impact",
    rows: [
      ["Research areas and subareas", "ReciterAI", "Nightly", "Computed; not hand-editable. Hiding a paper removes it"],
      ["Impact score (one per paper)", "ReciterAI", "Nightly", "Computed; not hand-editable"],
      ["Plain-language synopsis (one per paper)", "ReciterAI", "Nightly", "Computed; not hand-editable"],
      ["Methods and tools", "ReciterAI", "Nightly", "Computed. You can hide the section"],
      ["Core facilities (in a publication's details)", "ReciterAI", "Nightly", "The core's Owner or Curator confirms or rejects each one"],
      ["Home-page Spotlight", "ReciterAI", "Weekly", "Chosen by the model. Hiding a paper removes it"],
      ["Search vocabulary (the subject terms search understands)", "NLM MeSH", "Annual", "Loaded when NLM publishes each year"],
    ],
  },
  {
    group: "Funding & disclosures",
    rows: [
      ["Grants", "InfoEd, all sponsors", "Nightly", "Request a change (routes to Sponsored Research, OSRA). You can hide a grant"],
      ["Your role on a grant (PI, MPI, Co-I, Key Personnel)", "InfoEd", "Nightly", "Request a change (routes to OSRA)"],
      ["NIH grants from before WCM", "NIH RePORTER, matched to you", "Weekly", "Remove a wrong match with Not me in Edit my profile; details are fixed at NIH"],
      ["Grant abstracts", "NIH RePORTER, NSF, Gates Foundation", "Weekly", "From the funder's public record"],
      ["Papers linked to a grant", "NIH RePORTER", "Weekly", "Hide a paper that isn't yours"],
      ["Available technologies (licensable inventions)", "WCM Enterprise Innovation (Center for Technology Licensing) portfolio", "Weekly", "Ask Enterprise Innovation to correct the listing"],
      ["Disclosures (External relationships)", "WCM Conflicts-of-Interest system", "Nightly", <>Update it yourself in the <a href={WRG} className={LINK}>Weill Research Gateway</a></>],
    ],
  },
  {
    group: "News & media",
    rows: [
      ["News mentions", "WCM Newsroom", "Weekly", "Hide one, or use Not me for a wrong match. Name matches are reviewed first"],
      ["Media highlights", "WCM External Affairs' press digest", "Nightly", "Hide one, or use Not me for a wrong match. Each clip is reviewed first"],
    ],
  },
  {
    group: "Your profile page",
    rows: [
      ["Overview", "Scholars", "On save", "Write it yourself, or start from an AI draft"],
      ["Custom web address", "Scholars", "On approval", "Request one on the Profile URL card; an administrator approves it"],
      ["Profile editors", "Scholars", "On save", "Name up to 10 people to edit on your behalf"],
      ["Whether your profile is shown", "Scholars", "On save", "Use Hide my profile on the Visibility card"],
    ],
  },
];

const MAIN_CLASS = [
  "min-w-0 pb-24 pt-8 text-[var(--apollo-ink)]",
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
  "[&_th]:border-b-2 [&_th]:border-[#d3d8de] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:align-top [&_th]:text-[13px] [&_th]:font-semibold [&_th]:text-[var(--apollo-ink-2)]",
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
        <p className="text-[13px] font-semibold text-[var(--apollo-ink-2)]">About</p>
        <h1
          id="start"
          className="mt-1 scroll-mt-28 font-serif text-4xl font-semibold leading-tight tracking-tight lg:scroll-mt-20"
        >
          Scholars at Weill Cornell Medicine
        </h1>
        <p className="mt-3 text-lg leading-relaxed text-[var(--apollo-ink-2)]">
          How your profile is built, how to read it, and how to change the things that are yours to
          change.
        </p>

        <Callout variant="key" heading="Start here">
          <p>
            Scholars does not store a profile you fill out. It builds your profile from systems that
            already hold your information and shows a copy. That one fact answers most questions.
          </p>
          <ul>
            <li>
              <em>Where your data comes from.</em> Authoritative source systems: PubMed, Scopus,
              OpenAlex, the WCM Web Directory, the Enterprise Directory, ASMS, InfoEd, NIH RePORTER,
              NYP, the Graduate School, the WCM Newsroom, External Affairs&apos; press
              digest, and the COI system. On top of
              those sit two in-house layers. ReCiter decides which publications are yours. ReciterAI
              derives your research areas, the Impact score, and your synopses.
            </li>
            <li>
              <em>How you correct it.</em> Almost always at the source, not in Scholars. If you edit
              the copy, the next refresh overwrites it. You submit corrections through Edit my
              profile. Request a change either sends you to the tool where you fix it yourself or opens a prefilled email to the office that handles it.
            </li>
            <li>
              <em>What you control here.</em> A short list: your overview text, which records are
              shown, your Selected highlights, and the honors and positions you add yourself.
            </li>
          </ul>
        </Callout>

        <p>
          Scholars replaces VIVO, WCM&apos;s previous research-profile site. Like VIVO, it is mostly
          read-only. It assembles your profile from systems that already hold your information instead
          of asking you to fill one out. You do not enter publications, and there is no
          &ldquo;claim your profile&rdquo; step. Profiles are built automatically. Two names recur and
          are easy to confuse. <em>ReCiter</em> decides which publications are yours, which is author
          disambiguation. <em>ReciterAI</em> works out what a publication is about and how notable it
          is: your research areas, the Impact score, and the one-line synopsis. They do different
          jobs.
        </p>

        <p>
          <strong>Where Scholars goes beyond VIVO.</strong> Two things changed. First, you have
          more control over your own profile. Publication attribution through{" "}
          <a href={PM} className={LINK}>
            ReCiter Publication Manager
          </a>{" "}
          (confirming the papers that are yours and rejecting the ones that aren&apos;t) carried over
          from the VIVO era and works as it did before. What&apos;s new with Scholars is
          profile-level self-service: you write your own overview, hide or restore individual papers,
          choose which of your papers appear as Selected highlights, and can request a name-based
          custom web address. Second, there are more ways for your work and expertise to surface:
          representative papers in the home Spotlight, the research areas you publish in, the specific
          methods and tools your published work draws on, and expert listings that place you among the
          most active faculty in an area.
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
              a: "ReCiter matched it, or it hasn’t yet. You can hide a wrong match for now. The real fix is to reject it in Publication Manager.",
            },
            {
              href: "#provenance",
              q: "Where does the information on my profile come from?",
              a: "From authoritative source systems, plus the ReCiter and ReciterAI computed layers. Most fields are corrected at the source.",
            },
            {
              href: "#showcase",
              q: "Why isn’t my best paper a “Selected highlight”?",
              a: "By default they are picked automatically from Impact, author position, recency, and publication type. You can also pick your own on your Edit my profile page.",
            },
            {
              href: "#search",
              q: "Why isn’t my publication showing up in search?",
              a: "Usually the index hasn’t rebuilt yet, your search terms don’t match, or the paper is hidden. Search is separate from your profile.",
            },
            {
              href: "#center-admin",
              q: "How do I add or remove a member of my center?",
              a: "A center Owner or Curator edits the roster in the app. Center membership is one of the few shared institutional fields Scholars itself owns.",
            },
            {
              href: "#profile-url",
              q: "Can I change my profile’s web address?",
              a: "You can request a custom, name-based address on your Edit my profile page, and the Scholars team approves it. Your existing address keeps working and redirects to the new one.",
            },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-[#f6f7f9]"
            >
              <span className="font-medium text-[#7d1c1c]">{item.q}</span>
              <span className="mt-0.5 block text-sm text-[var(--apollo-ink-2)]">{item.a}</span>
            </Link>
          ))}
        </div>

        <hr className="mt-12 border-border" />
        <p className="mt-8 text-[13px] font-semibold text-[var(--apollo-ink-2)]">
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
            { href: "#center-admin", t: "A center administrator", d: "You manage a center roster, shared institutional data that Scholars itself owns." },
          ].map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="rounded-[10px] border border-border p-4 no-underline hover:border-[#7d1c1c]"
            >
              <span className="block font-medium text-[#7d1c1c]">{c.t}</span>
              <span className="mt-1 block text-sm text-[var(--apollo-ink-2)]">{c.d}</span>
            </Link>
          ))}
        </div>

        <h2 id="scholar">Scholar (faculty)</h2>
        <p>
          Your profile is assembled for you automatically. Your name comes from the Enterprise Directory (ED), and you change it in the WCM Web Directory; your title from the Enterprise Directory (ED), usually following your primary
          ASMS appointment, though a &ldquo;working title&rdquo; set in ED, a division-chief or center-director role, or a title a Scholars administrator picks for you on request can take its place; and your
          primary department from ASMS, the system of record for your primary appointment. Your
          publications are matched to you by ReCiter from PubMed. Your funding comes from two
          systems: InfoEd, WCM&apos;s grants system of record for active and recent awards across all
          sponsors, and NIH RePORTER, which backfills NIH grants InfoEd never held (those from a
          prior institution and older WCM history); for NIH-funded work, RePORTER also supplies
          the abstract text and the NIH-portfolio link. Disclosures come from the COI system, and a NewYork-Presbyterian
          position from NYP. Your research areas, the Impact numbers, and the synopses are computed by
          ReciterAI.
        </p>
        <p>
          <strong>What you can change yourself,</strong> on your Edit my profile page at{" "}
          <code>/edit/scholar/[your CWID]</code>:
        </p>
        <ul>
          <li>Your overview text, and your Selected highlights.</li>
          <li>
            Which records appear. Hide a publication that isn&apos;t yours, or a grant, education
            entry, or mentee relationship, and restore any of them later. Every change is reversible
            and recorded.
          </li>
          <li>
            Honors and distinctions, and positions the directory does not carry, which you add
            yourself because no upstream system holds them.
          </li>
          <li>
            Who else may edit your profile, so an assistant or coordinator can maintain it for you.
          </li>
          <li>
            A data correction for a field that comes from another system. Use Request a change. It sends you to the tool where you fix it yourself, or opens a prefilled email to ITS Support or the office
            that owns the field.
          </li>
        </ul>
        <p>
          The full list, with the mechanics for each, is in{" "}
          <Link href="#control" className={LINK}>
            What you control
          </Link>
          .
        </p>
        <p>
          Your profile also has a stable web address you don&apos;t normally need to touch. A custom
          one can be requested on your Edit my profile page, and the Scholars team approves it (see{" "}
          <Link href="#profile-url" className={LINK}>
            Your profile URL
          </Link>
          ).
        </p>
        <p>
          <strong>What you cannot change directly</strong> are the source-of-record fields. For a
          publication that isn&apos;t yours, hide it as a quick fix, then reject it in{" "}
          <a href={PM} className={LINK}>
            ReCiter Publication Manager
          </a>
          . That corrects the attribution at the source so it does not come back. A missing
          publication is added there too, by you or the library curation team, whoever gets to it
          first. Your name, department, title, funding, disclosures, and appointments are all
          corrected at their source: use Request a change. For your name and disclosures it sends you to the tool where you fix them yourself. For the rest it opens an email to the office that handles the field. Research
          areas, Impact, and synopsis are computed by ReciterAI and cannot be hand-edited. The full
          map is in{" "}
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
          its Impact. A paper with no full-time WCM faculty author is outside the scope and is not
          scored. That is a matter of scope, a cost-and-scale choice, not a judgment on quality (see{" "}
          <Link href="#impact" className={LINK}>
            why the scope stops there
          </Link>
          ).
        </p>
        <p>
          To correct your academic appointment, use Request a change on your Edit my profile page.
          Your postdoc record reaches Scholars through the Enterprise Directory, which draws on WCM&apos;s HR employee records. The request is
          routed to ITS support, who either fix a data-sync (ETL) issue in the pipeline or escalate a
          genuine source-record correction to the office that owns your record. Either way, the fix flows back through
          the Enterprise Directory on the next refresh. Your self-serve controls (overview, hide and
          restore, submit a correction) are the same as a faculty member&apos;s.
        </p>

        <h2 id="dept-admin">Department or division administrator</h2>
        <p>
          You mostly read and report. But if you hold a curation role on a unit, you also have a
          real in-app editor (see{" "}
          <Link href="#roles" className={LINK}>
            Roles
          </Link>
          ).
        </p>
        <p>
          Anyone can browse a unit&apos;s output (its faculty, research areas, and publications) on the
          department and division pages. An Owner or Curator of a unit can edit
          unit-level data at <code>/edit/department/[code]</code> or{" "}
          <code>/edit/division/[code]</code>: unit metadata (description, website link, and
          leadership; changing a unit&apos;s web address is Superuser-only) and
          the roster of a manually-created division. LDAP-sourced division membership stays with ED
          and is not editable here. A Superuser can do all of this across every unit and grant
          roles.
        </p>
        <p>
          No role lets you move someone between departments. A unit Owner or Curator can, however, edit the overview, positions, and honors of a faculty member in the unit, and hide records on that person&apos;s
          profile. Primary department is derived from a person&apos;s primary appointment (Faculty
          Affairs, by way of ASMS and the Enterprise Directory). It isn&apos;t directly editable, and
          it changes only when the appointment does. The two personal controls, overview and
          publication visibility, are the scholar&apos;s own, though a unit Owner or Curator may also change them, and each such edit is audit-logged. Owners and Curators can run the Publications and NIH-funded publications reports for their unit themselves at <code>/edit/reports</code>. For other recurring reports by research area,
          date, or funding, ask the Scholars team through{" "}
          <Link href="#requests" className={LINK}>
            Request a change
          </Link>
          .
        </p>
        <p>
          Set expectations with your faculty. Impact is publication-level, not a ranking of your
          people (
          <Link href="#impact" className={LINK}>
            the Impact score
          </Link>
          ). Research areas are model-derived (
          <Link href="#research-areas" className={LINK}>
            Research areas
          </Link>
          ). And the showcase surfaces are algorithmic (
          <Link href="#showcase" className={LINK}>
            Spotlight
          </Link>
          ).
        </p>

        <h2 id="center-admin">Center administrator</h2>
        <p>
          Like a department or division Owner or Curator, you have a data responsibility native to Scholars.{" "}
          <strong>
            Center membership is one of the <em>institutional</em> fields whose system of record is
            Scholars itself
          </strong>
          . Unit and division metadata and manually-created division rosters are Scholars-owned too,
          and that set is likely to grow. Your overview, publication-visibility choices, and Selected
          highlights are stored here as well, but those are an individual&apos;s own profile rather
          than shared data about the institution. Center rosters are not held anywhere upstream, so
          they are maintained in this application, and they are self-serve for the right roles.
        </p>
        <p>
          A center Owner or Curator manages the roster at <code>/edit/center/[code]</code>: add,
          remove, or update a member, with membership type, program, and start and end dates. Every
          change is one transaction and is audit-logged. If you do not have a role yet, a Superuser
          grants you one (so can a comms steward, and an Owner can grant Owner or Curator roles on their own center), or you can request
          access through{" "}
          <Link href="#requests" className={LINK}>
            Request a change
          </Link>
          .
        </p>
        <p>
          Everything else about your center&apos;s people (names, titles, departments, publications,
          funding, research areas, scores) comes from the same sources and follows the same correction paths
          as any scholar. You route those. You do not own them.
        </p>

        <hr className="mt-12 border-border" />
        <p className="mt-8 text-[13px] font-semibold text-[var(--apollo-ink-2)]">
          Part 2: shared reference
        </p>

        <h2 id="provenance">Where your data comes from</h2>
        <p>
          Nearly every part of a profile traces to a system of record. Scholars shows a copy and
          cannot override the source; corrections made upstream appear here after the next refresh.
          The exceptions are the things you add or choose in Scholars itself, marked
          &ldquo;Scholars&rdquo; below.
        </p>
        <ProvenanceFlow />
        <p className="text-[15px] text-[var(--apollo-ink-2)]">
          In all, <span className="tabular-nums">25</span> sources feed Scholars.{" "}
          <span className="tabular-nums">15</span> are WCM systems: the Enterprise Directory, the
          Web Directory, ASMS, InfoEd, the Conflicts-of-Interest system, ReCiter, ReciterAI,
          OnCore, Jenzabar, the Medical Education rosters, the weillcornell.org physician
          directory, Enterprise Innovation, the WCM Newsroom, External Affairs&apos; press digest,
          and WCM Identity. <span className="tabular-nums">10</span> are outside sources: PubMed,
          Scopus, OpenAlex, Web of Science, NIH iCite, NIH RePORTER, NSF, the Gates Foundation,
          ClinicalTrials.gov, and NLM&apos;s MeSH vocabulary.
        </p>
        <p>
          The full map, field by field. <em>Nightly</em> runs overnight. <em>Weekly</em> runs on
          Sundays. <em>Occasional</em> means someone runs an export by hand, with no schedule, so
          that data is only as current as its last export. <em>On save</em> takes effect as soon as
          you save.
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
            {PROVENANCE.map((g) => (
              <tbody key={g.group}>
                <tr>
                  <th
                    colSpan={4}
                    scope="colgroup"
                    className="!pt-5 !text-xs !uppercase !tracking-wide !text-[var(--apollo-ink)]"
                  >
                    {g.group}
                  </th>
                </tr>
                {g.rows.map(([what, source, refresh, fix]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td className="!text-[13px] !text-[var(--apollo-ink-2)]">{source}</td>
                    <td>{refresh}</td>
                    <td>{fix}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p>A few less obvious behaviors the map explains:</p>
        <ul>
          <li>
            Most publications reach your profile because ReCiter matched them to you from PubMed. A
            paper that is not in PubMed can still appear, but only if a library curator adds it in
            ReCiter from an outside source such as Scopus, OpenAlex, or Web of Science. Those papers
            are labeled with their source (for example <em>Source: Scopus</em>) and carry a DOI
            rather than a PMID. They are added deliberately, not matched automatically, so
            ReCiter&apos;s attribution scoring never sees them.
          </li>
          <li>
            MeSH &ldquo;check tags&rdquo; (Humans, Male, Female, Adult, and so on) are filtered out by
            ReciterDB before Scholars sees them, so they never appear as topics. That is intended,
            not a gap.
          </li>
          <li>
            A copy can lag its source. A correction you make today appears only after the next
            refresh, and for an occasional source, only after the next export. Your photo is the
            exception: it is shown live from the Web Directory, so a change appears right away.
          </li>
          <li>
            A correction to directory or appointment data (department, title, an appointment, a
            hospital position, or a mentee) goes through Request a change and is routed to ITS
            Support. A wrong value can be one of two things: a source-record error, which they
            escalate to the owning office such as Faculty Affairs, or a data-sync problem in the
            pipeline, which they fix directly. That routing is the trade-off for showing an
            authoritative copy rather than a hand-kept duplicate.
          </li>
        </ul>

        <h3 id="disclosures" className="scroll-mt-28 lg:scroll-mt-20">
          Disclosures
        </h3>
        <p>
          Disclosures are the financial interests and outside relationships a scholar reports to
          WCM. Their system of record is the Weill Research Gateway, WCM&apos;s conflict-of-interest system, they refresh nightly,
          and on a profile they are shown as External relationships, grouped by category. You manage
          your own disclosures in the{" "}
          <a href={WRG} className={LINK}>
            Weill Research Gateway
          </a>
          ; Scholars shows a copy and cannot edit it. A change you make there appears after the next
          nightly refresh. If a disclosure you have ended still shows here, use Request a change,
          which routes to ITS Support.
        </p>

        <h2 id="correct">How to correct something</h2>
        <p>
          Your Edit my profile page is the front door. It lets you edit your overview, hide or
          restore records, and submit a data correction through Request a change, which routes to
          the office that owns the field or sends you to the tool where you fix it yourself. You
          never have to figure out where to send it. The rule of thumb: if Scholars owns the field,
          it is fixed here; otherwise the fix happens at the source and appears after the next
          refresh.
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
                <td>ReCiter, from Edit my profile or Publication Manager</td>
                <td>
                  Use Not mine next to it. It leaves your profile and search right away, and the
                  rejection goes to ReCiter so it does not return. You can also reject it in{" "}
                  {PmLink}
                </td>
              </tr>
              <tr>
                <td>A publication that is yours is missing</td>
                <td>ReCiter Publication Manager</td>
                <td>
                  Add or confirm it at{" "}
                  <a href={PM} className={LINK}>
                    reciter.weill.cornell.edu
                  </a>
                  , you or the library curation team, whoever gets there first. A paper that is not
                  in PubMed at all is added by a library curator from an outside source such as
                  Scopus or OpenAlex
                </td>
              </tr>
              <tr>
                <td>A wrong field on a publication (title, author order, DOI)</td>
                <td>PubMed, or the outside source for a curator-added paper</td>
                <td>Request a change (routes to ITS Support); the record is corrected at PubMed</td>
              </tr>
              <tr>
                <td>Your preferred name, email, or photo</td>
                <td>WCM Web Directory</td>
                <td>Update it yourself in the {WebDirLink}. A new photo shows right away</td>
              </tr>
              <tr>
                <td>Your degrees or education</td>
                <td>ASMS</td>
                <td>Request a change (routes to the Office of Faculty Affairs)</td>
              </tr>
              <tr>
                <td>Your title, department, division, or an appointment</td>
                <td>Enterprise Directory, from your faculty record</td>
                <td>
                  Request a change (routes to ITS Support, who fix a sync problem or escalate to
                  Faculty Affairs). For your displayed title, name the title you want shown
                </td>
              </tr>
              <tr>
                <td>A postdoc or fellow academic appointment</td>
                <td>Faculty Affairs, by way of the Enterprise Directory</td>
                <td>
                  Request a change, routed to ITS Support, who fix a data-sync issue or escalate a
                  source correction to Faculty Affairs
                </td>
              </tr>
              <tr>
                <td>A Graduate School appointment, or a mentee</td>
                <td>Jenzabar, the Medical Education rosters, or the Enterprise Directory</td>
                <td>Request a change (routes to ITS Support). You can hide a mentee meanwhile</td>
              </tr>
              <tr>
                <td>A mentee is missing</td>
                <td>Scholars</td>
                <td>
                  Add them under Mentees in Edit my profile. Co-authors with a trainee-type
                  appointment are listed there under &ldquo;From your publications&rdquo; for you to
                  accept or dismiss.
                </td>
              </tr>
              <tr>
                <td>Your hospital position</td>
                <td>Enterprise Directory, NewYork-Presbyterian record</td>
                <td>Request a change (routes to ITS Support)</td>
              </tr>
              <tr>
                <td>Your funding or grants</td>
                <td>InfoEd; NIH RePORTER for NIH grants from before WCM</td>
                <td>
                  Request a change for an InfoEd grant (routes to Sponsored Research, OSRA). A
                  RePORTER grant is matched to you from your publications, so remove a wrong match
                  with Not me in Edit my profile
                </td>
              </tr>
              <tr>
                <td>A disclosure</td>
                <td>Weill Research Gateway</td>
                <td>
                  Update it yourself in the{" "}
                  <a href={WRG} className={LINK}>
                    Weill Research Gateway
                  </a>
                </td>
              </tr>
              <tr>
                <td>A clinical trial</td>
                <td>OnCore</td>
                <td>Corrected in OnCore; appears after the next export</td>
              </tr>
              <tr>
                <td>A board certification or specialty</td>
                <td>weillcornell.org physician directory</td>
                <td>Corrected in your weillcornell.org physician profile</td>
              </tr>
              <tr>
                <td>A wrong research area, Impact score, or synopsis</td>
                <td>ReciterAI (computed)</td>
                <td>
                  Not hand-editable. Report a systematic error through the{" "}
                  <Link href="/about/feedback" className={LINK}>
                    feedback form
                  </Link>
                </td>
              </tr>
              <tr>
                <td>A wrong or missing available technology</td>
                <td>WCM Enterprise Innovation</td>
                <td>Ask Enterprise Innovation to correct its portfolio; flows in on the next weekly refresh</td>
              </tr>
              <tr>
                <td>Center membership</td>
                <td>Scholars</td>
                <td>
                  A center Owner or Curator edits it at <code>/edit/center/[code]</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 id="control">What you control</h2>
        <p>These are yours to do directly, on your Edit my profile page:</p>
        <ul>
          <li>
            <strong>Your overview text.</strong> The free-text statement about your work. You write
            it, or start from an AI draft built from your own record and edit it before you save.
          </li>
          <li>
            <strong>Hide or restore a record.</strong> Not just publications: you can also hide a
            grant, an education entry, or a mentee relationship. Hiding is reversible and recorded.
            It also reaches search within moments: a hidden paper or grant stops being listed under
            your name there, though a paper with other Weill Cornell authors stays searchable under
            their names (
            <Link href="#search" className={LINK}>
              more on that below
            </Link>
            ). For a publication that isn&apos;t yours, use &ldquo;Not mine?&rdquo; next to it
            rather than Hide. It removes the paper from your profile and search right away and sends
            the rejection to ReCiter, which corrects the attribution at the source so it does not
            return. You can also reject it in{" "}
            <a href={PM} className={LINK}>
              Publication Manager
            </a>{" "}
            directly.
          </li>
          <li>
            <strong>Add an honor or distinction.</strong> Academy memberships, investigatorships, and
            prizes. You or a curator enter these, because no upstream system holds them. Endowed
            chairs are the exception: those arrive through your title and should not be added here.
          </li>
          <li>
            <strong>Add a position the directory does not carry.</strong> WCM roles the feed omits,
            such as Program Director or Head of Section, and current or past posts at other
            institutions. Both of these show on your profile only, not in search or on department,
            division, and center pages.
          </li>
          <li>
            <strong>Choose your Selected highlights.</strong> The small set of papers featured on
            your profile (shown as Highlights). By default these are chosen from papers where you are first or senior author, by Impact, recency, and publication type; you can instead pick
            them yourself.
          </li>
          <li>
            <strong>Name someone to edit on your behalf.</strong> You manage your own profile
            editors, so an assistant or coordinator can maintain your profile for you.
          </li>
          <li>
            <strong>Submit a data correction.</strong> For a field you cannot edit directly, use
            Request a change and it routes to the office that owns the field.
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
          (departments, divisions, centers, core facilities, and institutions), governed by the three roles below. A Communications Steward also has Superuser-level curation rights, except creating or removing units.
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
                <td>Edit that unit&apos;s curated data; grant Owner or Curator roles on it (a department Owner also covers its divisions)</td>
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
          Roles are unit-scoped: a role on one center does not grant access to another, and every
          edit is audit-logged. What&apos;s curatable: center rosters and metadata, manually-created
          division rosters, and unit metadata (description, website link, and leadership). What&apos;s
          not: a scholar&apos;s source-of-record fields. A unit&apos;s Owners and Curators can also
          help maintain the profiles of that unit&apos;s scholars, for example by editing an
          overview or hiding a publication, and each such edit is logged.
        </p>
        <p>
          Roles come from two places. Some are imported from the Enterprise Directory as maintained in
          the WCM Web Directory for an org unit: a unit&apos;s Department Administrators become Owners
          of that unit, as do Division Administrators who hold the IAMDELA delegation. Other Division
          Administrators and IAMDELA delegates become Curators. On top
          of that, a Superuser grants Owner and Curator roles inside Scholars, and a unit Owner (a
          Department Administrator, for example) can assign additional Owners or Curators for their unit.
          These curation roles are separate from the ED person-type (faculty / appointee) that
          categorizes people on their profiles.
        </p>
        <p>
          Separately, a scholar can assign a <strong>proxy</strong> to act on their own profile.
        </p>

        <h2 id="research-areas">Research areas</h2>
        <Callout variant="key" heading="Two axes: what, and how">
          <p>
            A scholar&apos;s work is described along two axes. <em>Research areas</em> capture{" "}
            <strong>what</strong> you study. <em>Methods and tools</em> capture <strong>how</strong>{" "}
            you study it. They are derived independently and shown separately, and together
            they give a fuller picture than either alone.
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
          roadmap, and NIH research designations. It aligned cleanly with all three. What the model
          surfaced from the literature mirrors how the institution and the wider field already
          organize science.
        </p>
        <p>
          Each publication is then placed on that map. ReciterAI scores each paper against every
          research area, using a plain-language synopsis of the paper together with its abstract, then
          associates the paper with all the research areas it relates to (and, within each, zero or
          more subareas), each carrying its own relevance score. Because real research often spans
          several areas, a single paper is commonly associated with more than one. A scholar&apos;s
          areas, shown on research-area pages, in search, and in each paper&apos;s detail view,
          reflect the balance of their published work. The profile page itself lists Topics, which
          come from MeSH keywords, not research areas.
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
          <em>Cancer Biology</em> more loosely. All three are kept. There is no single
          &ldquo;primary&rdquo; area, because the work genuinely sits across them. Within Aging &amp;
          Geroscience it is then placed into finer subareas (here <em>Immune Aging</em> as the
          best fit, with <em>Cellular Senescence</em> secondary). A paper that fits no subarea cleanly
          is left unassigned rather than forced into one.
        </p>
        <Callout variant="warn" heading="A second score, a click deeper">
          <p>
            Each publication-to-area pairing carries a <em>relevance</em> score from 0 to 1: in
            the example, roughly 0.85 for Aging &amp; Geroscience, 0.78 for Immunology, and 0.42 for
            Cancer Biology. It measures how central the paper is to <em>that</em> area, a different
            question from the Impact score&apos;s &ldquo;how notable is this paper overall.&rdquo; A
            paper can be highly relevant to an area yet modest in Impact, or the reverse. On a
            research-area page, relevance decides which papers appear in the default Strongly
            relevant list, with the rest under Also relevant. It is also combined with Impact to pick
            the area&apos;s Spotlight papers, so a paper is featured there when it is both central to
            the area and notable. Neither score appears in listings today: publication lists and
            search results show no number at all. Both surface when you open a publication&apos;s
            detail view. Impact reads &ldquo;Impact&rdquo; followed by a value out of 100, and each
            research area shows its relevance as a bar with a value from 0 to 1.
          </p>
        </Callout>
        <p>
          <strong>Freshness.</strong> The taxonomy (the set of research areas itself) is stable
          between rebuilds and is recomputed only periodically, when the field has shifted
          enough to warrant it, not on a fixed clock. Your publications, though, are classified into
          the current taxonomy on a weekly run as new work is ingested, so an individual paper does
          not wait for a taxonomy rebuild to receive its areas, and your profile keeps up as you
          publish. An area can shift when the taxonomy is next rebuilt, and that is expected.
          Research-area scoring reads the paper&apos;s plain-language synopsis together with its
          abstract; a paper without an abstract is still scored from its synopsis. Subarea assignment
          instead reads the title together with the synopsis, not the abstract. A genuinely wrong area
          is a ReciterAI matter. Request a change has no option for research areas, so if areas look wrong across many of your papers, tell us through the site&apos;s Feedback link.
        </p>

        <h2 id="methods">Methods &amp; tools</h2>
        <p>
          Methods and tools describe <em>how</em> a scholar does their research: the techniques,
          instruments, datasets, models, and software behind the work. They are read directly from
          the publications themselves. ReciterAI scans the abstracts of each Weill Cornell
          scholar&apos;s papers and grants and identifies the specific methods and resources actually
          used, skipping the commodity lab staples that don&apos;t distinguish one group from
          another.
        </p>
        <p>
          Closely related mentions are merged, so that &ldquo;MRI,&rdquo; &ldquo;magnetic resonance
          imaging,&rdquo; and &ldquo;MRI scanner&rdquo; become a single entry, and they are grouped
          into broader capability families, so a profile reads at the right level rather than as a
          list of synonyms. Routine staples that nearly every lab uses, such as PCR or a t-test, are
          set aside and never count toward a profile.
        </p>
        <p>
          <strong>How methods are organized.</strong> Behind each entry sits a four-level
          structure, from most specific to most general:
        </p>
        <ul>
          <li>
            <strong>Raw mention.</strong> The exact phrase as it appeared in a paper, such as
            &ldquo;scRNA-seq&rdquo; or &ldquo;single-cell RNA sequencing.&rdquo;
          </li>
          <li>
            <strong>Canonical method.</strong> The single standard name those mentions resolve to
            (&ldquo;single-cell RNA sequencing&rdquo;).
          </li>
          <li>
            <strong>Family.</strong> The capability group of related techniques it belongs to
            (&ldquo;single-cell genomics&rdquo;).
          </li>
          <li>
            <strong>Supercategory.</strong> The broad domain above the family.
          </li>
        </ul>
        <p>
          A profile shows methods at the family level, with a few representative tools shown when you hover a family, and search
          and the methods pages use the same structure.
        </p>
        <p>
          <strong>The same paper, on methods.</strong> From our example&apos;s abstract, ReciterAI
          picks out <em>single-cell RNA sequencing</em>, the <em>10x Genomics</em> platform, and{" "}
          <em>CITE-seq</em>, and it ignores the routine qPCR validation step, a commodity staple
          that doesn&apos;t distinguish one lab from another. &ldquo;scRNA-seq&rdquo; and
          &ldquo;single-cell RNA sequencing&rdquo; collapse into one entry, filed under a broader{" "}
          <em>single-cell genomics</em> capability family. On the
          scholar&apos;s own profile, their methods are ordered by how much they themselves use each
          one.
        </p>
        <p>
          Because this is drawn from a scholar&apos;s own publications, it reflects demonstrated,
          hands-on use rather than self-reported interests. ReciterAI refreshes the methods data
          periodically rather than on a fixed schedule, so methods from a new paper appear only
          after its next refresh.
        </p>
        <p>
          From a scholar&apos;s publications, a method is attributed to them only when they were
          first or senior (last) author on the paper it was drawn from. Grant abstracts help
          ReciterAI recognize and group methods, but they never add a method to a profile. This errs toward under-attribution on purpose: it keeps the list to methods the
          scholar themselves led, at the cost of occasionally omitting one they used as a middle
          author on a large collaboration. Better to show fewer, surer methods than to over-claim.
        </p>

        <h2 id="impact">The Impact score</h2>
        <p>
          The Impact score is a number from 0 to 100 that ReciterAI assigns to a publication, shown
          when you open the publication&apos;s detail view. The model reads the paper&apos;s title and
          abstract, its journal and date, and its citation figures (the iCite citation count, plus the
          NIH percentile and Relative Citation Ratio when those exist). It weighs novelty, rigor,
          evidence of influence, practical relevance, and the standing of the journal. A calibrated model combines them into a single number by comparing
          the paper against a fixed ladder of reference points (described below). It is not a
          hand-tuned formula. It is a judgment the model makes against that ladder, which is why two
          papers with comparable evidence land at comparable scores.
        </p>
        <h3>What the score is for, and what it isn&apos;t</h3>
        <p>
          The Impact score has a narrow job. Inside Scholars it is used mainly to help the
          application decide <em>which of your own publications to surface</em>: on the home-page
          showcase, in your profile&apos;s highlights, on a research-area page. It is an input to that
          choice, not a verdict on you, and the aim of surfacing is to give every researcher&apos;s
          strongest work its due rather than letting a few famous papers crowd everyone else out. It
          is <strong>not</strong> a ranking of scholars, and it is not used to evaluate people for
          promotion, funding, or effort.
        </p>
        <p>
          It is also a <em>leading</em> indicator. Field-normalized citation metrics like the NIH
          percentile and the Relative Citation Ratio (RCR) need two to three years of accumulated
          citations to settle, so for a paper published this month they do not yet exist. The Impact
          score reads what is already available (the venue, the abstract, and the earliest
          citation signal) to estimate early where the paper is likely to land. The paper is scored
          once. The percentile and RCR are folded in only if ReciterAI later runs a full rescore by hand. That lets you and your
          department act on new work without waiting years for the citation record to catch up.
        </p>
        <p>
          It is not a direct measure of quality. The model is asked to weigh novelty and rigor as well
          as influence and venue, but it sees only the title, abstract, journal, date, and citation
          figures, never the full paper. A careful negative result, a foundational methods paper, or a
          study in a small field can matter enormously and still carry a modest score, and a heavily
          cited but incremental paper can carry a high one. Read it as &ldquo;how visible and
          well-placed is this paper,&rdquo; not &ldquo;how good is this science.&rdquo;
        </p>
        <h3>How to read the number</h3>
        <p>
          The model scores against a fixed ladder of about seventy-five reference points spanning all
          of biomedicine, so the same number means the same thing in any field. The bands are
          demanding. Preliminary or underpowered work sits in the low tier (a letter to the editor
          anchors at 8, a single-patient case report near 12). Solid but incremental studies fall in
          the 30s and 40s. The 50s and 60s already denote strong contributions with clear influence,
          and the 70s and 80s are major, practice-shaping or field-shaping work. So a score that looks
          modest is not a poor grade: a paper in the 60s is, by this rubric, a strong and influential
          one.
        </p>
        <Callout variant="note" heading="High scores are rare">
          <p>
            The top of the ladder is held for paradigm-shifting, field-defining work (the
            discovery of the DNA double helix anchors at 99, penicillin at 97, CRISPR-Cas9
            genome editing at 93), so the scale is demanding and the model is sparing with high
            numbers. There is no fixed ceiling for a real paper, but very high scores are uncommon.
            The practical effect is that a number which looks middling can still mark one of a
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
          is calibrated for parity. The ladder rates clinical trials, health-services research, and
          implementation work on the same terms as bench science, and the scorer runs a
          counterfactual check (would this same evidence score higher attached to a basic-science
          paper?) and corrects itself when the answer is yes. Clinical, implementation, and
          health-services work can reach the same heights as bench discovery.
        </p>
        <p>
          <strong>Which publications are scored.</strong> The scoring scope is full-time WCM faculty
          only: ReciterAI scores the substantive research articles (from 2020 onward) that have at
          least one full-time WCM faculty author, and the Impact then appears on that publication
          wherever it shows, including on a co-author&apos;s or trainee&apos;s view. A publication
          with no full-time WCM faculty author is outside the scope and is not scored. Publication{" "}
          <em>type</em> matters too. Only research articles are scored, so Reviews, Case Reports,
          Letters, and Editorials carry no Impact and do not appear on the surfaces it feeds (see{" "}
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
          above, first-authored by a WCM faculty member in a leading journal. It was scored when it was
          only months old, before it had an NIH percentile or RCR, so the model worked from the venue,
          the abstract, and its first handful of citations and assigned <strong>Impact: 84</strong>,
          a high score, which the model assigns sparingly. That same 84 shows in the paper&apos;s detail
          view wherever you open it (from the first author&apos;s profile, a middle co-author&apos;s, or a
          trainee&apos;s) because it describes the paper, not any one author.
        </p>
        <p>
          <strong>How often it updates.</strong> Scholars copies Impact scores and synopses from
          ReciterAI every night. ReciterAI scores a new publication once, usually within a day or two
          of it appearing. It does not re-score a paper when its citation count changes.
          Scores change only when ReciterAI runs a full rescore, which is done by hand.
        </p>
        <p>
          <strong>Why a publication can show no Impact.</strong> When a paper has no score, its
          detail view simply leaves the Impact section out. This is not a quality judgment. Usually the
          paper is outside the scoring scope (published before 2020, not a research article, or with no
          full-time WCM faculty author), or it is very recent and not yet scored.
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
                <td>Yes, in a publication&apos;s detail view</td>
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
            The search index rebuilds nightly, but a hide reaches search within seconds. When
            you hide a paper from your profile, your name comes off that paper in search and it
            stops counting toward your own search results. The paper itself stays in search as long
            as another WCM author still shows it. If every WCM author hides it, it leaves search entirely.
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
          ). Your Highlights use one formula
          (the ReciterAI Impact score multiplied by author position, publication type, and recency).
          The other surfaces use their own rules, shown in the table. Only research articles receive an Impact score or a research-area tag, so Reviews, Case
          Reports, Letters, and Editorials do not appear on these surfaces.
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
                <td>Spotlight</td>
                <td>Home page</td>
                <td>One featured subarea per research area, with a short summary and three of its papers; up to eight cards show at a time</td>
                <td>Chosen by ReciterAI, which checks monthly for a new set; Scholars picks up the latest set each week</td>
              </tr>
              <tr id="selected-highlights" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Selected highlights</td>
                <td>A scholar&apos;s profile</td>
                <td>That scholar&apos;s most notable papers</td>
                <td>The three highest by Impact, weighted by publication type and age (papers under six months old are left out), restricted to first- or senior-author papers. A scholar may instead curate these manually.</td>
              </tr>
              <tr id="recent-highlights" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Spotlight</td>
                <td>Research area page</td>
                <td>Three notable papers in a research area</td>
                <td>Research articles from 2020 onward with Impact of 40 or more, first- or senior-authored by full-time faculty; ranked by fit to the area and Impact. Middle-author papers fill in only when fewer than three qualify.</td>
              </tr>
              <tr id="top-scholars" className="scroll-mt-28 lg:scroll-mt-20">
                <td>Scholars in this area</td>
                <td>Research area page</td>
                <td>Full-time faculty most active in a research area</td>
                <td>Sum of how strongly their first- or senior-author papers (2020 onward) fit the research area, weighted by publication type and a mild recency factor; updated nightly</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          So the honest answer to &ldquo;why isn&apos;t my Cell paper a Selected highlight&rdquo; is
          usually that it is not a first- or senior-author paper, it is less than six months old,
          it has no Impact score (for example, it is not a research article), or three other papers simply rank higher. The same paper can be featured on one surface and not
          another, because the filters differ.
        </p>
        <Callout variant="note" heading="A representative selection, not a complete list">
          <p>
            Read these surfaces as a <em>representative selection</em> of a scholar&apos;s work, a
            curated highlight rather than a complete or proportional inventory. Most feature only
            research articles from 2020 onward on which the scholar is <em>first or senior (last)
            author</em>; co-first and co-senior authors count too, since equal-contribution
            authorship is tracked upstream. This is a signal-to-noise choice: a faculty
            member&apos;s first- and senior-author papers are the ones they led or supervised, so
            restricting to them gives a truer picture of what a scholar drives than a feed that also
            pulled in every large-consortium paper they were a middle author on. The cost is real. It
            leaves out some work that genuinely reflects expertise, such as key collaborations where
            the scholar contributed without leading, but it keeps the highlighted set focused rather
            than crowded. The selection is curated and not meant to be exhaustive: every paper
            attributed to a scholar, in any author position, still appears in full on their profile
            and in search.
          </p>
        </Callout>
        <h3>Who appears on these surfaces</h3>
        <p>
          These surfaces do not share one role list. The research-area Spotlight draws only on
          full-time faculty. The home-page Spotlight shows papers chosen by ReciterAI, credited to
          their publicly listed WCM authors. Your own Highlights come from your own papers, whatever
          your role, but only papers with an Impact score can qualify. Everyone still appears in full
          on their own profile, in search, and on the Browse directory. <strong>Scholars in
          this area</strong> narrows further to full-time faculty only, because it is a
          principal-investigator surface. Doctoral students are not shown on any public surface at
          all, which is a privacy choice, and they appear only as plain-text names where a mentor or
          co-author relationship refers to them.
        </p>

        <h2 id="mentees">Mentees</h2>
        <p>
          The Mentoring section of a profile is assembled from three source records, each covering a
          different kind of trainee, plus anything the mentor adds. Current and former mentees both
          appear. A former postdoc shows the years of the appointment rather than &ldquo;since&rdquo;, and a student shows a class year.
          Each mentee chip carries the number of publications you co-authored with them, and the
          section header switches to a breakdown by program (MD, MD-PhD, PhD, postdoc, early career,
          other) once the list is long enough for that to be useful.
        </p>
        <ul>
          <li>
            <strong>PhD and MD-PhD students</strong> come from Jenzabar, the Graduate School&apos;s
            system: the thesis advisor of record for each student, including graduates. Corrections
            go to ITS Support through Request a change, and support fixes the record.
          </li>
          <li>
            <strong>MD students and early-career trainees</strong> come from Medical
            Education&apos;s scholarly-project records (Areas of Concentration and the related
            programs), including past classes.
          </li>
          <li>
            <strong>Postdocs</strong> come from Employee Central through the Enterprise Directory:
            the supervisor named on the postdoctoral appointment, current and expired. When the
            supervisor of record is a lab administrator rather than the PI, Scholars uses the PI
            named in the appointment&apos;s lab unit instead. Corrections are routed to ITS support,
            who fix a sync issue or escalate to HR.
          </li>
          <li>
            <strong>Mentees you add yourself</strong> under Mentees › Added by you in the console:
            visiting students, trainees from another institution, or anyone who predates the systems
            above. A name is enough; a CWID, program, and completion year are optional.
          </li>
        </ul>
        <p>
          Because every one of those records can miss someone, the console also{" "}
          <strong>suggests mentees from your publications</strong>. Nightly, for full-time faculty, Scholars looks at the
          co-authors of your ReCiter-curated papers from the last eight years who hold, or once held, a trainee-type appointment at WCM,
          namely students, postdocs, fellows, residents, and volunteers, and lists them under
          Mentees › From your publications, ranked by how often you are the paper&apos;s last
          author. Research staff are listed with their title so a colleague is easy to tell from a
          trainee; co-authors whose career stage the directory cannot establish are set aside rather
          than suggested. Each suggestion shows the shared papers, and you add it from a short prefilled form
          or mark it &ldquo;not a mentee&rdquo; so it does not return. An accepted suggestion
          becomes one of your own entries and is grouped by program on the profile like a sourced
          one.
        </p>
        <Callout variant="note" heading="Suggestions are private until you act on them">
          <p>
            Nothing under From your publications is visible to anyone but you (and a Scholars superuser
            working on your behalf) until you add it. Hiding a mentee from a training record is likewise
            display-only and reversible: it removes them from your public profile and every
            mentoring page without changing the underlying record.
          </p>
        </Callout>

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
          administrator sets a custom address for you, the old address keeps working. It permanently
          redirects to the new one, so existing links, citations, and bookmarks don&apos;t break.
        </p>
        <p>
          <strong>Want a different address?</strong> Ask for one on the Profile URL card of your
          Edit my profile page. Addresses
          stay name-based, so ask for a variation of your first and last name. You can add a middle
          initial or a fuller form (for example <code>jane-q-smith</code>) when a namesake already has
          the plain form. They aren&apos;t free-choice handles, and you can&apos;t claim a word like a
          research area or a department. A Scholars administrator approves or declines the request, and
          you see the decision on the same card. If it is approved, your old
          address keeps working and permanently redirects.
        </p>
        <Callout variant="note" heading="A number in your address isn’t a ranking">
          <p>
            If your address ends in a number (<code>jane-smith-2</code>), it only means someone
            already had the name-based address when yours was created. The first profile keeps the
            plain <code>jane-smith</code>, and each later namesake gets the next number, in the order
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
          , starting on your Edit my profile page, which routes the request to the owning office for
          you. A <em>bug</em> means something is broken. Report it through the{" "}
          <Link href="/about/feedback" className={LINK}>
            feedback form
          </Link>
          {" "}(the Feedback button on every page). Use the same form for a systematic model error,
          such as wrong scores or research areas across many items. An <em>enhancement</em> is a
          feature request: include your stakeholder role, the surface or behavior, what you want, and
          the underlying need, and submit it the same way. A correction opens a prefilled email to
          the office that owns the data, or points you to the tool where you fix it yourself.
        </p>

        <hr className="mt-12 border-border" />

        <h2 id="glossary">Glossary</h2>
        <dl className="mt-4 space-y-5">
          {[
            { term: "Impact score", def: "A score from 0 to 100 that ReciterAI assigns to a publication: a calibrated model weighs its citation signal (iCite count, plus NIH percentile and RCR once they exist), journal standing, and recency against a fixed ladder of about 200 reference points. Publication-level and not author-relative: the same number for every co-author. Field-aware but not a literal cross-field ranking. Used mainly to help decide which of a scholar’s papers to surface; not a ranking of people. High scores are rare (the scale is demanding and the 90 to 100 band is reserved for historic landmarks), so a mid-range score can still mark a top paper. Shown when you open a publication’s detail view." },
            { term: "Author Position", def: "Your place in a publication’s author list (first / middle / senior). This, not Impact, conveys your role on a paper." },
            { term: "ReCiter", def: "WCM’s author-disambiguation engine. Decides which publications are yours, from PubMed. Runs nightly." },
            { term: "ReCiter Publication Manager", def: "The curation interface at reciter.weill.cornell.edu where a publication’s attribution is corrected. A misattributed paper is rejected here; a missing one is added here." },
            { term: "ReciterAI", def: "WCM’s pipeline that derives a publication’s research areas, Impact score, and one-line synopsis. Impact and synopsis refresh nightly; research areas and subareas are assigned weekly; the research-area taxonomy is rebuilt periodically." },
            { term: "Research areas (and subareas)", def: "WCM’s AI-derived map of what scholars work on: broad research areas such as Cancer Biology, each with finer subareas. ReciterAI derives them from publications, not from MeSH or a fixed list, and scores how strongly each paper relates to each area. Distinct from the MeSH keywords that power search." },
            { term: "Edit my profile", def: "The page where a scholar edits their overview, hides or restores publications, and submits data corrections (Request a change), which route to the owning office." },
            { term: "Profile URL (slug)", def: "A profile’s web address: the short scholars.weill.cornell.edu/<slug> and the longer /scholars/<slug> both work and lead to the same page. The slug is derived automatically from the scholar’s preferred name (e.g. jane-smith); a later namesake gets a number (jane-smith-2) and the earlier profile keeps the plain form; it is not a ranking. The address is stable: if it changes, the old one permanently redirects, so existing links keep working. A scholar can request a custom address (still based on their name) on Edit my profile, and a Scholars administrator approves it." },
            { term: "iCite", def: "The NIH tool Scholars uses for the cited-by list on a publication, which tracks PubMed’s own Cited By. The headline times-cited count comes from Scopus instead, and is usually the larger of the two because Scopus indexes venues PubMed does not." },
            { term: "Scopus", def: "Elsevier’s abstract and citation database. Scholars uses it for two things: the headline times-cited count on a publication, and publications that are not in PubMed, which a curator can add in Publication Manager. It is not used for author disambiguation — deciding which publications are yours is ReCiter’s job, from PubMed." },
            { term: "OpenAlex", def: "An open catalog of scholarly works. Like Scopus, it is a source for publications that are not in PubMed, which a curator can add in Publication Manager; such a paper is labeled “Source: OpenAlex” and carries a DOI rather than a PMID. It is not used for citation counts or for author disambiguation." },
            { term: "InfoEd", def: "WCM’s grants system of record, for all sponsors. NIH RePORTER supplies NIH abstract text and the portfolio link, and adds NIH awards InfoEd never held. NSF and Gates Foundation abstracts come from those funders’ public records." },
            { term: "Grant roles (PI, MPI, Co-I)", def: (<>Your role on an award, as recorded in InfoEd. PI is the principal investigator. MPI marks an NIH <a href={NIH_MPI} className={LINK}>multiple-principal-investigator</a> award, where two or more investigators hold principal-investigator standing equally; NIH names one of them the contact PI for correspondence only, which carries no seniority. Co-I is a co-investigator, Sub-PI leads a subaward, and KP is other key personnel. MPI is not a lesser form of PI, and it is not the same as co-PI, which is an NSF term not used on NIH awards. Corrections go to Sponsored Research through Request a change. A grant shown “via NIH RePORTER” always lists the role as PI and is corrected through NIH, not Sponsored Research.</>) },
            { term: "Available technologies", def: "Licensable inventions a scholar holds in the WCM Enterprise Innovation (Center for Technology Licensing) portfolio, shown on their profile with a link to the public technology page (innovation.weill.cornell.edu). Sourced from Enterprise Innovation and refreshed weekly." },
            { term: "MeSH", def: "Medical Subject Headings, the NLM’s controlled vocabulary for indexing biomedical literature. Scholars search is MeSH-aware." },
            { term: "System of record (SOR)", def: "The authoritative system that owns a field. Scholars shows a copy and cannot override it; corrections happen at the SOR. Scholars is the SOR for the institutional data it curates directly (center membership, unit and division metadata, and manually-created division rosters), and that set may grow; a scholar’s own overview and visibility choices are stored in Scholars too, but those are personal profile data, not shared institutional records." },
            { term: "Roles (Superuser / Owner / Curator)", def: "Unit-scoped permissions for curating centers, divisions, and departments. Superuser is global and can grant any role; an Owner acts on one unit and can grant Owner or Curator on it; a Curator acts on one unit and grants nothing. Every edit is audit-logged." },
            { term: "Spotlight / Selected research", def: "The home-page showcase: a rotating set of cards, one per research area, each featuring a subarea and a few of its representative publications. ReciterAI chooses the subareas and papers and republishes the set at most monthly; Scholars checks for a new set weekly, and each visit shows a random selection of the cards. Not scholar-curated." },
            { term: "Suppression", def: "Hiding a misattributed publication from a profile. A reversible, recorded near-term measure; the source-level fix is rejecting the paper in Publication Manager." },
          ].map(({ term, def }) => (
            <div key={term} id={`g-${term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`} className="scroll-mt-28 lg:scroll-mt-20">
              <dt className="font-medium">{term}</dt>
              <dd className="mt-0.5 text-[var(--apollo-ink-2)]">{def}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
