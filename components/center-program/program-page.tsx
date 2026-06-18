/**
 * Center program page (#1105) — first-class surface for
 * /centers/[slug]/programs/[code], modeled on the division page.
 *
 * Bordered hero card with a "Program in {Center}" eyebrow, description, a single
 * program LeaderCard, and a dashed-divider scholars count; below it, the active
 * roster of that program's members. Gated behind `CENTER_PROGRAM_PAGES` (the
 * route `notFound()`s when off, the center/program is missing, or the code is
 * excluded — e.g. ZY "Non-aligned Clinical").
 *
 * Membership is Prisma-sourced (via `getCenterProgram` → `getCenterMembers`),
 * NEVER the search index — per #1074/#1076 no `centerProgram:` facet key exists.
 */
import { notFound } from "next/navigation";
import { getCenterProgram } from "@/lib/api/centers";
import { isCenterProgramPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { LeaderCard } from "@/components/scholar/leader-card";
import { CenterMembersClient } from "@/components/center/center-members-client";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export async function CenterProgramPage({
  centerSlug,
  code,
}: {
  centerSlug: string;
  code: string;
}) {
  if (!isCenterProgramPagesEnabled()) notFound();

  const detail = await getCenterProgram(centerSlug, code);
  if (!detail) notFound();

  const centerPath = `/centers/${detail.center.slug}`;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/browse">Browse</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href={centerPath}>{detail.center.name}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.program.label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="rounded-lg border border-border bg-background px-7 py-[26px]">
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          Program
          <span className="ml-2 text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
            in{" "}
            <a
              href={centerPath}
              className="hover:underline"
              style={{ textDecoration: "none" }}
            >
              {detail.center.name}
            </a>
          </span>
        </div>
        <h1 className="page-title mb-[18px] text-[40px] font-medium leading-none tracking-[-0.01em]">
          {detail.program.label}
        </h1>
        {detail.program.description && (
          <p className="mb-[22px] max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {detail.program.description}
          </p>
        )}

        {detail.leader && (
          <LeaderCard
            leader={detail.leader}
            role={detail.leader.isInterim ? "Interim Leader" : "Leader"}
          />
        )}

        <div className="mt-[22px] flex flex-wrap gap-[9px] border-t border-dashed border-border pt-4 text-[14px] text-muted-foreground">
          {detail.scholarCount > 0 ? (
            <span>
              <b className="font-medium text-foreground">
                {detail.scholarCount.toLocaleString()}
              </b>{" "}
              {detail.scholarCount === 1 ? "scholar" : "scholars"}
            </span>
          ) : (
            <span>Membership data pending</span>
          )}
        </div>
      </section>

      <div className="mt-10">
        {detail.members.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No members listed for this program.
          </p>
        ) : (
          // #1105 — reuse the center roster's facet sidebar (Membership type /
          // Methods & tools / Organizational unit + the Appointment chip row) by
          // feeding this program's members as a single group. `singleProgram`
          // hides the redundant lone section header; the Program facet auto-hides
          // with one group. Still Prisma-sourced — no search-index facet key.
          <CenterMembersClient
            result={{
              mode: "grouped",
              groups: [
                {
                  label: detail.program.label,
                  code: detail.program.code,
                  members: detail.members,
                },
              ],
              total: detail.members.length,
            }}
            centerSlug={detail.center.slug}
            singleProgram
          />
        )}
      </div>
    </main>
  );
}
