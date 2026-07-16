/**
 * #1323 — the Historical Appointments reveal panel. Lists a scholar's past
 * (source "ED-HISTORICAL") appointments, each hidden from the public profile
 * until a reveal-capable editor shows it. Unlike the active Appointments panel
 * (hide-to-suppress), this is reveal-to-show: the toggle flips
 * `Appointment.showOnProfile` via POST /api/edit/appointment-visibility.
 *
 * Display-only: it does not change the underlying record, and the CV export
 * always includes historical appointments regardless of this flag. Rendered for
 * every editor the write route authorizes via `authorizeOverviewWrite` — the
 * scholar themselves (self, self-serve), a superuser / comms_steward, a granted
 * proxy, or a unit-admin curator — and the route re-enforces the same
 * authorization, so an unauthorized POST 403s.
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { EditPanel } from "@/components/edit/edit-panel";
import type { EditContextHistoricalAppointment } from "@/lib/api/edit-context";

export type HistoricalAppointmentsCardProps = {
  scholarName: string;
  appointments: ReadonlyArray<EditContextHistoricalAppointment>;
};

function yearRange(startDate: string | null, endDate: string | null): string {
  const start = startDate ? startDate.slice(0, 4) : null;
  const end = endDate ? endDate.slice(0, 4) : null;
  if (!start && !end) return "";
  if (!start) return end ?? "";
  return `${start}–${end ?? "present"}`;
}

export function HistoricalAppointmentsCard({
  scholarName,
  appointments,
}: HistoricalAppointmentsCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setVisibility(externalId: string, showOnProfile: boolean) {
    setError(null);
    setBusyId(externalId);
    try {
      const res = await fetch("/api/edit/appointment-visibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appointmentExternalId: externalId, showOnProfile }),
      });
      if (!res.ok) {
        setError("We couldn't update this appointment. Please try again.");
        return;
      }
      // The /edit page is force-dynamic; a refresh re-reads the showOnProfile state.
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't update this appointment. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <EditPanel
      slot="historical-appointments-panel"
      heading="Historical appointments"
      subsection
      description={`Past appointments from the Weill Cornell directory. They are hidden from ${scholarName}'s public profile until you show one. Showing or hiding here is display-only — it doesn't change the record, and the CV export always includes them.`}
    >
      {appointments.length === 0 ? (
        <p className="text-muted-foreground text-sm">No historical appointments on file.</p>
      ) : (
        <ul className="divide-apollo-border divide-y" data-slot="historical-appointments-list">
          {appointments.map((a) => (
            <li
              key={a.externalId}
              className="flex items-center justify-between gap-3 py-3"
              data-testid={`historical-appointment-row-${a.externalId}`}
            >
              <div className="min-w-0">
                <p className="text-[14px] font-normal">{a.title}</p>
                <p className="text-muted-foreground text-xs">
                  {a.organization}
                  {yearRange(a.startDate, a.endDate) && (
                    <>
                      {" · "}
                      {yearRange(a.startDate, a.endDate)}
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending && busyId === a.externalId}
                onClick={() => setVisibility(a.externalId, !a.showOnProfile)}
              >
                {a.showOnProfile ? "Hide from profile" : "Show on profile"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </EditPanel>
  );
}
