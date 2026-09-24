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
 * Client only for the two filters (Refresh on the diagram, "who fixes it" on
 * the table); everything renders on the server first. Built from divs with
 * ARIA table roles rather than <table> so MAIN_CLASS's `[&_td]` styles on the
 * page don't reach it, and so rows can stack as cards below `md`.
 */

import Link from "next/link";
import { useState } from "react";

const LINK = "text-[#7d1c1c] underline underline-offset-4 hover:no-underline";
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
  { name: "Web Directory", data: "Photo, shown live; email and who can see it; where you edit your name", cad: "live" },
  { name: "ASMS", data: "Education and training", cad: "nightly" },
  { name: "InfoEd (Weill Research Gateway)", data: "Grants and grant roles", cad: "nightly" },
  { name: "External Relationships / COI (WRG)", data: "Disclosures, which you manage in the Weill Research Gateway", cad: "nightly" },
  { name: "ReCiter", data: "Which papers are yours, publication details, MeSH tags, citation counts, ORCID iD", cad: "nightly" },
  { name: "ReciterAI", data: "Research areas, Impact, synopses, methods, core facilities, Spotlight", cad: "nightly" },
  { name: "OnCore", data: "Which clinical trials you are on", cad: "occasional" },
  { name: "Jenzabar", data: "PhD thesis advisees, Graduate School appointments", cad: "nightly" },
  { name: "Medical Education rosters", data: "MD scholarly-project, MD-PhD and early-career mentees", cad: "occasional" },
  { name: "POPS physician directory / WeillCornell.org", data: "Board certifications, specialties, clinical expertise", cad: "weekly" },
  { name: "Center for Technology Licensing", data: "Available technologies", cad: "weekly" },
  { name: "WCM Newsroom", data: "News mentions", cad: "weekly" },
  { name: "Muck Rack", data: "Media highlights, as curated by External Affairs", cad: "nightly" },
  { name: "Clinical & Translational Science Center", data: "Clinical & Translational Science Center roster (not publications)", cad: "nightly" },
];

const EXT: Source[] = [
  { name: "PubMed", data: "Publication records, retractions", cad: "nightly" },
  { name: "Scopus", data: "Citation counts, papers not in PubMed", cad: "nightly" },
  { name: "OpenAlex", data: "Papers not in PubMed", cad: "nightly" },
  { name: "Web of Science", data: "Papers not in PubMed", cad: "nightly" },
  { name: "NIH iCite", data: "Citing papers", cad: "occasional" },
  { name: "NIH RePORTER", data: "Earlier NIH grants, abstracts, grant-linked papers", cad: "weekly" },
  { name: "NSF Awards", data: "NSF grant abstracts", cad: "weekly" },
  { name: "Gates Foundation", data: "Gates grant summaries", cad: "weekly" },
  { name: "ClinicalTrials.gov", data: "Trial details", cad: "weekly" },
  { name: "NLM MeSH", data: "Subject vocabulary for search", cad: "annual" },
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
      { field: "Photo", source: "Web Directory", cadence: "Live", tag: "Yours · Web Directory", how: <>Add, change or remove it in the {WebDir}. It shows right away.</> },
      { field: "Email and who can see it", source: "Web Directory", cadence: "Nightly", tag: "Yours · Web Directory", how: <>Change the address or its &ldquo;Publish to&rdquo; setting in the {WebDir}.</> },
      { field: "ORCID iD", source: "Scholars, synced with ReCiter", cadence: "On save", tag: "Yours to edit", how: "Confirm or enter it under Identifiers & profiles." },
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
      { field: "Papers not in PubMed", detail: "From Scopus, OpenAlex or Web of Science", source: "ReCiter, added by library curators", cadence: "Nightly", tag: "At the source", how: "Ask the library curation team to add or remove one." },
      { field: "Publication details", detail: "Title, authors, journal, DOI", source: "PubMed", cadence: "Nightly", tag: "Request a change", how: "Routes to ITS Support. The fix is made at PubMed." },
      { field: "MeSH topics", detail: "The Topics list on your profile", source: "PubMed indexing, via ReCiter", cadence: "Nightly", tag: "At the source", how: "Set by NLM indexers. Hide a paper to drop its tags." },
      { field: "Citation count", source: "Scopus", cadence: "Nightly", tag: "At the source", how: "Follows Scopus." },
      { field: "Citing papers", source: "NIH iCite", cadence: "Occasional", tag: "At the source", how: "Follows iCite." },
      { field: "Retractions", source: "PubMed", cadence: "Nightly", tag: "Not editable", how: "Retracted papers are hidden everywhere automatically." },
      { field: "Selected highlights", detail: "Up to three featured papers", source: "Scholars, from Impact scores", cadence: "Nightly", tag: "Yours to edit", how: "Pick your own on your edit page, or keep the automatic set." },
      { field: "Datasets", detail: "Off unless you turn it on", source: "ReCiter database", cadence: "Weekly", tag: "Yours to edit", how: "Turn the section on, then hide or mark “Not mine.”" },
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
const GREEN_OUTLINE = "border-[#a9d3c0] bg-[var(--apollo-surface)] text-[var(--apollo-green)]";
const SLATE = "border-[#d5dfeb] bg-[#eaf0f7] text-[#2f4a6d]";
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
        {sources.map((s) => {
          const hit = cad === s.cad;
          return (
            <div
              key={s.name}
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
        })}
      </div>
    </div>
  );
}

export function SystemContext() {
  const [cad, setCad] = useState<Cadence | null>(null);
  const all = [...WCM, ...EXT];
  return (
    <div className="mt-6 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">System sources</span>
            <span className="text-sm tabular-nums text-[var(--apollo-ink-2)]">
              {all.length} sources feed Scholars
            </span>
          </div>
          <span className="text-sm text-[var(--apollo-ink-2)]">
            All sources refresh nightly unless marked.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto" role="group" aria-label="Highlight sources by refresh schedule">
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

      <div className="grid grid-cols-1 gap-3 rounded-[var(--apollo-radius-card)] border border-[var(--apollo-border)] p-4 shadow-[var(--apollo-shadow-card)] sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto_220px] lg:gap-0 bg-[var(--apollo-page)]">
        <div className="flex flex-col gap-4">
          <SourceGroup label="WCM source systems" sources={WCM} cad={cad} />
          <SourceGroup label="Outside sources" sources={EXT} cad={cad} />
        </div>

        <div className="flex items-center justify-center gap-1.5 text-[var(--apollo-ink-2)] lg:flex-col lg:px-1">
          <span className="whitespace-nowrap rounded-full border border-[var(--apollo-border-strong)] bg-[var(--apollo-surface)] px-2 text-xs">
            ingest
          </span>
          <svg width="44" height="12" viewBox="0 0 44 12" className="hidden lg:block" aria-hidden="true">
            <path d="M0 6h40M35 1l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <svg width="12" height="22" viewBox="0 0 12 22" className="lg:hidden" aria-hidden="true">
            <path d="M6 0v18M1 13l5 6 5-6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </div>

        <div className="flex flex-col justify-center rounded-[10px] border border-[var(--apollo-border-strong)] bg-[var(--apollo-surface-2)] p-5 shadow-[inset_0_3px_0_var(--apollo-maroon)]">
          <div className="flex flex-col items-center gap-1.5 py-2 text-center">
            <span className="text-base font-semibold">Scholars</span>
            <span className="text-[13px] text-[var(--apollo-ink-2)]">
              Combines imported data with edits and publishes profiles
            </span>
          </div>
          <div className="flex h-[34px] items-center justify-center gap-2 text-[var(--apollo-ink-2)]">
            <svg width="12" height="22" viewBox="0 0 12 22" aria-hidden="true">
              <path d="M6 22V4M1 9l5-6 5 6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span className="text-xs">applied on top</span>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--apollo-border-strong)] bg-[var(--apollo-green-tint)] px-3.5 py-3">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="text-[var(--apollo-green)]">
                <PencilIcon />
              </span>
              Edits in Scholars
            </span>
            <div className="flex flex-col gap-1 text-xs">
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
      <div className="text-xs text-[var(--apollo-ink-2)]">
        Photos are shown live from the Web Directory rather than copied, so a new photo appears
        right away. &ldquo;Occasional&rdquo; means someone runs an export by hand, with no
        schedule.
      </div>
    </div>
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
