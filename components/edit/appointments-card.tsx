/**
 * The Appointments attribute panel (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Panel — Appointments). A thin config wrapper
 * over the shared `EntityPanel`. Lists the scholar's ACTIVE appointments
 * (the set the profile sidebar renders); a chair appointment renders `locked`
 * (no control + explanatory text).
 */
"use client";

import { Badge } from "@/components/ui/badge";
import { EntityPanel } from "@/components/edit/entity-panel";
import type { EditContextAppointment } from "@/lib/api/edit-context";

export type AppointmentsCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  appointments: ReadonlyArray<EditContextAppointment>;
};

function yearRange(startDate: string | null, endDate: string | null): string {
  const start = startDate ? startDate.slice(0, 4) : null;
  const end = endDate ? endDate.slice(0, 4) : "present";
  if (!start) return end === "present" ? "" : end;
  return `${start}–${end}`;
}

export function AppointmentsCard({ cwid, mode, scholarName, appointments }: AppointmentsCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";
  return (
    <EntityPanel
      slot="appointments-panel"
      cwid={cwid}
      mode={mode}
      scholarName={scholarName}
      entityType="appointment"
      entities={appointments}
      getTitle={(a) => a.title}
      renderMeta={(a) => (
        <>
          {a.isPrimary && (
            <>
              <Badge variant="secondary">Primary</Badge>
              {" · "}
            </>
          )}
          {a.organization}
          {yearRange(a.startDate, a.endDate) && <>{" · "}{yearRange(a.startDate, a.endDate)}</>}
        </>
      )}
      copy={{
        heading: "Appointments",
        description: `Hide an appointment to remove it from ${possessive} public profile. A department chair role can't be hidden here. Hiding is display-only — it doesn't correct the record, which stays in WCM systems and on internal reports.`,
        empty: mode === "superuser" ? "This scholar has no appointments on file." : "You have no appointments on file.",
        one: "appointment",
        other: "appointments",
        lockedNote: "This is a department chair appointment and can't be hidden here.",
      }}
    />
  );
}
