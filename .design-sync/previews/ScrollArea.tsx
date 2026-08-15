import { ScrollArea } from "scholars-profile-system";

const grants: Array<{ title: string; sponsor: string; award: string; role: string }> = [
  { title: "Mechanisms of ferroptosis in acute kidney injury", sponsor: "NIH/NIDDK", award: "R01DK123456", role: "PI" },
  { title: "Single-cell atlas of the injured renal tubule", sponsor: "NIH/NIDDK", award: "U01DK134567", role: "Co-I" },
  { title: "Iron chelation therapy for chronic kidney disease", sponsor: "American Society of Nephrology", award: "ASN-22-778", role: "PI" },
  { title: "GPX4 as a therapeutic target in tubular injury", sponsor: "NIH/NIGMS", award: "R21GM145890", role: "PI" },
  { title: "Redox biology core facility renewal", sponsor: "Weill Cornell Medicine", award: "WCM-CORE-4471", role: "Co-PI" },
  { title: "Longitudinal biomarkers of AKI-to-CKD transition", sponsor: "NIH/NIDDK", award: "K23DK198234", role: "Mentor" },
  { title: "Computational modeling of tubular cell death pathways", sponsor: "NSF", award: "NSF-2145887", role: "Co-I" },
  { title: "Sex differences in ferroptosis susceptibility", sponsor: "American Heart Association", award: "AHA-24-908812", role: "PI" },
  { title: "Novel iron-chelating nanoparticle delivery", sponsor: "NIH/NIBIB", award: "R01EB029456", role: "Co-I" },
  { title: "Pilot: metabolomics of dialysis-dependent ESRD", sponsor: "Empire Clinical Research Investigator Program", award: "ECRIP-2023-19", role: "PI" },
  { title: "Training grant in translational nephrology", sponsor: "NIH/NIDDK", award: "T32DK007757", role: "Co-PI" },
];

const publications: Array<{ title: string; journal: string; year: number }> = [
  { title: "Ferroptosis-driven tubular injury in acute kidney disease", journal: "J Am Soc Nephrol", year: 2025 },
  { title: "Single-cell transcriptomics of renal tubular repair", journal: "Nat Med", year: 2024 },
  { title: "Iron chelation delays progression of CKD in a murine model", journal: "Kidney Int", year: 2024 },
  { title: "GPX4 depletion sensitizes tubular cells to oxidative stress", journal: "Cell Rep", year: 2023 },
  { title: "Lipid peroxidation biomarkers predict AKI-to-CKD transition", journal: "JCI Insight", year: 2023 },
  { title: "A murine model of ferroptotic tubular necrosis", journal: "Am J Physiol Renal Physiol", year: 2022 },
  { title: "Sex-specific differences in oxidative stress response", journal: "Kidney360", year: 2022 },
  { title: "Nanoparticle-delivered iron chelators reduce tubular damage", journal: "Biomaterials", year: 2021 },
  { title: "Metabolomic profiling of dialysis-dependent ESRD patients", journal: "Nephrol Dial Transplant", year: 2021 },
  { title: "Redox imbalance as a driver of chronic kidney disease", journal: "Free Radic Biol Med", year: 2020 },
  { title: "GPX4 structure-function analysis in epithelial cells", journal: "J Biol Chem", year: 2020 },
  { title: "A review of regulated cell death pathways in nephrology", journal: "Nat Rev Nephrol", year: 2019 },
];

export function GrantsList() {
  return (
    <div className="p-4" style={{ width: 380 }}>
      <p className="mb-2 text-sm font-semibold text-foreground">Grants (11)</p>
      <ScrollArea type="always" style={{ height: 200 }} className="rounded-md border border-border">
        <div className="divide-y divide-border">
          {grants.map((g) => (
            <div key={g.award} className="p-3">
              <p className="text-sm font-medium text-foreground leading-snug">{g.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {g.sponsor} &middot; {g.award} &middot; {g.role}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function PublicationsList() {
  return (
    <div className="p-4" style={{ width: 380 }}>
      <p className="mb-2 text-sm font-semibold text-foreground">Publications (12)</p>
      <ScrollArea type="always" style={{ height: 200 }} className="rounded-md border border-border">
        <div className="divide-y divide-border">
          {publications.map((p) => (
            <div key={p.title} className="p-3">
              <p className="text-sm text-foreground leading-snug">{p.title}</p>
              <p className="mt-1 text-xs text-muted-foreground italic">
                {p.journal} &middot; {p.year}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
