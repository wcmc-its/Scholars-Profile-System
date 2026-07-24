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

function Chevron({ dir }: { dir: "right" | "down" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d={dir === "right" ? "M5 3l5 5-5 5" : "M3 5l5 5 5-5"} />
    </svg>
  );
}

/** Between-column cue: a chevron on wide screens, a caret between stacked groups on narrow. */
function Step() {
  return (
    <>
      <div className="hidden items-start justify-center pt-[42px] text-muted-foreground md:flex">
        <Chevron dir="right" />
      </div>
      <div className="flex justify-center text-muted-foreground md:hidden">
        <Chevron dir="down" />
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
  { what: "Name, photo", from: "WCM Web Directory" },
  { what: "Title, department, appointments", from: "ASMS, Enterprise Directory" },
  { what: "Publications", from: "PubMed, Scopus, OpenAlex" },
  { what: "Funding", from: "InfoEd, NIH RePORTER" },
  { what: "Disclosures, hospital position", from: "COI system, NewYork-Presbyterian" },
];

const COMPUTED: { name: string; does: string }[] = [
  { name: "ReCiter", does: "Decides which publications are yours" },
  { name: "ReciterAI", does: "Research areas, the Impact score, and your synopses" },
];

const SCHOLARS_OWNED = [
  "Your overview text",
  "Publications you have hidden",
  "Selected highlights",
  "Center membership",
];

export function ProvenanceFlow() {
  return (
    <div className="mt-5 max-w-[820px]">
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-[1fr_24px_1fr_24px_1fr] md:gap-0">
        {/* 1 — where it originates */}
        <div className="grid content-start gap-2.5">
          <ColHead>System origin</ColHead>
          {SOURCES.map((s) => (
            <Source key={s.what} what={s.what} from={s.from} />
          ))}
        </div>

        <Step />

        {/* 2 — the two computed layers the page warns are easy to confuse */}
        <div className="grid content-start gap-2.5">
          <ColHead>What Scholars works out</ColHead>
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
          <ColHead>What you see</ColHead>
          <div className={`${CARD} bg-[#fafbfc]`}>
            <span className="block text-[15px] font-semibold">Your profile page</span>
            <span className="mt-0.5 block text-[13px] text-muted-foreground">
              Rebuilt nightly from everything on the left. Scholars holds a copy, not the original.
            </span>
          </div>
          <div className="rounded-[10px] border border-[#c9d8ee] bg-[#f3f6fb] p-3">
            <span className="block text-sm font-semibold">Added when the page is built</span>
            <span className="mt-0.5 block text-[13px] text-muted-foreground">
              The short list Scholars stores itself, and the only part you edit here.
            </span>
            <ul className="!mt-1.5 !ml-4 text-[13px] text-muted-foreground">
              {SCHOLARS_OWNED.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
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
