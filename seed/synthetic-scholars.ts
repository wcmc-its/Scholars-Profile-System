/**
 * Synthetic seed data for the Phase 1 prototype.
 *
 * Covers identity-layer edge cases:
 *   - Standard ASCII names
 *   - Diacritics (NFKD-decomposable)
 *   - Non-decomposable Latin extensions (Søren)
 *   - Apostrophes and hyphens (O'Brien)
 *   - CJK names that rely on ED romanization for slug
 *   - Slug collision (two Jane Smiths)
 *   - Name-change history (slug_history rows)
 *   - Soft-deleted scholars (Q4' departure)
 *   - CWID aliases (Q2' replacement_cwid)
 *
 * NO real WCM data. All names, CWIDs, and content are fictional.
 *
 * Usage: `npm run seed`
 */
import { prisma } from "@/lib/db";
import { deriveSlug } from "@/lib/slug";

type SeedScholar = {
  cwid: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string;
  primaryDepartment: string;
  email: string;
  overview: string | null;
  // Slug override for collision testing; otherwise derived from preferredName.
  slugOverride?: string;
  // For soft-delete testing.
  deletedAt?: Date;
  // ISO8601 to control ordering for collision-resolution determinism.
  createdAt: Date;
  appointmentTitle: string;
  appointmentOrg: string;
};

const scholars: SeedScholar[] = [
  {
    cwid: "jas2001",
    preferredName: "Jane Smith",
    fullName: "Jane Adelaide Smith",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Department of Medicine",
    email: "jas2001@med.cornell.edu",
    overview:
      "Dr. Smith's research focuses on the molecular mechanisms of cardiac fibrosis and the development of targeted therapeutics for heart failure.",
    createdAt: new Date("2018-01-15"),
    appointmentTitle: "Professor of Medicine",
    appointmentOrg: "Department of Medicine",
  },
  {
    cwid: "jod2002",
    preferredName: "John Doe",
    fullName: "John Patrick Doe",
    primaryTitle: "Associate Professor of Surgery",
    primaryDepartment: "Department of Surgery",
    email: "jod2002@med.cornell.edu",
    overview:
      "Dr. Doe is a board-certified general surgeon with expertise in minimally invasive abdominal procedures.",
    createdAt: new Date("2019-08-01"),
    appointmentTitle: "Associate Professor of Surgery",
    appointmentOrg: "Department of Surgery",
  },
  {
    cwid: "mga2003",
    preferredName: "María José García-López",
    fullName: "María José García-López",
    primaryTitle: "Assistant Professor of Pediatrics",
    primaryDepartment: "Department of Pediatrics",
    email: "mga2003@med.cornell.edu",
    overview: "Dr. García-López studies pediatric infectious disease epidemiology in immigrant populations.",
    createdAt: new Date("2021-03-10"),
    appointmentTitle: "Assistant Professor of Pediatrics",
    appointmentOrg: "Department of Pediatrics",
  },
  {
    cwid: "mao2004",
    preferredName: "Mary-Anne O'Brien",
    fullName: "Mary-Anne Catherine O'Brien",
    primaryTitle: "Professor of Neurology",
    primaryDepartment: "Department of Neurology",
    email: "mao2004@med.cornell.edu",
    overview:
      "Dr. O'Brien's lab investigates the neuroinflammatory basis of multiple sclerosis using single-cell sequencing approaches.",
    createdAt: new Date("2015-09-01"),
    appointmentTitle: "Professor of Neurology",
    appointmentOrg: "Department of Neurology",
  },
  {
    cwid: "ski2005",
    preferredName: "Søren Kierkegaard",
    fullName: "Søren Aabye Kierkegaard",
    primaryTitle: "Associate Professor of Psychiatry",
    primaryDepartment: "Department of Psychiatry",
    email: "ski2005@med.cornell.edu",
    overview: "Dr. Kierkegaard studies existential dimensions of clinical depression and trauma recovery.",
    createdAt: new Date("2017-06-15"),
    appointmentTitle: "Associate Professor of Psychiatry",
    appointmentOrg: "Department of Psychiatry",
  },
  {
    cwid: "lim2006",
    // ED romanization is the slug source per Q3' refinement; CJK names slug to "" via deriveSlug,
    // so we supply the romanized form as preferredName in production. Here we mirror that.
    preferredName: "Li Ming",
    fullName: "李明 (Li Ming)",
    primaryTitle: "Professor of Oncology",
    primaryDepartment: "Department of Medicine",
    email: "lim2006@med.cornell.edu",
    overview: "Dr. Li directs the precision oncology program with a focus on hepatocellular carcinoma.",
    createdAt: new Date("2014-01-15"),
    appointmentTitle: "Professor of Oncology",
    appointmentOrg: "Department of Medicine",
  },
  // Collision case: another Jane Smith, joined later — gets jane-smith-2.
  {
    cwid: "jas2007",
    preferredName: "Jane Smith",
    fullName: "Jane Beatrice Smith",
    primaryTitle: "Assistant Professor of Radiology",
    primaryDepartment: "Department of Radiology",
    email: "jas2007@med.cornell.edu",
    overview:
      "Dr. Smith's clinical research focuses on quantitative MRI biomarkers in early-stage breast cancer.",
    slugOverride: "jane-smith-2", // explicit because seed runs in a single transaction
    createdAt: new Date("2023-07-01"), // after jas2001
    appointmentTitle: "Assistant Professor of Radiology",
    appointmentOrg: "Department of Radiology",
  },
  // Name-change history — Sarah Davies became Sarah Johnson; old slug is in slug_history.
  {
    cwid: "sjo2008",
    preferredName: "Sarah Johnson",
    fullName: "Sarah Elizabeth Johnson",
    primaryTitle: "Associate Professor of Genetics",
    primaryDepartment: "Department of Genetics",
    email: "sjo2008@med.cornell.edu",
    overview:
      "Dr. Johnson's lab develops CRISPR-based screening tools for rare-variant interpretation in clinical genetics.",
    createdAt: new Date("2016-04-15"),
    appointmentTitle: "Associate Professor of Genetics",
    appointmentOrg: "Department of Genetics",
  },
  // Soft-deleted: departed scholar, within retention window.
  {
    cwid: "rwi2009",
    preferredName: "Robert Wilson",
    fullName: "Robert Andrew Wilson",
    primaryTitle: "Professor of Cardiology",
    primaryDepartment: "Department of Medicine",
    email: "rwi2009@med.cornell.edu",
    overview: "Departed scholar, soft-deleted within the 60-day retention window for Q4' testing.",
    deletedAt: new Date(), // departed today
    createdAt: new Date("2010-09-01"),
    appointmentTitle: "Professor of Cardiology",
    appointmentOrg: "Department of Medicine",
  },
  // CWID-alias case: dpa2010 is the current CWID; the old CWID dpa1010 is in cwid_aliases.
  {
    cwid: "dpa2010",
    preferredName: "Diana Patel",
    fullName: "Diana Anjali Patel",
    primaryTitle: "Associate Professor of Pediatric Hematology",
    primaryDepartment: "Department of Pediatrics",
    email: "dpa2010@med.cornell.edu",
    overview: "Dr. Patel investigates the pathophysiology of pediatric sickle cell disease.",
    createdAt: new Date("2018-11-01"),
    appointmentTitle: "Associate Professor of Pediatric Hematology",
    appointmentOrg: "Department of Pediatrics",
  },
  // Two more standard scholars for breadth.
  {
    cwid: "jho2011",
    preferredName: "James Howard",
    fullName: "James Howard III",
    primaryTitle: "Professor of Anesthesiology",
    primaryDepartment: "Department of Anesthesiology",
    email: "jho2011@med.cornell.edu",
    overview: "Dr. Howard specializes in pediatric anesthesia and pain management.",
    createdAt: new Date("2012-01-15"),
    appointmentTitle: "Professor of Anesthesiology",
    appointmentOrg: "Department of Anesthesiology",
  },
  {
    cwid: "agr2012",
    preferredName: "Anna Grant",
    fullName: "Anna Margaret Grant",
    primaryTitle: "Assistant Professor of Dermatology",
    primaryDepartment: "Department of Dermatology",
    email: "agr2012@med.cornell.edu",
    overview: "Dr. Grant's research interests include autoimmune skin diseases and dermatologic imaging.",
    createdAt: new Date("2022-09-01"),
    appointmentTitle: "Assistant Professor of Dermatology",
    appointmentOrg: "Department of Dermatology",
  },
];

async function seed() {
  console.log("Seeding synthetic scholars...");

  // Reset (idempotent re-runs).
  await prisma.cwidAlias.deleteMany();
  await prisma.slugHistory.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.scholar.deleteMany();

  for (const s of scholars) {
    const slug = s.slugOverride ?? deriveSlug(s.preferredName);
    await prisma.scholar.create({
      data: {
        cwid: s.cwid,
        preferredName: s.preferredName,
        fullName: s.fullName,
        primaryTitle: s.primaryTitle,
        primaryDepartment: s.primaryDepartment,
        email: s.email,
        overview: s.overview,
        slug,
        deletedAt: s.deletedAt ?? null,
        createdAt: s.createdAt,
        appointments: {
          create: [
            {
              title: s.appointmentTitle,
              organization: s.appointmentOrg,
              startDate: s.createdAt,
              endDate: null,
              isPrimary: true,
              isInterim: false,
              externalId: `ED-${s.cwid}-1`,
            },
          ],
        },
      },
    });
  }

  // Sarah Johnson was previously "sarah-davies" — name change recorded in slug_history.
  await prisma.slugHistory.create({
    data: {
      oldSlug: "sarah-davies",
      currentCwid: "sjo2008",
      createdAt: new Date("2022-06-01"),
    },
  });

  // Diana Patel's old CWID was dpa1010 (replacement_cwid signal from ED).
  await prisma.cwidAlias.create({
    data: {
      oldCwid: "dpa1010",
      currentCwid: "dpa2010",
      source: "ed_replacement_cwid",
      createdAt: new Date("2019-02-15"),
    },
  });

  const count = await prisma.scholar.count();
  const slugCount = await prisma.slugHistory.count();
  const aliasCount = await prisma.cwidAlias.count();
  console.log(`Seeded ${count} scholars, ${slugCount} slug-history rows, ${aliasCount} CWID aliases.`);
}

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
