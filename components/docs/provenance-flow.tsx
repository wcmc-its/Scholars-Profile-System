/**
 * The provenance diagram for `/about#provenance`.
 *
 * Adapted from `docs/architecture/system-context.svg` (View 1), reorganised for a
 * non-technical reader: grouped by what appears on a profile rather than by system,
 * with protocol/infra detail (LDAPS, Step Functions, Aurora, OpenSearch, SAML) dropped.
 * The return path is the addition — it is the section's whole point and the
 * architecture view has no equivalent, because architecturally there isn't one.
 *
 * Built as CSS Grid rather than an SVG so it reflows to one column on a phone,
 * keeps its text selectable and screen-readable, and needs no new dependency.
 *
 * Colours intentionally match the surrounding page (`#7d1c1c` accent, the Callout
 * note palette for the Scholars-owned box) rather than the `apollo-*` tokens, which
 * are a warmer greige family used on the editor surfaces and would clash here. When
 * the page is tokenised, this component moves with it — see the /about design issue.
 */

const ACCENT = "text-[#7d1c1c]";
const CARD = "rounded-[10px] border border-[#d3d8de] p-3";

/**
 * A shafted arrow, not a chevron. A bare ">" reads as a comparison operator
 * rather than a direction, which is exactly how the first draft was misread.
 */
function Arrow({ dir }: { dir: "right" | "down" }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      {dir === "right" ? (
        <>
          <path d="M3 10h13" />
          <path d="M12 6l4 4-4 4" />
        </>
      ) : (
        <>
          <path d="M10 3v13" />
          <path d="M6 12l4 4 4-4" />
        </>
      )}
    </svg>
  );
}

/** Between-column cue: rightward on wide screens, downward between stacked groups. */
function Step() {
  return (
    <>
      <div className="hidden items-start justify-center pt-[40px] text-muted-foreground md:flex">
        <Arrow dir="right" />
      </div>
      <div className="flex justify-center py-1 text-muted-foreground md:hidden">
        <Arrow dir="down" />
      </div>
    </>
  );
}

function ColHead({ children }: { children: React.ReactNode }) {
  return (
    <div className={`text-[11px] font-bold uppercase tracking-wider ${ACCENT}`}>{children}</div>
  );
}

function Source({ what, from }: { what: string; from: string }) {
  return (
    <div className={CARD}>
      <span className="block text-[15px] font-semibold">{what}</span>
      <span className="mt-0.5 block text-[13px] text-muted-foreground">{from}</span>
    </div>
  );
}

const SOURCES: { what: string; from: string }[] = [
  { what: "Name, photo, title, appointments", from: "Directory" },
  { what: "Primary department, education", from: "ASMS" },
  { what: "Publications", from: "PubMed, Scopus, OpenAlex" },
  { what: "Funding", from: "InfoEd, NIH RePORTER" },
  { what: "Clinical research", from: "OnCore" },
  { what: "Available technologies", from: "Center for Technology Licensing" },
  { what: "Disclosures, hospital position", from: "COI system, NewYork-Presbyterian" },
  { what: "News mentions", from: "WCM Research news site" },
];

/**
 * Separate WCM systems, not part of Scholars, and not alike: ReCiter proposes and
 * a person decides, while ReciterAI's output is not hand-edited. The column head
 * therefore names what they produce rather than claiming either is automatic.
 */
const COMPUTED: { name: string; does: string }[] = [
  {
    name: "ReCiter",
    does: "Suggests and scores which publications are yours. You or the library team confirm or reject each one in Publication Manager.",
  },
  {
    name: "ReciterAI",
    does: "Works out your research areas, the Impact score, and your synopses. These are not hand-edited.",
  },
];

/** Everywhere a scholar's data surfaces, not just their own profile. */
const SURFACES = [
  "Search and Browse",
  "Department, division, and center pages",
  "Research area pages",
  "The home page Spotlight",
];

/**
 * The manual layer, merged over ETL data at read time (FieldOverride + Suppression),
 * plus the records Scholars is itself the system of record for. Honors belong here
 * rather than upstream: `Honor.source` defaults to CURATOR and carries an
 * `enteredByCwid`, so they are entered here and approved via the honors queue.
 */
const SCHOLARS_OWNED = [
  "Your overview text",
  "Your Selected highlights",
  "Honors and distinctions, on your profile only",
  "Positions the directory omits, on your profile only",
  "Anything you have hidden. Hiding affects your profile, not search.",
  "Center membership, kept by center administrators",
];

export function ProvenanceFlow() {
  return (
    <div className="mt-5 max-w-[820px]">
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-[1fr_24px_1fr_24px_1fr] md:gap-0">
        {/* 1 — where it originates */}
        <div className="grid content-start gap-2.5">
          <ColHead>System of record</ColHead>
          {SOURCES.map((s) => (
            <Source key={s.what} what={s.what} from={s.from} />
          ))}
        </div>

        <Step />

        {/* 2 — the two computed layers the page warns are easy to confuse */}
        <div className="grid content-start gap-2.5">
          <ColHead>Attribution, topics, and scores</ColHead>
          {COMPUTED.map((c) => (
            <div key={c.name} className={`${CARD} bg-[#f6f7f9]`}>
              <span className={`block text-[15px] font-semibold ${ACCENT}`}>{c.name}</span>
              <span className="mt-0.5 block text-[13px] text-muted-foreground">{c.does}</span>
            </div>
          ))}
        </div>

        <Step />

        {/* 3 — the rendered profile, plus the one layer Scholars itself stores */}
        <div className="grid content-start gap-2.5">
          <ColHead>Where it appears</ColHead>
          <div className={`${CARD} bg-[#fafbfc]`}>
            <span className="block text-[15px] font-semibold">Your profile page</span>
            <span className="mt-0.5 block text-[13px] text-muted-foreground">
              Rebuilt nightly from everything on the left. Scholars holds a copy, not the original.
            </span>
          </div>
          <div className={`${CARD} bg-[#fafbfc]`}>
            <span className="block text-[15px] font-semibold">And across the rest of the site</span>
            <ul className="!mt-1.5 !ml-4 text-[13px] text-muted-foreground">
              {SURFACES.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/*
        The Scholars-owned layer sits below the flow rather than in a column,
        mirroring the architecture view's override layer: it merges upward into
        the surfaces above instead of belonging to any one of them. Full width
        also stops it towering over a column it never fit inside.
      */}
      <div className="mt-2.5 rounded-[10px] border border-[#c9d8ee] bg-[#f3f6fb] p-3.5">
        <div className="flex items-baseline gap-2">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 translate-y-1 text-muted-foreground"
            aria-hidden="true"
          >
            <path d="M10 17V4" />
            <path d="M6 8l4-4 4 4" />
          </svg>
          <span className="text-sm font-semibold">Stored in Scholars, and merged in on top</span>
        </div>
        <ul className="!mt-2 !ml-4 grid gap-y-1 text-[13px] text-muted-foreground sm:grid-cols-2 sm:gap-x-8">
          {SCHOLARS_OWNED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {/* The return path: the section's actual argument. */}
      <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-dashed border-[#c9d8ee] bg-[#f3f6fb] p-3.5">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={`mt-0.5 h-4 w-4 shrink-0 ${ACCENT}`}
          aria-hidden="true"
        >
          <path d="M13 8a5 5 0 1 1-1.6-3.7" />
          <path d="M13 2v3h-3" />
        </svg>
        <p className="!mt-0 text-sm">
          <strong className={ACCENT}>Corrections go back to the first column, not to Scholars.</strong>{" "}
          Editing the copy does not work: the next refresh overwrites it. Request a change on your
          profile and it routes to the office that owns that field. The only exception is the blue
          box, which Scholars owns and you edit here directly.
        </p>
      </div>
    </div>
  );
}
