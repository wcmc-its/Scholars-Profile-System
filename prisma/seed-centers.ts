/**
 * Seed the `center` table with WCM cross-disciplinary research centers.
 *
 * Run: npx tsx prisma/seed-centers.ts
 *
 * Idempotent — re-running upserts each row by `code`. `directorCwid` and
 * `scholarCount` are intentionally left null/0 here; populate via:
 *   - directorCwid: manual SQL once a real scholar match exists
 *   - scholarCount: future ETL (e.g. reporting_cancer_center for the
 *     Meyer Cancer Center)
 */
import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../lib/generated/prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });

type Seed = {
  code: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  centerType: "center" | "institute";
};

const CENTERS: Seed[] = [
  {
    code: "englander_ipm",
    name: "Englander Institute for Precision Medicine",
    slug: "englander-precision-medicine",
    description:
      "Genomic medicine, precision diagnostics, and translational therapeutics across cancer, rare disease, and immunology.",
    sortOrder: 10,
    centerType: "institute",
  },
  {
    code: "meyer_cancer_center",
    name: "Sandra and Edward Meyer Cancer Center",
    slug: "meyer-cancer-center",
    description:
      "NCI-designated cancer center spanning basic, translational, and clinical oncology research at WCM and NewYork-Presbyterian.",
    sortOrder: 20,
    centerType: "center",
  },
  {
    code: "cardiovascular_ri",
    name: "Cardiovascular Research Institute",
    slug: "cardiovascular-research-institute",
    description:
      "Multidisciplinary cardiovascular science from molecular pathways to clinical trials, including the cardio-oncology consortium.",
    sortOrder: 40,
    centerType: "institute",
  },
  {
    code: "computational_biomed",
    name: "Institute for Computational Biomedicine",
    slug: "computational-biomedicine",
    description:
      "Computational genomics, biomedical informatics, machine learning in medicine, and clinical decision support research.",
    sortOrder: 50,
    centerType: "institute",
  },
  {
    code: "aging_research",
    name: "Center for Aging Research",
    slug: "aging-research",
    description:
      "Geroscience, late-life cognitive and physical decline, and the clinical care of older adults across WCM and partner sites.",
    sortOrder: 60,
    centerType: "center",
  },
  {
    code: "iris_cantor_womens_health",
    name: "Iris Cantor Women's Health Center",
    slug: "iris-cantor-womens-health",
    description:
      "Sex-specific medicine, reproductive endocrinology, and clinical research focused on women's cardiovascular and metabolic health.",
    sortOrder: 70,
    centerType: "center",
  },
  {
    code: "inflammation_research",
    name: "Center for Inflammation Research",
    slug: "inflammation-research",
    description:
      "Innate and adaptive immunity in chronic disease, autoimmune mechanisms, and immunotherapy development.",
    sortOrder: 80,
    centerType: "center",
  },
  {
    code: "health_equity",
    name: "Center for Health Equity Research",
    slug: "health-equity-research",
    description:
      "Population health, social determinants of health, and disparities research across NYC and national cohorts.",
    sortOrder: 90,
    centerType: "center",
  },
];

async function main() {
  let inserted = 0;
  let updated = 0;
  for (const c of CENTERS) {
    const existing = await prisma.center.findUnique({ where: { code: c.code } });
    await prisma.center.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        slug: c.slug,
        description: c.description,
        sortOrder: c.sortOrder,
        centerType: c.centerType,
        source: "seed",
      },
      update: {
        name: c.name,
        slug: c.slug,
        description: c.description,
        sortOrder: c.sortOrder,
        centerType: c.centerType,
      },
    });
    existing ? updated++ : inserted++;
  }
  console.log(`Centers seeded: ${inserted} new, ${updated} updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
