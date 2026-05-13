import { prisma } from "@/lib/db";
import { getMenteesForMentor } from "@/lib/api/mentoring";
(async () => {
  const candidates: { cwid: string; slug: string; preferredName: string }[] = await prisma.$queryRawUnsafe(`
    SELECT s.cwid, s.slug, s.preferred_name as preferredName FROM scholar s
    WHERE s.status='active' AND s.cwid IN (
      SELECT mentor_cwid FROM postdoc_mentor_relationship
      UNION SELECT mentor_cwid FROM phd_mentor_relationship
    ) LIMIT 80
  `);
  for (const c of candidates) {
    const mentees = await getMenteesForMentor(c.cwid);
    if (mentees.length === 8 || mentees.length === 9 || mentees.length === 7) {
      console.log(`${mentees.length} ${c.slug} (${c.preferredName})`);
    }
  }
  await prisma.$disconnect();
})();
