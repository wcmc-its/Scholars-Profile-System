/**
 * `/edit` landing for a non-scholar proxy who serves MORE THAN ONE scholar
 * (#779 / scholar-proxy-spec.md § Identity and session — the department-admin
 * fan-out, D5). A single-grant proxy is redirected straight to their scholar; a
 * proxy with no grant 404s — so this renders only for the 2+ case.
 *
 * Deliberately minimal: a picker so the proxy chooses whose profile to edit.
 * Visual/interaction polish (and a richer "scholars I serve" dashboard) is a
 * UI-SPEC deliverable; v1 is this list.
 */
import Link from "next/link";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { identityImageEndpoint } from "@/lib/headshot";

export type ProxyLandingScholar = {
  cwid: string;
  preferredName: string;
};

export function ProxyLanding({ scholars }: { scholars: ProxyLandingScholar[] }) {
  return (
    <div className="bg-apollo-page min-h-screen">
      <ConsoleTopBar />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-10">
        <h2 className="text-lg font-semibold">Profiles you edit as a proxy</h2>
        <p className="text-muted-foreground mt-1 mb-6 text-sm">
          You have been designated to edit these scholars&rsquo; profiles on their behalf. Choose one
          to continue.
        </p>
        <ul className="flex flex-col gap-2" data-testid="proxy-landing-list">
          {scholars.map((s) => (
            <li key={s.cwid}>
              <Link
                href={`/edit/scholar/${encodeURIComponent(s.cwid)}`}
                className="apollo-card hover:border-apollo-maroon/40 flex items-center gap-3 px-4 py-3 transition-colors"
                data-testid={`proxy-landing-item-${s.cwid}`}
              >
                <HeadshotAvatar
                  cwid={s.cwid}
                  preferredName={s.preferredName}
                  identityImageEndpoint={identityImageEndpoint(s.cwid)}
                  size="sm"
                />
                <span className="font-medium">{s.preferredName}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
