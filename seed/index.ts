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
  // reset() below unconditionally deletes every scholar / publication / grant /
  // appointment / education row. This file ships inside the ETL image
  // (Dockerfile COPYs the whole repo) alongside tsx and the writer DSN, and the
  // documented prod run-task slot takes a literal `npm run <script>` string — so
  // the distance between a routine ETL invocation and a full corpus wipe is one
  // mistyped word. Fail closed wherever NODE_ENV=production (both the `etl` and
  // `runtime` Dockerfile stages set it); completely inert on a dev machine.
  if (process.env.NODE_ENV === "production" && process.env.SEED_CONFIRM !== "yes") {
    throw new Error(
      "Refusing to seed with NODE_ENV=production: reset() deletes every scholar, " +
        "publication, grant, appointment and education row and replaces them with " +
        "synthetic fixtures. Set SEED_CONFIRM=yes if that is genuinely intended.",
    );
  }

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
