/**
 * `/edit/cornell` — home for a Cornell Ithaca NetID sign-in (`ITHACA_LOGIN`,
 * Ithaca login plan step 5). On the proxy's partner allowlist, so it reads the
 * session through `getPartnerNetid` itself; every other `/edit` page sees a
 * partner as signed out.
 *
 * v1: the person's own ORCID iD, and "Connect your ORCID iD" (the shared
 * `/api/edit/orcid/connect` flow, which returns here). Later steps add reports
 * and center rosters.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrcidIdIcon } from "@/components/scholar/orcid-id-icon";
import { buttonVariants } from "@/components/ui/button";
import { ithacaScholar } from "@/lib/auth/partner-login";
import { getPartnerNetid, getSession } from "@/lib/auth/session-server";
import { isOrcidConnectEnabled } from "@/lib/edit/orcid-connect";

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

  if (!row) {
    return (
      <Shell>
        <p>Your Cornell account ({netid}@cornell.edu) isn&apos;t set up for Scholars.</p>
        {signOut}
      </Shell>
    );
  }

  const authenticated = row.orcidConfirmMethod === "authenticated";
  return (
    <Shell>
      <p>
        Signed in as <strong>{row.preferredName}</strong> ({netid}@cornell.edu)
      </p>
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
      {signOut}
    </Shell>
  );
}
