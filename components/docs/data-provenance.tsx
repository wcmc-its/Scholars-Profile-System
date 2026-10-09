"use client";

/**
 * `/about#provenance` and `/about#correct`: the System context diagram and the
 * single field table ("Every field, and how to fix it"), ported from the
 * approved About-diagram mockup (Projects/…/About diagram/About diagrams.dc.html).
 *
 * Every source, refresh and fix route was traced to the ETL, the deployed
 * schedules (cdk/lib/etl-stack.ts), flags and Request-a-change routing
 * (lib/edit/request-a-change.ts) on master, 2026-09-24. Update a row when its
 * ETL step, cadence or route changes. "Occasional" = a hand-run export or
 * import with no schedule.
 *
 * The diagram (#1903) shows the page's thesis: sources, then the ReCiter and
 * ReciterAI computed layers, then Scholars, with corrections going back
 * upstream. Plain HTML/CSS rather than an SVG from scripts/diagrams (those are
 * fixed-palette, fixed-viewBox architecture drawings), so it reflows to a
 * single column on phones and takes its colours from theme tokens.
 *
 * Client only for the two filters (Refresh on the diagram, "who fixes it" on
 * the table); everything renders on the server first. Built from divs with
 * ARIA table roles rather than <table> so MAIN_CLASS's `[&_td]` styles on the
 * page don't reach it, and so rows can stack as cards below `md`.
 */

import Link from "next/link";
import { useState } from "react";

const LINK = "text-docs-accent underline underline-offset-4 hover:no-underline";
const WEB_DIR = "https://directory.weill.cornell.edu";
const PM = "https://reciter.weill.cornell.edu";
const WRG = "https://wrg.weill.cornell.edu";

const WebDir = (
  <a href={WEB_DIR} className={LINK}>
    Web Directory
  </a>
);

type Cadence = "live" | "nightly" | "weekly" | "annual" | "occasional";
type Source = { name: string; data: string; cad: Cadence };

const WCM: Source[] = [
  { name: "Enterprise Directory", data: "Name, degrees, titles, appointments, department, NYP positions, postdoc supervisors", cad: "nightly" },
  { name: "Web Directory", data: "Photo, shown live (a new one within a day); email and who can see it; where you edit your name", cad: "live" },
  { name: "ASMS", data: "Education and training", cad: "nightly" },
  { name: "InfoEd (Weill Research Gateway)", data: "Grants and grant roles", cad: "nightly" },
  { name: "External Relationships / COI (WRG)", data: "Disclosures, which you manage in the Weill Research Gateway", cad: "nightly" },
  { name: "OnCore", data: "Which clinical trials you are on", cad: "occasional" },
  { name: "Jenzabar", data: "PhD thesis advisees, Graduate School appointments", cad: "nightly" },
  { name: "Medical Education rosters", data: "MD scholarly-project, MD-PhD and early-career mentees", cad: "occasional" },
  { name: "Faculty Review Tool", data: "Mentees you list in your annual faculty review, offered as suggestions", cad: "annual" },
  { name: "POPS physician directory / WeillCornell.org", data: "Board certifications, specialties, clinical expertise", cad: "weekly" },
  { name: "Center for Technology Licensing", data: "Available technologies", cad: "weekly" },
  { name: "WCM Newsroom", data: "News mentions", cad: "weekly" },
  { name: "Muck Rack", data: "Media highlights, as curated by External Affairs", cad: "nightly" },
  { name: "Clinical & Translational Science Center", data: "Clinical & Translational Science Center roster (not publications)", cad: "nightly" },
];

const EXT: Source[] = [
  { name: "PubMed", data: "Publication records, retractions", cad: "nightly" },
  { name: "ORCID", data: "Suggested ORCID iDs, from public ORCID records that name WCM", cad: "weekly" },
  { name: "Scopus", data: "Citation counts, papers not in PubMed", cad: "nightly" },
  { name: "OpenAlex", data: "Papers not in PubMed", cad: "nightly" },
  { name: "NIH iCite", data: "Citing papers", cad: "occasional" },
  { name: "NIH RePORTER", data: "Earlier NIH grants, abstracts, grant-linked papers", cad: "weekly" },
  { name: "NSF Awards", data: "NSF grant abstracts", cad: "weekly" },
  { name: "Gates Foundation", data: "Gates grant summaries", cad: "weekly" },
  { name: "ClinicalTrials.gov", data: "Trial details, status, whether results are posted; condition MeSH terms for search", cad: "weekly" },
  { name: "NLM MeSH", data: "Subject vocabulary for search", cad: "annual" },
];

// Feed the Datasets section and the data-sharing dashboard via reciterdb.dataset_deposit
// (scripts/bulk-data-rule, hand-run, so "occasional"; the SPS copy itself is weekly).
const DATA: Source[] = [
  { name: "Europe PMC", data: "Full-text Data Availability statements, scanned for dataset deposits", cad: "occasional" },
  { name: "PubMed Central", data: "Full text where Europe PMC has none", cad: "occasional" },
  { name: "DataCite", data: "Dataset titles, creators and publishers", cad: "occasional" },
];

// The two in-house computed layers between the sources and Scholars (#1903):
// ReCiter matches publication records to people; ReciterAI reads those papers.
const LAYERS: [Source, Source] = [
  { name: "ReCiter", data: "Which papers are yours, publication details, MeSH tags, citation counts, suggested ORCID iDs from your PubMed author records", cad: "nightly" },
  { name: "ReciterAI", data: "Research areas, Impact, synopses, methods, core facilities, Spotlight", cad: "nightly" },
];

const CADENCES: Cadence[] = ["live", "nightly", "weekly", "annual", "occasional"];

const SCHOLARS_EDITS = [
  "Overview",
  "Positions and honors you add",
  "Mentees you add",
  "ORCID and profile links",
  "Selected highlights",
  "Anything you hide",
  "Center rosters",
  "Custom URL",
];

type Tag =
  | "Yours to edit"
  | "Yours · Web Directory"
  | "Yours · Research Gateway"
  | "You request · admin approves"
  | "Request a change"
  | "Unit curator"
  | "At the source"
  | "Not editable";

type Row = {
  field: string;
  detail?: string;
  source: string;
  cadence: string;
  tag: Tag;
  how: React.ReactNode;
};

const GROUPS: { id: string; label: string; rows: Row[] }[] = [
  {
    id: "g-contact",
    label: "Name, photo & contact",
    rows: [
      { field: "Name", detail: "Your preferred name", source: "Enterprise Directory", cadence: "Nightly", tag: "Yours · Web Directory", how: <>Change Preferred Name in the {WebDir}. It appears the next day.</> },
      { field: "Degrees after your name", source: "Enterprise Directory, from ASMS", cadence: "Nightly", tag: "Request a change", how: "Routes to the Office of Faculty Affairs." },
      { field: "Photo", source: "Web Directory", cadence: "Live", tag: "Yours · Web Directory", how: <>Add, change or remove it in the {WebDir}. A change shows right away; a new photo within about a day.</> },
      { field: "Email and who can see it", source: "Web Directory", cadence: "Nightly", tag: "Yours · Web Directory", how: <>Change the address or its &ldquo;Publish to&rdquo; setting in the {WebDir}.</> },
      { field: "ORCID iD", source: "Scholars (copied to ReCiter nightly)", cadence: "On save", tag: "Yours to edit", how: "Confirm or enter it under Identifiers & profiles." },
      { field: "Profile links", detail: "LinkedIn, X, Bluesky, Google Scholar, ResearchGate", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Add or remove them under Identifiers & profiles." },
    ],
  },
  {
    id: "g-appointments",
    label: "Appointments & positions",
    rows: [
      { field: "Titles and appointments", detail: "Primary and working titles", source: "Enterprise Directory", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support, who fix the sync or escalate to Faculty Affairs. You can hide a row meanwhile." },
      { field: "Displayed title", detail: "Which of your titles appears under your name", source: "Scholars, chosen from your titles", cadence: "Nightly", tag: "Request a change", how: "You may request a different primary title, but the request may or may not be honored." },
      { field: "Department and division", source: "Enterprise Directory", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support." },
      { field: "Chair and chief titles", detail: "Shown under your title", source: "Enterprise Directory", cadence: "Nightly", tag: "Unit curator", how: "A chief role is inferred from HR data; the unit’s Owner can override it. For a chair role that has ended, use Request a change." },
      { field: "Past WCMC appointments", detail: "Earlier ranks", source: "Enterprise Directory", cadence: "Nightly", tag: "Yours to edit", how: "Hide or show each one on your edit page. Report a wrong rank with Request a change." },
      { field: "Graduate School appointment", source: "Jenzabar", cadence: "Occasional", tag: "Request a change", how: "Routes to ITS Support." },
      { field: "Institution", detail: "Shown only when it isn’t WCM", source: "Enterprise Directory", cadence: "Nightly", tag: "At the source", how: "No in-app route. The faculty record has to change." },
      { field: "Whether you have a public profile", detail: "Set by your person type", source: "Enterprise Directory", cadence: "Nightly", tag: "At the source", how: "Follows your HR or faculty record." },
      { field: "Positions the directory omits", detail: "Leadership roles and positions elsewhere; your profile only", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Add, edit or remove them on your edit page." },
    ],
  },
  {
    id: "g-centers",
    label: "Center roles",
    rows: [
      { field: "Center membership", source: "Scholars", cadence: "On save", tag: "Unit curator", how: "The center’s Owner or Curator edits the roster. You can hide the Centers card." },
      { field: "CTSC membership", detail: "Clinical & Translational Science Center investigators and trainees", source: "Clinical & Translational Science Center", cadence: "Nightly", tag: "At the source", how: "Ask the CTSC to correct its roster. It appears after the next nightly sync." },
      { field: "Center director and program leader", source: "Scholars", cadence: "On save", tag: "Unit curator", how: "Set by the center’s Owner or Curator." },
    ],
  },
  {
    id: "g-clinical",
    label: "Clinical",
    rows: [
      { field: "Clinical trials", detail: "Which trials, your role, status, sponsor", source: "OnCore", cadence: "Weekly", tag: "At the source", how: "Correct it in OnCore. It appears after the next export, which is run by hand. You can hide the section." },
      { field: "Trial details", detail: "Phase, summary, conditions, enrollment", source: "ClinicalTrials.gov", cadence: "Weekly", tag: "At the source", how: "The study team updates the registration." },
      { field: "Board certifications, specialties, expertise", detail: "Used in search and CV export", source: "POPS physician directory / WeillCornell.org", cadence: "Weekly", tag: "At the source", how: "Update your weillcornell.org physician profile." },
      { field: "Clinical profile link", detail: "Link to weillcornell.org", source: "Enterprise Directory", cadence: "Nightly", tag: "At the source", how: "Follows your directory entry and NYP clinical affiliation." },
      { field: "Hospital position", detail: "NewYork-Presbyterian titles", source: "NYP, by way of the Enterprise Directory", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support. You can hide it meanwhile." },
    ],
  },
  {
    id: "g-education",
    label: "Education & honors",
    rows: [
      { field: "Education and training", source: "ASMS", cadence: "Nightly", tag: "Request a change", how: "Routes to the Office of Faculty Affairs. You can hide an entry or the graduation years." },
      { field: "Honors and distinctions", detail: "Not endowed chairs, which come through your title", source: "Scholars, curated by the Office of the Research Dean", cadence: "On save", tag: "Yours to edit", how: "Add, edit or remove them on your edit page." },
    ],
  },
  {
    id: "g-mentoring",
    label: "Mentoring",
    rows: [
      { field: "PhD thesis advisees", source: "Jenzabar", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support. You can hide one meanwhile." },
      { field: "MD scholarly-project mentees", detail: "AOC, MD-PhD program and early-career rosters", source: "Medical Education rosters", cadence: "Occasional", tag: "Request a change", how: "Routes to ITS Support. You can hide one meanwhile." },
      { field: "Postdocs you supervise", detail: "From HR reporting lines", source: "Enterprise Directory", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support, who escalate to HR." },
      { field: "Mentees you add", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Add or remove them under Mentees." },
      { field: "Suggestions from your Faculty Review", detail: "Private until you accept one. Link each to a WCM person so their co-publications show", source: "Faculty Review Tool", cadence: "Annual", tag: "Yours to edit", how: "Accept, link or dismiss each one under Mentees." },
      { field: "Suggestions from your co-authors", detail: "Private until you accept one; full-time faculty only", source: "ReCiter", cadence: "Nightly", tag: "Yours to edit", how: "Accept or dismiss each one under Mentees." },
      { field: "Your postdoctoral mentor", detail: "Shown on a postdoc’s own profile", source: "Enterprise Directory", cadence: "Nightly", tag: "At the source", how: "Follows your HR reporting line. You can hide the card." },
      { field: "Papers with each mentee", detail: "Co-publication counts", source: "ReCiter", cadence: "Occasional", tag: "Not editable", how: "Follows your publication list." },
    ],
  },
  {
    id: "g-pubs",
    label: "Publications",
    rows: [
      {
        field: "Which papers are yours",
        source: "ReCiter, which stores curated data from PubMed, Scopus, and OpenAlex",
        cadence: "Nightly",
        tag: "Yours to edit",
        how: (
          <>
            Use Not mine on your edit page; the rejection goes to ReCiter. Or reject it in{" "}
            <a href={PM} className={LINK}>
              Publication Manager
            </a>
            .
          </>
        ),
      },
      { field: "Papers not in PubMed", detail: "From Scopus or OpenAlex", source: "ReCiter, added by library curators", cadence: "Nightly", tag: "At the source", how: "Ask the library curation team to add or remove one." },
      { field: "Publication details", detail: "Title, authors, journal, DOI", source: "PubMed", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support. The fix is made at PubMed." },
      { field: "MeSH topics", detail: "The Topics list on your profile", source: "PubMed indexing, via ReCiter", cadence: "Nightly", tag: "At the source", how: "Set by NLM indexers. Hide a paper to drop its tags." },
      { field: "Citation count", source: "Scopus", cadence: "Nightly", tag: "At the source", how: "Follows Scopus." },
      { field: "Citing papers", source: "NIH iCite", cadence: "Occasional", tag: "At the source", how: "Follows iCite." },
      { field: "Retractions", source: "PubMed", cadence: "Nightly", tag: "Not editable", how: "Retracted papers are hidden everywhere automatically." },
      { field: "Selected highlights", detail: "Up to three featured papers", source: "Scholars, from Impact scores", cadence: "Nightly", tag: "Yours to edit", how: "Pick your own on your edit page, or keep the automatic set." },
      { field: "Datasets", detail: "Off unless you turn it on", source: "Europe PMC and PubMed Central full text, PubMed and DataCite, via the ReCiter database", cadence: "Occasional", tag: "Yours to edit", how: "Turn the section on, then hide or mark “Not mine.”" },
    ],
  },
  {
    id: "g-research",
    label: "Research areas & Impact",
    rows: [
      {
        field: "Research areas and subareas",
        source: "ReciterAI",
        cadence: "Nightly",
        tag: "Not editable",
        how: (
          <>
            Computed from your papers. Report a systematic error through the{" "}
            <Link href="/about/feedback" className={LINK}>
              feedback form
            </Link>
            .
          </>
        ),
      },
      { field: "Impact score", detail: "One per paper, in publication details", source: "ReciterAI", cadence: "Nightly", tag: "Not editable", how: "Computed; research articles from 2020 on only." },
      { field: "Plain-language synopsis", detail: "One per paper", source: "ReciterAI", cadence: "Nightly", tag: "Not editable", how: "Computed; no correction route." },
      { field: "Methods and tools", source: "ReciterAI", cadence: "Nightly", tag: "Not editable", how: "You can hide the section." },
      { field: "Core facilities", detail: "In publication details", source: "ReciterAI", cadence: "Nightly", tag: "Unit curator", how: "The core’s Owner or Curator confirms or rejects each one." },
      { field: "Home-page Spotlight", source: "ReciterAI", cadence: "Weekly", tag: "Not editable", how: "Chosen by the model. Hiding a paper removes it." },
      { field: "Search vocabulary", detail: "Subject terms search understands", source: "NLM MeSH", cadence: "Annual", tag: "Not editable", how: "Loaded when NLM publishes each year." },
    ],
  },
  {
    id: "g-funding",
    label: "Funding & disclosures",
    rows: [
      { field: "Grants", detail: "Title, sponsor, dates, award number", source: "InfoEd (Weill Research Gateway)", cadence: "Nightly", tag: "Request a change", how: "Routes to Sponsored Research (OSRA). You can hide a grant." },
      { field: "Your role on a grant", detail: "PI, MPI, Co-I, Key Personnel", source: "InfoEd (Weill Research Gateway)", cadence: "Nightly", tag: "Request a change", how: "Routes to OSRA." },
      { field: "NIH grants from before WCM", source: "NIH RePORTER", cadence: "Weekly", tag: "At the source", how: "Remove a wrong match with Not me on your edit page. Details are fixed at NIH." },
      { field: "Grant abstracts", source: "NIH RePORTER, NSF, Gates Foundation", cadence: "Weekly", tag: "At the source", how: "From the funder’s public record." },
      { field: "Papers linked to a grant", source: "NIH RePORTER", cadence: "Weekly", tag: "At the source", how: "Hide a paper that isn’t yours." },
      { field: "Available technologies", source: "Center for Technology Licensing", cadence: "Weekly", tag: "At the source", how: "Ask the Center for Technology Licensing to correct the listing." },
      {
        field: "Disclosures",
        detail: "Shown as External relationships",
        source: "External Relationships / COI (WRG)",
        cadence: "Nightly",
        tag: "Yours · Research Gateway",
        how: (
          <>
            Update it in the{" "}
            <a href={WRG} className={LINK}>
              Weill Research Gateway
            </a>
            .
          </>
        ),
      },
    ],
  },
  {
    id: "g-news",
    label: "News & media",
    rows: [
      { field: "News mentions", source: "WCM Newsroom", cadence: "Weekly", tag: "Yours to edit", how: "Hide one or mark “Not me.” Name matches are reviewed first." },
      { field: "Media highlights", source: "Muck Rack, as curated by External Affairs", cadence: "Nightly", tag: "Yours to edit", how: "Hide one or mark “Not me.” Each clip is reviewed first." },
    ],
  },
  {
    id: "g-page",
    label: "Your profile page",
    rows: [
      { field: "Overview", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Write it yourself or start from an AI draft." },
      { field: "Custom URL", source: "Scholars", cadence: "On approval", tag: "You request · admin approves", how: "Request it on the Profile URL card. The old address keeps redirecting." },
      { field: "Profile editors", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Name up to 10 people to edit on your behalf." },
      { field: "Hide your profile", source: "Scholars", cadence: "On save", tag: "Yours to edit", how: "Use Hide my profile on the Visibility card." },
    ],
  },
];

type Fix = "all" | "yours" | "others" | "source";
const FIXES: [Fix, string][] = [
  ["all", "All fields"],
  ["yours", "I can fix it"],
  ["others", "Someone else fixes it"],
  ["source", "At the source"],
];
const fixOf = (tag: Tag): Exclude<Fix, "all"> =>
  tag.startsWith("You")
    ? "yours"
    : tag === "Request a change" || tag === "Unit curator"
      ? "others"
      : "source";

/** Green = you act, slate = someone acts on your request, neutral = nobody here can. */
const GREEN_OUTLINE = "border-docs-pill-green-border bg-[var(--apollo-surface)] text-[var(--apollo-green)]";
const SLATE = "border-docs-pill-slate-border bg-docs-pill-slate-bg text-docs-pill-slate-text";
const TAG_STYLE: Record<Tag, string> = {
  "Yours to edit": "border-transparent bg-[var(--apollo-green-tint)] text-[var(--apollo-green)]",
  "Yours · Web Directory": GREEN_OUTLINE,
  "Yours · Research Gateway": GREEN_OUTLINE,
  "You request · admin approves": GREEN_OUTLINE,
  "Request a change": SLATE,
  "Unit curator": SLATE,
  "At the source": "border-[var(--apollo-border-strong)] bg-[var(--apollo-lock-bg)] text-[var(--apollo-ink)]",
  "Not editable": "border-dashed border-[var(--apollo-border-strong)] bg-transparent text-[var(--apollo-ink-2)]",
};

/** Tags that name another tool link straight to it. */
const TAG_HREF: Partial<Record<Tag, string>> = {
  "Yours · Web Directory": WEB_DIR,
  "Yours · Research Gateway": WRG,
};

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Nightly is the default ("All sources refresh nightly unless marked"), so only other schedules get a pill. */
function CadencePill({ cad }: { cad: string }) {
  if (cad.toLowerCase() === "nightly") return null;
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--apollo-border-strong)] bg-[var(--apollo-surface-2)] px-2 text-xs font-medium leading-[18px] text-[var(--apollo-ink)]">
      {cad}
    </span>
  );
}

function SourceCard({ s, cad }: { s: Source; cad: Cadence | null }) {
  const hit = cad === s.cad;
  return (
    <div
      className={`flex min-w-0 flex-col gap-0.5 rounded-lg border bg-[var(--apollo-surface)] px-3 py-2 transition-opacity ${
        hit ? "border-[var(--apollo-ink-2)]" : "border-[var(--apollo-border-strong)]"
      } ${cad && !hit ? "opacity-35" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
        <CadencePill cad={s.cad} />
      </div>
      <span className="text-xs text-[var(--apollo-ink-2)]">{s.data}</span>
    </div>
  );
}

function SourceGroup({
  label,
  sources,
  cad,
}: {
  label: string;
  sources: Source[];
  cad: Cadence | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <span className="text-[13px] font-semibold text-[var(--apollo-ink-2)]">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{sources.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {sources.map((s) => (
          <SourceCard key={s.name} s={s} cad={cad} />
        ))}
      </div>
    </div>
  );
}

/**
 * One arrow of the provenance diagram. `flow` (solid, ink) is data moving
 * downstream toward Scholars; `fix` (dashed, maroon) is a correction going
 * back upstream to the system that owns the record. Drawn in currentColor so
 * the tone follows the theme tokens; the SVG is decorative and the label (or
 * the surrounding text) carries the meaning.
 */
function Arrow({
  dir,
  tone = "flow",
  label,
  className = "",
}: {
  dir: "down" | "up" | "right" | "left";
  tone?: "flow" | "fix";
  label?: string;
  className?: string;
}) {
  const vertical = dir === "down" || dir === "up";
  const path = {
    down: "M6 1v24M1 19l5 6 5-6",
    up: "M6 27V3M1 9l5-6 5 6",
    right: "M1 6h30M25 1l6 5-6 5",
    left: "M33 6H3M9 1 3 6l6 5",
  }[dir];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${
        tone === "fix" ? "text-docs-accent" : "text-[var(--apollo-ink-2)]"
      } ${className}`}
    >
      <svg
        width={vertical ? 12 : 34}
        height={vertical ? 28 : 12}
        viewBox={vertical ? "0 0 12 28" : "0 0 34 12"}
        className="shrink-0"
        aria-hidden="true"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray={tone === "fix" ? "3 2.5" : undefined}
        />
      </svg>
      {label && <span>{label}</span>}
    </span>
  );
}

/** The two columns of the lower half: computed layers (left) and Scholars (right). */
const LANES = "grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)] sm:gap-0";

const FIX_ROUTES: { name: string; to: string; body: React.ReactNode }[] = [
  {
    name: "Not mine",
    to: "ReCiter",
    body: "Reject a wrong paper on your edit page or in Publication Manager. ReCiter learns from it and stops matching the paper to you.",
  },
  {
    name: "Request a change",
    to: "the office that owns the record",
    body: "Titles, appointments, grants, education and the like are fixed by the office behind the source system.",
  },
  {
    name: "Fix it yourself",
    to: "at the source",
    body: <>Your name, photo and email in the {WebDir}; your disclosures in the Weill Research Gateway.</>,
  },
];

export function SystemContext() {
  const [cad, setCad] = useState<Cadence | null>(null);
  const sources = [...WCM, ...EXT, ...DATA];
  const all = [...sources, ...LAYERS];
  return (
    <figure
      className="mt-6 flex flex-col gap-3.5"
      aria-labelledby="provenance-diagram-title"
      aria-describedby="provenance-diagram-caption"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span id="provenance-diagram-title" className="text-lg font-semibold">
              How a profile is assembled
            </span>
            <span className="text-sm tabular-nums text-[var(--apollo-ink-2)]">
              {sources.length} sources, {LAYERS.length} computed layers
            </span>
          </div>
          <span className="text-sm text-[var(--apollo-ink-2)]">
            All sources refresh nightly unless marked.
          </span>
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 sm:ml-auto"
          role="group"
          aria-label="Highlight sources by refresh schedule"
        >
          <span className="text-xs text-[var(--apollo-ink-2)]">Refresh</span>
          {CADENCES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cad === c}
              onClick={() => setCad(cad === c ? null : c)}
              className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs text-[var(--apollo-ink)] ${
                cad === c
                  ? "border-[var(--apollo-ink-2)] bg-[var(--apollo-surface-2)] font-semibold"
                  : "border-[var(--apollo-border-strong)] bg-[var(--apollo-surface)]"
              }`}
            >
              {c}
              <span className="tabular-nums text-muted-foreground">
                {all.filter((s) => s.cad === c).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col rounded-[var(--apollo-radius-card)] border border-[var(--apollo-border)] bg-[var(--apollo-page)] p-4 shadow-[var(--apollo-shadow-card)] sm:p-5">
        {/* 1. Source systems */}
        <div className="flex flex-col gap-4">
          <SourceGroup label="WCM source systems" sources={WCM} cad={cad} />
          <SourceGroup label="Outside sources" sources={EXT} cad={cad} />
          <SourceGroup label="Data-sharing sources" sources={DATA} cad={cad} />
        </div>

        {/* Source → lanes: publications go through the computed layers, the
            rest is copied as-is; corrections travel back up. */}
        <div className={`${LANES} py-3`}>
          <div className="flex justify-center">
            <Arrow dir="down" label="Publication records" />
          </div>
          <div className="hidden sm:block" />
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <Arrow dir="down" label="Everything else, as-is" />
            <Arrow dir="up" tone="fix" label="Corrections" />
          </div>
        </div>

        <div className={LANES}>
          {/* 2. Computed layers */}
          <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--apollo-slate-tint-border)] bg-[var(--apollo-slate-tint)] p-3.5">
            <span className="px-0.5 pb-1 text-[13px] font-semibold text-[var(--apollo-ink-2)]">
              Computed layers
            </span>
            <SourceCard s={LAYERS[0]} cad={cad} />
            <div className="flex justify-center">
              <Arrow dir="down" />
            </div>
            <SourceCard s={LAYERS[1]} cad={cad} />
          </div>

          <div className="flex items-center justify-center gap-4 sm:flex-col sm:gap-2">
            {/* Phones stack the lanes, so the arrows turn vertical. */}
            <span className="contents sm:hidden">
              <Arrow dir="down" />
              <Arrow dir="up" tone="fix" label="Not mine" />
            </span>
            <span className="hidden sm:contents">
              <Arrow dir="right" />
              <Arrow dir="left" tone="fix" />
              <span className="text-xs text-docs-accent">Not mine</span>
            </span>
          </div>

          {/* 3. Scholars */}
          <div className="flex flex-col rounded-[10px] border border-[var(--apollo-border-strong)] bg-[var(--apollo-surface-2)] p-4 shadow-[inset_0_3px_0_var(--apollo-maroon)]">
            <div className="flex flex-col items-center gap-1 py-1 text-center">
              <span className="text-base font-semibold">Scholars</span>
              <span className="text-[13px] text-[var(--apollo-ink-2)]">
                Combines imported data with edits and publishes profiles
              </span>
            </div>
            <div className="flex h-[34px] items-center justify-center">
              <Arrow dir="up" label="applied on top" />
            </div>
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--apollo-border-strong)] bg-[var(--apollo-green-tint)] px-3.5 py-3">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="text-[var(--apollo-green)]">
                  <PencilIcon />
                </span>
                Edits in Scholars
              </span>
              <div className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs min-[480px]:grid-cols-2 sm:grid-cols-1 lg:grid-cols-2">
                {SCHOLARS_EDITS.map((e) => (
                  <span key={e}>{e}</span>
                ))}
              </div>
              <span className="border-t border-[var(--apollo-border-strong)] pt-1.5 text-xs text-[var(--apollo-ink-2)]">
                Made by scholars, their editors, or unit curators. Kept separately, so imports never
                overwrite them.
              </span>
            </div>
          </div>
        </div>

        {/* Corrections, back upstream */}
        <div className="mt-4 rounded-[10px] border border-dashed border-docs-accent bg-[var(--apollo-surface)] p-3.5">
          <div className="flex items-center gap-2 pb-2">
            <Arrow dir="up" tone="fix" />
            <span className="text-[13px] font-semibold text-docs-accent">
              Corrections go back upstream, not into Scholars
            </span>
          </div>
          <ul className="!m-0 grid !list-none grid-cols-1 gap-3 sm:grid-cols-3">
            {FIX_ROUTES.map((r) => (
              <li key={r.name} className="!m-0 flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {r.name} <span className="font-normal text-[var(--apollo-ink-2)]">&rarr; {r.to}</span>
                </span>
                <span className="text-xs text-[var(--apollo-ink-2)]">{r.body}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption id="provenance-diagram-caption" className="text-xs text-[var(--apollo-ink-2)]">
        Source systems feed Scholars on a schedule. Publication records pass through two computed
        layers first: ReCiter decides which papers are yours, and ReciterAI works out what they are
        about. Scholars applies the edits made in Scholars itself and publishes the result.
        Corrections go back to the system that owns the record, because the next refresh would
        overwrite a fix made to the copy. Photos are shown live from the Web Directory rather than
        copied, so a changed photo appears right away and a new one within about a day.
        &ldquo;Occasional&rdquo; means someone runs an export by hand, with no schedule.
      </figcaption>
    </figure>
  );
}

function TagPill({ tag }: { tag: Tag }) {
  const href = TAG_HREF[tag];
  const cls = `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-px text-xs font-medium no-underline ${TAG_STYLE[tag]}`;
  const body = (
    <>
      {tag === "At the source" && <LockIcon />}
      {tag === "Not editable" && <BanIcon />}
      {(tag === "Request a change" || tag === "Unit curator") && <SendIcon />}
      {tag.startsWith("You") && <PencilIcon />}
      {tag}
      {href && <ExternalIcon />}
    </>
  );
  return href ? (
    <a href={href} className={`${cls} hover:underline`}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

const COLS = "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-4";

export function FieldTable() {
  const [fix, setFix] = useState<Fix>("all");
  const allRows = GROUPS.flatMap((g) => g.rows);
  const count = (f: Fix) => (f === "all" ? allRows.length : allRows.filter((r) => fixOf(r.tag) === f).length);
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: g.rows.filter((r) => fix === "all" || fixOf(r.tag) === fix),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="mt-5 flex flex-col gap-3.5">
      <div
        className="flex flex-wrap gap-0.5 self-start rounded-[7px] border border-[var(--apollo-border)] bg-[var(--apollo-surface-2)] p-0.5"
        role="group"
        aria-label="Filter fields by who fixes them"
      >
        {FIXES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={fix === k}
            onClick={() => setFix(k)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[13px] ${
              fix === k
                ? "bg-white font-semibold text-[var(--apollo-ink)] shadow-[0_1px_2px_rgba(34,30,28,0.12),0_0_0_1px_var(--apollo-border-strong)]"
                : "text-[var(--apollo-ink-2)]"
            }`}
          >
            {label}
            <span className="tabular-nums text-muted-foreground">{count(k)}</span>
          </button>
        ))}
      </div>

      <div
        role="table"
        aria-label="Every field, and how to fix it"
        className="overflow-hidden rounded-[var(--apollo-radius-card)] border border-[var(--apollo-border)] bg-[var(--apollo-surface)] shadow-[var(--apollo-shadow-card)]"
      >
        <div
          role="row"
          className={`hidden border-b border-[var(--apollo-border)] bg-[var(--apollo-surface-2)] px-4 py-2.5 text-xs font-semibold text-[var(--apollo-ink-2)] ${COLS}`}
        >
          <span role="columnheader">Field</span>
          <span role="columnheader">System of record</span>
          <span role="columnheader">If it&apos;s wrong</span>
        </div>
        {groups.map((g) => (
          <div key={g.id} role="rowgroup" id={g.id} className="scroll-mt-28 lg:scroll-mt-20">
            <div
              role="row"
              className="flex items-baseline gap-2.5 border-t border-[var(--apollo-border-strong)] bg-[var(--apollo-rail)] px-4 py-2.5 shadow-[inset_3px_0_0_var(--apollo-ink-2)]"
            >
              <a
                role="rowheader"
                href={`#${g.id}`}
                className="text-xs font-semibold uppercase tracking-wide text-[var(--apollo-ink)] no-underline hover:underline"
              >
                {g.label}
              </a>
              <span className="text-xs tabular-nums text-muted-foreground">
                {g.rows.length} {g.rows.length === 1 ? "field" : "fields"}
              </span>
            </div>
            {g.rows.map((r) => (
              <div
                key={r.field}
                role="row"
                className={`flex flex-col gap-1.5 border-t border-[var(--apollo-border)] px-4 py-3 md:items-start ${COLS}`}
              >
                <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.field}</span>
                    <CadencePill cad={r.cadence} />
                  </div>
                  {r.detail && <span className="text-xs text-[var(--apollo-ink-2)]">{r.detail}</span>}
                </div>
                <span role="cell" className="text-[13px] text-[var(--apollo-ink-2)]">
                  <span className="md:hidden">From </span>
                  {r.source}
                </span>
                <div role="cell" className="flex min-w-0 flex-col items-start gap-1">
                  <TagPill tag={r.tag} />
                  <span className="text-[13px] text-[var(--apollo-ink-2)]">{r.how}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
