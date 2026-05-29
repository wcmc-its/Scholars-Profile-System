import type { Metadata } from "next";
import Link from "next/link";
import { DocsToc, type NavGroup } from "@/components/docs/docs-toc";

/**
 * /docs (v0) — single comprehensive documentation page, stakeholder-first +
 * shared reference, ported from the approved `scholars-documentation4.html`
 * mockup. Force-static, rendered inside the shared public header/footer; the
 * DocsToc sidebar is the only client piece (scroll-spy). The hybrid SPEC's
 * multi-page split (per-question URLs, per-methodology pages) is the
 * post-launch build; the old sub-routes 301 into the anchors here.
 */
export const dynamic = "force-static";
export const revalidate = false;

export const metadata: Metadata = {
  title: "Documentation — Scholars at WCM",
  description:
    "How your Scholars profile is built, how to read it, and how to change the things that are yours to change — provenance, corrections, the Impact score, topics, search, and the showcase surfaces.",
  alternates: { canonical: "/docs" },
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
      { id: "topics", label: "Topics & subtopics" },
      { id: "impact", label: "The Impact score" },
      { id: "search", label: "Search" },
      { id: "showcase", label: "Spotlight & Selected research" },
      { id: "requests", label: "Requesting changes" },
    ],
  },
  { group: "", items: [{ id: "glossary", label: "Glossary" }] },
];

const LINK = "text-[#7d1c1c] underline underline-offset-4 hover:no-underline";
const PM = "https://reciter.weill.cornell.edu";
const SCHOLARS_EMAIL = "mailto:scholars@weill.cornell.edu";

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
    <div className={`mt-5 rounded-[10px] border p-4 ${box}`}>
      <div className={`mb-1 text-[13px] font-bold uppercase tracking-wide ${head}`}>{heading}</div>
      {children}
    </div>
  );
}

const MAIN_CLASS = [
  "min-w-0 pb-24 pt-8",
  "[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:ml-5 [&_ul]:list-disc [&_li]:mt-1 [&_ol]:mt-3 [&_ol]:ml-5 [&_ol]:list-decimal",
  "[&_h2]:mt-14 [&_h2]:scroll-mt-20 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-7 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border-b-2 [&_th]:border-[#d3d8de] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:align-top [&_th]:text-xs [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground",
  "[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
].join(" ");

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-6 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-12">
      <DocsToc nav={NAV} />

      <main className={MAIN_CLASS}>
        <p className="text-xs font-bold uppercase tracking-widest text-[#7d1c1c]">Documentation</p>
        <h1
          id="start"
          className="mt-1 scroll-mt-20 font-serif text-4xl font-semibold leading-tight tracking-tight"
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
              <em>Where your data comes from</em> &mdash; authoritative source systems (PubMed, the
              Enterprise Directory, InfoEd, NIH RePORTER, NYP, the Graduate School, the COI system)
              plus two in-house layers: ReCiter, which decides which publications are yours, and
              ReciterAI, which derives topics, the Impact score, and synopses.
            </li>
            <li>
              <em>How you correct it</em> &mdash; almost always at the source, not in Scholars.
              Fixing the copy would not hold; the next refresh overwrites it. Your self-edit
              interface is where you submit those corrections, and it routes each one to the office
              that owns the field.
            </li>
            <li>
              <em>What you control here</em> &mdash; a small, deliberate set: your overview text and
              which of your publications are shown.
            </li>
          </ul>
        </Callout>

        <p>
          Scholars is not VIVO, and it is not a submission system. You do not enter publications,
          and there is no &ldquo;claim your profile&rdquo; step &mdash; profiles are built
          automatically. Two names recur and are easy to confuse: <em>ReCiter</em> decides which
          publications are yours (author disambiguation), while <em>ReciterAI</em> derives what a
          publication is about and how notable it is (topics, the Impact score, the one-line
          synopsis). Different systems, different jobs.
        </p>

        <h3>Common questions</h3>
        <div className="mt-3 overflow-hidden rounded-[10px] border border-border bg-[#fafbfc]">
          {[
            {
              href: "#impact",
              q: "What does “Impact: 84” mean — is that my impact?",
              a: "No. It describes the publication, not your role on it; every co-author sees the same number.",
            },
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
              a: "Those surfaces are chosen by a model, not by you — filtered by author position, recency, and publication type.",
            },
            {
              href: "#search",
              q: "Why isn’t my publication showing up in search?",
              a: "Usually the index has not rebuilt yet, your terms do not match, or the paper is hidden. Search is separate from your profile.",
            },
            {
              href: "#center-admin",
              q: "How do I add or remove a member of my center?",
              a: "A center Owner or Curator edits the roster in-app — center membership is the one thing Scholars itself owns.",
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
          Part 1 — by stakeholder
        </p>
        <h2 id="who">Which of these are you?</h2>
        <p>
          Jump to your section. Each is short and links into the shared reference below for the
          mechanics.
        </p>
        <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
          {[
            { href: "#scholar", t: "A scholar (faculty)", d: "You have a profile and want it to be right." },
            { href: "#postdoc", t: "A postdoc or fellow", d: "An academic appointee who can appear as a scholar." },
            { href: "#dept-admin", t: "A department / division administrator", d: "You report on a unit’s output and field its faculty’s questions." },
            { href: "#center-admin", t: "A center administrator", d: "You manage a center — the one thing Scholars itself owns." },
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
          Your profile is assembled for you automatically. Your name, title, and primary department
          come from the Enterprise Directory (ED). Your publications are matched to you by ReCiter
          from PubMed. Your funding comes from InfoEd, WCM&apos;s grants system of record for all
          sponsors; for federally funded work, NIH RePORTER supplies the abstract text and the
          NIH-portfolio link. Disclosures come from the COI system, and a NewYork-Presbyterian
          position from NYP. Your topics, the Impact numbers, and the synopses are computed by
          ReciterAI.
        </p>
        <p>
          <strong>What you can change yourself</strong>, in your self-edit interface at{" "}
          <code>/edit/scholar/[your CWID]</code>: your overview text; which publications appear
          (hide one that isn&apos;t yours, or restore one you hid &mdash; reversible and recorded);
          and a data correction for anything else (Request a change, routed to the office that owns
          the field). A personalized profile URL is planned but not yet self-serve.
        </p>
        <p>
          <strong>What you cannot change directly</strong>: source-of-record fields. For a{" "}
          <em>misattributed publication</em>, hide it as a quick near-term fix, then reject it in{" "}
          <a href={PM} className={LINK}>
            ReCiter Publication Manager
          </a>{" "}
          to correct the attribution at the source so it does not come back; a <em>missing</em>{" "}
          publication is added there too. Your name, department, title, funding, disclosures, and
          appointments are corrected at their source &mdash; use Request a change in your self-edit
          interface and it routes to the right office. Topics, Impact, and synopsis are computed by
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
          academic-appointee person-type &mdash; not from the Graduate School. That is the main
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
          scored. That is scope, not a quality judgment.
        </p>
        <p>
          To correct your academic appointment, use Request a change in your self-edit interface (it
          routes through WCM HR) &mdash; it is corrected in ED and flows back on the next refresh.
          Your self-serve controls (overview, hide/restore, submit a correction) are the same as a
          faculty member&apos;s.
        </p>

        <h2 id="dept-admin">Department or division administrator</h2>
        <p>
          You mostly read and report &mdash; but if you hold a curation role on a unit, you also
          have a real in-app editor (see{" "}
          <Link href="#roles" className={LINK}>
            Roles
          </Link>
          ).
        </p>
        <p>
          Anyone can browse a unit&apos;s output &mdash; its faculty, topics, and publications
          &mdash; on the department and division surfaces. An Owner or Curator of a unit can edit
          unit-level data in-app at <code>/edit/department/[code]</code> or{" "}
          <code>/edit/division/[code]</code>: unit metadata (leadership, slug, browse category) and
          the roster of a manually-created division. LDAP-sourced division membership stays with ED
          and is not editable here. A Superuser can do all of this across every unit and grant
          roles.
        </p>
        <p>
          No role lets you move someone between departments or edit a faculty member&apos;s personal
          profile. Primary department comes from ED &mdash; correct it through WCM HR and it flows
          back. The two personal controls (overview, publication visibility) belong to the scholar.
          For recurring reports by topic, date, or funding, email the Scholars team at{" "}
          <a href={SCHOLARS_EMAIL} className={LINK}>
            scholars@weill.cornell.edu
          </a>
          .
        </p>
        <p>
          Set expectations with your faculty: Impact is publication-level, not a ranking of your
          people (
          <Link href="#impact" className={LINK}>
            the Impact score
          </Link>
          ); topics are model-derived (
          <Link href="#topics" className={LINK}>
            Topics
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
          <strong>Center membership is the only field whose system of record is Scholars itself</strong>{" "}
          &mdash; center rosters are not held anywhere upstream, so they are maintained in this
          application, and they are self-serve for the right roles.
        </p>
        <p>
          A center Owner or Curator manages the roster at <code>/edit/center/[code]</code> &mdash;
          add, remove, or update a member, with membership type, program, and start/end dates. Every
          change is one transaction and is audit-logged. If you do not have a role yet, a Superuser
          grants you one (an Owner can also grant Curators on their own center), or email{" "}
          <a href={SCHOLARS_EMAIL} className={LINK}>
            scholars@weill.cornell.edu
          </a>
          .
        </p>
        <p>
          Everything else about your center&apos;s people &mdash; names, titles, departments,
          publications, funding, topics, scores &mdash; comes from the same sources and follows the
          same correction paths as any scholar. You route those; you do not own them.
        </p>

        <hr className="mt-12 border-border" />
        <p className="mt-8 text-xs font-bold uppercase tracking-widest text-[#7d1c1c]">
          Part 2 — shared reference
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
                <td>Name, primary department, title, affiliation, person-type (faculty / appointee)</td>
                <td>Enterprise Directory (ED) — WCM directory/HR</td>
                <td>Nightly</td>
                <td>Request a change (routes to the Directory office); applied in ED</td>
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
                <td>Topics, subtopics, Impact score, synopsis</td>
                <td>ReciterAI (in-house)</td>
                <td>Weekly (taxonomy roughly annual)</td>
                <td>Not hand-editable; report a systematic error</td>
              </tr>
              <tr>
                <td>Funding / grants</td>
                <td>InfoEd — all sponsors (NIH RePORTER supplies federal abstract text)</td>
                <td>Nightly</td>
                <td>Request a change (routes to Sponsored Research); applied in InfoEd</td>
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
                <td>
                  Scholars (this app){" "}
                  <span className="ml-1 inline-block rounded-full bg-[#7d1c1c] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                    Scholars-owned
                  </span>
                </td>
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
          Two non-obvious behaviors this map explains. MeSH &ldquo;check tags&rdquo; (Humans, Male,
          Female, Adult, and so on) are filtered out upstream by ReciterDB before Scholars sees
          them, so they correctly never appear as topics &mdash; intended, not a gap. And a copy can
          lag the source: a correction you make today appears only after the next refresh. That is
          the cost of showing an authoritative copy rather than a hand-kept duplicate.
        </p>

        <h2 id="correct">How to correct something</h2>
        <p>
          Your self-edit interface is the front door: it lets you edit your overview, hide or
          restore publications, and submit a data correction &mdash; Request a change, which routes
          to the office that owns the field (you never have to figure out where to send it). The
          rule of thumb &mdash; if Scholars owns it, it is fixed here; otherwise the fix happens at
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
                  </a>
                </td>
              </tr>
              <tr>
                <td>A wrong field on a publication (title, author order, DOI)</td>
                <td>PubMed (NIH/NLM)</td>
                <td>Bibliographic metadata flows from the publisher/NLM</td>
              </tr>
              <tr>
                <td>Your name, department, or affiliation</td>
                <td>Enterprise Directory</td>
                <td>Request a change in your self-edit interface (routes to the Directory office)</td>
              </tr>
              <tr>
                <td>A postdoc or fellow academic appointment</td>
                <td>Enterprise Directory</td>
                <td>Request a change (routes through WCM HR)</td>
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
                <td>A wrong topic, Impact score, or synopsis</td>
                <td>ReciterAI (computed)</td>
                <td>Report a systematic error via Request a change (routes to the Scholars team)</td>
              </tr>
              <tr className="[&>td]:bg-[#f7f1f1]">
                <td>Center membership</td>
                <td>Scholars</td>
                <td>
                  A center Owner/Curator edits it at <code>/edit/center/[code]</code>, or email{" "}
                  <a href={SCHOLARS_EMAIL} className={LINK}>
                    scholars@weill.cornell.edu
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 id="control">What you control</h2>
        <p>Three things are yours to do directly, in your self-edit interface:</p>
        <ul>
          <li>
            <strong>Your overview text</strong> &mdash; the free-text statement about your work. You
            write it; it is not derived from anything.
          </li>
          <li>
            <strong>Hide or restore a publication</strong> &mdash; if ReCiter attributed a paper that
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
            <strong>Submit a data correction</strong> &mdash; for a field you cannot edit directly,
            Request a change and it is routed to the office that owns the field.
          </li>
        </ul>
        <Callout variant="note" heading="Not a control — worth knowing">
          <p>
            You cannot edit Impact scores, topics, or synopses (computed); you cannot pick which
            papers are featured (algorithmic &mdash; see{" "}
            <Link href="#showcase" className={LINK}>
              Spotlight
            </Link>
            ); and there is no &ldquo;pin this paper&rdquo; control.
          </p>
        </Callout>

        <h2 id="roles">Roles &amp; who can edit</h2>
        <p>
          Most editing in Scholars is source-system editing. The exception is unit curation &mdash;
          centers, divisions, and departments &mdash; governed by three roles.
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
          Roles are unit-scoped &mdash; a role on one center does not grant access to another &mdash;
          and every edit is audit-logged. Curatable: center rosters and metadata, manually-created
          division rosters, and unit metadata (leadership, slug, browse category). Not curatable: a
          scholar&apos;s source-of-record fields, or a scholar&apos;s personal overview and
          publication controls.
        </p>
        <p>
          These curation roles are granted inside Scholars by a Superuser. They are separate from the
          ED person-type (faculty / appointee) that categorizes people on their profiles.
        </p>

        <h2 id="topics">Topics &amp; subtopics</h2>
        <p>
          Topics and subtopics are not self-selected and not raw MeSH terms. ReciterAI derives them
          per publication from the title, abstract (where available), MeSH descriptors, and NIH
          RePORTER terms, mapped against a curated set of parent-topic anchors and organized as a
          parent-topic to subtopic hierarchy. The pipeline assigns one topic and zero or more
          subtopics per publication.
        </p>
        <Callout variant="warn" heading="An internal score you never see">
          <p>
            Each publication-to-topic pairing carries a relevance score used only to rank
            publications within a topic. It is never shown. The only score you see in a publication
            context is the Impact score (&ldquo;Impact: NN&rdquo;).
          </p>
        </Callout>
        <p>
          <strong>Freshness.</strong> The taxonomy &mdash; the set of topics &mdash; recomputes on a
          longer (roughly annual) cycle, but your publications are classified into the current
          taxonomy as they are ingested on the weekly pipeline, so an individual paper does not wait
          a year to receive topics. A topic can shift when the taxonomy is rebuilt; that is expected.
          A publication with no abstract is classified from title, MeSH, and RePORTER terms, and a
          cross-cutting paper can sit under more than one parent topic. A genuinely wrong topic is a
          ReciterAI matter &mdash; report a systematic error.
        </p>

        <h2 id="impact">The Impact score</h2>
        <p>
          The Impact score is a 0&ndash;100 number ReciterAI assigns to a publication, shown as
          &ldquo;Impact: NN&rdquo;. It blends the publication&apos;s citation signal (from iCite), a
          journal or venue signal, and recency.
        </p>
        <Callout variant="key" heading="The misconception to correct first">
          <p>
            The Impact score describes the paper, not your role on it. It is not author-relative
            &mdash; first, middle, and senior author on the same paper all see the same number
            &mdash; and it is not field-normalized. Author Position conveys your role; Impact conveys
            the paper&apos;s standing.
          </p>
        </Callout>
        <p>
          <strong>Which publications are scored.</strong> The scoring scope is full-time WCM faculty
          only: ReciterAI scores publications authored by a full-time WCM faculty member, and the
          Impact then appears on that publication wherever it shows, including on a co-author&apos;s
          or trainee&apos;s view. A publication with no full-time WCM faculty author is outside the
          scope and is not scored. Publication type is weighted: Academic Articles at full weight;
          Reviews and Case Reports down-weighted, so they need a higher score to surface; Letters and
          Editorials hard-excluded.
        </p>
        <p>
          <strong>How often it updates.</strong> Impact scores and synopses refresh on a weekly batch
          &mdash; distinct from the nightly refresh of source mirrors like ED and PubMed. A score can
          lag a brand-new citation by up to a week.
        </p>
        <p>
          <strong>Why a publication can show no Impact (a dash).</strong> Not a quality judgment.
          Usually the paper is very recent and not yet scored in a batch, is a preprint or in-press,
          or is in a venue the citation source does not index.
        </p>
        <h3>The three scores in the system</h3>
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
                <td>No — drives attribution behind the scenes</td>
              </tr>
              <tr>
                <td>Impact score</td>
                <td>A publication&apos;s overall standing</td>
                <td>per publication</td>
                <td>Yes — &ldquo;Impact: NN&rdquo;</td>
              </tr>
              <tr>
                <td>Topic-relevance score</td>
                <td>How central a paper is to a topic</td>
                <td>per (publication, topic)</td>
                <td>No — internal ranking only</td>
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
        <Callout variant="note" heading="Search is separate from your profile">
          <p>
            Whether a publication appears in search is governed by the search index, which rebuilds
            on its own schedule. Whether it appears on your profile is governed by attribution and
            your hide/restore choices. Hiding a paper from your profile does not remove it from
            search, and the reverse holds too.
          </p>
        </Callout>

        <h2 id="showcase">Spotlight &amp; Selected research</h2>
        <p>
          The showcase surfaces are chosen by a model, not by you &mdash; there is no &ldquo;feature
          this paper&rdquo; control. They share one formula, the ReciterAI Impact score combined with
          recency, plus surface-specific filters.
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
                <td>Representative publications per subtopic, in a small rotating set</td>
                <td>Ranked by Impact within the subtopic; refreshed weekly</td>
              </tr>
              <tr>
                <td>Selected highlights</td>
                <td>A scholar&apos;s profile</td>
                <td>That scholar&apos;s most notable papers</td>
                <td>Impact and recency, restricted to first- or senior-author papers; lighter recency weight</td>
              </tr>
              <tr>
                <td>Recent contributions</td>
                <td>Home page</td>
                <td>Recent notable work across WCM</td>
                <td>Impact and heavy recency; eligible roles only; one per research area</td>
              </tr>
              <tr>
                <td>Recent highlights</td>
                <td>Topic page</td>
                <td>Recent notable work in a topic</td>
                <td>Impact and heavy recency; all attributed authors</td>
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

        <h2 id="requests">Requesting a correction, bug, or enhancement</h2>
        <p>
          Three different requests go to different places. A <em>correction</em> means something is
          wrong &mdash; a misattributed paper, a stale department, a bad topic; use{" "}
          <Link href="#correct" className={LINK}>
            How to correct something
          </Link>
          , starting in your self-edit interface, which routes the request to the owning office for
          you. A <em>bug</em> means something is broken; report it to the Scholars team at{" "}
          <a href={SCHOLARS_EMAIL} className={LINK}>
            scholars@weill.cornell.edu
          </a>
          , and a systematic model error, such as wrong scores or topics across many items, routes to
          a ReciterAI review. An <em>enhancement</em> is a feature request: include your stakeholder
          role, the surface or behavior, what you want, and the underlying need. A guided request
          form, routed through WCM&apos;s service tooling, is rolling out; until then, email{" "}
          <a href={SCHOLARS_EMAIL} className={LINK}>
            scholars@weill.cornell.edu
          </a>
          .
        </p>

        <hr className="mt-12 border-border" />

        <h2 id="glossary">Glossary</h2>
        <dl className="mt-4 space-y-5">
          {[
            { term: "Impact score", def: "A 0–100 score ReciterAI assigns to a publication from its citation signal (iCite), journal signal, and recency. Publication-level, not author-relative or field-normalized. Shown as “Impact: NN”; the same number for every co-author." },
            { term: "Author Position", def: "Your place in a publication’s author list (first / middle / senior). This, not Impact, conveys your role on a paper." },
            { term: "ReCiter", def: "WCM’s author-disambiguation engine. Decides which publications are yours, from PubMed. Runs nightly." },
            { term: "ReCiter Publication Manager", def: "The curation interface at reciter.weill.cornell.edu where a publication’s attribution is corrected. A misattributed paper is rejected here; a missing one is added here." },
            { term: "ReciterAI", def: "WCM’s pipeline that derives a publication’s topics, Impact score, and one-line synopsis. Impact and synopsis refresh weekly; the topic taxonomy recomputes roughly annually." },
            { term: "Self-edit interface", def: "Where a scholar edits their overview, hides or restores publications, and submits data corrections (Request a change), which route to the owning office." },
            { term: "iCite", def: "The NIH tool Scholars uses as its only citation source. Scholars does not use Scopus." },
            { term: "InfoEd", def: "WCM’s grants system of record, for all sponsors. NIH RePORTER supplies federal abstract text and the portfolio link." },
            { term: "MeSH", def: "Medical Subject Headings, the NLM’s controlled vocabulary for indexing biomedical literature. Scholars search is MeSH-aware." },
            { term: "System of record (SOR)", def: "The authoritative system that owns a field. Scholars shows a copy and cannot override it; corrections happen at the SOR. Center membership is the only field whose SOR is Scholars itself." },
            { term: "Roles (Superuser / Owner / Curator)", def: "Unit-scoped permissions for curating centers, divisions, and departments. Superuser is global and grants roles; Owner and Curator act on one unit. Every edit is audit-logged." },
            { term: "Spotlight / Selected research", def: "The home-page showcase of representative publications per subtopic, selected by ReciterAI Impact within the subtopic and refreshed weekly. Not scholar-curated." },
            { term: "Suppression", def: "Hiding a misattributed publication from a profile. A reversible, recorded near-term measure; the source-level fix is rejecting the paper in Publication Manager." },
          ].map(({ term, def }) => (
            <div key={term} id={`g-${term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`} className="scroll-mt-20">
              <dt className="font-semibold">{term}</dt>
              <dd className="mt-0.5 text-muted-foreground">{def}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
