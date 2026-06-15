import type { ReactNode } from "react";

/**
 * Sidebar section wrapper used across the profile right rail (Contact,
 * Appointments, Education, …). Pure presentational with no server-only deps, so
 * it renders from both server components and client islands — the contact-email
 * reveal (`contact-email-reveal.tsx`) uses it to render a standalone Contact card
 * when there is no server-baked contact content.
 */
export function SidebarCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border py-4">
      <div className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
        {title}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
