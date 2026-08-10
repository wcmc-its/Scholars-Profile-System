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
};

const DOI_PATTERN = /^10\.\d{4,9}\//;

/** Resolve a dataset's accession-or-DOI to a public link, or null when
 *  neither a known repository resolver nor the DOI pattern matches. */
function resolveUrl(d: Dataset): string | null {
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
  const url = resolveUrl(dataset);
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-3">
      <div>
        <div className="text-base leading-snug font-medium">{dataset.repository}</div>
        <div className="text-muted-foreground mt-0.5 text-sm">
          {dataset.dataType ? <span>{dataset.dataType}</span> : null}
          {dataset.dataType && dataset.depositYear ? " · " : null}
          {dataset.depositYear ? <span>{dataset.depositYear}</span> : null}
        </div>
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
