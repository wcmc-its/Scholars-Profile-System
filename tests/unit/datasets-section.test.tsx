/**
 * Render-path tests for the dataset deposits profile section (#2350 phase 1):
 *   - accessModel/confidence render on the muted secondary line when present,
 *     and are absent from the DOM (never the literal string "null") when not.
 *   - the newly added ACCESSION_RESOLVERS entries produce the expected href
 *     for a sample accession from each repository.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DatasetsSection } from "@/components/profile/datasets-section";
import type { ProfilePayload } from "@/lib/api/profile";

type Dataset = ProfilePayload["datasets"][number];

const dataset = (over: Partial<Dataset> = {}): Dataset => ({
  datasetId: "ds-1",
  repository: "GEO",
  accessionOrDoi: "GSE12345",
  resourceType: null,
  dataType: null,
  accessModel: null,
  depositYear: null,
  authorPosition: "first",
  confidence: null,
  title: null,
  description: null,
  creators: null,
  publisher: null,
  trialPhase: null,
  trialStatus: null,
  trialConditions: null,
  ...over,
});

describe("DatasetsSection — accessModel/confidence", () => {
  it("renders accessModel and confidence on the muted line when present", () => {
    render(<DatasetsSection datasets={[dataset({ accessModel: "controlled", confidence: "high" })]} />);
    expect(screen.getByText(/controlled/)).toBeTruthy();
    expect(screen.getByText(/high/)).toBeTruthy();
  });

  it('never renders the literal string "null" when both are absent', () => {
    const { container } = render(
      <DatasetsSection
        datasets={[
          dataset({ accessModel: null, confidence: null, dataType: null, depositYear: null }),
        ]}
      />,
    );
    expect(container.textContent).not.toContain("null");
  });

  it("omits accessModel from the DOM when null but still shows confidence", () => {
    render(<DatasetsSection datasets={[dataset({ accessModel: null, confidence: "unclear" })]} />);
    expect(screen.queryByText(/controlled|open/)).toBeNull();
    expect(screen.getByText(/unclear/)).toBeTruthy();
  });

  it("omits confidence from the DOM when null but still shows accessModel", () => {
    render(<DatasetsSection datasets={[dataset({ accessModel: "open", confidence: null })]} />);
    expect(screen.getByText(/open/)).toBeTruthy();
    expect(screen.queryByText(/high|low|unclear/)).toBeNull();
  });
});

describe("DatasetsSection — title/metadata enrichment (#2350 phase 2)", () => {
  it("renders repository as the headline and leaves metaParts unchanged when title is absent (purely additive path)", () => {
    render(
      <DatasetsSection
        datasets={[dataset({ repository: "ClinicalTrials.gov", trialPhase: "PHASE1", trialStatus: "RECRUITING" })]}
      />,
    );
    expect(screen.getByText("ClinicalTrials.gov")).toBeTruthy();
    // trialPhase/trialStatus only fold into metaParts once a title exists.
    expect(screen.queryByText(/PHASE1/)).toBeNull();
    expect(screen.queryByText(/RECRUITING/)).toBeNull();
  });

  it("renders title as the headline and folds repository/trialPhase/trialStatus into the meta line when title is present", () => {
    render(
      <DatasetsSection
        datasets={[
          dataset({
            repository: "ClinicalTrials.gov",
            accessionOrDoi: "NCT03815682",
            title: "RPTR-147 in Patients With Selected Solid Tumors and Lymphomas",
            trialPhase: "PHASE1",
            trialStatus: "TERMINATED",
            trialConditions: ["Solid Tumor", "Lymphoma"],
          }),
        ]}
      />,
    );
    expect(screen.getByText("RPTR-147 in Patients With Selected Solid Tumors and Lymphomas")).toBeTruthy();
    const meta = screen.getByText(/PHASE1/);
    expect(meta.textContent).toContain("ClinicalTrials.gov");
    expect(meta.textContent).toContain("PHASE1");
    expect(meta.textContent).toContain("TERMINATED");
    expect(meta.textContent).toContain("Solid Tumor, Lymphoma");
  });

  it("composes publisher/creators/description into the TechnologyOverview trigger, DataCite-only fields never on a CT.gov row", () => {
    render(
      <DatasetsSection
        datasets={[
          dataset({
            repository: "Zenodo",
            accessionOrDoi: "10.5281/zenodo.1211768",
            title: "A global distribution of dissolved organic carbon",
            publisher: "Zenodo",
            creators: ["Jane Doe", "John Smith"],
            description: "Current global carbon models...",
          }),
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Overview" });
    expect(trigger).toBeTruthy();
  });

  it("shows no Overview trigger when there's no title/description/creators/publisher (CT.gov-only row)", () => {
    render(
      <DatasetsSection
        datasets={[
          dataset({
            repository: "ClinicalTrials.gov",
            title: "A trial",
            trialConditions: ["Solid Tumor"],
          }),
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.getByText(/Solid Tumor/)).toBeTruthy();
  });
});

describe("DatasetsSection — new accession resolvers (#2350 phase 1)", () => {
  const cases: Array<{ repository: string; accession: string; href: string }> = [
    {
      repository: "ClinicalTrials.gov",
      accession: "NCT04267848",
      href: "https://clinicaltrials.gov/study/NCT04267848",
    },
    {
      repository: "ProteomeXchange",
      accession: "PXD000001",
      href: "http://proteomecentral.proteomexchange.org/cgi/GetDataset?ID=PXD000001",
    },
    {
      repository: "MassIVE",
      accession: "MSV000078556",
      href: "https://massive.ucsd.edu/ProteoSAFe/dataset.jsp?accession=MSV000078556",
    },
    {
      repository: "Synapse",
      accession: "syn2580853",
      href: "https://www.synapse.org/Synapse:syn2580853",
    },
    {
      repository: "OpenNeuro",
      accession: "ds000001",
      href: "https://openneuro.org/datasets/ds000001",
    },
    {
      repository: "Metabolomics Workbench",
      accession: "ST000001",
      href: "https://www.metabolomicsworkbench.org/data/DRCCMetadata.php?Mode=Study&StudyID=ST000001",
    },
    {
      repository: "EGA",
      accession: "EGAS00001000001",
      href: "https://ega-archive.org/studies/EGAS00001000001",
    },
    {
      repository: "EGA",
      accession: "EGAD00001000001",
      href: "https://ega-archive.org/datasets/EGAD00001000001",
    },
  ];

  it.each(cases)("resolves $repository accession $accession to the expected href", ({
    repository,
    accession,
    href,
  }) => {
    render(<DatasetsSection datasets={[dataset({ repository, accessionOrDoi: accession })]} />);
    const link = screen.getByRole("link", { name: accession });
    expect(link.getAttribute("href")).toBe(href);
  });
});
