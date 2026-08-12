import type { ProfilePayload } from "@/lib/api/profile";
import { TechnologyOverview } from "@/components/profile/technology-overview";

type Dataset = ProfilePayload["datasets"][number];

/** Most rows fit above the fold; the rest collapse into a native <details> —
 *  same cap and zero-JS pattern as `technologies-section.tsx`'s ROW_CAP. */
const ROW_CAP = 5;

/** Accession → repository resolver URL templates, for the repos most likely
 *  in a WCM biomedical corpus (scripts/bulk-data-rule/catalog.py's canonical
 *  names). Repos not listed here (or a DOI-keyed repo, handled separately
 *  below) render with no link — the row still shows repository + accession +
 *  data type, per the plan's "degrades gracefully" note. */
const ACCESSION_RESOLVERS: Record<string, (accession: string) => string> = {
  GEO: (a) => `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(a)}`,
  SRA: (a) => `https://www.ncbi.nlm.nih.gov/sra/?term=${encodeURIComponent(a)}`,
  dbGaP: (a) => `https://www.ncbi.nlm.nih.gov/gap/?term=${encodeURIComponent(a)}`,
  "BioProject/BioSample": (a) => `https://www.ncbi.nlm.nih.gov/bioproject/${encodeURIComponent(a)}`,
  GenBank: (a) => `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(a)}`,
  PDB: (a) => `https://www.rcsb.org/structure/${encodeURIComponent(a)}`,
  ENA: (a) => `https://www.ebi.ac.uk/ena/browser/view/${encodeURIComponent(a)}`,
  "ArrayExpress/BioStudies": (a) => `https://www.ebi.ac.uk/biostudies/arrayexpress/studies/${encodeURIComponent(a)}`,
  PRIDE: (a) => `https://www.ebi.ac.uk/pride/archive/projects/${encodeURIComponent(a)}`,
  MetaboLights: (a) => `https://www.ebi.ac.uk/metabolights/${encodeURIComponent(a)}`,
  ProteomeXchange: (a) =>
    `http://proteomecentral.proteomexchange.org/cgi/GetDataset?ID=${encodeURIComponent(a)}`,
  MassIVE: (a) => `https://massive.ucsd.edu/ProteoSAFe/dataset.jsp?accession=${encodeURIComponent(a)}`,
  "Metabolomics Workbench": (a) =>
    `https://www.metabolomicsworkbench.org/data/DRCCMetadata.php?Mode=Study&StudyID=${encodeURIComponent(a)}`,
  OpenNeuro: (a) => `https://openneuro.org/datasets/${encodeURIComponent(a)}`,
  Synapse: (a) => `https://www.synapse.org/Synapse:${encodeURIComponent(a)}`,
  // EGAD-prefixed accessions are dataset records; everything else (most
  // commonly EGAS studies) resolves under /studies/.
  EGA: (a) =>
    `https://ega-archive.org/${a.startsWith("EGAD") ? "datasets" : "studies"}/${encodeURIComponent(a)}`,
  "ClinicalTrials.gov": (a) => `https://clinicaltrials.gov/study/${encodeURIComponent(a)}`,
};

const DOI_PATTERN = /^10\.\d{4,9}\//;

/** `dataset.accessModel` is the bare `"open" | "controlled"` enum
 *  (`scripts/bulk-data-rule/attribute.py`'s `access_model()`) — readable
 *  labels for public display. `confidence` ('high'|'low'|'unclear') is
 *  deliberately NOT given the same treatment and NOT shown here at all: it's
 *  the extraction pipeline's confidence that a citation is really a deposit
 *  reference, not a fact about the dataset — a bare "high"/"low" on a public
 *  profile reads as an endorsement of the dataset, which it isn't. Still used
 *  for /edit's review-queue sort order (`lib/api/edit-context.ts`); just not
 *  rendered to a public visitor. */
const ACCESS_LABELS: Record<string, string> = {
  open: "Open access",
  controlled: "Controlled access",
};

/** Resolve a dataset's accession-or-DOI to a public link, or null when
 *  neither a known repository resolver nor the DOI pattern matches. Exported
 *  so the /edit Datasets card (#2348) links each row the same way the public
 *  profile does, rather than duplicating the resolver table. Narrowed to just
 *  the two fields it needs (not the full `Dataset` shape) so any row carrying
 *  `repository` + `accessionOrDoi` — including `EditContextDataset` — can
 *  reuse it structurally. */
export function resolveDatasetUrl(d: { repository: string; accessionOrDoi: string }): string | null {
  if (DOI_PATTERN.test(d.accessionOrDoi)) {
    return `https://doi.org/${d.accessionOrDoi}`;
  }
  return ACCESSION_RESOLVERS[d.repository]?.(d.accessionOrDoi) ?? null;
}

export function DatasetsSection({ datasets }: { datasets: Dataset[] }) {
  const sorted = [...datasets].sort((a, b) => (b.depositYear ?? 0) - (a.depositYear ?? 0));

  if (sorted.length === 0) return null;

  const head = sorted.slice(0, ROW_CAP);
  const rest = sorted.slice(ROW_CAP);

  return (
    <>
      <ul>
        {head.map((d) => (
          <li key={d.datasetId} className="border-border border-t py-3 first:border-t-0">
            <DatasetRow dataset={d} />
          </li>
        ))}
      </ul>
      {rest.length > 0 ? (
        // Native <details> so "show more" needs no client state — the section
        // stays server-rendered, same as technologies-section.tsx.
        <details className="border-border border-t">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer py-3 text-sm">
            Show {rest.length} more {rest.length === 1 ? "dataset" : "datasets"}
          </summary>
          <ul>
            {rest.map((d) => (
              <li key={d.datasetId} className="border-border border-t py-3 first:border-t-0">
                <DatasetRow dataset={d} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** "A, B, and C" (Oxford comma for 3+; "A and B" for 2; "A" for 1) — used for
 *  the Creators line in the DataCite overview composition below. */
function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function DatasetRow({ dataset }: { dataset: Dataset }) {
  const url = resolveDatasetUrl(dataset);
  const hasTitle = Boolean(dataset.title);
  // When a title exists, `repository` no longer heads the row (see below) —
  // fold it, plus the two CT.gov scalars and comma-joined conditions, into
  // the same meta line as the pre-existing fields. When there's no title yet
  // (repos Phase B doesn't cover, or before it's run at all), leave this
  // exactly as it was — a purely additive rendering path.
  const accessLabel = dataset.accessModel ? ACCESS_LABELS[dataset.accessModel] ?? dataset.accessModel : null;
  const metaParts = (
    hasTitle
      ? [
          dataset.repository,
          dataset.trialPhase,
          dataset.trialStatus,
          dataset.trialConditions && dataset.trialConditions.length > 0
            ? dataset.trialConditions.join(", ")
            : null,
          dataset.dataType,
          dataset.depositYear ? String(dataset.depositYear) : null,
          accessLabel,
        ]
      : [
          dataset.dataType,
          dataset.depositYear ? String(dataset.depositYear) : null,
          accessLabel,
        ]
  ).filter((p): p is string => Boolean(p));

  // DataCite-only fields (never populated for ClinicalTrials.gov rows) —
  // composed into one `\n`-joined string and handed to TechnologyOverview
  // as-is: a "Publisher: X" line, a "Creators: A, B, and C" line (either
  // omitted when null/empty), then the description as its own line.
  const overviewLines = [
    dataset.publisher ? `Publisher: ${dataset.publisher}` : null,
    dataset.creators && dataset.creators.length > 0
      ? `Creators: ${formatNameList(dataset.creators)}`
      : null,
    dataset.description,
  ].filter((p): p is string => Boolean(p));
  const overviewText = overviewLines.length > 0 ? overviewLines.join("\n") : null;

  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-3">
      <div>
        <div className="text-base leading-snug font-medium">{dataset.title ?? dataset.repository}</div>
        {overviewText ? (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {metaParts.length > 0 ? <span>{metaParts.join(" · ")}</span> : null}
            {metaParts.length > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/60">
                ·
              </span>
            ) : null}
            <TechnologyOverview overview={overviewText} />
          </div>
        ) : metaParts.length > 0 ? (
          <div className="text-muted-foreground mt-0.5 text-sm">{metaParts.join(" · ")}</div>
        ) : null}
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`View on ${dataset.repository}`}
          className="font-mono text-xs whitespace-nowrap text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          {dataset.accessionOrDoi}
        </a>
      ) : (
        <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
          {dataset.accessionOrDoi}
        </span>
      )}
    </div>
  );
}
