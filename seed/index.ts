/**
 * Seed orchestrator. Idempotent — wipes the relevant tables and re-creates
 * everything from the synthetic fixtures.
 *
 * Usage: `npm run seed`
 */
import { prisma } from "@/lib/db";
import { seedScholars } from "./scholars";
import { seedPublications } from "./publications";
import { seedGrants } from "./grants";
import { seedEducation } from "./education";

async function reset() {
  // Order matters: child tables first, parent tables last.
  await prisma.publicationScore.deleteMany();
  await prisma.topicAssignment.deleteMany();
  await prisma.publicationAuthor.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.grant.deleteMany();
  await prisma.education.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.cwidAlias.deleteMany();
  await prisma.slugHistory.deleteMany();
  await prisma.scholar.deleteMany();
}

async function main() {
  console.log("Resetting tables...");
  await reset();

  console.log("Seeding scholars + appointments + identity-history rows...");
  await seedScholars();

  console.log("Seeding education + training...");
  await seedEducation();

  console.log("Seeding grants...");
  await seedGrants();

  console.log("Seeding publications + authorship + topic-assignments + pub-scores...");
  await seedPublications();

  const counts = {
    scholars: await prisma.scholar.count(),
    appointments: await prisma.appointment.count(),
    publications: await prisma.publication.count(),
    publicationAuthors: await prisma.publicationAuthor.count(),
    topicAssignments: await prisma.topicAssignment.count(),
    publicationScores: await prisma.publicationScore.count(),
    grants: await prisma.grant.count(),
    education: await prisma.education.count(),
    slugHistory: await prisma.slugHistory.count(),
    cwidAliases: await prisma.cwidAlias.count(),
  };

  console.log("Seed complete:", counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
