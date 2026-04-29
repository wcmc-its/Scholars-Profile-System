/**
 * Synthetic grants. Filter logic on the read side (spec line 125) excludes:
 *   - Confidential = 'Y'
 *   - program_type = 'Contract without funding'
 *   - Null Project_Period_Start / Project_Period_End
 *   - Roles other than PI / PI-Subaward / Co-PI / Co-I / Key Personnel
 *
 * The seed only inserts grants that pass the filter (no need to demonstrate
 * exclusion in Phase 2; the Phase 4 ETL will exercise that logic).
 */
import { prisma } from "@/lib/db";

type GrantSpec = {
  cwid: string;
  title: string;
  role: string;
  funder: string;
  startDate: Date;
  endDate: Date;
  externalId: string;
};

const grants: GrantSpec[] = [
  {
    cwid: "jas2001",
    title: "Mechanisms of Reversible Cardiac Fibrosis (R01)",
    role: "PI",
    funder: "National Heart, Lung, and Blood Institute (NIH)",
    startDate: new Date("2022-09-01"),
    endDate: new Date("2027-08-31"),
    externalId: "INFOED-JS-R01-1",
  },
  {
    cwid: "jas2001",
    title: "Translational Cardiovascular Training Program (K12)",
    role: "Co-I",
    funder: "National Heart, Lung, and Blood Institute (NIH)",
    startDate: new Date("2018-07-01"),
    endDate: new Date("2023-06-30"),
    externalId: "INFOED-JS-K12-1",
  },
  {
    cwid: "mao2004",
    title: "Microglial Subpopulations in MS Progression (R01)",
    role: "PI",
    funder: "National Institute of Neurological Disorders and Stroke (NIH)",
    startDate: new Date("2021-04-01"),
    endDate: new Date("2026-03-31"),
    externalId: "INFOED-MAO-R01-1",
  },
  {
    cwid: "mao2004",
    title: "Single-Cell Atlas of MS Lesions",
    role: "PI",
    funder: "National Multiple Sclerosis Society",
    startDate: new Date("2023-01-01"),
    endDate: new Date("2025-12-31"),
    externalId: "INFOED-MAO-NMSS-1",
  },
  {
    cwid: "lim2006",
    title: "Hepatocellular Carcinoma Therapeutic Targets (P01)",
    role: "PI",
    funder: "National Cancer Institute (NIH)",
    startDate: new Date("2020-09-01"),
    endDate: new Date("2025-08-31"),
    externalId: "INFOED-LM-P01-1",
  },
  {
    cwid: "sjo2008",
    title: "CRISPR-Based Variant Interpretation Platform (R01)",
    role: "PI",
    funder: "National Human Genome Research Institute (NIH)",
    startDate: new Date("2022-04-01"),
    endDate: new Date("2027-03-31"),
    externalId: "INFOED-SJ-R01-1",
  },
  {
    cwid: "dpa2010",
    title: "Pediatric Sickle Cell Translational Career Award (K23)",
    role: "PI",
    funder: "National Heart, Lung, and Blood Institute (NIH)",
    startDate: new Date("2021-07-01"),
    endDate: new Date("2026-06-30"),
    externalId: "INFOED-DP-K23-1",
  },
  {
    cwid: "dpa2010",
    title: "Sickle Cell Disease Translational Network",
    role: "Co-I",
    funder: "National Heart, Lung, and Blood Institute (NIH)",
    startDate: new Date("2017-09-01"),
    endDate: new Date("2022-08-31"),
    externalId: "INFOED-DP-NET-1",
  },
];

export async function seedGrants() {
  for (const g of grants) {
    await prisma.grant.create({
      data: g,
    });
  }
}
