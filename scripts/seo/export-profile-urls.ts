/**
 * Export every public scholar's canonical profile URL as CSV (#683, Deliverable 1).
 *
 *   npm run seo:profile-urls                       # → stdout
 *   npm run seo:profile-urls -- --out data/seo/profile-urls.csv
 *
 * Seeds the cross-team SEO outreach (#683 Workstream A): hand a partner office
 * (microsites, news, clinical) the cwid → canonical profile-URL map so inbound
 * links point at the authoritative profile. Columns:
 *
 *   cwid,name,title,department,role,url
 *
 * The URL is the live canonical (`siteBaseUrl()` + `canonicalProfilePath(slug)`),
 * so it honors `PROFILE_CANONICAL` / `NEXT_PUBLIC_SITE_URL` in the running env —
 * set those to match the target environment (prod default:
 * `https://scholars.weill.cornell.edu` + `/scholars/{slug}` until the #671 root
 * flip). Inclusion mirrors the sitemap exactly (`deletedAt: null, status:
 * "active"`, ordered by slug). Pure read; no writes.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";

import { prisma } from "@/lib/db";
import { canonicalProfilePath } from "@/lib/profile-url";
import { siteBaseUrl } from "@/lib/sitemap";

function parseArgs(argv: string[]): { out: string | null } {
  const i = argv.indexOf("--out");
  return { out: i >= 0 ? (argv[i + 1] ?? null) : null };
}

/** RFC-4180 CSV field: quote when it contains a comma, quote, or newline. */
function csv(value: string | null | undefined): string {
  const s = value ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const base = siteBaseUrl();

  const scholars = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
      roleCategory: true,
    },
    orderBy: { slug: "asc" },
  });

  const header = "cwid,name,title,department,role,url";
  const lines = scholars.map((s) =>
    [
      csv(s.cwid),
      csv(s.preferredName),
      csv(s.primaryTitle),
      csv(s.primaryDepartment),
      csv(s.roleCategory),
      csv(`${base}${canonicalProfilePath(s.slug)}`),
    ].join(","),
  );
  const body = [header, ...lines].join("\n") + "\n";

  if (out) {
    await fs.writeFile(out, body, "utf8");
    console.error(`Wrote ${scholars.length} profile URLs → ${out}`);
  } else {
    process.stdout.write(body);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
