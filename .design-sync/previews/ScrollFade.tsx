import { ScrollFade } from "scholars-profile-system";

const topics: string[] = [
  "Tumor immunology and immunotherapy resistance",
  "Single-cell genomics of the tumor microenvironment",
  "Ferroptosis and redox biology in cancer",
  "CRISPR screening for synthetic lethality",
  "Epigenetic regulation of stem cell fate",
  "Structural biology of membrane transporters",
  "Computational modeling of gene regulatory networks",
  "Neuroinflammation in neurodegenerative disease",
  "Metabolic reprogramming in hepatocellular carcinoma",
  "Vascular biology and angiogenesis",
];

const grants: Array<{ title: string; award: string }> = [
  { title: "Mechanisms of ferroptosis in acute kidney injury", award: "R01DK123456" },
  { title: "Single-cell atlas of the injured renal tubule", award: "U01DK134567" },
  { title: "Iron chelation therapy for chronic kidney disease", award: "ASN-22-778" },
  { title: "GPX4 as a therapeutic target in tubular injury", award: "R21GM145890" },
  { title: "Redox biology core facility renewal", award: "WCM-CORE-4471" },
  { title: "Longitudinal biomarkers of AKI-to-CKD transition", award: "K23DK198234" },
  { title: "Sex differences in ferroptosis susceptibility", award: "AHA-24-908812" },
  { title: "Novel iron-chelating nanoparticle delivery", award: "R01EB029456" },
];

export function ResearchTopicsRail() {
  return (
    <div className="p-4" style={{ width: 260 }}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Research topics
      </p>
      <ScrollFade viewportClassName="max-h-64 overflow-y-auto pr-2">
        <ul className="divide-y divide-border text-sm text-foreground">
          {topics.map((t) => (
            <li key={t} className="pb-2 pt-2 first:pt-0">
              {t}
            </li>
          ))}
        </ul>
      </ScrollFade>
    </div>
  );
}

export function GrantsSidebar() {
  return (
    <div className="rounded-md border border-border p-4" style={{ width: 280 }}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Active grants
      </p>
      <ScrollFade viewportClassName="max-h-64 overflow-y-auto pr-2">
        <ul className="divide-y divide-border">
          {grants.map((g) => (
            <li key={g.award} className="pb-2 pt-2 first:pt-0">
              <p className="text-sm leading-snug text-foreground">{g.title}</p>
              <p className="text-xs text-muted-foreground">{g.award}</p>
            </li>
          ))}
        </ul>
      </ScrollFade>
    </div>
  );
}
