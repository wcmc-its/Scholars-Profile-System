"use client";

import { useMemo } from "react";
import type { ProfilePayload } from "@/lib/api/profile";

type Dataset = ProfilePayload["datasets"][number];

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
  const sorted = useMemo(
    () => [...datasets].sort((a, b) => (b.depositYear ?? 0) - (a.depositYear ?? 0)),
    [datasets],
  );

  if (sorted.length === 0) return null;

  return (
    <ul>
      {sorted.map((d) => (
        <li key={d.datasetId} className="border-border border-t py-3 first:border-t-0">
          <DatasetRow dataset={d} />
        </li>
      ))}
    </ul>
  );
}

function DatasetRow({ dataset }: { dataset: Dataset }) {
  const url = resolveDatasetUrl(dataset);
  const metaParts = [
    dataset.dataType,
    dataset.depositYear ? String(dataset.depositYear) : null,
    dataset.accessModel,
    dataset.confidence,
  ].filter((p): p is string => Boolean(p));
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-3">
      <div>
        <div className="text-base leading-snug font-medium">{dataset.repository}</div>
        {metaParts.length > 0 ? (
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
