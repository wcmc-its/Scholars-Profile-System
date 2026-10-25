"use client";

/**
 * #3071 — pieces the grant attribution queue and report 14 share: the
 * RePORTER name line, the plain-language account of the check, and the
 * requeue call.
 * Mockup: Projects/Scholars-Profile-System/mockups (Grant Attribution
 * Showcase canvas). Imports only the pure `@/lib/edit/grant-attribution-queue`.
 */
import { reporterNameParts } from "@/lib/edit/grant-attribution-queue";
import { cn } from "@/lib/utils";

/** The report's address, by its stable number. */
export const GRANT_ATTRIBUTION_REPORT_HREF = "/edit/reports/14";

/** "RePORTER: Pat D. Example", the words that differ from the scholar's
 *  names on record marked in red. Nothing when the run recorded no name. */
export function ReporterNameLine({
  reporterName,
  scholarNames,
  className,
}: {
  reporterName: string | null;
  scholarNames: ReadonlyArray<string>;
  className?: string;
}) {
  if (!reporterName) return null;
  const parts = reporterNameParts(reporterName, scholarNames);
  const differs = parts.some((p) => p.differs);
  return (
    <span
      className={cn("text-muted-foreground text-[12.5px]", className)}
      data-testid="reporter-name-line"
    >
      RePORTER:{" "}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          {p.differs ? (
            <mark className="text-destructive bg-transparent font-medium">{p.text}</mark>
          ) : (
            p.text
          )}
        </span>
      ))}
      {differs ? <span className="sr-only"> (differs from the scholar&rsquo;s name)</span> : null}
    </span>
  );
}

/** The plain-language account of the check, shared with the report. */
export function HowWeCheck() {
  return (
    <>
      <p className="m-0 text-[13px] leading-normal text-[#3a3532]">
        NIH RePORTER links awards to people by name, so some belong to a namesake. Each week every
        such award is weighed against:
      </p>
      <ul className="m-0 pl-[18px] text-[13px] leading-relaxed text-[#3a3532]">
        <li>Papers in the scholar&rsquo;s confirmed publications that cite the award</li>
        <li>
          Whether the scholar&rsquo;s accepted papers already link them to the award&rsquo;s NIH
          profile
        </li>
        <li>Co-investigators who co-author with the scholar</li>
        <li>Where and when the scholar trained and worked</li>
        <li>WCM records of who holds the award, and whether anyone else at WCM shares the name</li>
        <li>How many NIH investigators share the name</li>
      </ul>
      <p className="m-0 text-[13px] leading-normal text-[#3a3532]">
        Clear evidence shows or hides the award on its own. Anything in between waits in the queue
        for a curator.
      </p>
    </>
  );
}

/** Send an award the check settled on its own back to the queue. */
export async function postRequeue(
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/requeue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 409 && data?.error === "already_pending")
      return { ok: false, message: "This award is already in To review." };
    if (res.status === 409 && data?.error === "decided") {
      return {
        ok: false,
        message: "A curator has decided this award. Use Move back to review on its row instead.",
      };
    }
    if (res.status === 409 && data?.error === "hidden_by_age") {
      return {
        ok: false,
        message: "This award is hidden because it is old, so reviewing it would not show it.",
      };
    }
    if (res.status === 403)
      return { ok: false, message: "Your role can read this queue but not decide it." };
    return { ok: false, message: "We couldn't send that award to review. Please try again." };
  } catch {
    return { ok: false, message: "We couldn't send that award to review. Please try again." };
  }
}
