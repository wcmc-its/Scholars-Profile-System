/**
 * `/edit/cornell` — home for a Cornell Ithaca NetID sign-in (`ITHACA_LOGIN`,
 * Ithaca login plan step 5). On the proxy's partner allowlist, so it reads the
 * session through `getPartnerNetid` itself; every other `/edit` page sees a
 * partner as signed out.
 *
 * The centers whose members the person curates (step 4), the reports granted
 * to their eppn (step 3; PARTNER_REPORT_KEYS only),
 * and, for someone with an Ithaca roster row, their own ORCID iD with "Connect
 * your ORCID iD" (the shared `/api/edit/orcid/connect` flow, which returns here).
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrcidIdIcon } from "@/components/scholar/orcid-id-icon";
import { buttonVariants } from "@/components/ui/button";
import { ithacaScholar } from "@/lib/auth/partner-login";
import { db } from "@/lib/db";
import { getPartnerNetid, getSession } from "@/lib/auth/session-server";
import { isOrcidConnectEnabled } from "@/lib/edit/orcid-connect";
import {
  ARTICLE_COUNT_REPORT,
  HIGH_IMPACT_PUBS_REPORT,
  loadReportScopesForCwid,
  PARTNER_REPORT_KEYS,
} from "@/lib/edit/report-access";
import { loadReportMeta } from "@/lib/edit/report-meta";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cornell sign-in — Scholars",
  robots: { index: false, follow: false },
};

const OUTCOME: Record<string, { text: string; error: boolean }> = {
  connected: { text: "Your ORCID iD is connected.", error: false },
  denied: {
    text: "You didn't grant access on ORCID, so nothing changed. You can try again any time.",
    error: false,
  },
  failed: { text: "Couldn't connect your ORCID iD. Try again.", error: true },
  held: {
    text: "That ORCID iD is already on another Scholars record, so it wasn't added here. Contact the Scholars team to sort it out.",
    error: true,
  },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Scholars @ Weill Cornell Medicine</h1>
      <div className="mt-6 space-y-4">{children}</div>
    </main>
  );
}

export default async function CornellHomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.ITHACA_LOGIN !== "on") notFound();

  const netid = await getPartnerNetid();
  if (!netid) {
    // A WCM session (the proxy already sent the signed-out to SSO).
    const wcm = await getSession();
    return (
      <Shell>
        <p>
          This page is for Cornell Ithaca NetID sign-ins.
          {wcm && (
            <>
              {" "}
              You&apos;re signed in with your Weill Cornell account:{" "}
              <Link className="underline" href="/edit?attr=identifiers-profiles">
                manage your ORCID iD in your profile editor
              </Link>
              .
            </>
          )}
        </p>
      </Shell>
    );
  }

  const row = await ithacaScholar(netid);
  const raw = (await searchParams)?.orcid;
  const outcome = OUTCOME[typeof raw === "string" ? raw : ""];
  const signOut = (
    <form action="/api/auth/logout" method="POST">
      <button type="submit" className="text-muted-foreground text-sm underline">
        Sign out
      </button>
    </form>
  );

  // Reports granted to this eppn (PARTNER_REPORT_KEYS only; report 8 = Article
  // count, 9 = High-impact publications).
  const eppn = `${netid}@cornell.edu`;
  const meta = await loadReportMeta();
  const reports = (
    await Promise.all(
      (
        [
          [ARTICLE_COUNT_REPORT, "8"],
          [HIGH_IMPACT_PUBS_REPORT, "9"],
        ] as const
      ).map(async ([key, n]) =>
        PARTNER_REPORT_KEYS.has(key) && (await loadReportScopesForCwid(eppn, key)).size > 0
          ? meta.get(n) ?? null
          : null,
      ),
    )
  ).filter((m) => m !== null);

  // Centers this eppn curates (login step 4; center grants only).
  const centerGrants = await db.read.unitAdmin.findMany({
    where: { cwid: eppn, entityType: "center" },
    select: { entityId: true },
  });
  const centers =
    centerGrants.length === 0
      ? []
      : await db.read.center.findMany({
          where: { code: { in: centerGrants.map((g) => g.entityId) } },
          select: { code: true, name: true },
          orderBy: { name: "asc" },
        });

  if (!row && reports.length === 0 && centers.length === 0) {
    return (
      <Shell>
        <p>Your Cornell account ({eppn}) isn&apos;t set up for Scholars.</p>
        {signOut}
      </Shell>
    );
  }

  const authenticated = row?.orcidConfirmMethod === "authenticated";
  return (
    <Shell>
      <p>
        Signed in as <strong>{row?.preferredName ?? netid}</strong> ({eppn})
      </p>
      {centers.length > 0 && (
        <section className="border-apollo-border-strong space-y-3 rounded-lg border p-4">
          <h2 className="text-lg font-semibold">Your centers</h2>
          <ul className="list-disc space-y-1 pl-5">
            {centers.map((c) => (
              <li key={c.code}>
                <Link className="underline" href={`/edit/center/${encodeURIComponent(c.code)}`}>
                  {c.name}
                </Link>{" "}
                <span className="text-muted-foreground text-sm">members</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reports.length > 0 && (
        <section className="border-apollo-border-strong space-y-3 rounded-lg border p-4">
          <h2 className="text-lg font-semibold">Your reports</h2>
          <ul className="list-disc space-y-1 pl-5">
            {reports.map((r) => (
              <li key={r.slug}>
                <Link className="underline" href={`/edit/reports/${r.slug}`}>
                  {r.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {row && (
        <section className="border-apollo-border-strong space-y-3 rounded-lg border p-4">
          <h2 className="text-lg font-semibold">Your ORCID iD</h2>
          {row.orcid ? (
            <p className="flex items-center gap-2">
              <OrcidIdIcon />
              <a
                className="font-mono underline"
                href={`https://orcid.org/${row.orcid}`}
                target="_blank"
                rel="noreferrer"
              >
                {row.orcid}
              </a>
              <span className="text-muted-foreground text-sm">
                {authenticated ? "Authenticated" : "On file, not yet verified by you"}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">No ORCID iD on file.</p>
          )}
          {outcome && (
            <p role="status" className={outcome.error ? "text-destructive" : undefined}>
              {outcome.text}
            </p>
          )}
          {isOrcidConnectEnabled() && !authenticated && (
            // A full navigation, not <Link>: a prefetch would start the OAuth flow.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a
              href="/api/edit/orcid/connect"
              className={`${buttonVariants({ variant: "apollo", size: "sm" })} gap-2`}
              data-testid="orcid-connect"
            >
              <OrcidIdIcon />
              {row.orcid ? "Sign in to ORCID to verify" : "Connect your ORCID iD"}
            </a>
          )}
        </section>
      )}
      {signOut}
    </Shell>
  );
}
