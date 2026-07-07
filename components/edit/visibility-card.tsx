/**
 * The Profile Visibility card (#356 Phase 6 C6 / Phase 7 C4, UI-SPEC § `/edit`
 * Card 2 + § `/edit/scholar/[cwid]` Card 2 superuser arm).
 *
 * Two state machines over the same `(ownRow, adminRow)` pair, one per mode:
 *
 * **Self mode** (`mode='self'`) — the scholar manages their own self-suppression
 * (`ownRow`); the admin row is informational only.
 *
 *   ┌─────────────────┬────────────────┬───────────────────────────────────┐
 *   │ ownRow          │ adminRow       │ Controls                          │
 *   ├─────────────────┼────────────────┼───────────────────────────────────┤
 *   │ null            │ null           │ "Hide my profile" → confirm dialog│
 *   │ set             │ null           │ "Make my profile visible" (revoke)│
 *   │ null            │ set            │ no control (admin-only revoke)    │
 *   │ set             │ set            │ "Remove my hold" (revoke own only)│
 *   └─────────────────┴────────────────┴───────────────────────────────────┘
 *
 * **Superuser mode** (`mode='superuser'`) — the administrator manages the
 * admin hold (`adminRow`); the scholar's self-suppression is informational
 * only (v1 does not surface a "revoke their self-hold" admin action — keeps
 * scope tight).
 *
 *   ┌─────────────────┬────────────────┬────────────────────────────────────────────┐
 *   │ ownRow          │ adminRow       │ Controls (acting on adminRow only)         │
 *   ├─────────────────┼────────────────┼────────────────────────────────────────────┤
 *   │ null            │ null           │ "Hide this scholar's profile" (req. reason)│
 *   │ set             │ null           │ "Hide this scholar's profile" + self-note  │
 *   │ null            │ set            │ "Restore this scholar's profile" (revoke)  │
 *   │ set             │ set            │ "Restore this scholar's profile" + self-note │
 *   └─────────────────┴────────────────┴────────────────────────────────────────────┘
 *
 * Hide → confirm dialog. In self mode the dialog is `optional-preset`
 * (UI-SPEC § Suppression and confirmation dialogs row 1); in superuser mode
 * the dialog is `required-text` (UI-SPEC § Suppression … row 2, SPEC §
 * Suppression UX — a superuser suppression's reason is mandatory). Revoke /
 * restore → no dialog (UI-SPEC § Feedback: confirmation gates loss of
 * visibility, never restoration).
 *
 * Endpoints (Phase 2):
 *   POST /api/edit/suppress  { entityType, entityId, reason }   → { suppressionId }
 *   POST /api/edit/revoke    { suppressionId }                  → { ok }
 *
 * On a successful write the card flips into its new state locally and calls
 * `router.refresh()` so sibling components pick up any cascading changes from
 * a suppression-OFF re-read.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { EditContextScholar } from "@/lib/api/edit-context";

/**
 * section-visibility-spec — the state the Sections panel renders. When
 * `VisibilityCard` receives it, a second "Sections" panel renders below the
 * whole-profile control with one switch per hideable section.
 */
export type SectionVisibilityCardState = {
  /** Section keys (`SECTION_VISIBILITY_FIELDS`) currently hidden. */
  hidden: readonly string[];
  /** Per-section hidden-RECORD counts from the edit-context suppression state
   *  (no new query) — only the three sections with per-record hiding carry one. */
  hiddenRecordCounts: {
    hideMentoring: number;
    hideEducation: number;
    hideFunding: number;
  };
  /** Base path for the "N records hidden →" deep-link into each record card
   *  (`/edit` for self, `/edit/scholar/<cwid>` for a superuser / proxy). */
  basePath: string;
};

/** The seven hideable sections, in display order. `recordAttr` links the audit
 *  count to that section's record-level card; `null` = no per-record hiding. */
const SECTION_PANEL_DEFS = [
  { key: "hideMentoring", label: "Mentoring", recordAttr: "mentees", countKey: "hideMentoring" },
  { key: "hideEducation", label: "Education", recordAttr: "education", countKey: "hideEducation" },
  { key: "hideFunding", label: "Funding", recordAttr: "funding", countKey: "hideFunding" },
  { key: "hideCenters", label: "Centers", recordAttr: null, countKey: null },
  { key: "hidePostdocMentor", label: "Postdoctoral Mentor", recordAttr: null, countKey: null },
  { key: "hideClinicalTrials", label: "Clinical trials", recordAttr: null, countKey: null },
  { key: "hideMethods", label: "Methods & Tools", recordAttr: null, countKey: null },
] as const;

type SuppressionRow = { id: string; reason: string };
type AdminRow = SuppressionRow & { createdAt: Date };

export type VisibilityCardProps = {
  cwid: string;
  /** The visibility-card slice of the scholar's suppression state. */
  suppression: EditContextScholar["suppression"];
  /**
   * The target scholar's preferred name — drives the superuser dialog title
   * ("Hide **{Name}**'s profile?") and the inline copy. Required when
   * `mode='superuser'`; ignored in `mode='self'`.
   */
  scholarName?: string;
  /**
   * Defaults to `'self'` for Phase 6 callers. `'superuser'` flips the state-
   * machine controls onto `adminRow`, switches the dialog to `required-text`
   * (UI-SPEC § Suppression and confirmation dialogs row 2 — a superuser
   * suppression's reason is mandatory), and adjusts the inline copy.
   */
  mode?: "self" | "superuser";
  /**
   * Reframe the first-person copy to the scholar's name (#955 #10) for an editor
   * who is NOT the scholar — a proxy / unit-admin. They drive the SAME `'self'`
   * (`ownRow`) state machine the scholar does, so `mode` stays `'self'`; only the
   * copy changes. Independent of `mode`: a superuser is already third-person via
   * `mode='superuser'`.
   */
  thirdPerson?: boolean;
  /**
   * section-visibility-spec — the Sections panel state (the seven whole-section
   * hide toggles). When provided, a second "Sections" panel renders below the
   * whole-profile control. Omitted ⇒ the panel is not rendered, so existing
   * callers / tests that pass only `suppression` are unaffected.
   */
  sections?: SectionVisibilityCardState;
};

export function VisibilityCard({
  cwid,
  suppression: initial,
  scholarName,
  mode = "self",
  thirdPerson = false,
  sections,
}: VisibilityCardProps) {
  const router = useRouter();
  const [ownRow, setOwnRow] = React.useState<SuppressionRow | null>(initial.ownRow);
  const [adminRow, setAdminRow] = React.useState<AdminRow | null>(initial.adminRow);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  // ---- POST helpers --------------------------------------------------------

  async function suppressTarget(reason: string | null) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          // server defaults a blank reason for self; superuser mode pre-validates
          // the dialog's required-text so a blank should never reach here.
          ...(reason ? { reason } : {}),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(
          mode === "superuser"
            ? "We couldn't hide this scholar's profile. Please try again."
            : "We couldn't hide your profile. Please try again.",
        );
        // Re-throw so the dialog's "Working…" state resets and the dialog
        // stays open for the user to retry / cancel.
        throw new Error("suppress_failed");
      }
      const newRow: SuppressionRow = {
        id: data.suppressionId,
        reason: reason ?? (mode === "superuser" ? "" : "Self-suppressed via /edit"),
      };
      if (mode === "self") {
        setOwnRow(newRow);
      } else {
        // The just-created superuser suppression is the new adminRow. The
        // server stamps `createdAt`; we approximate locally — a router.refresh
        // pulls the server value on the next re-render.
        setAdminRow({ ...newRow, createdAt: new Date() });
      }
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revokeTarget(suppressionId: string, which: "own" | "admin") {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressionId }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(
          which === "admin"
            ? "We couldn't restore this scholar's profile. Please try again."
            : "We couldn't make your profile visible. Please try again.",
        );
        return;
      }
      if (which === "admin") setAdminRow(null);
      else setOwnRow(null);
      router.refresh();
    } catch {
      setError(
        which === "admin"
          ? "We couldn't restore this scholar's profile. Please try again."
          : "We couldn't make your profile visible. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  // ---- render --------------------------------------------------------------

  const isHidden = ownRow !== null || adminRow !== null;
  // A superuser is third-person by definition (`mode='superuser'`); a proxy /
  // unit-admin is third-person via the explicit `thirdPerson` flag while keeping
  // the self state machine. Either way the COPY is third-person (#955 #10).
  const showThirdPerson = thirdPerson || mode === "superuser";

  return (
    <>
      <EditPanel
        slot="visibility-card"
        data-mode={mode}
        heading="Profile visibility"
        // The "Yours to edit" ownership cue is first-person — drop it for a
        // proxy / unit-admin editing on the scholar's behalf (#955 #10).
        owned={mode === "self" && !showThirdPerson}
        headerAction={
          <Badge
            variant="outline"
            className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
          >
            {isHidden ? "Hidden" : "Public"}
          </Badge>
        }
      >
        <div className="flex flex-col gap-3">
          {mode === "self"
            ? renderSelfBody({
                ownRow,
                adminRow,
                pending,
                thirdPerson,
                scholarName,
                onHide: () => setConfirmOpen(true),
                onRevokeOwn: () => ownRow && revokeTarget(ownRow.id, "own"),
              })
            : renderSuperuserBody({
                ownRow,
                adminRow,
                pending,
                onHide: () => setConfirmOpen(true),
                onRevokeAdmin: () => adminRow && revokeTarget(adminRow.id, "admin"),
              })}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </EditPanel>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          showThirdPerson
            ? `Hide ${scholarName ?? "this scholar"}'s profile?`
            : "Hide your profile?"
        }
        description={
          mode === "superuser"
            ? "This scholar's profile will be removed from public view and search immediately. A reason is required for the audit log."
            : thirdPerson
              ? `${scholarName ?? "This scholar"}'s profile will be removed from public view and search immediately. It can be made visible again at any time.`
              : "Your profile will be removed from public view and search immediately. You can make it visible again at any time."
        }
        reasonMode={mode === "superuser" ? "required-text" : "optional-preset"}
        confirmLabel={showThirdPerson ? "Hide profile" : "Hide my profile"}
        confirmVariant="destructive"
        onConfirm={suppressTarget}
      />

      {sections ? (
        <SectionsPanel
          cwid={cwid}
          state={sections}
          showThirdPerson={showThirdPerson}
          scholarName={scholarName}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// section-visibility-spec — the Sections panel: one switch per hideable section
// (7), each toggling a boolean `field_override(scholar, <key>)` via
// POST /api/edit/field. Hide → confirm dialog (optional-preset, matching the
// profile-hide pattern); show → no dialog (never gate restoration). A per-
// section read-only "N records hidden →" count links to that section's record
// card; the counts come from the edit-context suppression state (no new query).
// ---------------------------------------------------------------------------

function SectionsPanel({
  cwid,
  state,
  showThirdPerson,
  scholarName,
}: {
  cwid: string;
  state: SectionVisibilityCardState;
  showThirdPerson: boolean;
  scholarName?: string;
}) {
  const router = useRouter();
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set(state.hidden));
  const [confirmKey, setConfirmKey] = React.useState<string | null>(null);
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function writeSection(key: string, hide: boolean) {
    setError(null);
    setPendingKey(key);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: key,
          value: hide ? "true" : "false",
        }),
      });
      const data = (await res.json()) as { ok?: boolean };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't update that section. Please try again.");
        return;
      }
      setHidden((prev) => {
        const next = new Set(prev);
        if (hide) next.add(key);
        else next.delete(key);
        return next;
      });
      router.refresh();
    } catch {
      setError("We couldn't update that section. Please try again.");
    } finally {
      setPendingKey(null);
    }
  }

  // Hide (switch → on) gates on a confirm dialog; show (switch → off) applies
  // immediately (UI-SPEC § Feedback — never gate restoration).
  function onToggle(key: string, checked: boolean) {
    if (checked) setConfirmKey(key);
    else void writeSection(key, false);
  }

  const poss = showThirdPerson ? `${scholarName ?? "this scholar"}'s` : "your";
  const confirmDef = SECTION_PANEL_DEFS.find((d) => d.key === confirmKey);

  return (
    <>
      <EditPanel
        slot="visibility-sections"
        heading="Sections"
        description={`Hide a whole section from ${poss} public profile. Hidden sections stay in Scholars and remain searchable — nothing is deleted, and you can show them again at any time.`}
      >
        <ul className="divide-border flex flex-col divide-y">
          {SECTION_PANEL_DEFS.map((def) => {
            const isHidden = hidden.has(def.key);
            const count = def.countKey ? state.hiddenRecordCounts[def.countKey] : 0;
            return (
              <li
                key={def.key}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{def.label}</div>
                  <div className="text-muted-foreground text-xs">
                    {isHidden ? "Hidden" : "Visible"}
                    {def.recordAttr && count > 0 ? (
                      <>
                        {" · "}
                        <a
                          href={`${state.basePath}?attr=${def.recordAttr}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {count} {count === 1 ? "record" : "records"} hidden →
                        </a>
                      </>
                    ) : null}
                  </div>
                </div>
                <Switch
                  checked={isHidden}
                  disabled={pendingKey === def.key}
                  onCheckedChange={(checked) => onToggle(def.key, checked)}
                  aria-label={`Hide the ${def.label} section`}
                  data-testid={`section-toggle-${def.key}`}
                />
              </li>
            );
          })}
        </ul>

        {error && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </EditPanel>

      <ConfirmDialog
        open={confirmKey !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKey(null);
        }}
        title={`Hide the ${confirmDef?.label ?? "section"} section?`}
        description={`The ${confirmDef?.label ?? "section"} section will be removed from ${poss} public profile. The underlying data stays in Scholars and remains searchable — you can show it again at any time.`}
        reasonMode="optional-preset"
        confirmLabel="Hide section"
        confirmVariant="destructive"
        onConfirm={async () => {
          const key = confirmKey;
          if (!key) return;
          await writeSection(key, true);
          setConfirmKey(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Self body — the Phase 6 ownRow state machine. A proxy / unit-admin drives the
// SAME machine on the scholar's behalf, so only the copy reframes to the
// scholar's name (#955 #10 — `thirdPerson`); the first-person copy is byte-
// identical when `thirdPerson` is false.
// ---------------------------------------------------------------------------

type SelfBodyArgs = {
  ownRow: SuppressionRow | null;
  adminRow: AdminRow | null;
  pending: boolean;
  thirdPerson: boolean;
  scholarName: string | undefined;
  onHide: () => void;
  onRevokeOwn: () => void;
};

function renderSelfBody({
  ownRow,
  adminRow,
  pending,
  thirdPerson,
  scholarName,
  onHide,
  onRevokeOwn,
}: SelfBodyArgs) {
  // Possessive subject: "Your" (first-person) or the scholar's name (third).
  const Poss = thirdPerson ? `${scholarName ?? "This scholar"}'s` : "Your";
  const poss = thirdPerson ? `${scholarName ?? "this scholar"}'s` : "your";
  const restoreNote = thirdPerson
    ? "It can be made visible again at any time."
    : "You can make it visible again at any time.";
  if (ownRow === null && adminRow === null) {
    return (
      <>
        <p className="text-sm">{Poss} profile is visible to the public.</p>
        <p className="text-muted-foreground text-sm">
          Hiding removes {poss} whole profile from the public site and from search. {Poss} name may
          still appear in the WCM directory and on co-authors&apos; pages. {restoreNote}
        </p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onHide}
            data-testid="visibility-hide"
          >
            {thirdPerson ? "Hide profile" : "Hide my profile"}
          </Button>
        </div>
      </>
    );
  }
  if (ownRow !== null && adminRow === null) {
    return (
      <>
        <Alert variant="info">
          <AlertDescription>
            {Poss} profile is hidden. It is not visible to the public or in search.
          </AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="apollo"
            onClick={onRevokeOwn}
            disabled={pending}
            data-testid="visibility-revoke-self"
          >
            {pending ? "Working…" : thirdPerson ? "Make profile visible" : "Make my profile visible"}
          </Button>
        </div>
      </>
    );
  }
  if (ownRow === null && adminRow !== null) {
    return (
      <Alert variant="info">
        <AlertDescription>
          {Poss} profile has been hidden by a site administrator. Contact the
          Scholars Profile team for help.
        </AlertDescription>
      </Alert>
    );
  }
  // both — edge case 4
  return (
    <>
      <Alert variant="info">
        <AlertDescription>
          {Poss} profile has been hidden by a site administrator. Contact the
          Scholars Profile team for help.
        </AlertDescription>
      </Alert>
      <p className="text-sm">
        {thirdPerson ? "It has also been hidden directly." : "You have also hidden it yourself."}
      </p>
      <p className="text-sm text-muted-foreground">
        The profile stays hidden while the administrator hold remains.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={onRevokeOwn}
          disabled={pending}
          data-testid="visibility-revoke-own-hold"
        >
          {pending ? "Working…" : thirdPerson ? "Remove hold" : "Remove my hold"}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Superuser body — controls act on adminRow only; ownRow is informational.
// ---------------------------------------------------------------------------

type SuperuserBodyArgs = {
  ownRow: SuppressionRow | null;
  adminRow: AdminRow | null;
  pending: boolean;
  onHide: () => void;
  onRevokeAdmin: () => void;
};

function renderSuperuserBody({
  ownRow,
  adminRow,
  pending,
  onHide,
  onRevokeAdmin,
}: SuperuserBodyArgs) {
  // No admin hold → the superuser may add one. ownRow becomes informational.
  if (adminRow === null) {
    return (
      <>
        {ownRow === null ? (
          <p className="text-sm">This scholar&apos;s profile is visible to the public.</p>
        ) : (
          <Alert variant="info">
            <AlertDescription>
              This scholar has self-hidden their profile. You can still add an
              administrator hold.
            </AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onHide}
            data-testid="visibility-hide"
          >
            Hide this scholar&apos;s profile
          </Button>
        </div>
      </>
    );
  }
  // Admin hold exists → the superuser may restore.
  return (
    <>
      <Alert variant="info">
        <AlertDescription>
          An administrator hold is in place. Reason:{" "}
          <em>{adminRow.reason || "(no reason on file)"}</em>.
        </AlertDescription>
      </Alert>
      {ownRow !== null && (
        <p className="text-sm text-muted-foreground">
          This scholar has also self-hidden their profile. Restoring the hold
          lifts the administrator action; the scholar&apos;s self-hold remains.
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="apollo"
          onClick={onRevokeAdmin}
          disabled={pending}
          data-testid="visibility-revoke-admin"
        >
          {pending ? "Working…" : "Restore this scholar's profile"}
        </Button>
      </div>
    </>
  );
}
