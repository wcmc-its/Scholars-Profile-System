/**
 * Seed orchestrator. Idempotent — wipes the relevant tables and re-creates
 * everything from the synthetic fixtures.
 *
 * Usage: `npm run seed`
 */
import { db } from "@/lib/db";
import { seedScholars } from "./scholars";
import { seedPublications } from "./publications";
import { seedGrants } from "./grants";
import { seedEducation } from "./education";

async function reset() {
  // Order matters: child tables first, parent tables last.
  await db.write.publicationScore.deleteMany();
  await db.write.topicAssignment.deleteMany();
  await db.write.publicationAuthor.deleteMany();
  await db.write.publication.deleteMany();
  await db.write.grant.deleteMany();
  await db.write.education.deleteMany();
  await db.write.appointment.deleteMany();
  await db.write.cwidAlias.deleteMany();
  await db.write.slugHistory.deleteMany();
  await db.write.scholar.deleteMany();
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
    scholars: await db.write.scholar.count(),
    appointments: await db.write.appointment.count(),
    publications: await db.write.publication.count(),
    publicationAuthors: await db.write.publicationAuthor.count(),
    topicAssignments: await db.write.topicAssignment.count(),
    publicationScores: await db.write.publicationScore.count(),
    grants: await db.write.grant.count(),
    education: await db.write.education.count(),
    slugHistory: await db.write.slugHistory.count(),
    cwidAliases: await db.write.cwidAlias.count(),
  };

  console.log("Seed complete:", counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
